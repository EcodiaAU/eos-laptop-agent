'use strict'
// tools/vault/run-daemon.js - boot the PRODUCTION vault daemon.
// Secure-Enclave keystore + SQLite store + real CDP fill/tab-verify, loopback only.
// This is the whole thing wired: the conductor's only reach is
//   POST 127.0.0.1:<port>/submit_2fa {service, cdp_session_ref} -> {status}
// and it never gets a code back. Usage: node run-daemon.js [port]
const path = require('path')
const { createDaemon } = require('./vault-daemon')
const { createSeedStore } = require('./seed-store')
const { createKeystore, secureEnclaveBackend } = require('./keystore')
const { createBudget } = require('./budget')
const { makeVerifyTab } = require('./verify-tab')
const { readTab, makeFill } = require('./cdp-adapter')

const PORT = parseInt(process.argv[2] || '7788', 10)
const VAULT_DB = path.join(require('os').homedir(), 'PRIVATE', 'ecodia-creds', 'vault', 'vault.db')

const se = secureEnclaveBackend({})
if (!se.provisioned) { console.error('FATAL: Secure Enclave key not provisioned'); process.exit(1) }

const store = createSeedStore({ keystore: createKeystore({ backend: se }), dbPath: VAULT_DB })
const budget = createBudget({
  onFreeze: (service, reason) => console.error(`[vault] FROZEN ${service}: ${reason} (fail-closed; manual clear required)`),
})

const d = createDaemon({
  store,
  budget,
  verifyTab: makeVerifyTab(readTab),   // daemon reads the live tab itself
  fill: makeFill({}),                  // daemon types the code; never returns it
})

const server = d.listen(PORT, () => {
  const a = server.address()
  console.log(JSON.stringify({
    vault: 'up',
    bind: a.address + ':' + a.port,
    keystore: se.id,
    enrolled: store.loadRegistry().map(r => `${r.service}[${r.tier}]`),
  }))
})

const shutdown = () => { try { server.close() } catch (_e) {} try { store.close() } catch (_e) {} process.exit(0) }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown)
