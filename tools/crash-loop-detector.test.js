// crash-loop-detector.test.js - proves the boot crash-loop detector (2026-08-13
// survival hardening): N boots inside a window fire EXACTLY ONE page, isolated
// restarts never trip, and a cooldown rate-limits paging while the loop persists.
// The pager is injected so this test NEVER texts Tate.
//
// Run: node tools/crash-loop-detector.test.js   (exit 0 = pass, non-zero = fail)
'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { recordBootAndDetect } = require('../lib/crash-loop-detector')

let failures = 0
function ok(name, fn) {
  try { fn(); console.log('  ok - ' + name) }
  catch (e) { failures++; console.error('  FAIL - ' + name + ': ' + (e && e.message || e)) }
}

function tmpPaths() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crashloop-'))
  return {
    dir,
    historyPath: path.join(dir, 'boot-history.json'),
    stampPath: path.join(dir, 'crashloop-page.stamp'),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  }
}

const OPTS = { windowMs: 5 * 60 * 1000, threshold: 5, cooldownMs: 30 * 60 * 1000 }

// ── 1. isolated restarts (spread out) never trip ──────────────────────────────
ok('boots spread beyond the window never trip', () => {
  const p = tmpPaths()
  const paged = []
  let t = 1_000_000
  for (let i = 0; i < 6; i++) {
    // each boot 10 min apart -> only ever 1 inside a 5 min window
    const r = recordBootAndDetect({ ...OPTS, ...p, now: t, pager: (m) => paged.push(m) })
    assert.strictEqual(r.tripped, false, 'boot ' + i + ' must not trip')
    t += 10 * 60 * 1000
  }
  assert.strictEqual(paged.length, 0, 'no page for spread-out restarts')
  p.cleanup()
})

// ── 2. a rapid crash-loop fires EXACTLY ONE page ──────────────────────────────
ok('5 boots in the window fire exactly one page', () => {
  const p = tmpPaths()
  const paged = []
  let t = 2_000_000
  const results = []
  for (let i = 0; i < 5; i++) {
    results.push(recordBootAndDetect({ ...OPTS, ...p, now: t, pager: (m) => paged.push(m) }))
    t += 10 * 1000 // ~10s apart, the ThrottleInterval cadence
  }
  // boots 1-4 below threshold, boot 5 trips + pages.
  assert.strictEqual(results[3].tripped, false, '4th boot below threshold')
  assert.strictEqual(results[4].tripped, true, '5th boot trips')
  assert.strictEqual(results[4].paged, true, '5th boot pages')
  assert.strictEqual(paged.length, 1, 'exactly ONE page')
  assert.ok(/CRASH-LOOP/.test(paged[0]), 'message names the crash-loop')
  // No em-dash in the page text.
  assert.ok(!paged[0].includes(String.fromCharCode(0x2014)), 'no em-dash in page')
  p.cleanup()
})

// ── 3. cooldown: continued looping does NOT spam ──────────────────────────────
ok('cooldown rate-limits paging while the loop continues', () => {
  const p = tmpPaths()
  const paged = []
  let t = 3_000_000
  // 5 quick boots -> one page.
  for (let i = 0; i < 5; i++) { recordBootAndDetect({ ...OPTS, ...p, now: t, pager: (m) => paged.push(m) }); t += 10 * 1000 }
  assert.strictEqual(paged.length, 1, 'one page at trip')
  // 5 more boots still inside the window, still tripped, but inside cooldown.
  for (let i = 0; i < 5; i++) { const r = recordBootAndDetect({ ...OPTS, ...p, now: t, pager: (m) => paged.push(m) }); assert.ok(r.tripped, 'still tripped'); t += 10 * 1000 }
  assert.strictEqual(paged.length, 1, 'no additional page inside cooldown (no spam)')
  p.cleanup()
})

// ── 4. after cooldown elapses, a persistent loop pages again ──────────────────
ok('a loop persisting past the cooldown pages again', () => {
  const p = tmpPaths()
  const paged = []
  let t = 4_000_000
  for (let i = 0; i < 5; i++) { recordBootAndDetect({ ...OPTS, ...p, now: t, pager: (m) => paged.push(m) }); t += 10 * 1000 }
  assert.strictEqual(paged.length, 1)
  // Jump past the cooldown; the loop is still hot (boots keep landing in-window
  // relative to each new now). Use a short window relative to the cooldown jump
  // by keeping boots close together after the jump.
  t += OPTS.cooldownMs + 60 * 1000
  for (let i = 0; i < 5; i++) { recordBootAndDetect({ ...OPTS, ...p, now: t, pager: (m) => paged.push(m) }); t += 10 * 1000 }
  assert.strictEqual(paged.length, 2, 'a second page after the cooldown elapses')
  p.cleanup()
})

// ── 5. the detector never throws on a corrupt history file ────────────────────
ok('corrupt history file is non-fatal', () => {
  const p = tmpPaths()
  fs.writeFileSync(p.historyPath, 'not json {{{')
  const paged = []
  const r = recordBootAndDetect({ ...OPTS, ...p, now: 5_000_000, pager: (m) => paged.push(m) })
  assert.strictEqual(r.boots, 1, 'corrupt history treated as empty, this boot counted')
  assert.strictEqual(r.tripped, false)
  p.cleanup()
})

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILED')
process.exit(failures === 0 ? 0 : 1)
