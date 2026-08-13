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
const { loadTools, SKIP_RE } = require('../lib/tool-autoload')

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
fs.writeFileSync(path.join(fixtureDir, 'bad.js'),
  'throw new Error("boom at require time")')
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
  fs.writeFileSync(path.join(badDir, 'x.js'), 'throw new Error("x")')
  fs.writeFileSync(path.join(badDir, 'y.js'), 'throw new Error("y")')
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

fs.rmSync(fixtureDir, { recursive: true, force: true })

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILED')
process.exit(failures === 0 ? 0 : 1)
