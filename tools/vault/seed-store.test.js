'use strict'
const test = require('node:test')
const assert = require('node:assert')
const crypto = require('crypto')
const { createSeedStore } = require('./seed-store')
const { createKeystore } = require('./keystore')
const { resolveService } = require('./registry')

function store() { return createSeedStore({ keystore: createKeystore({ key32: crypto.randomBytes(32) }) }) }
const OTPAUTH = 'otpauth://totp/GitHub:code@ecodia.au?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=GitHub&algorithm=SHA1&digits=6&period=30'

test('enroll from otpauth stores ciphertext only, loadSeed opens it', () => {
  const s = store()
  const id = s.enroll({ service: 'github', tier: 'OPEN', backend: 'totp', otpauthUri: OTPAUTH, registered_origin: 'https://github.com' })
  // DB holds ciphertext, not the plaintext secret
  const raw = s._db.prepare('SELECT seed_ciphertext FROM vault_seed WHERE seed_id=?').get(id)
  const rawStr = Buffer.from(raw.seed_ciphertext).toString('utf8')
  assert.doesNotMatch(rawStr, /GEZDGNBVGY3TQOJQ/)
  // loadSeed opens it inside the daemon
  const seed = s.loadSeed(id)
  assert.strictEqual(seed.secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')
  assert.strictEqual(seed.digits, 6)
  s.close()
})

test('loadRegistry feeds resolveService and normalizes the service key', () => {
  const s = store()
  s.enroll({ service: 'GitHub', tier: 'OPEN', backend: 'totp', otpauthUri: OTPAUTH, registered_account: 'code@ecodia.au' })
  const r = resolveService('github', s.loadRegistry())
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.tier, 'OPEN')
  s.close()
})

test('tier is immutable at the DB layer after enroll', () => {
  const s = store()
  const id = s.enroll({ service: 'vercel', tier: 'OPEN', backend: 'totp', secret: 'GEZDGNBVGY3TQOJQ' })
  assert.throws(() => s._db.prepare("UPDATE vault_seed SET tier='GATED' WHERE seed_id=?").run(id), /immutable/)
  s.close()
})

test('a GATED enroll without human presence is refused', () => {
  const s = store()
  assert.throws(() => s.enroll({ service: 'bank-australia', tier: 'GATED', backend: 'totp', secret: 'X' }), /enrolled_under_presence/)
  // with presence it succeeds
  const id = s.enroll({ service: 'bank-australia', tier: 'GATED', backend: 'totp', secret: 'GEZDGNBVGY3TQOJQ', enrolled_under_presence: true, registered_account: 'tate BankAust' })
  assert.ok(id)
  s.close()
})

test('backup codes are stored sealed', () => {
  const s = store()
  const id = s.enroll({ service: 'canva', tier: 'OPEN', backend: 'backup_code' })
  s.addBackupCodes(id, ['CODE-1111', 'CODE-2222'])
  const rows = s._db.prepare('SELECT code_ciphertext FROM vault_backup_code WHERE seed_id=?').all(id)
  assert.strictEqual(rows.length, 2)
  assert.doesNotMatch(Buffer.from(rows[0].code_ciphertext).toString('utf8'), /CODE-1111/)
  s.close()
})

test('audit writes and reads back', () => {
  const s = store()
  s.audit({ service: 'github', tier: 'OPEN', backend: 'totp', event: 'fill' })
  s.audit({ service: 'github', event: 'deny', detail: 'test' })
  const tail = s.auditTail(5)
  assert.strictEqual(tail.length, 2)
  assert.strictEqual(tail[0].event, 'deny')
  s.close()
})

test('loadSeed returns null for an unknown id', () => {
  const s = store()
  assert.strictEqual(s.loadSeed('nope'), null)
  s.close()
})
