'use strict'
// tools/vault/enroll.js - host side of phone-side enrollment. The PHONE seals the
// password to its own SE key (VaultEnroll) and hands the host only the ciphertext
// blob + non-secret metadata. This stores that, and turns a stored entry into an
// eosvault://login link. The host NEVER holds the plaintext - it only relays the
// blob the phone produced; only the phone can ever open it.
//   node enroll.js store '<enroll-json-from-phone>'
//   node enroll.js login <service> [uSel] [pSel] [sSel] [submit0|1]
//   node enroll.js list
const fs = require('fs')
const path = require('path')
const STORE = path.join(require('os').homedir(), 'PRIVATE', 'ecodia-creds', 'vault', 'enrolled.json')

function load() { try { return JSON.parse(fs.readFileSync(STORE, 'utf8')) } catch (_e) { return {} } }
function save(o) { fs.mkdirSync(path.dirname(STORE), { recursive: true, mode: 0o700 }); fs.writeFileSync(STORE, JSON.stringify(o, null, 2), { mode: 0o600 }) }

function store(json) {
  const e = JSON.parse(json)
  if (e.type !== 'enroll' || !e.blob || !e.origin) throw new Error('not an enroll payload {type:enroll, service, origin, username, blob}')
  const all = load()
  const key = String(e.service || e.origin).toLowerCase().replace(/[\s_]+/g, '-')
  all[key] = { service: e.service, origin: e.origin, username: e.username, blob: e.blob, enrolledAt: new Date().toISOString() }
  save(all)
  return { stored: key, service: e.service, origin: e.origin, username: e.username, blobLen: e.blob.length, note: 'ciphertext only - host cannot open it' }
}

function toUrlB64(b64) { return b64.replace(/\+/g, '-').replace(/\//g, '_') }

function loginLink(service, uSel, pSel, sSel, submit) {
  const all = load()
  const key = String(service).toLowerCase().replace(/[\s_]+/g, '-')
  const e = all[key]
  if (!e) throw new Error('no enrolled credential for "' + service + '" (have: ' + Object.keys(all).join(', ') + ')')
  const params = new URLSearchParams({
    blob: toUrlB64(e.blob), origin: e.origin, user: e.username || '',
    uSel: uSel || 'input[type=email],input[name=login],#login_field,#username',
    pSel: pSel || 'input[type=password],#password',
    sSel: sSel || 'button[type=submit],input[type=submit]',
    submit: (submit == null ? '1' : String(submit)),
  })
  return 'eosvault://login?' + params.toString()
}

module.exports = { store, loginLink, load }

if (require.main === module) {
  const [cmd, a1, a2, a3, a4, a5] = process.argv.slice(2)
  try {
    if (cmd === 'store') console.log(JSON.stringify(store(a1), null, 2))
    else if (cmd === 'login') console.log(loginLink(a1, a2, a3, a4, a5))
    else if (cmd === 'list') { const all = load(); console.log(Object.values(all).map(e => `${e.service} | ${e.origin} | ${e.username} | enrolled ${e.enrolledAt}`).join('\n') || '(none enrolled)') }
    else console.log('usage: enroll.js store <json> | login <service> [uSel pSel sSel submit] | list')
  } catch (e) { console.error('ERR', e.message); process.exit(1) }
}
