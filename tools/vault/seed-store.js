'use strict'
// tools/vault/seed-store.js - SQLite persistence for the vault (node:sqlite,
// zero-dep, matches schema.sql). Composes the keystore: seeds and backup codes
// are SEALED before they touch the DB, so vault.db holds only ciphertext (red-team
// T3: no plaintext at rest; in production the keystore is Secure-Enclave-rooted).
// enroll() parses an otpauth:// URI (daemon-side, out-of-band), seals the secret,
// and writes the row + the immutable tier. loadSeed() opens the ciphertext INSIDE
// the daemon; the plaintext never leaves. Design spec: docs/security/2fa-...md s4/s9.
const { DatabaseSync } = require('node:sqlite')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const totp = require('./totp')
const { normalizeService, TIERS } = require('./registry')

const SCHEMA = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8')

function createSeedStore(opts) {
  opts = opts || {}
  if (!opts.keystore) throw new Error('createSeedStore: keystore required')
  const ks = opts.keystore
  const db = new DatabaseSync(opts.dbPath || ':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(SCHEMA)

  // enroll - parse otpauth (or take an explicit secret), seal it, store the row.
  // tier is written ONCE here and is immutable at the DB layer (schema trigger).
  // opts: { service, tier, backend, otpauthUri?|secret?, registered_origin,
  //         registered_account, enrolled_under_presence?, is_secondary? }
  function enroll(row) {
    const service = normalizeService(row.service)
    if (!Object.values(TIERS).includes(row.tier)) throw new Error('enroll: invalid tier ' + row.tier)
    let secret = row.secret, algorithm = row.algorithm || 'sha1', digits = row.digits || 6, period = row.period || 30
    let registered_account = row.registered_account
    if (row.otpauthUri) {
      const p = totp.parseOtpauth(row.otpauthUri)
      secret = p.secret; algorithm = p.algorithm; digits = p.digits; period = p.period
      if (!registered_account && p.account) registered_account = p.account
    }
    // GATED seeds must be enrolled under live human presence (red-team T4/enrollment).
    if (row.tier === TIERS.GATED && !row.enrolled_under_presence) {
      throw new Error('enroll: a GATED seed requires enrolled_under_presence=true (out-of-band, human present)')
    }
    const seed_id = crypto.randomUUID()
    const sealed = (secret != null) ? Buffer.from(ks.seal(secret), 'utf8') : null
    db.prepare(`INSERT INTO vault_seed
      (seed_id, service, tier, backend, registered_origin, registered_account, seed_ciphertext, algorithm, digits, period, enrolled_under_presence, is_secondary)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      seed_id, service, row.tier, row.backend, row.registered_origin || null, registered_account || null,
      sealed, algorithm, digits, period, row.enrolled_under_presence ? 1 : 0, row.is_secondary ? 1 : 0)
    return seed_id
  }

  // loadRegistry - the non-secret rows for registry.resolveService().
  function loadRegistry() {
    return db.prepare(`SELECT seed_id, service, tier, backend, registered_origin, registered_account FROM vault_seed`).all()
  }

  // loadSeed - open the sealed secret INSIDE the daemon. Returns null if absent.
  function loadSeed(seed_id) {
    const r = db.prepare(`SELECT seed_ciphertext, algorithm, digits, period FROM vault_seed WHERE seed_id=?`).get(seed_id)
    if (!r || !r.seed_ciphertext) return null
    const secret = ks.open(Buffer.from(r.seed_ciphertext).toString('utf8'))
    return { secret, algorithm: r.algorithm, digits: r.digits, period: r.period }
  }

  function addBackupCodes(seed_id, codes) {
    const ins = db.prepare(`INSERT INTO vault_backup_code (seed_id, code_ciphertext, state) VALUES (?,?, 'unused')`)
    for (const c of codes) ins.run(seed_id, Buffer.from(ks.seal(String(c)), 'utf8'))
  }

  function audit(ev) {
    db.prepare(`INSERT INTO vault_audit (service, tier, backend, event, detail) VALUES (?,?,?,?,?)`)
      .run(ev.service || null, ev.tier || null, ev.backend || null, ev.event, ev.detail || null)
  }
  function auditTail(n) { return db.prepare(`SELECT service, event, detail FROM vault_audit ORDER BY id DESC LIMIT ?`).all(n || 20) }

  function close() { db.close() }
  return { enroll, loadRegistry, loadSeed, addBackupCodes, audit, auditTail, close, _db: db }
}

module.exports = { createSeedStore }
