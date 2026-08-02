'use strict'
// Tests for the roster. Every case here is a failure this system has actually suffered,
// not a hypothetical: the stale-flag stranding (2026-06-22 tate@), the four-site env
// drift, and the "a disable is temporary but nothing ever re-checks it" shape.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const os = require('os')

const reg = require('./accounts-registry')

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acctreg-'))
  return { file: path.join(dir, 'accounts-registry.json'), lastGoodFile: path.join(dir, 'accounts-registry.json.last-good'), dir }
}

test('missing file bootstraps all-enabled and says so', () => {
  const s = sandbox()
  const r = reg.read(s)
  assert.strictEqual(r.source, 'bootstrap')
  assert.deepStrictEqual(Object.keys(r.registry.accounts).sort(), ['code', 'money', 'tate'])
  assert.ok(r.alarms.some(a => /MISSING/.test(a)), 'bootstrap alarms')
  assert.ok(fs.existsSync(s.file), 'bootstrap persisted')
  assert.deepStrictEqual(reg.enabled(s).sort(), ['code', 'money', 'tate'])
})

test('tate@ is enabled by default (the 2026-06-22 stale-disable is gone)', () => {
  const s = sandbox()
  assert.ok(reg.enabled(s).includes('tate'))
  assert.deepStrictEqual(reg.disabledEmails(s), [])
})

test('a disable without a reason is REFUSED', () => {
  const s = sandbox()
  const r = reg.disable('code', Object.assign({ expires_at: new Date(Date.now() + 3600e3).toISOString() }, s))
  assert.strictEqual(r.ok, false)
  assert.match(r.reason, /needs a reason/)
})

test('a disable without an expiry is REFUSED (the stranding guard)', () => {
  const s = sandbox()
  const r = reg.disable('code', Object.assign({ reason: 'testing' }, s))
  assert.strictEqual(r.ok, false)
  assert.match(r.reason, /disabled_expires_at/)
})

test('a well-formed disable is honored and hides the account', () => {
  const s = sandbox()
  const r = reg.disable('money', Object.assign({ reason: 'subscription paused', expires_at: new Date(Date.now() + 3600e3).toISOString(), by: 'test' }, s))
  assert.strictEqual(r.ok, true)
  assert.ok(!reg.enabled(s).includes('money'))
  assert.ok(reg.disabledEmails(s).includes('money@ecodia.au'), 'legacy email form is emitted for the ACCOUNTS_DISABLED consumers')
})

test('an EXPIRED disable re-enables itself and alarms (tate@ 2026-06-22 shape)', () => {
  const s = sandbox()
  reg.read(s)
  const raw = JSON.parse(fs.readFileSync(s.file, 'utf8'))
  raw.accounts.tate.enabled = false
  raw.accounts.tate.disabled_reason = 'subscription paused'
  raw.accounts.tate.disabled_expires_at = new Date(Date.now() - 60e3).toISOString()
  fs.writeFileSync(s.file, JSON.stringify(raw))
  const r = reg.read(s)
  assert.strictEqual(r.registry.accounts.tate.enabled, true, 'expired disable does not survive')
  assert.ok(r.alarms.some(a => /EXPIRED/.test(a)), 'the re-enable is visible, not silent')
  assert.ok(reg.enabled(s).includes('tate'))
})

test('a malformed disable is HONORED but alarms every read (operator intent wins)', () => {
  const s = sandbox()
  reg.read(s)
  const raw = JSON.parse(fs.readFileSync(s.file, 'utf8'))
  raw.accounts.code.enabled = false          // no reason, no expiry: exactly the old env-flag shape
  fs.writeFileSync(s.file, JSON.stringify(raw))
  const r = reg.read(s)
  assert.strictEqual(r.registry.accounts.code.enabled, false, 'a deliberate disable is not silently revoked')
  assert.ok(r.alarms.some(a => /no reason and\/or no expiry/.test(a)), 'but it screams on every read')
})

test('a corrupt file falls back to .last-good', () => {
  const s = sandbox()
  reg.read(s)
  reg.enable('tate', Object.assign({ by: 'test' }, s))   // a successful mutate writes .last-good
  assert.ok(fs.existsSync(s.lastGoodFile))
  fs.writeFileSync(s.file, '{ this is not json')
  const r = reg.read(s)
  assert.ok(r.alarms.some(a => /CORRUPT/.test(a)))
  assert.ok(r.alarms.some(a => /last-good/.test(a)))
  assert.deepStrictEqual(Object.keys(r.registry.accounts).sort(), ['code', 'money', 'tate'])
})

test('a corrupt file with no .last-good still yields a usable all-enabled roster', () => {
  const s = sandbox()
  fs.mkdirSync(path.dirname(s.file), { recursive: true })
  fs.writeFileSync(s.file, 'not json at all')
  const r = reg.read(s)
  assert.strictEqual(r.source, 'corrupt-default')
  assert.deepStrictEqual(reg.enabled(s).sort(), ['code', 'money', 'tate'], 'fail-open: stranding is the worse failure')
})

test('a corrupt-file parse error never carries file content into an alarm', () => {
  const s = sandbox()
  fs.mkdirSync(path.dirname(s.file), { recursive: true })
  fs.writeFileSync(s.file, '{"secret":"hunter2-should-never-appear",')
  const r = reg.read(s)
  assert.ok(!r.alarms.join(' ').includes('hunter2'), 'JSON.parse errors quote their input; the alarm must not')
})

test('snapshot_state is advisory and never removes an account from the roster', () => {
  const s = sandbox()
  reg.read(s)
  reg.markSnapshot('code', 'dead', 'invalid_grant', Object.assign({ by: 'test' }, s))
  assert.strictEqual(reg.get('code', s).snapshot_state, 'dead')
  assert.ok(reg.enabled(s).includes('code'), 'a dead snapshot must NOT block switching - a full re-login needs no snapshot')
})

test('switch results accumulate and reset', () => {
  const s = sandbox()
  reg.read(s)
  reg.recordSwitchResult('money', false, 'no magic link', Object.assign({ by: 'test' }, s))
  reg.recordSwitchResult('money', false, 'no magic link', Object.assign({ by: 'test' }, s))
  assert.strictEqual(reg.get('money', s).consecutive_switch_failures, 2)
  reg.recordSwitchResult('money', true, null, Object.assign({ by: 'test' }, s))
  assert.strictEqual(reg.get('money', s).consecutive_switch_failures, 0)
  assert.ok(reg.get('money', s).last_switch_ok_at)
})

test('identity fields persist for the usage probe org-header corroboration', () => {
  const s = sandbox()
  reg.read(s)
  reg.setIdentity('code', { org_uuid: 'org-abc', account_uuid: 'acct-def' }, Object.assign({ by: 'test' }, s))
  assert.strictEqual(reg.get('code', s).org_uuid, 'org-abc')
  assert.strictEqual(reg.get('code', s).account_uuid, 'acct-def')
})

test('login methods and mirrors match the live fleet', () => {
  const s = sandbox()
  const r = reg.read(s)
  assert.strictEqual(r.registry.accounts.tate.login_method, 'google-sso')
  assert.strictEqual(r.registry.accounts.code.login_method, 'google-sso')
  assert.strictEqual(r.registry.accounts.money.login_method, 'magic-link', 'money@ is a tate@ alias: its Claude login is a magic link, not SSO')
  assert.strictEqual(r.registry.accounts.money.pw_mirror, null)
  assert.strictEqual(r.registry.accounts.code.pw_mirror_provenance, 'kv', 'code@ mirror is regenerable from kv_store')
  assert.strictEqual(r.registry.accounts.tate.pw_mirror_provenance, 'local-only', 'tate@ has no kv key: a rotation needs Tate')
})

test('unknown account mutations are refused, not silently ignored', () => {
  const s = sandbox()
  reg.read(s)
  const r = reg.enable('nobody', Object.assign({ by: 'test' }, s))
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.reason, 'unknown-account')
})
