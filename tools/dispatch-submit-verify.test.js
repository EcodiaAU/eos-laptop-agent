'use strict'

// dispatch-submit-verify.test - the submit-evidence probe, and its negative
// controls.
//
// The property under test is not "can it find a string". It is that the answer
// discriminates a worker that RAN from every cheaper thing that looks like one:
// an observing chat that quoted the credential, a stale transcript, a scan that
// could not see far enough. Each of those has a case here, and each is written
// so that DISABLING the guard makes it fail (run with EOS_MUTATE=<name> to see
// that happen, which is the only way to know the case is measuring anything).

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const MUTATE = process.env.EOS_MUTATE || ''
const results = []
function check(name, fn) {
  try { fn(); results.push([name, true]); process.stdout.write('  PASS  ' + name + '\n') }
  catch (e) { results.push([name, false]); process.stdout.write('  FAIL  ' + name + '  [' + e.message + ']\n') }
}

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'eos-submit-verify-'))
process.env.EOS_CC_PROJECTS_DIR = SANDBOX
delete require.cache[require.resolve('./dispatch-submit-verify')]
const V = require('./dispatch-submit-verify')

function writeTranscript(slug, name, body, mtimeMs) {
  const dir = path.join(SANDBOX, slug)
  fs.mkdirSync(dir, { recursive: true })
  const fp = path.join(dir, name)
  fs.writeFileSync(fp, body)
  if (typeof mtimeMs === 'number') {
    const s = mtimeMs / 1000
    fs.utimesSync(fp, s, s)
  }
  return fp
}

// The exact byte form composeBrief writes into a dispatched brief, as it appears
// once embedded in a JSONL message body (quotes escaped).
function briefLine(cred) {
  return '{"type":"user","message":{"role":"user","content":"'
    + 'mcp__coord__coord_verify_paste({tab_id:\\"tab_1\\", tab_credential:\\"' + cred + '\\"})'
    + '"}}\n'
}

const CRED = '11111111-2222-3333-4444-555555555555'
const OTHER = '99999999-8888-7777-6666-555555555555'
const t0 = Date.now()

process.stdout.write('dispatch-submit-verify' + (MUTATE ? '  [MUTATION: ' + MUTATE + ']' : '') + '\n')

// ---- 1. the positive: a worker turn written after t0 is found --------------
check('finds a submitted brief written after the dispatch stamp', () => {
  writeTranscript('proj-a', 'worker.jsonl', briefLine(CRED), t0 + 1000)
  const r = V.findSubmitEvidence({ credential: CRED, sinceMs: t0 })
  assert.strictEqual(r.found, true, 'expected found, got ' + JSON.stringify(r))
})

// ---- 2. NEGATIVE CONTROL: an observer quoting the credential is not a run ---
//
// This is the case that caught itself. A session that prints the worker registry
// emits "tab_credential": "<cred>" - spaced, separately quoted. An earlier draft
// keyed on the bare credential and matched exactly that, so a chat that merely
// LOOKED at a worker proved the worker had run. Measured for real: a test typing
// its own fake credential matched its own transcript.
check('NEG: registry JSON quoting the credential is NOT submit evidence', () => {
  writeTranscript('proj-obs', 'observer.jsonl',
    '{"type":"assistant","message":{"content":"row: {\\"tab_credential\\": \\"' + CRED + '\\"}"}}\n',
    t0 + 1000)
  const r = V.findSubmitEvidence({ credential: CRED, sinceMs: t0 })
  // proj-a from case 1 is still on disk and legitimately matches, so this case
  // must run against a credential nobody has submitted.
  const r2 = V.findSubmitEvidence({ credential: OTHER, sinceMs: t0 })
  writeTranscript('proj-obs', 'observer2.jsonl',
    '{"type":"assistant","message":{"content":"row: {\\"tab_credential\\": \\"' + OTHER + '\\"}"}}\n',
    t0 + 1000)
  const r3 = V.findSubmitEvidence({ credential: OTHER, sinceMs: t0 })
  assert.strictEqual(r.found, true, 'sanity: case-1 credential should still be found')
  assert.strictEqual(r2.found, false, 'a credential with no transcript must not be found')
  if (MUTATE === 'needle') {
    // With the needle loosened to a bare substring this becomes true, which is
    // what makes the case a real control rather than a restatement.
    assert.strictEqual(r3.found, true, 'mutation expected the loose needle to match')
  } else {
    assert.strictEqual(r3.found, false,
      'observer-quoted credential must not count as a submit: ' + JSON.stringify(r3))
  }
})

// ---- 3. NEGATIVE CONTROL: a pre-dispatch transcript is out of window --------
check('NEG: a transcript older than the dispatch stamp is not evidence', () => {
  const old = '00000000-aaaa-bbbb-cccc-dddddddddddd'
  writeTranscript('proj-old', 'ancient.jsonl', briefLine(old), t0 - 600000)
  const r = V.findSubmitEvidence({ credential: old, sinceMs: t0 })
  assert.strictEqual(r.found, false, 'stale file matched: ' + JSON.stringify(r))
})

// ---- 4. the mtime slack is real, not decorative ----------------------------
//
// The harness can create the file a beat before we stamp t0, and filesystem
// mtime granularity cuts the same way. A file inside the slack window must be
// read, or a fast worker reads as a failed submit and gets its tab closed.
check('a file written just inside the mtime slack window is still read', () => {
  const c = 'aaaabbbb-cccc-dddd-eeee-ffff00001111'
  writeTranscript('proj-slack', 'fast.jsonl', briefLine(c), t0 - (V.MTIME_SLACK_MS - 1000))
  const r = V.findSubmitEvidence({ credential: c, sinceMs: t0 })
  assert.strictEqual(r.found, true, 'slack window not honoured: ' + JSON.stringify(r))
})

// ---- 5. a capped scan must SAY it was capped, not report a clean miss -------
//
// This is the difference between "no session started" and "I could not look".
// The caller closes a tab on the first and must not on the second.
check('a capped candidate set reports candidate_cap_hit rather than a clean miss', () => {
  const dir = path.join(SANDBOX, 'proj-flood')
  fs.mkdirSync(dir, { recursive: true })
  for (let i = 0; i < V.CANDIDATE_CAP + 20; i++) {
    const fp = path.join(dir, 'f' + i + '.jsonl')
    fs.writeFileSync(fp, '{"noise":' + i + '}\n')
    const s = (t0 + 2000) / 1000
    fs.utimesSync(fp, s, s)
  }
  const r = V.findSubmitEvidence({ credential: OTHER, sinceMs: t0 })
  assert.strictEqual(r.found, false)
  assert.strictEqual(r.candidate_cap_hit, true, 'cap not reported: ' + JSON.stringify(r))
  assert.ok(r.candidates_matched > V.CANDIDATE_CAP, 'total not reported')
})

// ---- 6. newest-first, so the cap keeps the files that can actually match ----
check('candidates are ordered newest-first so the cap keeps the plausible ones', () => {
  const files = V._candidateFiles(SANDBOX, t0 - 60000)
  const stats = files.slice(0, 5).map((f) => fs.statSync(f).mtimeMs)
  for (let i = 1; i < stats.length; i++) {
    assert.ok(stats[i - 1] >= stats[i], 'not sorted newest-first')
  }
})

// ---- 7. a malformed credential is refused, not treated as a wildcard -------
check('NEG: a too-short or missing credential is refused', () => {
  assert.strictEqual(V.findSubmitEvidence({}).found, false)
  assert.ok(V.findSubmitEvidence({}).error, 'no error reported for missing credential')
  assert.strictEqual(V.findSubmitEvidence({ credential: 'abc' }).found, false)
})

// ---- 8. waitForSubmit times out cleanly and says so ------------------------
check('waitForSubmit reports timed_out rather than throwing', () => {
  const r = require('child_process').execFileSync(process.execPath, ['-e', `
    process.env.EOS_CC_PROJECTS_DIR = ${JSON.stringify(SANDBOX)};
    const V = require(${JSON.stringify(require.resolve('./dispatch-submit-verify'))});
    V.waitForSubmit({credential:'ffffffff-0000-1111-2222-333333333333',sinceMs:Date.now(),timeoutMs:1200,pollMs:300})
      .then(r=>{process.stdout.write(JSON.stringify(r))});
  `], { encoding: 'utf8', timeout: 20000 })
  const out = JSON.parse(r)
  assert.strictEqual(out.found, false)
  assert.strictEqual(out.timed_out, true)
  assert.ok(out.polls >= 2, 'expected more than one poll, got ' + out.polls)
})

try { fs.rmSync(SANDBOX, { recursive: true, force: true }) } catch (e) {}

const failed = results.filter((r) => !r[1])
process.stdout.write('\n' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed\n')
process.exit(failed.length ? 1 : 0)
