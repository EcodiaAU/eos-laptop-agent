'use strict'

// dispatch-submit-verify - answer "did the brief we pasted actually SUBMIT?"
//
// WHY THIS EXISTS. The Mac dispatch path populates a Claude Code chat input from
// the extension host (focusless, reliable) and then submits it with ONE System
// Events Return keystroke, because the CC extension contributes no submit
// command. Probed exhaustively 2026-09-17 against
// anthropic.claude-code-2.1.251: 23 contributed commands, 23 registerCommand
// call sites, and not one of them submits. So the submit is the only
// focus-dependent step left in the chain, and nothing downstream checked it.
//
// The cost of not checking, measured 2026-09-17 over 48h of real dispatches:
// 500 worker rows registered, 481 whose last_heartbeat_at never advanced past
// registered_at. The dispatcher returned ok:true with a submit_path string for
// rows whose brief was sitting in an input box that nobody ever pressed Enter
// on. Tate saw it as "lots of tabs getting stuck with the prompts pasted but
// the submit step failing somehow".
//
// THE SIGNAL, and why it is this one. A Claude Code session that takes a turn
// appends its turn to a transcript JSONL under ~/.claude/projects/<slug>/. The
// brief carries the worker's tab_credential (composeBrief writes it into the
// verify_paste line), so a transcript containing that credential is proof that
// THIS brief became a turn in a real session.
//
// The credential is the key rather than the tab_id on purpose. Tab ids are
// printed constantly by other sessions - fleet-owns output, the active_workers
// prompt block, any chat that inspects the registry - so a tab_id match can be
// the OBSERVER's own transcript quoting the id rather than the worker running.
// That false-green is not hypothetical: it inflated the first measurement of
// this very bug from <=34 submitted to 73.
//
// A BARE credential is still not enough, and the proof of that was a negative
// control failing on itself: a session that typed the test credential into its
// own turn matched its own transcript. Any chat that inspects the worker
// registry prints credentials the same way. So the needle is the BRIEF'S OWN
// BYTE FORM, tab_credential:"<cred>" as composeBrief writes it (quotes escaped
// in the JSONL), which registry JSON - "tab_credential": "<cred>", spaced and
// separately quoted - does not produce.
//
// Validated 2026-09-17 against six real dispatches from the previous 6 hours:
// the brief-form needle and a bare-credential search agreed on every one (3
// found, 3 not), so specificity costs no sensitivity. Those same six are the
// bug in miniature - three tabs opened and never submitted.
//
// Scanning is bounded by mtime: only files touched at or after the dispatch
// stamp can hold the new turn, which keeps a poll to a handful of files instead
// of the whole corpus (an unscoped grep over ~/.claude/projects ran past 120s).
//
// MTIME IS THE RIGHT CLOCK HERE, and this is the one place that needs saying.
// A transcript-corpus mtime window is normally a trap: a mass touch on this Mac
// put 4,656 files in one minute, so an mtime window over days is mostly phantom
// (doctrine: a-transcript-window-on-mtime-is-not-a-time-window-2026-09-13, which
// names "was this FILE written" as the legitimate case). This is that case, and
// the asymmetry is what makes it safe: a stale touch can only OVER-include, and
// an over-included old file cannot match, because the needle is a credential
// minted seconds ago that exists in exactly one brief. Under-inclusion would be
// the dangerous direction and mtime cannot under-include a file being written
// right now. A content clock would be strictly worse: the file we are waiting
// for has no timestamped record yet, so it would fall back to mtime anyway.
//
// Over-inclusion still costs READS, so the candidate set is capped and taken
// newest-first. A capped pass reports it rather than reporting a clean miss.

const fs = require('fs')
const path = require('path')
const os = require('os')

const PROJECTS_DIR = process.env.EOS_CC_PROJECTS_DIR
  || path.join(os.homedir(), '.claude', 'projects')

// Filesystem mtime granularity plus the lag between "we stamped t0" and "the
// harness created the file" both cut the wrong way, so the window opens a little
// before t0. 4s is enough for both and still excludes the previous dispatch.
const MTIME_SLACK_MS = 4000

// Ceiling on files read per pass, newest-first. A dispatch window should match a
// handful; anything near this means the corpus was touched en masse and the pass
// says so rather than returning a confident miss.
const CANDIDATE_CAP = 400

function _candidateFiles(projectsDir, sinceMs, cap) {
  const hits = []
  let slugs
  try { slugs = fs.readdirSync(projectsDir) } catch (e) { return [] }
  const floor = sinceMs - MTIME_SLACK_MS
  for (const slug of slugs) {
    const dir = path.join(projectsDir, slug)
    let names
    try { names = fs.readdirSync(dir) } catch (e) { continue }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue
      const fp = path.join(dir, n)
      try {
        const st = fs.statSync(fp)
        if (st.mtimeMs >= floor) hits.push({ fp: fp, m: st.mtimeMs })
      } catch (e) { /* raced away */ }
    }
  }
  hits.sort((a, b) => b.m - a.m)
  const limit = typeof cap === 'number' ? cap : CANDIDATE_CAP
  const capped = hits.length > limit
  const files = hits.slice(0, limit).map((h) => h.fp)
  files.capped = capped
  files.total_matched = hits.length
  return files
}

// findSubmitEvidence - one pass. Returns {found, file, scanned}.
//
// A hit is a literal substring match on the credential. No parsing: a partially
// flushed JSONL line is still proof the turn started, and requiring valid JSON
// would make the answer depend on flush timing rather than on whether the
// session ran.
function findSubmitEvidence(opts) {
  opts = opts || {}
  const credential = opts.credential
  if (!credential || String(credential).length < 8) {
    return { found: false, error: 'credential required (>=8 chars)', scanned: 0 }
  }
  const projectsDir = opts.projectsDir || PROJECTS_DIR
  const sinceMs = typeof opts.sinceMs === 'number' ? opts.sinceMs : 0
  const files = _candidateFiles(projectsDir, sinceMs)
  // tab_credential:"<cred>" with the quote optionally backslash-escaped, which
  // is how it survives being embedded in a JSONL message body.
  const needle = new RegExp('tab_credential:\\\\?"' + String(credential).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  for (const fp of files) {
    let buf
    try { buf = fs.readFileSync(fp, 'utf8') } catch (e) { continue }
    if (needle.test(buf)) {
      return { found: true, file: fp, scanned: files.length }
    }
  }
  return {
    found: false,
    scanned: files.length,
    // A capped pass is NOT evidence of absence. The caller must not close a tab
    // on a miss it could not have seen, so this flag rides out with the answer.
    candidate_cap_hit: !!files.capped,
    candidates_matched: files.total_matched,
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

// waitForSubmit - poll until the evidence appears or the budget runs out.
//
// The default budget is deliberately generous. A cold CC worker loads skills,
// auto-memory and every MCP server before its first model call, and the
// transcript's first line lands when the turn STARTS rather than when it
// finishes, so this is waiting on process start, not on the model. 25s covers
// an observed cold start with room; the caller retries rather than extending,
// because a longer single wait cannot tell a slow start from a dead keystroke.
async function waitForSubmit(opts) {
  opts = opts || {}
  const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 25000
  const pollMs = typeof opts.pollMs === 'number' ? opts.pollMs : 1000
  const deadline = Date.now() + timeoutMs
  let last = { found: false, scanned: 0 }
  let polls = 0
  for (;;) {
    polls += 1
    last = findSubmitEvidence(opts)
    if (last.found) return Object.assign({}, last, { polls, waited_ms: timeoutMs - (deadline - Date.now()) })
    if (Date.now() >= deadline) break
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())))
  }
  return Object.assign({}, last, { polls, timed_out: true, waited_ms: timeoutMs })
}

module.exports = {
  findSubmitEvidence,
  waitForSubmit,
  _candidateFiles,
  PROJECTS_DIR,
  MTIME_SLACK_MS,
  CANDIDATE_CAP,
}
