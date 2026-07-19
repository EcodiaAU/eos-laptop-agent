'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { createBackupCodes } = require('./backup-codes')

const CODES = () => [{ id: 'c1', value: 'AAAA' }, { id: 'c2', value: 'BBBB' }, { id: 'c3', value: 'CCCC' }, { id: 'c4', value: 'DDDD' }]

test('lease then confirm consumes exactly one code', () => {
  const bc = createBackupCodes(CODES())
  const l = bc.lease()
  assert.strictEqual(l.id, 'c1')
  assert.strictEqual(bc.remaining(), 3)   // leased, not yet consumed -> still counts as not-unused
  bc.confirm('c1')
  assert.strictEqual(bc.remaining(), 3)
  assert.strictEqual(bc.snapshot().find(r => r.id === 'c1').state, 'consumed')
})

test('a missed fill re-offers the SAME code, never burns a new one', () => {
  const bc = createBackupCodes(CODES())
  const first = bc.lease()
  const retry = bc.lease()   // fill missed, daemon retries
  assert.strictEqual(retry.id, first.id)   // SAME code re-offered
  // only after release does the next lease advance
  bc.release(first.id)
  const next = bc.lease()
  assert.strictEqual(next.id, first.id)    // released back to unused, re-offered first
})

test('the drain bug is dead: N missed fills do NOT burn N codes', () => {
  const bc = createBackupCodes(CODES())
  for (let i = 0; i < 10; i++) bc.lease()   // 10 retries against a stuck vendor page
  // still only one code leased, three untouched
  const states = bc.snapshot()
  assert.strictEqual(states.filter(s => s.state === 'leased').length, 1)
  assert.strictEqual(states.filter(s => s.state === 'unused').length, 3)
  assert.strictEqual(states.filter(s => s.state === 'consumed').length, 0)
})

test('release returns a leased code to the pool', () => {
  const bc = createBackupCodes(CODES())
  const l = bc.lease()
  bc.release(l.id)
  assert.strictEqual(bc.snapshot().find(r => r.id === l.id).state, 'unused')
})

test('sequential logins consume codes in order', () => {
  const bc = createBackupCodes(CODES())
  for (const id of ['c1', 'c2']) { const l = bc.lease(); assert.strictEqual(l.id, id); bc.confirm(id) }
  assert.strictEqual(bc.remaining(), 2)
})

test('low-water alarm fires once when unused drops to threshold', () => {
  const lows = []
  const bc = createBackupCodes(CODES(), { lowWater: 2, onLow: (n) => lows.push(n) })
  bc.lease(); bc.confirm('c1')   // 3 unused, no alarm
  assert.strictEqual(lows.length, 0)
  bc.lease(); bc.confirm('c2')   // 2 unused -> alarm
  assert.strictEqual(lows.length, 1)
  assert.strictEqual(lows[0], 2)
  bc.lease(); bc.confirm('c3')   // 1 unused -> no second alarm (fires once)
  assert.strictEqual(lows.length, 1)
})

test('lease returns null when the set is exhausted', () => {
  const bc = createBackupCodes([{ id: 'only', value: 'X' }])
  bc.lease(); bc.confirm('only')
  assert.strictEqual(bc.lease(), null)
})

test('confirm/release on a non-leased id is a clean no-op error', () => {
  const bc = createBackupCodes(CODES())
  assert.strictEqual(bc.confirm('c1').ok, false)   // never leased
  assert.strictEqual(bc.release('c1').reason, 'not-leased')
})
