'use strict'

// tool-autoload.js - fault-tolerant loader for the laptop-agent tool modules.
//
// WHY THIS EXISTS (2026-08-13 crash-loop hardening, Tate overseas from ~2026-09-24):
// index.js used to require() every file in tools/ inside a bare loop with NO
// per-file try/catch. One load-time throw - a bad dep after `npm i`, a half-
// written commit, an extension update that broke a shared module - crashed boot
// before app.listen. The laptop-agent plist is KeepAlive + ThrottleInterval=10,
// so launchd respawned the crashing process every ~10s FOREVER, silently: no
// API, no dispatch, no alert. The dispatcher is the sole path for all scheduled
// work, so a silent boot crash-loop is survival-critical when no human is at the
// keyboard. Handoff: drafts/away-resilience/HANDOFF-threat-hunt-2026-08-13.md
// (Hunter 4 #1). Doctrine: mac-unattended-resilience-conductor-survival-2026-08-13.
//
// This loader wraps each require() so a single bad tool file is SKIPPED and
// logged (filename + error), and the agent still comes up with every remaining
// tool. A degraded agent (missing one tool) is strictly better than a dead one.
//
// TWO SCREENS, and they catch different things.
//
// SCREEN 1, BY NAME (SKIP_RE). Preserved verbatim from the old inline loop: test
// and harness files run assertions and call process.exit() at load (no
// require.main guard), which would kill the server mid-autoload. Match BOTH the
// suffix conventions (*.test.js / *.spec.js / *.bench.js / *.integration.js) AND
// the `test-` prefix convention - tools/test-tab-title-match.js slipped the old
// suffix-only filter, ran its suite at require(), printed "7 passed" and exited
// before app.listen; the agent was down ~5h on 2026-06-22.
// ALSO the `-test.js` suffix convention (tools/route-test.js): a hands-on manual
// CLI with an unguarded top-level IIFE that pasted a marker into Tate's first CC
// tab and called process.exit(0) at require - launchd respawned it into a paste-
// loop (2026-08-23). It carries its own require.main guard now, but a manual
// harness has no business being autoloaded as a tool, so the filter skips it too.
//
// SCREEN 2, BY CONTENT (screenSource, added 2026-08-29). A name blocklist can
// only ever catch the last filename that detonated, and the class detonated a
// THIRD time on 2026-08-28: tools/reap-leaked-worker-tabs.js was a one-shot CLI
// with a self-executing top-level body and no require.main guard, matched no
// name rule, ran at require() during autoload and killed the host before
// app.listen. Tate was paged at 09:02 AEST. The bug is the class, not the three
// filenames, so the durable screen reads the SOURCE before requiring it and
// refuses anything shaped like a script rather than a module:
//   A. no export signature at all      - it can only run side effects
//   B. process.exit() with no require.main guard - it exits at load
//   C. top-level IIFE with no require.main guard - it runs at load
// Measured against the real tools/ dir the day it shipped: 46 autoload
// candidates, rule A skipped exactly 1 (reap-leaked-worker-tabs.js, which
// exports nothing, so the registry loses nothing), rules B and C skipped ZERO.
// The screen is deliberately biased AGAINST skipping: every protective signal
// (the export signature, the require.main guard) is read from the RAW source, so
// a comment or a string mentioning it still saves the file, while every
// incriminating signal (process.exit, the IIFE) is read from source with
// comments and string literals blanked out, so a mention in prose cannot condemn
// one. Both directions are failures: a landmine slipping through kills the host,
// and a legitimate tool wrongly skipped is a needlessly degraded agent.
// Doctrine: autoload-content-screen-not-name-blocklist-2026-08-29.

const fs = require('fs')
const path = require('path')

const SKIP_RE = /(^test-|-test\.js$|\.(test|spec|bench|integration)\.js$)/

// Protective signals - read from RAW source so a mention anywhere saves the file.
const EXPORT_RE = /module\s*\.\s*exports|(^|[^.\w$])exports\s*[.[]|Object\s*\.\s*defineProperty\s*\(\s*exports\b/
const MAIN_GUARD_RE = /require\s*\.\s*main\s*===?\s*module|module\s*===?\s*require\s*\.\s*main/

// Incriminating signals - read from source with comments and strings blanked.
const PROCESS_EXIT_RE = /process\s*\.\s*exit\s*\(/
// Column 0 only. An indented IIFE is nested inside something and does not run at
// load; a top-level one does. Anchored with /m against blanked source, which
// preserves line structure, so a commented-out IIFE cannot match.
const TOP_LEVEL_IIFE_RE = /^[;!]?(void\s+)?\(\s*(async\s+)?(function\b|\([^)\n]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/m

// blankNonCode(src) -> src with the CONTENTS of comments, string literals and
// regex literals replaced by spaces, newlines preserved so line-anchored regexes
// still see the original column and line layout.
//
// A hand-rolled scanner rather than a chain of regexes because the naive version
// desyncs on the ordinary cases: "http://example.com" inside a string reads as a
// line comment, an apostrophe inside a comment opens a phantom string. Regex
// literals are tracked too (via the standard prev-significant-token heuristic)
// because an unhandled /.../ containing a quote is the other classic desync.
function blankNonCode(src) {
  const NORMAL = 0, LINE = 1, BLOCK = 2, SQ = 3, DQ = 4, TPL = 5, RE = 6
  let state = NORMAL
  let out = ''
  let prevSig = ''   // last significant (non-space) code char seen
  let prevWord = ''  // last identifier/keyword seen, for the regex heuristic
  let word = ''
  // Enclosing templates whose ${ } interpolation we are currently INSIDE. Each
  // entry counts the unclosed `{` seen since that `${`, so only a `}` at depth
  // zero ends the interpolation. Without this, a backtick or quote sitting in
  // an interpolation terminates the template that contains it and the scan
  // desyncs for the rest of the file (reproducible at tools/reflex.js:328).
  const tplStack = []
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    const n = src[i + 1]
    if (state === NORMAL) {
      if (c === '/' && n === '/') { state = LINE; out += '  '; i++; continue }
      if (c === '/' && n === '*') { state = BLOCK; out += '  '; i++; continue }
      if (c === '/' && regexCanStartHere(prevSig, prevWord)) { state = RE; out += ' '; continue }
      if (c === "'") { state = SQ; out += ' '; continue }
      if (c === '"') { state = DQ; out += ' '; continue }
      if (c === '`') { state = TPL; out += ' '; continue }
      if (tplStack.length) {
        // Inside an interpolation: the delimiters are template syntax, not
        // code, so the closing `}` is blanked and hands control back to the
        // template. Braces of the expression itself just move the depth.
        if (c === '}' && tplStack[tplStack.length - 1] === 0) {
          tplStack.pop()
          state = TPL
          out += ' '
          prevSig = ''; prevWord = ''; word = ''
          continue
        }
        if (c === '{') tplStack[tplStack.length - 1]++
        else if (c === '}') tplStack[tplStack.length - 1]--
      }
      out += c
      if (/[A-Za-z0-9_$]/.test(c)) { word += c } else if (word) { prevWord = word; word = '' }
      if (!/\s/.test(c)) prevSig = c
      continue
    }
    // `${` opens an interpolation, whose contents are real code rather than
    // template text. Checked before the blanking below so the expression is
    // scanned as code; an escaped `\${` never reaches here because the
    // backslash branch further down has already consumed the `$`.
    if (state === TPL && c === '$' && n === '{') {
      out += '  '
      i++
      tplStack.push(0)
      state = NORMAL
      prevSig = ''; prevWord = ''; word = ''
      continue
    }
    // Inside a non-code run: emit a space for every char, a real newline for
    // newlines, and watch for the terminator.
    out += (c === '\n' ? '\n' : ' ')
    if (state === LINE) {
      if (c === '\n') { state = NORMAL; prevSig = ''; prevWord = '' }
      continue
    }
    if (state === BLOCK) {
      if (c === '*' && n === '/') { out += ' '; i++; state = NORMAL }
      continue
    }
    if (c === '\\') { if (i + 1 < src.length) { out += (src[i + 1] === '\n' ? '\n' : ' '); i++ } continue }
    if (state === SQ && c === "'") { state = NORMAL; prevSig = "'"; prevWord = ''; continue }
    if (state === DQ && c === '"') { state = NORMAL; prevSig = '"'; prevWord = ''; continue }
    if (state === TPL && c === '`') { state = NORMAL; prevSig = '`'; prevWord = ''; continue }
    if (state === RE && (c === '/' || c === '\n')) { state = NORMAL; prevSig = '/'; prevWord = ''; continue }
  }
  return out
}

// A `/` starts a regex literal (not a division) when the previous significant
// token cannot end an expression. Conservative: when unsure, treat it as
// division, which leaves the text as code and can only cost a missed skip.
function regexCanStartHere(prevSig, prevWord) {
  if (!prevSig) return true
  if ('([{,;:=!&|?+-*%~^<>'.indexOf(prevSig) !== -1) return true
  if (prevSig === ')' || prevSig === ']' || prevSig === '}') return false
  if (/[A-Za-z0-9_$]/.test(prevSig)) {
    return /^(return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/.test(prevWord)
  }
  return false
}

// screenSource(src) -> null when the file is safe to require, else
// { reason, detail } naming why it looks like a script rather than a module.
function screenSource(src) {
  const code = blankNonCode(src)
  const hasExport = EXPORT_RE.test(src)          // RAW: protective
  const hasGuard = MAIN_GUARD_RE.test(src)       // RAW: protective
  if (!hasExport) {
    return {
      reason: 'no-export-signature',
      detail: 'no module.exports and no exports.<name> assignment, so requiring it can only run side effects',
    }
  }
  if (PROCESS_EXIT_RE.test(code) && !hasGuard) {
    return {
      reason: 'process-exit-without-require-main-guard',
      detail: 'calls process.exit() outside any `require.main === module` guard, so it exits the host at load',
    }
  }
  if (TOP_LEVEL_IIFE_RE.test(code) && !hasGuard) {
    return {
      reason: 'top-level-iife-without-require-main-guard',
      detail: 'runs a top-level IIFE outside any `require.main === module` guard, so it executes at load',
    }
  }
  return null
}

// loadTools({ toolDir, logger, requireFn }) -> { tools, loaded, failed }
//   tools   : { "<module>.<export>": fn }  (registry, same shape as before)
//   loaded  : [ "<module>", ... ]           (modules that loaded cleanly)
//   failed  : [ { file, error, contentSkip?, reason? }, ... ]
//
// A `failed` entry with contentSkip:true was refused BEFORE require by the
// content screen: deliberate, by design, and NOT a sign of a degraded boot. An
// entry without it threw at require and IS a degradation. index.js splits the
// two onto /api/health so a canary reading tool_load_failures keeps meaning
// "something broke" rather than going permanently amber on a screened CLI.
//
// logger defaults to console; requireFn is injectable so a test can point the
// loader at a fixture directory without going through Node's module cache for
// the real tools. A require throw NEVER propagates - it is captured into failed.
function loadTools(opts) {
  const o = opts || {}
  const toolDir = o.toolDir
  const logger = o.logger || console
  const requireFn = o.requireFn || require
  if (!toolDir) throw new Error('loadTools: toolDir required')

  const tools = {}
  const loaded = []
  const failed = []

  let files
  try {
    files = fs.readdirSync(toolDir)
  } catch (e) {
    // The tools directory itself is unreadable. Log and return an empty registry
    // rather than throwing - the caller can still bring up the bare HTTP surface.
    logger.error('[autoload] tools directory unreadable (' + toolDir + '): ' + (e && e.message || e))
    return { tools, loaded, failed }
  }

  for (const file of files) {
    if (!file.endsWith('.js')) continue
    if (SKIP_RE.test(file)) continue
    const full = path.join(toolDir, file)
    const moduleName = path.basename(file, '.js')

    // SCREEN 2: read the source and refuse anything script-shaped BEFORE the
    // require. This is the whole point - once require() runs it is too late,
    // because a top-level process.exit() takes the host down with it and no
    // try/catch can catch an exit.
    let src
    try {
      src = fs.readFileSync(full, 'utf8')
    } catch (e) {
      failed.push({ file, error: 'unreadable: ' + ((e && e.message) || String(e)), contentSkip: true, reason: 'unreadable' })
      logger.error('[autoload] SKIPPED tool file ' + file + ' (unreadable, not required): ' + ((e && e.message) || String(e)))
      continue
    }
    const verdict = screenSource(src)
    if (verdict) {
      failed.push({ file, error: 'content-screen: ' + verdict.reason + ' - ' + verdict.detail, contentSkip: true, reason: verdict.reason })
      logger.error('[autoload] SKIPPED tool file ' + file + ' (deliberate content-skip, NOT a load error): ' +
        verdict.reason + ' - ' + verdict.detail)
      continue
    }

    try {
      const mod = requireFn(full)
      if (mod && typeof mod === 'object') {
        for (const [name, fn] of Object.entries(mod)) {
          tools[moduleName + '.' + name] = fn
        }
      }
      loaded.push(moduleName)
    } catch (e) {
      // A single bad tool file must NOT crash boot. Skip it, keep going.
      failed.push({ file, error: (e && e.message) || String(e) })
      logger.error('[autoload] SKIPPED tool file ' + file + ' (load-time error): ' +
        ((e && e.stack) || (e && e.message) || String(e)))
    }
  }

  if (failed.length) {
    const errs = failed.filter(f => !f.contentSkip)
    const skips = failed.filter(f => f.contentSkip)
    if (errs.length) {
      logger.error('[autoload] ' + errs.length + ' tool file(s) failed to load and were skipped: ' +
        errs.map(f => f.file).join(', ') + '. Agent came up with the remaining ' + loaded.length + '.')
    }
    if (skips.length) {
      logger.error('[autoload] ' + skips.length + ' tool file(s) refused by the content screen (by design, not a fault): ' +
        skips.map(f => f.file + ' [' + f.reason + ']').join(', ') + '.')
    }
  }

  return { tools, loaded, failed }
}

module.exports = { loadTools, SKIP_RE, screenSource, blankNonCode }
