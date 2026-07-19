'use strict'
// tools/vault/inbox.js - the HOST end of the phone->host channel. The phone, after a
// vault login, scrapes ONLY the requested read-only data and posts a signed result
// message here; the host reads it. The host never receives the session or password -
// only the specific scraped datum it asked for (the "secure worker returns data, not
// keys" model). Messages are signed by the phone's Secure Enclave Signing key; the
// host verifies against the paired signing public key, so a message the host did not
// solicit or that a hijacked conductor forged is rejected.
//   node inbox.js receive '<message-json>'   (validates + stores; verifies signature if paired)
//   node inbox.js read [type]                (host reads pending messages)
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const INBOX = path.join(require('os').homedir(), 'PRIVATE', 'ecodia-creds', 'vault', 'inbox.json')
const PAIRING = path.join(require('os').homedir(), 'PRIVATE', 'ecodia-creds', 'vault', 'phone-pairing.json')

function load(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch (_e) { return null } }
function save(o) { fs.mkdirSync(path.dirname(INBOX), { recursive: true, mode: 0o700 }); fs.writeFileSync(INBOX, JSON.stringify(o, null, 2), { mode: 0o600 }) }

// Verify a phone signature over the canonical message bytes using the paired P-256
// signing public key (x963 base64). Returns true/false/null(no pairing).
function verifySig(canonicalBytes, sigB64) {
  const pairing = load(PAIRING)
  if (!pairing || !pairing.signing) return null
  try {
    const pubDer = spkiFromX963(Buffer.from(pairing.signing, 'base64'))
    const key = crypto.createPublicKey({ key: pubDer, format: 'der', type: 'spki' })
    return crypto.verify(null, canonicalBytes, { key, dsaEncoding: 'der' }, Buffer.from(sigB64, 'base64'))
  } catch (_e) { return false }
}

// Wrap a raw 65-byte x963 P-256 public key as a DER SPKI so Node's crypto can import it.
function spkiFromX963(x963) {
  const prefix = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex') // P-256 SPKI header
  return Buffer.concat([prefix, x963])
}

function canonical(msg) {
  // sign over everything except the signature field, key-sorted for determinism.
  const { sig, ...rest } = msg
  return Buffer.from(JSON.stringify(rest, Object.keys(rest).sort()))
}

function receive(json) {
  const msg = JSON.parse(json)
  if (!msg.type) throw new Error('message needs a type (pairing|enroll|result)')
  let sigOk = null
  if (msg.sig) sigOk = verifySig(canonical(msg), msg.sig)
  if (sigOk === false) throw new Error('signature INVALID - message rejected (not from the paired phone)')
  const box = load(INBOX) || { messages: [] }
  box.messages.push({ ...msg, sigVerified: sigOk, receivedAt: new Date().toISOString() })
  save(box)
  return { stored: msg.type, sigVerified: sigOk, count: box.messages.length }
}

function read(type) {
  const box = load(INBOX) || { messages: [] }
  const msgs = type ? box.messages.filter(m => m.type === type) : box.messages
  return msgs
}

module.exports = { spkiFromX963, canonical, verifySig, receive, read }

if (require.main === module) {
  const [cmd, a1] = process.argv.slice(2)
  try {
    if (cmd === 'receive') console.log(JSON.stringify(receive(a1), null, 2))
    else if (cmd === 'read') console.log(JSON.stringify(read(a1), null, 2))
    else console.log('usage: inbox.js receive <json> | read [type]')
  } catch (e) { console.error('ERR', e.message); process.exit(1) }
}
