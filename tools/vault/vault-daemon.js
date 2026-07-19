'use strict'
// tools/vault/vault-daemon.js - the vault daemon HTTP service. Composes seed-store
// + budget + keystore + submit_2fa behind a LOOPBACK-ONLY server. This is the one
// surface the conductor calls; it hands back {status} and never a code (fill-not-
// return). fill + verifyTab are injected: in production they are cdp.nativeFill and
// a live-tab origin+account read; if either is absent the daemon DENIES (fail-safe,
// never fills without a real verifier). Design spec: docs/security/2fa-...md s3.
const http = require('http')
const { submit2fa } = require('./submit-2fa')

// createDaemon({ store, budget, fill, verifyTab, now, launchLogin? }) -> { handle, listen }
function createDaemon(deps) {
  deps = deps || {}
  const store = deps.store
  if (!store) throw new Error('createDaemon: store required')
  const now = deps.now || (() => Math.floor(Date.now() / 1000))
  // Fail-safe: if no real verifier/filler is wired, deny rather than fill blind.
  const verifyTab = deps.verifyTab || (async () => false)
  const fill = deps.fill || (async () => ({ ok: false }))

  function submitDeps() {
    return {
      rows: store.loadRegistry(),
      loadSeed: (id) => store.loadSeed(id),
      verifyTab,
      fill,
      budget: deps.budget,
      approvals: deps.approvals,
      audit: (e) => { try { store.audit(e) } catch (_e) {} },
      now,
    }
  }

  async function readJson(req) {
    return new Promise((resolve) => {
      let body = ''
      req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy() })
      req.on('end', () => { try { resolve(JSON.parse(body || '{}')) } catch (_e) { resolve(null) } })
    })
  }

  // The request handler. Loopback binding is enforced in listen(); the handler
  // also rejects any request whose socket is not local as defence in depth.
  async function handle(req, res) {
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
    const ra = req.socket.remoteAddress || ''
    if (!(ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1')) return send(403, { error: 'loopback-only' })

    if (req.method === 'GET' && req.url === '/health') {
      let seeds = 0
      try { seeds = store.loadRegistry().length } catch (_e) {}
      return send(200, { ok: true, seeds })   // no secret material, ever
    }
    if (req.method === 'POST' && req.url === '/submit_2fa') {
      const body = await readJson(req)
      if (!body || !body.service) return send(400, { error: 'service required' })
      const result = await submit2fa({ service: body.service, cdpSessionRef: body.cdp_session_ref, approvalToken: body.approval_token }, submitDeps())
      return send(200, result)   // {status: filled|approval_required|denied}, never a code
    }
    if (req.method === 'POST' && req.url === '/enroll') {
      // Software-mode enrollment surface. In production this is further gated
      // (GATED enrollment needs human presence, enforced in store.enroll).
      const body = await readJson(req)
      try { const seed_id = store.enroll(body || {}); return send(200, { seed_id }) }
      catch (e) { return send(400, { error: String(e.message || e) }) }
    }
    return send(404, { error: 'not-found' })
  }

  function listen(port, cb) {
    const server = http.createServer((req, res) => { handle(req, res).catch(() => { try { res.writeHead(500); res.end('{}') } catch (_e) {} }) })
    server.listen(port || 0, '127.0.0.1', cb)   // LOOPBACK ONLY
    return server
  }

  return { handle, listen, submitDeps }
}

module.exports = { createDaemon }
