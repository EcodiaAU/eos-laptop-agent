// routes/cowork.js - REST surface for the cowork.* tool family.
//
// Primary entry: POST /api/cowork/dispatch-worker
//
// Why this route exists separately from /api/tool: the observer self-heal hook
// (C:/Users/tjdTa/.claude/hooks/observer_signal.py) POSTs here directly with a
// flat body shape. That hook is unauthenticated by design (it has no access to
// the AGENT_TOKEN bearer because it runs inside the Claude Code hook surface,
// not as a registered worker). Mounting a dedicated REST route lets us:
//   1. Accept the flat body shape {brief, reason, session_id, ts, source}
//      without forcing the hook to learn /api/tool's {tool, params} envelope.
//   2. Run unauthenticated for the localhost self-heal path while /api/tool
//      still requires auth for everything else.
//   3. Fall back to a queue-file substrate when the in-process cowork tool
//      handler is unavailable (or rejects), so the hook never 404s.
//
// Request body (all fields optional except brief):
//   {brief: string, kind?: string, target_ide?: 'cursor'|'stable'|'insiders',
//    parent_task_id?: string, reason?: string, session_id?: string,
//    ts?: string, source?: string}
//
// Success response (direct invocation path):
//   {ok: true, tab_id, task_id, brief_path, ...full dispatch_worker result}
//
// Success response (queued fallback path):
//   {ok: true, queued: true, request_id, request_path}
//
// Error response:
//   {ok: false, error: string, ...context}

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const COORD_ROOT = 'D:\\.code\\EcodiaOS\\coordination'
const DISPATCH_REQUESTS_DIR = path.join(COORD_ROOT, 'dispatch_requests')
const BRIEFS_DIR = path.join(COORD_ROOT, 'briefs')

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }) } catch (e) {}
}

function uuid() {
  return crypto.randomUUID()
}

// Resolve the cowork tool module once at mount time. If it fails to load (file
// missing, syntax error, transient require error) we fall through to the
// queue-file substrate. Either way the route stays up.
function loadCoworkModule() {
  try {
    const mod = require('../tools/cowork')
    if (mod && typeof mod.dispatch_worker === 'function') return mod
    return null
  } catch (e) {
    console.error('cowork.js tool module load failed (will queue requests):', e.message)
    return null
  }
}

function mount(app, auth) {
  const cowork = loadCoworkModule()

  app.post('/api/cowork/dispatch-worker', async (req, res) => {
    const body = req.body || {}
    const brief = body.brief
    if (!brief || typeof brief !== 'string') {
      return res.status(400).json({ ok: false, error: 'brief required (string)' })
    }

    // Direct-invocation path. ctx passed in case the handler reads x-tab-* for
    // parent_conductor_tab_id attribution.
    if (cowork && typeof cowork.dispatch_worker === 'function') {
      const ctx = {
        tab_id: req.headers['x-tab-id'],
        tab_credential: req.headers['x-tab-credential'],
      }
      const params = {
        brief: brief,
        ide: body.target_ide || body.ide,
        parent_conductor_tab_id: body.parent_task_id || ctx.tab_id,
        // Pass-through extras for telemetry (the handler ignores unknown keys).
        kind: body.kind,
        reason: body.reason,
        session_id: body.session_id,
        source: body.source,
      }
      try {
        const result = await cowork.dispatch_worker(params, ctx)
        const status = result && result.ok === false ? 500 : 200
        // Result already contains tab_id, task_id, brief_file_audit etc.
        // Synthesize brief_path alias for the hook's expected contract.
        const enriched = Object.assign({}, result, {
          brief_path: result && result.brief_file_audit,
        })
        return res.status(status).json(enriched)
      } catch (e) {
        // dispatch_worker threw - fall through to queue substrate so the hook
        // doesn't 500-loop. Caller can inspect the queued request later.
        return queueRequest(req, res, body, { invocation_error: e.message })
      }
    }

    // Fallback: write the request to a queue file. An external daemon (or the
    // next conductor turn) can drain dispatch_requests/ and dispatch one at a
    // time. The route stays 200-OK so the self-heal hook is satisfied.
    return queueRequest(req, res, body, null)
  })

  // Diagnostic probe: callers can verify the route is mounted + which path
  // would be taken (direct vs queued) without firing a real dispatch.
  app.get('/api/cowork/info', (_req, res) => {
    res.json({
      ok: true,
      route: '/api/cowork/dispatch-worker',
      mode: cowork ? 'direct-invocation' : 'queue-file-fallback',
      queue_dir: DISPATCH_REQUESTS_DIR.replace(/\\/g, '/'),
    })
  })
}

function queueRequest(req, res, body, extra) {
  try {
    ensureDir(DISPATCH_REQUESTS_DIR)
    const request_id = uuid()
    const filename = Date.now() + '-' + request_id + '.json'
    const request_path = path.join(DISPATCH_REQUESTS_DIR, filename)
    const record = {
      request_id: request_id,
      received_at: new Date().toISOString(),
      remote_addr: (req && req.socket && req.socket.remoteAddress) || null,
      body: body,
    }
    if (extra) record.dispatch_invocation = extra
    fs.writeFileSync(request_path, JSON.stringify(record, null, 2), 'utf8')
    return res.status(202).json({
      ok: true,
      queued: true,
      request_id: request_id,
      request_path: request_path.replace(/\\/g, '/'),
      note: 'cowork.dispatch_worker handler unavailable or threw; request persisted for daemon pickup.',
    })
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'queue write failed: ' + e.message })
  }
}

module.exports = { mount }
