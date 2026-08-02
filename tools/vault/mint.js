#!/usr/bin/env node
'use strict'
// tools/vault/mint.js - the ONE braindead-simple interactive TOTP mint.
//
// WHY THIS EXISTS: fresh chats repeatedly struggled to mint a 2FA code (e.g. the
// EcodiaTate GitHub authenticator prompt) because the SessionStart roster named
// the capability + the enrolled seeds but handed over NO command, so each chat
// had to re-derive the SE-keystore -> seed-store -> totp composition and the ones
// that got it slightly wrong asked Tate to log in - the exact failure the
// you-can-log-in doctrine exists to kill. Origin: Tate 2026-07-29 ("another chat
// trying to get the ecodiatate github 2fa code is struggling ... the hook isnt
// firing well enough"). Now every chat runs ONE line:
//
//     node /Users/ecodia/.code/eos-laptop-agent/tools/vault/mint.js github-tate
//
// and gets the 6 digits on stdout, nothing else. Then cdp.nativeFill it into the
// authenticator prompt on canonical Chrome (9222).
//
// SECURITY: routes through registry.resolveService, so it inherits the tier
// model unchanged - it mints OPEN seeds only and REFUSES GATED (Bank Australia)
// and EXCLUDED, regardless of what the caller types. (tate@ Google was GATED
// until 2026-08-02; Tate ungated it so the headless account switch can satisfy
// its 2FA prompt unattended.) It prints
// ONLY the code (never the seed, never the otpauth secret). This is the
// interactive-conductor path; the hardened daemon (submit-2fa.js) that fills a
// verified tab and never returns a code remains the automated path.
const path = require('path')
const os = require('os')
const registry = require('./registry')
const totp = require('./totp')
const { createKeystore, secureEnclaveBackend } = require('./keystore')
const { createSeedStore } = require('./seed-store')

const VAULT_DB = path.join(os.homedir(), 'PRIVATE', 'ecodia-creds', 'vault', 'vault.db')

function die(msg, code) {
  process.stderr.write(msg + '\n')
  process.exit(code == null ? 1 : code)
}

function openStore() {
  const se = secureEnclaveBackend({})
  return createSeedStore({ keystore: createKeystore({ backend: se }), dbPath: VAULT_DB })
}

function listOpen(store) {
  return store.loadRegistry()
    .map(r => ({ ...r, res: registry.resolveService(r.service, store.loadRegistry()) }))
    .filter(r => r.res.ok && r.res.tier === 'OPEN')
    .map(r => `  ${r.service}  (${r.registered_account || '?'})`)
    .join('\n')
}

function main() {
  const service = (process.argv[2] || '').trim()
  let store
  try { store = openStore() } catch (e) {
    return die('[vault mint] cannot open the vault: ' + e.message +
      '\n  vault.db expected at ' + VAULT_DB +
      '\n  if the Secure Enclave is not provisioned: tools/vault/se/eos-vault-se provision <keyfile>')
  }

  if (!service || service === '--list' || service === '-l') {
    process.stderr.write('[vault mint] usage: node tools/vault/mint.js <service>\n' +
      'enrolled OPEN services (mintable now):\n' + (listOpen(store) || '  (none)') + '\n')
    process.exit(service ? 0 : 2)
  }

  const rows = store.loadRegistry()
  const r = registry.resolveService(service, rows)
  if (!r.ok) {
    return die('[vault mint] refused "' + service + '": ' + r.reason +
      '\n  (GATED accounts - Bank Australia - are login-only + Tate-gated by design.)' +
      '\nenrolled OPEN services:\n' + (listOpen(store) || '  (none)'))
  }
  if (r.tier !== 'OPEN') {
    return die('[vault mint] refused "' + service + '": tier=' + r.tier +
      ' is not mintable on the interactive path (GATED/EXCLUDED are out-of-band).')
  }

  const seed = store.loadSeed(r.seed_id)
  if (!seed || !seed.secret) return die('[vault mint] no seed material for "' + service + '" (enrollment incomplete).')

  // NB: totp()/verify() read opts.step, not opts.period - map it so a future
  // seed with period != 30 mints correctly instead of silently defaulting to 30.
  const code = totp.totp(seed.secret, { algorithm: seed.algorithm, digits: seed.digits, step: seed.period })
  process.stdout.write(code + '\n')
}

main()
