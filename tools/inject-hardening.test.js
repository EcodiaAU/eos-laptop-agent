'use strict'

// Unit tests for the 2026-08-03 routing-reliability hardening:
//   - inject-lock: cross-process mutex (acquire / timeout / stale-break / release)
//   - verifyActiveIsTarget: the guard that makes a misroute impossible
// No live IDE: verify is exercised by stubbing ide.tabs. The lock uses a real
// (sandboxed) temp path.
//
// Run: node tools/inject-hardening.test.js

const os = require('os')
const path = require('path')
process.env.EOS_INJECT_LOCK = path.join(os.tmpdir(), 'eos-inject-test-' + process.pid + '.lock')
process.env.EOS_INJECT_LOCK_STALE_MS = '500'

const lock = require('./inject-lock')
const ide = require('./ide')
const ci = require('./chat-inject')

let passed = 0
function ok(name, cond) {
  if (!cond) { console.error('FAIL: ' + name); process.exitCode = 1 }
  else { passed++; console.log('ok - ' + name) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ide.tabs stub -> one editor group, tabs with an active flag.
const CC = 'mainThreadWebview-claudeVSCodePanel'
function stubTabs(list) {
  ide.tabs = async () => ({
    groups: [{ viewColumn: 1, tabs: list.map((t, i) => ({ label: t.label, index: i, isActive: !!t.active, viewType: CC })) }],
  })
}

;(async () => {
  // ── verifyActiveIsTarget ────────────────────────────────────────────────
  stubTabs([{ label: 'Studio' }, { label: 'Coord.send_message', active: true }, { label: 'Chambers' }])
  ok('verify: active label matches target -> ok', (await ci.verifyActiveIsTarget('Coord.send_message', 1, 1)).ok === true)
  const miss = await ci.verifyActiveIsTarget('Studio', 1, 0)
  ok('verify: target NOT active -> not ok (this is the misroute guard)', miss.ok === false && miss.active_label === 'Coord.send_message')

  // generic label falls back to exact position
  stubTabs([{ label: 'Claude Code' }, { label: 'Claude Code', active: true }, { label: 'X' }])
  ok('verify: generic label + correct position -> ok', (await ci.verifyActiveIsTarget('Claude Code', 1, 1)).ok === true)
  ok('verify: generic label + wrong position -> not ok', (await ci.verifyActiveIsTarget('Claude Code', 1, 0)).ok === false)

  // no active tab -> not ok (never paste into nothing)
  stubTabs([{ label: 'A' }, { label: 'B' }])
  ok('verify: no active tab -> not ok', (await ci.verifyActiveIsTarget('A', 1, 0)).ok === false)

  // ── inject-lock ─────────────────────────────────────────────────────────
  const a = await lock.acquire({ timeoutMs: 1000, who: 'test-a' })
  ok('lock: first acquire succeeds', a.ok === true)

  const b = await lock.acquire({ timeoutMs: 250, who: 'test-b' })
  ok('lock: second acquire times out while held (no double-hold)', b.ok === false && b.reason === 'lock_timeout')

  lock.release(a.token)
  const c = await lock.acquire({ timeoutMs: 1000, who: 'test-c' })
  ok('lock: re-acquire succeeds after release', c.ok === true)

  // stale break: hold, wait past STALE_MS, a new acquirer breaks it
  await sleep(650) // > 500ms STALE_MS; c is now stale
  const d = await lock.acquire({ timeoutMs: 2000, who: 'test-d' })
  ok('lock: stale holder (dead mid-inject) is broken and re-acquired', d.ok === true)
  lock.release(d.token)

  console.log('\n' + passed + ' checks passed')
  if (process.exitCode) { console.error('\nSOME CHECKS FAILED'); process.exit(1) }
})().catch((e) => { console.error('THREW', e); process.exit(1) })
