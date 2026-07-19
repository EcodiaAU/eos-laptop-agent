'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { resolveService, requiresApproval, normalizeService, TIERS } = require('./registry')

const REG = [
  { seed_id: 's1', service: 'github', tier: 'OPEN', backend: 'totp', registered_origin: 'https://github.com', registered_account: 'code@ecodia.au' },
  { seed_id: 's2', service: 'google-code', tier: 'OPEN', backend: 'totp', registered_origin: 'https://accounts.google.com', registered_account: 'code@ecodia.au' },
  { seed_id: 's3', service: 'google-tate', tier: 'GATED', backend: 'totp', registered_origin: 'https://accounts.google.com', registered_account: 'tate@ecodia.au' },
  { seed_id: 's4', service: 'bank-australia', tier: 'GATED', backend: 'email_otp', registered_origin: 'https://bankaust.com.au', registered_account: 'tate BankAust' },
]

test('exact normalized match resolves to one seed', () => {
  const r = resolveService('GitHub', REG)
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.seed_id, 's1')
  assert.strictEqual(r.tier, 'OPEN')
})

test('default-DENY on zero match', () => {
  const r = resolveService('dropbox', REG)
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.reason, 'no-match-default-deny')
})

test('default-DENY on ambiguous multiple match', () => {
  const dup = REG.concat([{ seed_id: 'sX', service: 'github', tier: 'OPEN', backend: 'totp', registered_account: 'other' }])
  const r = resolveService('github', dup)
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.reason, 'ambiguous-multiple-match-deny')
})

test('tate@ and code@ Google are separate rows with independent tiers', () => {
  assert.strictEqual(resolveService('google-code', REG).tier, 'OPEN')
  assert.strictEqual(resolveService('google-tate', REG).tier, 'GATED')
})

test('GATED service demands approval at the single choke point', () => {
  assert.strictEqual(requiresApproval(resolveService('google-tate', REG)), true)
  assert.strictEqual(requiresApproval(resolveService('bank-australia', REG)), true)
  assert.strictEqual(requiresApproval(resolveService('github', REG)), false)
})

test('a GATED-domain account mis-tagged OPEN is refused (belt-and-braces)', () => {
  const evil = [{ seed_id: 'sE', service: 'sneaky', tier: 'OPEN', backend: 'totp', registered_account: 'tate@ecodia.au' }]
  const r = resolveService('sneaky', evil)
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.reason, 'gated-domain-account-tagged-open-refused')
})

test('bank account mis-tagged OPEN is refused', () => {
  const evil = [{ seed_id: 'sB', service: 'notbank', tier: 'OPEN', backend: 'totp', registered_account: 'tate BankAust login' }]
  assert.strictEqual(resolveService('notbank', evil).reason, 'gated-domain-account-tagged-open-refused')
})

test('EXCLUDED tier never resolves', () => {
  const ex = [{ seed_id: 'sA', service: 'apple-id-tate', tier: 'EXCLUDED', backend: 'totp', registered_account: 'tate appleid' }]
  assert.strictEqual(resolveService('apple-id-tate', ex).ok, false)
})

test('invalid tier or backend denies', () => {
  assert.strictEqual(resolveService('x', [{ seed_id: '1', service: 'x', tier: 'SUPER', backend: 'totp' }]).reason, 'invalid-tier')
  assert.strictEqual(resolveService('y', [{ seed_id: '2', service: 'y', tier: 'OPEN', backend: 'magic' }]).reason, 'invalid-backend')
})

test('normalization collapses spaces/underscores/case consistently', () => {
  assert.strictEqual(normalizeService('Google_Code'), normalizeService('google code'))
  assert.strictEqual(normalizeService('  GitHub '), 'github')
})
