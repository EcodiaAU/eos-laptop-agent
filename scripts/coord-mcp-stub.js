#!/usr/bin/env node
// coord-mcp-stub.js - standalone stub of the coord MCP server.
//
// Speaks HTTP JSON-RPC like the laptop-agent's existing MCP servers.
// Implements the 8 coord.* tools as stubs PLUS the
// /api/comms/register-worker endpoint that workers call as their
// mandatory FIRST ACTION bootstrap.
//
// On register-worker, writes D:/.code/EcodiaOS/coordination/state/<tab_id>.spawned
// with the ISO timestamp. cowork.dispatch_worker polls this marker.
//
// Run: node D:/.code/eos-laptop-agent/scripts/coord-mcp-stub.js [port]
// Default port: 7457. Logs all requests to stderr.

const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const os = require('os')

const PORT = parseInt(process.argv[2] || '7457', 10)
const STATE_DIR = 'D:\\.code\\EcodiaOS\\coordination\\state'
const TOKEN_FILE = path.join(os.homedir(), '.ecodiaos', 'laptop-agent.token')

let SHARED_TOKEN = ''
try { SHARED_TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim() } catch (e) {
  console.error('warn: no laptop-agent token at', TOKEN_FILE, '- auth will accept any bearer')
}

// In-memory worker registry
const workers = new Map()  // tab_id -> { tab_credential, task_id, registered_at, last_heartbeat_at }
const inboxes = new Map()  // topic -> array of messages (FIFO)
const message_log = []

function uuid() { return crypto.randomUUID() }

function ensureStateDir() {
  try { fs.mkdirSync(STATE_DIR, { recursive: true }) } catch (e) {}
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = ''
    req.on('data', c => chunks += c)
    req.on('end', () => {
      if (!chunks) return resolve({})
      try { resolve(JSON.parse(chunks)) } catch (e) { reject(e) }
    })
    req.on('error', reject)
  })
}

function authOk(req) {
  if (!SHARED_TOKEN) return true  // no token configured = open mode for stub testing
  const h = req.headers['authorization'] || ''
  const m = h.match(/^Bearer\s+(.+)$/)
  if (!m) return false
  return m[1].trim() === SHARED_TOKEN
}

function send(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function log(...args) {
  process.stderr.write('[coord-stub] ' + args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ') + '\n')
}

// ----- coord.* tool handlers -----

function coord_send_message(params, ctx) {
  const message_id = uuid()
  const created_at = new Date().toISOString()
  const msg = {
    id: message_id,
    from: ctx.tab_id || 'unknown',
    to: params.to,
    body: params.body,
    task_id: params.task_id || null,
    in_reply_to: params.in_reply_to || null,
    created_at: created_at,
    seen_at: null,
    acknowledged_at: null,
  }
  message_log.push(msg)
  if (!inboxes.has(params.to)) inboxes.set(params.to, [])
  inboxes.get(params.to).push(msg)
  log('send_message', { id: message_id, from: msg.from, to: msg.to })
  return { message_id: message_id, created_at: created_at }
}

function coord_read_inbox(params, ctx) {
  const topic = 'chat.' + (ctx.tab_id || params.tab_id || 'conductor') + '.inbox'
  const since = params.since ? new Date(params.since).getTime() : 0
  const limit = params.limit || 50
  const inbox = inboxes.get(topic) || []
  const unread = inbox.filter(m => !m.seen_at && new Date(m.created_at).getTime() > since).slice(0, limit)
  for (const m of unread) m.seen_at = new Date().toISOString()
  log('read_inbox', { topic: topic, returned: unread.length, total_in_inbox: inbox.length })
  return { messages: unread }
}

async function coord_wait_for_inbox(params, ctx) {
  const topic = 'chat.' + (ctx.tab_id || params.tab_id || 'conductor') + '.inbox'
  const timeout_ms = Math.min(params.timeout || 300, 600) * 1000
  const start = Date.now()
  while (Date.now() - start < timeout_ms) {
    const inbox = inboxes.get(topic) || []
    const unread = inbox.filter(m => !m.seen_at)
    if (unread.length > 0) {
      for (const m of unread) m.seen_at = new Date().toISOString()
      log('wait_for_inbox WAKE', { topic: topic, returned: unread.length, hold_ms: Date.now() - start })
      return {
        trigger_message: unread[0],
        also_unread: unread.slice(1),
        current_active_workers: Array.from(workers.entries()).map(([tid, w]) => ({ tab_id: tid, task_id: w.task_id, last_heartbeat_at: w.last_heartbeat_at })),
        hold_duration_ms: Date.now() - start,
      }
    }
    await new Promise(r => setTimeout(r, 1000))
  }
  log('wait_for_inbox TIMEOUT', { topic: topic, hold_ms: Date.now() - start })
  return { trigger_message: null, also_unread: [], current_active_workers: [], hold_duration_ms: Date.now() - start, timed_out: true }
}

function coord_ack_message(params, ctx) {
  const m = message_log.find(x => x.id === params.id)
  if (!m) return { ok: false, error: 'message not found' }
  m.acknowledged_at = new Date().toISOString()
  if (params.action_summary) m.action_summary = params.action_summary
  log('ack_message', { id: params.id })
  return { ok: true, id: params.id, acknowledged_at: m.acknowledged_at }
}

function coord_list_workers(params, ctx) {
  const include_dead = !!params.include_dead
  const now = Date.now()
  const list = []
  for (const [tab_id, w] of workers.entries()) {
    const stale_ms = now - new Date(w.last_heartbeat_at || w.registered_at).getTime()
    const is_dead = stale_ms > 90000
    if (is_dead && !include_dead) continue
    list.push({ tab_id: tab_id, task_id: w.task_id, registered_at: w.registered_at, last_heartbeat_at: w.last_heartbeat_at, stale_ms: stale_ms, dead: is_dead })
  }
  return { count: list.length, workers: list }
}

function coord_heartbeat(params, ctx) {
  if (!ctx.tab_id) return { ok: false, error: 'tab_id required (via header or params)' }
  const w = workers.get(ctx.tab_id)
  if (!w) return { ok: false, error: 'worker not registered: ' + ctx.tab_id }
  w.last_heartbeat_at = new Date().toISOString()
  if (params.status) w.status = params.status
  if (typeof params.in_critical_section === 'boolean') w.in_critical_section = params.in_critical_section
  return { ok: true, last_heartbeat_at: w.last_heartbeat_at }
}

function coord_report_progress(params, ctx) {
  const tab_id = ctx.tab_id || 'unknown'
  log('report_progress', { tab_id: tab_id, task_id: params.task_id, summary: (params.summary || '').slice(0, 80) })
  return coord_send_message({
    to: 'chat.conductor.inbox',
    body: { type: 'progress', task_id: params.task_id, summary: params.summary },
    task_id: params.task_id,
  }, ctx)
}

function coord_signal_done(params, ctx) {
  const tab_id = ctx.tab_id || 'unknown'
  log('signal_done', { tab_id: tab_id, task_id: params.task_id, terminate: !!params.terminate })
  const w = workers.get(tab_id)
  if (w) w.terminated_at = new Date().toISOString()
  return coord_send_message({
    to: 'chat.conductor.inbox',
    body: { type: 'done', task_id: params.task_id, result_summary: params.result_summary, result_pointer: params.result_pointer, terminate: !!params.terminate },
    task_id: params.task_id,
  }, ctx)
}

// ----- HTTP server -----

const server = http.createServer(async (req, res) => {
  log(req.method, req.url)

  if (req.method === 'GET' && req.url === '/api/health') {
    return send(res, 200, { status: 'ok', workers: workers.size, messages: message_log.length, port: PORT })
  }

  if (req.method === 'GET' && req.url === '/api/info') {
    return send(res, 200, {
      service: 'coord-mcp-stub',
      tools: ['coord.send_message','coord.read_inbox','coord.wait_for_inbox','coord.ack_message','coord.list_workers','coord.heartbeat','coord.report_progress','coord.signal_done'],
      endpoints: ['/api/health','/api/info','/api/comms/register-worker','/api/tool','/api/inspect'],
    })
  }

  if (req.method === 'GET' && req.url === '/api/inspect') {
    return send(res, 200, {
      workers: Array.from(workers.entries()).map(([k,v]) => ({tab_id:k, ...v})),
      inboxes: Object.fromEntries(Array.from(inboxes.entries()).map(([t,m]) => [t, m.length])),
      message_log_size: message_log.length,
      last_5_messages: message_log.slice(-5),
    })
  }

  if (!authOk(req)) return send(res, 401, { error: 'unauthorized (need Bearer ' + (SHARED_TOKEN ? 'laptop-agent.token' : 'any') + ')' })

  if (req.method === 'POST' && req.url === '/api/comms/register-worker') {
    let body
    try { body = await readBody(req) } catch (e) { return send(res, 400, { error: 'bad json' }) }
    const { tab_id, task_id, tab_credential } = body
    if (!tab_id || !tab_credential) return send(res, 400, { error: 'tab_id + tab_credential required' })
    workers.set(tab_id, { tab_credential: tab_credential, task_id: task_id, registered_at: new Date().toISOString(), last_heartbeat_at: new Date().toISOString() })
    ensureStateDir()
    const markerPath = path.join(STATE_DIR, tab_id + '.spawned')
    try {
      fs.writeFileSync(markerPath, new Date().toISOString(), 'utf8')
    } catch (e) {
      log('failed to write marker', e.message)
    }
    log('REGISTER', { tab_id: tab_id, task_id: task_id, marker: markerPath })
    return send(res, 200, { ok: true, tab_id: tab_id, registered_at: workers.get(tab_id).registered_at, marker_path: markerPath })
  }

  if (req.method === 'POST' && req.url === '/api/tool') {
    let body
    try { body = await readBody(req) } catch (e) { return send(res, 400, { error: 'bad json' }) }
    const tool = body.tool
    const params = body.params || {}
    const ctx = {
      tab_id: req.headers['x-tab-id'] || params.tab_id,
      tab_credential: req.headers['x-tab-credential'] || params.tab_credential,
    }
    const handlers = {
      'coord.send_message': coord_send_message,
      'coord.read_inbox': coord_read_inbox,
      'coord.wait_for_inbox': coord_wait_for_inbox,
      'coord.ack_message': coord_ack_message,
      'coord.list_workers': coord_list_workers,
      'coord.heartbeat': coord_heartbeat,
      'coord.report_progress': coord_report_progress,
      'coord.signal_done': coord_signal_done,
    }
    const h = handlers[tool]
    if (!h) return send(res, 404, { error: 'unknown tool: ' + tool, available: Object.keys(handlers) })
    try {
      const result = await Promise.resolve(h(params, ctx))
      return send(res, 200, { ok: true, result: result })
    } catch (e) {
      return send(res, 500, { error: e.message, tool: tool })
    }
  }

  return send(res, 404, { error: 'not found' })
})

server.listen(PORT, '127.0.0.1', () => {
  log('coord-mcp-stub listening on http://localhost:' + PORT)
  log('endpoints: GET /api/health /api/info /api/inspect | POST /api/comms/register-worker /api/tool')
  log('state markers written to:', STATE_DIR)
})
