'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { resolveService, requiresApproval, normalizeService, TIERS } = require('./registry')

const REG = [
  { seed_id: 's1', service: 'github', tier: 'OPEN', backend: 'totp', registered_origin: 'https://github.com', registered_account: 'code@ecodia.au' },
  { seed_id: 's2', service: 'google-code', tier: 'OPEN', backend: 'totp', registered_origin: 'https://accounts.google.com', registered_account: 'code@ecodia.au' },
  // tate@ Google moved GATED -> OPEN on 2026-08-02 (Tate, for the account-switch
  // rebuild): tate@ is one of the three live Claude Max accounts, and a headless switch
  // onto it has to satisfy a Google 2FA prompt with no human present. Bank Australia is
  // now the only crown jewel.
  { seed_id: 's3', service: 'google-tate', tier: 'OPEN', backend: 'totp', registered_origin: 'https://accounts.google.com', registered_account: 'tate@ecodia.au' },
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

test('tate@ and code@ Google are separate rows, both mintable since 2026-08-02', () => {
  assert.strictEqual(resolveService('google-code', REG).tier, 'OPEN')
  assert.strictEqual(resolveService('google-tate', REG).tier, 'OPEN')
  assert.notStrictEqual(resolveService('google-code', REG).seed_id, resolveService('google-tate', REG).seed_id)
})

test('GATED service demands approval at the single choke point', () => {
  assert.strictEqual(requiresApproval(resolveService('bank-australia', REG)), true)
  assert.strictEqual(requiresApproval(resolveService('google-tate', REG)), false)
  assert.strictEqual(requiresApproval(resolveService('github', REG)), false)
})

test('a GATED-domain account mis-tagged OPEN is refused (belt-and-braces)', () => {
  // The safety net now guards Bank Australia only; tate@ Google is a legitimate OPEN row.
  const evil = [{ seed_id: 'sE', service: 'sneaky', tier: 'OPEN', backend: 'totp', registered_account: 'tate BankAustralia login' }]
  const r = resolveService('sneaky', evil)
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.reason, 'gated-domain-account-tagged-open-refused')
})

test('tate@ Google is NOT caught by the gated-domain safety net any more', () => {
  const row = [{ seed_id: 'sT', service: 'google-tate', tier: 'OPEN', backend: 'totp', registered_account: 'tate@ecodia.au' }]
  const r = resolveService('google-tate', row)
  assert.strictEqual(r.ok, true, 'tate@ Google resolves OPEN so the headless switch can mint its 2FA code')
  assert.strictEqual(requiresApproval(r), false)
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
