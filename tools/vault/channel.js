'use strict'
// tools/vault/channel.js - the HOST HTTP handler for the phone->host channel. The Friend
// backend route (or any authenticated ingress the phone can reach) forwards a POST here;
// this validates + routes it. It replaces the "email me the clipboard" relay.
//
// Nothing secret transits this channel BY DESIGN:
//   - result : read-only scraped data, SIGNED by the phone's Secure Enclave (tamper-evident)
//   - enroll : ciphertext blob only the phone's SE key can open (host never holds plaintext)
//   - pair   : public keys
// so the channel needs no confidentiality, only integrity, which the SE signature provides.
// A result with a bad/absent signature from the paired phone is rejected (a hijacked
// conductor cannot forge the data that comes back).
//
//   handle(pathname, bodyObj) -> { status, json }        (pure, unit-testable)
//   node channel.js serve <port>                          (loopback HTTP for proving)
const http = require('http')
const inbox = require('./inbox.js')
const enroll = require('./enroll.js')

function handle(pathname, body) {
  try {
    if (pathname === '/vault/result') {
      // body is a full signed message {type:'result', ...fields, sig}
      const r = inbox.receive(JSON.stringify({ ...body, type: 'result' }))
      if (r.sigVerified !== true) return { status: 401, json: { error: 'result signature not verified by the paired phone', sigVerified: r.sigVerified } }
      return { status: 200, json: { ok: true, stored: 'result', sigVerified: true } }
    }
    if (pathname === '/vault/enroll') {
      const r = enroll.store(JSON.stringify({ ...body, type: 'enroll' }))
      return { status: 200, json: { ok: true, ...r } }
    }
    return { status: 404, json: { error: 'unknown vault path: ' + pathname } }
  } catch (e) {
    // a signature OR value-binding failure is an integrity/auth failure (401)
    const status = /signature|not bound/i.test(e.message) ? 401 : 400
    return { status, json: { error: e.message } }
  }
}

function serve(port) {
  const srv = http.createServer((req, res) => {
    if (req.method !== 'POST') { res.writeHead(405); return res.end('POST only') }
    let raw = ''
    req.on('data', c => { raw += c; if (raw.length > 1e6) req.destroy() })
    req.on('end', () => {
      let body
      try { body = JSON.parse(raw || '{}') } catch (_e) { res.writeHead(400); return res.end('{"error":"bad json"}') }
      const out = handle(req.url, body)
      res.writeHead(out.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(out.json))
    })
  })
  srv.listen(port, '127.0.0.1', () => console.log('vault channel on 127.0.0.1:' + port))
  return srv
}

module.exports = { handle, serve }

if (require.main === module) {
  const [cmd, a1] = process.argv.slice(2)
  if (cmd === 'serve') serve(Number(a1 || 8790))
  else console.log('usage: channel.js serve <port>')
}
