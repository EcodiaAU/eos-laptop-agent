// tool-autoload.test.js - proves the fault-tolerant autoload (2026-08-13 crash-loop
// hardening): a throwing tool file is SKIPPED + logged and the agent still loads
// every OTHER tool, instead of one bad require crashing boot into a silent launchd
// respawn loop. Uses a temp fixture dir so it never touches the real tools/.
//
// Run: node tools/tool-autoload.test.js   (exit 0 = pass, non-zero = fail)
'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { loadTools, SKIP_RE, screenSource, blankNonCode } = require('../lib/tool-autoload')

let failures = 0
function ok(name, fn) {
  try { fn(); console.log('  ok - ' + name) }
  catch (e) { failures++; console.error('  FAIL - ' + name + ': ' + (e && e.message || e)) }
}

// Build a fixture tools dir: one good tool, one that throws at require, one that
// exports two fns, and a *.test.js that must be skipped.
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoload-fix-'))
fs.writeFileSync(path.join(fixtureDir, 'good.js'),
  'module.exports = { hello: () => "hi", bye: () => "bye" }')
// Carries an export signature ON PURPOSE: without one the 2026-08-29 content
// screen would refuse it before require, and this test would stop proving that a
// genuine load-time THROW is caught. It has to reach require() to throw.
fs.writeFileSync(path.join(fixtureDir, 'bad.js'),
  'module.exports = { unreachable: () => 1 }\nthrow new Error("boom at require time")')
fs.writeFileSync(path.join(fixtureDir, 'alsogood.js'),
  'module.exports = { ping: () => "pong" }')
fs.writeFileSync(path.join(fixtureDir, 'sneaky.test.js'),
  'process.exit(7) // must never run')
fs.writeFileSync(path.join(fixtureDir, 'test-prefixed.js'),
  'process.exit(7) // must never run (test- prefix)')
fs.writeFileSync(path.join(fixtureDir, 'notjs.txt'), 'ignored')

// Silent logger to capture messages without noise.
const logs = []
const logger = { error: (m) => logs.push(m), log: () => {} }

const result = loadTools({ toolDir: fixtureDir, logger })

// ── 1. the good tools loaded ──────────────────────────────────────────────────
ok('good tool files loaded with module.export naming', () => {
  assert.strictEqual(typeof result.tools['good.hello'], 'function')
  assert.strictEqual(result.tools['good.hello'](), 'hi')
  assert.strictEqual(typeof result.tools['good.bye'], 'function')
  assert.strictEqual(typeof result.tools['alsogood.ping'], 'function')
  assert.strictEqual(result.tools['alsogood.ping'](), 'pong')
})

// ── 2. the throwing tool was SKIPPED, not fatal ───────────────────────────────
ok('throwing tool file is skipped and recorded, boot continues', () => {
  assert.strictEqual(result.failed.length, 1, 'exactly one failure recorded')
  assert.strictEqual(result.failed[0].file, 'bad.js')
  assert.ok(/boom at require time/.test(result.failed[0].error), 'error captured: ' + result.failed[0].error)
  // The bad module contributed NO tools, but the good ones are all present.
  assert.ok(!Object.keys(result.tools).some(k => k.startsWith('bad.')), 'no bad.* tools registered')
  assert.ok(result.loaded.includes('good') && result.loaded.includes('alsogood'), 'both good modules loaded')
})

// ── 3. the failure was logged with the filename ───────────────────────────────
ok('the skip is logged with the offending filename', () => {
  assert.ok(logs.some(m => /SKIPPED tool file bad\.js/.test(m)), 'per-file skip logged: ' + JSON.stringify(logs))
  assert.ok(logs.some(m => /1 tool file\(s\) failed to load/.test(m)), 'summary logged')
})

// ── 4. test/harness files are never required (would process.exit) ─────────────
ok('test and test-prefixed files are skipped by the filter', () => {
  // If sneaky.test.js or test-prefixed.js had been required, this process would
  // have exited 7 before reaching here. Reaching here proves they were skipped.
  assert.ok(SKIP_RE.test('sneaky.test.js'))
  assert.ok(SKIP_RE.test('test-prefixed.js'))
  assert.ok(!SKIP_RE.test('good.js'))
  assert.ok(!result.loaded.includes('sneaky.test'))
  assert.ok(!result.loaded.includes('test-prefixed'))
})

// ── 5. an all-bad dir still returns (agent comes up bare, does not throw) ──────
ok('a directory of only-throwing tools returns without throwing', () => {
  const badDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoload-allbad-'))
  // Export signatures again, so these reach require() and throw rather than being
  // content-screened out (which would pass this test for the wrong reason).
  fs.writeFileSync(path.join(badDir, 'x.js'), 'module.exports = {}\nthrow new Error("x")')
  fs.writeFileSync(path.join(badDir, 'y.js'), 'module.exports = {}\nthrow new Error("y")')
  const r = loadTools({ toolDir: badDir, logger: { error: () => {}, log: () => {} } })
  assert.strictEqual(Object.keys(r.tools).length, 0)
  assert.strictEqual(r.failed.length, 2)
  fs.rmSync(badDir, { recursive: true, force: true })
})

// ── 6. an unreadable dir is non-fatal ─────────────────────────────────────────
ok('an unreadable tools dir returns an empty registry, does not throw', () => {
  const r = loadTools({ toolDir: '/nonexistent/path/does/not/exist', logger: { error: () => {}, log: () => {} } })
  assert.strictEqual(Object.keys(r.tools).length, 0)
  assert.strictEqual(r.failed.length, 0)
})

// =============================================================================
// CONTENT SCREEN (2026-08-29) - the name blocklist only ever caught the last
// filename that detonated, and the class detonated three times: test-tab-title-
// match.js (2026-06-22, ~5h outage), route-test.js (2026-08-23, paste loop),
// reap-leaked-worker-tabs.js (2026-08-28, Tate paged 09:02 AEST). Each was a
// self-executing script sitting in the autoloaded tools dir under a name no
// filter predicted. These fixtures are the class, not the filenames.
//
// The proof shape matters: each landmine writes a SENTINEL FILE at top level
// before it exits. A sentinel that exists means the file was require()d and the
// screen failed. Two of them then call process.exit(7), so a screen regression
// does not merely fail an assertion, it kills this test process outright with a
// non-zero code. There is no way for this suite to go green on a broken screen.
// =============================================================================

const screenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoload-screen-'))
const sentinel = (n) => path.join(screenDir, n + '.sentinel')
const w = (name, body) => fs.writeFileSync(path.join(screenDir, name), body)

// RULE A - no export signature at all. Requiring it can only run side effects,
// and its registry contribution is zero, so skipping it loses nothing. This is
// the exact shape of reap-leaked-worker-tabs.js on 2026-08-28.
w('landmine-noexport.js', [
  "const fs = require('fs')",
  "fs.writeFileSync(" + JSON.stringify(sentinel('noexport')) + ", 'ran')",
  'process.exit(7)',
].join('\n'))

// RULE B - exports cleanly (so rule A passes it) but calls process.exit() with
// no require.main guard. Nothing can catch an exit; the host just dies.
w('landmine-exit.js', [
  "const fs = require('fs')",
  'module.exports = { looksLegit: () => 1 }',
  "fs.writeFileSync(" + JSON.stringify(sentinel('exit')) + ", 'ran')",
  'process.exit(7)',
].join('\n'))

// RULE C - exports cleanly AND never exits, so rules A and B both pass it, but a
// column-0 IIFE fires its body at require. This is the route-test.js shape: it
// pasted a marker into Tate's live CC tab at load. No exit here, so if the screen
// misses it the suite survives to FAIL the assertion rather than dying.
w('landmine-iife.js', [
  "const fs = require('fs')",
  'module.exports = { alsoLooksLegit: () => 1 }',
  '(function () {',
  "  fs.writeFileSync(" + JSON.stringify(sentinel('iife')) + ", 'ran')",
  '})()',
].join('\n'))

// CONTROL 1 - a pedestrian module that MENTIONS process.exit in a comment and in
// a string literal. Over-eagerness is a real failure too: a wrongly skipped tool
// is a needlessly degraded agent, so this must load.
w('control-mentions.js', [
  '// This module never calls process.exit( itself. It only talks about it.',
  "const advice = 'call process.exit(1) from a CLI, never from a tool module'",
  '/* block comment: process.exit(0) and a stray (function(){})() at col 0 */',
  'module.exports = { advise: () => advice }',
].join('\n'))

// CONTROL 2 - the correctly-written CLI-capable module: exports, AND gates its
// side effects behind require.main. This is what a fixed landmine looks like and
// it must survive the screen.
w('control-guarded.js', [
  'function main () { process.exit(0) }',
  'module.exports = { main: main }',
  'if (require.main === module) main()',
].join('\n'))

// CONTROL 3 - proves the comment/string scanner does not desync on the ordinary
// hard cases: a URL inside a string (whose // is not a comment), an apostrophe
// inside a comment, and a regex literal containing a quote and a slash.
w('control-scanner.js', [
  "const url = 'https://example.com/a//b'",
  "// don't let this apostrophe open a phantom string",
  "const re = /['\"]\\/x/g",
  'module.exports = { url: () => url, re: () => re }',
].join('\n'))

const screenLogs = []
const screenResult = loadTools({
  toolDir: screenDir,
  logger: { error: (m) => screenLogs.push(m), log: () => {} },
})
const reasonOf = (f) => (screenResult.failed.find(x => x.file === f) || {}).reason

ok('landmines are skipped BEFORE require - no side effect ran', () => {
  // The load-bearing assertion. Reaching this line at all already proves the two
  // exiting landmines never ran (they would have taken the process with them).
  for (const n of ['noexport', 'exit', 'iife']) {
    assert.ok(!fs.existsSync(sentinel(n)),
      'sentinel ' + n + ' exists, so the file was require()d and the screen FAILED')
  }
})

ok('each landmine is recorded in failed with its rule as the reason', () => {
  assert.strictEqual(reasonOf('landmine-noexport.js'), 'no-export-signature')
  assert.strictEqual(reasonOf('landmine-exit.js'), 'process-exit-without-require-main-guard')
  assert.strictEqual(reasonOf('landmine-iife.js'), 'top-level-iife-without-require-main-guard')
  for (const f of ['landmine-noexport.js', 'landmine-exit.js', 'landmine-iife.js']) {
    const e = screenResult.failed.find(x => x.file === f)
    assert.strictEqual(e.contentSkip, true, f + ' must be marked contentSkip, not a load error')
    assert.ok(e.error && e.error.length > 20, f + ' must carry a human-readable reason: ' + e.error)
  }
})

ok('a content-skip is logged as deliberate, not as a load error', () => {
  assert.ok(screenLogs.some(m => /SKIPPED tool file landmine-noexport\.js \(deliberate content-skip, NOT a load error\)/.test(m)),
    'per-file content-skip logged distinctly: ' + JSON.stringify(screenLogs))
  assert.ok(screenLogs.some(m => /refused by the content screen \(by design, not a fault\)/.test(m)), 'summary logged')
  assert.ok(!screenLogs.some(m => /failed to load and were skipped/.test(m)),
    'a pure content-skip must NOT be reported as a load failure')
})

ok('the controls all load - the screen is not over-eager', () => {
  assert.strictEqual(typeof screenResult.tools['control-mentions.advise'], 'function')
  assert.strictEqual(screenResult.tools['control-mentions.advise'](),
    'call process.exit(1) from a CLI, never from a tool module')
  assert.strictEqual(typeof screenResult.tools['control-guarded.main'], 'function')
  assert.strictEqual(typeof screenResult.tools['control-scanner.url'], 'function')
  assert.strictEqual(screenResult.tools['control-scanner.url'](), 'https://example.com/a//b')
  for (const f of ['control-mentions.js', 'control-guarded.js', 'control-scanner.js']) {
    assert.ok(!screenResult.failed.some(x => x.file === f), f + ' was wrongly skipped')
  }
  assert.strictEqual(screenResult.loaded.length, 3, 'exactly the three controls loaded')
})

// screenSource is exported so the real-tools regression gate below can run the
// screen half without requiring anything.
ok('screenSource returns null for a module and a reason for a script', () => {
  assert.strictEqual(screenSource('module.exports = { a: 1 }'), null)
  assert.strictEqual(screenSource('console.log(1)').reason, 'no-export-signature')
  assert.strictEqual(
    screenSource('module.exports = {}\nprocess.exit(0)').reason,
    'process-exit-without-require-main-guard')
  // The guard rescues both incriminating shapes.
  assert.strictEqual(
    screenSource('module.exports = {}\nif (require.main === module) process.exit(0)'), null)
})

ok('blankNonCode preserves length and line structure', () => {
  const src = "const a = 'x' // c\n/* b */ const d = 1\n"
  const out = blankNonCode(src)
  assert.strictEqual(out.length, src.length)
  assert.strictEqual((out.match(/\n/g) || []).length, (src.match(/\n/g) || []).length)
  assert.ok(/const a =/.test(out) && /const d = 1/.test(out), 'real code survives: ' + JSON.stringify(out))
  assert.ok(!/\/\/ c/.test(out) && !/b \*\//.test(out), 'comment bodies blanked: ' + JSON.stringify(out))
})

// =============================================================================
// REAL-DIR REGRESSION GATE - the screen must cost the live agent nothing. Run it
// over the actual tools/ dir with require STUBBED so nothing executes here, and
// diff the set of files that pass BEFORE (name screen only) against AFTER (name
// + content screen). Any newly-skipped file that actually exports something is a
// regression and fails this suite.
// =============================================================================
ok('the content screen skips no exporting tool in the real tools dir', () => {
  const realDir = path.join(__dirname)
  const before = fs.readdirSync(realDir).filter(f => f.endsWith('.js') && !SKIP_RE.test(f))
  const r = loadTools({
    toolDir: realDir,
    logger: { error: () => {}, log: () => {} },
    requireFn: () => ({ stub: () => 1 }),   // nothing in tools/ runs in this process
  })
  const after = new Set(r.loaded.map(m => m + '.js'))
  const newlySkipped = before.filter(f => !after.has(f))
  const lostRealTools = newlySkipped.filter(f => {
    const src = fs.readFileSync(path.join(realDir, f), 'utf8')
    return /module\s*\.\s*exports|(^|[^.\w$])exports\s*[.[]/.test(src)
  })
  assert.deepStrictEqual(lostRealTools, [],
    'the screen would strip real exporting tools from the live agent: ' + lostRealTools.join(', '))
  assert.strictEqual(r.failed.filter(f => !f.contentSkip).length, 0, 'stubbed require must not throw')
  console.log('     real tools/: ' + before.length + ' candidates before, ' + after.size + ' after, ' +
    newlySkipped.length + ' content-skipped (' + (newlySkipped.join(', ') || 'none') + '), 0 exporting tools lost')
})

fs.rmSync(screenDir, { recursive: true, force: true })

fs.rmSync(fixtureDir, { recursive: true, force: true })

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILED')
process.exit(failures === 0 ? 0 : 1)
