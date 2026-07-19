'use strict'
// tools/vault/pair.js - host side of phone pairing + the host->phone decrypt proof.
// The phone's self-test copies a pairing bundle {keyAgreement, signing, sas} to the
// clipboard; Tate relays it. This stores the phone's real public keys, verifies the
// SAS (out-of-band, catches a MITM key swap), and can seal a test marker to the phone
// key -> an eosvault://test deep link the phone opens behind Face ID. That proves the
// host can seal to the REAL phone Secure Enclave key and only that phone can open it.
//   node pair.js store  '<pairing-bundle-json>'
//   node pair.js seal   '<marker text>'  '<origin>'
//   node pair.js show
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { sealTo } = require('./envelope')

const STORE = path.join(require('os').homedir(), 'PRIVATE', 'ecodia-creds', 'vault', 'phone-pairing.json')

function sasOf(kaB64, sgB64) {
  return crypto.createHash('sha256').update(kaB64 + '|' + sgB64).digest('hex').slice(0, 8).toUpperCase()
}

function store(bundleJson) {
  const b = JSON.parse(bundleJson)
  if (!b.keyAgreement || !b.signing) throw new Error('bundle needs keyAgreement + signing')
  const sas = sasOf(b.keyAgreement, b.signing)
  const match = b.sas ? (sas === String(b.sas).toUpperCase()) : null
  fs.mkdirSync(path.dirname(STORE), { recursive: true, mode: 0o700 })
  fs.writeFileSync(STORE, JSON.stringify({ ...b, hostSas: sas, storedAt: new Date().toISOString() }, null, 2), { mode: 0o600 })
  return { hostSas: sas, phoneSas: b.sas || null, sasMatch: match }
}

function toUrlB64(b64) { return b64.replace(/\+/g, '-').replace(/\//g, '_') }

function seal(marker, origin) {
  const p = JSON.parse(fs.readFileSync(STORE, 'utf8'))
  const blob = sealTo(p.keyAgreement, marker, origin)     // ECIES + origin AAD to the phone key
  const url = `eosvault://test?blob=${encodeURIComponent(toUrlB64(blob))}&origin=${encodeURIComponent(origin)}`
  return { url, origin, markerLen: marker.length }
}

const [cmd, a1, a2] = process.argv.slice(2)
try {
  if (cmd === 'store') { console.log(JSON.stringify(store(a1), null, 2)) }
  else if (cmd === 'seal') { console.log(JSON.stringify(seal(a1 || 'Hello from Ecodia, sealed to your phone', a2 || 'eos://selftest'), null, 2)) }
  else if (cmd === 'show') { console.log(fs.existsSync(STORE) ? fs.readFileSync(STORE, 'utf8') : '(not paired yet)') }
  else console.log('usage: pair.js store <bundle-json> | seal <marker> <origin> | show')
} catch (e) { console.error('ERR', e.message); process.exit(1) }
