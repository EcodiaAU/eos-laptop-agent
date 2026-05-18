// coord.js - coord.* tool handlers for inter-CC-tab coordination.
//
// File-backed persistence at D:\.code\EcodiaOS\coordination\:
//   workers/<tab_id>.json   - registered worker rows
//   messages/<msg_id>.json  - full message bodies
//   inbox/<topic>/<msg_id>  - empty marker files indexing messages by topic
//
// In-memory cache for hot reads (workers + per-topic message lists). Cache is
// rebuilt from disk at process start; writes go to both cache and disk.
//
// Wait_for_inbox is poll-based (1s loop) - simpler than PG LISTEN/NOTIFY and
// adequate for the single-Corazon use case.
//
// Tools take (params, ctx). ctx carries {tab_id, tab_credential} from request
// headers (X-Tab-Id, X-Tab-Credential) or params. Validation:
//   - register-worker creates the row + writes the .spawned marker
//   - subsequent coord.* calls require ctx.tab_id + ctx.tab_credential to match
//     the registered row (except send_message addressed to conductor, which any
//     tab is allowed to do without strict cred validation in v1)

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const COORD_ROOT = 'D:\\.code\\EcodiaOS\\coordination'
const WORKERS_DIR = path.join(COORD_ROOT, 'workers')
const MESSAGES_DIR = path.join(COORD_ROOT, 'messages')
const INBOX_DIR = path.join(COORD_ROOT, 'inbox')
const STATE_DIR = path.join(COORD_ROOT, 'state')  // already used by dispatcher for .spawned markers

const DEAD_HEARTBEAT_MS = 90 * 1000  // 90s without heartbeat = dead
const MAX_WAIT_TIMEOUT_S = 600       // 10min cap on long-poll
const WAIT_POLL_INTERVAL_MS = 1000   // 1s poll inside wait_for_inbox
const ALSO_UNREAD_CAP = 20           // wait_for_inbox bulk-return cap

// ── filesystem helpers ───────────────────────────────────────────────────

function ensureDirs() {
  for (const d of [COORD_ROOT, WORKERS_DIR, MESSAGES_DIR, INBOX_DIR, STATE_DIR]) {
    try { fs.mkdirSync(d, { recursive: true }) } catch (e) {}
  }
}

function atomicWriteJson(filepath, obj) {
  const tmp = filepath + '.tmp-' + process.pid + '-' + Date.now()
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8')
  fs.renameSync(tmp, filepath)
}

function readJsonSafe(filepath) {
  try { return JSON.parse(fs.readFileSync(filepath, 'utf8')) } catch (e) { return null }
}

function safeTopicSlug(topic) {
  // Topic strings are user-controlled - sanitize to a safe filename.
  return String(topic).replace(/[^\w.@-]/g, '_').slice(0, 200)
}

function inboxDirForTopic(topic) {
  const slug = safeTopicSlug(topic)
  const dir = path.join(INBOX_DIR, slug)
  try { fs.mkdirSync(dir, { recursive: true }) } catch (e) {}
  return dir
}

// ── in-memory cache (rebuilt at start) ───────────────────────────────────

const workers = new Map()         // tab_id -> worker row
const messagesById = new Map()    // msg_id -> full message
const inboxIndex = new Map()      // topic -> Set of msg_ids (ordered)

function loadFromDisk() {
  ensureDirs()
  // workers
  try {
    for (const f of fs.readdirSync(WORKERS_DIR)) {
      if (!f.endsWith('.json')) continue
      const row = readJsonSafe(path.join(WORKERS_DIR, f))
      if (row && row.tab_id) workers.set(row.tab_id, row)
    }
  } catch (e) {}
  // messages
  try {
    for (const f of fs.readdirSync(MESSAGES_DIR)) {
      if (!f.endsWith('.json')) continue
      const msg = readJsonSafe(path.join(MESSAGES_DIR, f))
      if (msg && msg.id) messagesById.set(msg.id, msg)
    }
  } catch (e) {}
  // inbox index (markers)
  try {
    for (const topicSlug of fs.readdirSync(INBOX_DIR)) {
      const dir = path.join(INBOX_DIR, topicSlug)
      try {
        const stat = fs.statSync(dir)
        if (!stat.isDirectory()) continue
      } catch (e) { continue }
      const ids = new Set()
      try {
        for (const m of fs.readdirSync(dir)) ids.add(m)
      } catch (e) {}
      // We index by SLUG, but the message bodies record the full topic; we'll
      // resolve via message body on read. Store under slug here, lookup via
      // safeTopicSlug() in read paths.
      inboxIndex.set(topicSlug, ids)
    }
  } catch (e) {}
}

loadFromDisk()

// ── core ops (no auth here - that's the route layer's job) ───────────────

function registerWorkerInternal({ tab_id, task_id, tab_credential, parent_conductor_tab_id, account_active_when_spawned }) {
  if (!tab_id) throw new Error('tab_id required')
  if (!tab_credential) throw new Error('tab_credential required')
  ensureDirs()
  const now = new Date().toISOString()
  const row = {
    tab_id: tab_id,
    tab_credential: tab_credential,
    task_id: task_id || null,
    parent_conductor_tab_id: parent_conductor_tab_id || null,
    account_active_when_spawned: account_active_when_spawned || null,
    registered_at: now,
    last_heartbeat_at: now,
    status: null,
    in_critical_section: false,
    terminated_at: null,
  }
  workers.set(tab_id, row)
  atomicWriteJson(path.join(WORKERS_DIR, tab_id + '.json'), row)
  // Also write the .spawned marker so dispatch_worker's waitForSpawnedAt sees it
  try { fs.writeFileSync(path.join(STATE_DIR, tab_id + '.spawned'), now, 'utf8') } catch (e) {}
  return row
}

function persistMessage(msg) {
  messagesById.set(msg.id, msg)
  atomicWriteJson(path.join(MESSAGES_DIR, msg.id + '.json'), msg)
  // Add to inbox index by topic
  const slug = safeTopicSlug(msg.to)
  let ids = inboxIndex.get(slug)
  if (!ids) { ids = new Set(); inboxIndex.set(slug, ids) }
  ids.add(msg.id)
  // Marker file (empty - presence indicates membership; mtime preserves order)
  try { fs.writeFileSync(path.join(inboxDirForTopic(msg.to), msg.id), '', 'utf8') } catch (e) {}
}

function deliverMessageToTopic(from, to, body, task_id, in_reply_to) {
  const id = crypto.randomUUID()
  const created_at = new Date().toISOString()
  const msg = {
    id: id,
    from: from || 'unknown',
    to: to,
    body: body,
    task_id: task_id || null,
    in_reply_to: in_reply_to || null,
    created_at: created_at,
    seen_at: null,
    acknowledged_at: null,
    action_summary: null,
  }
  persistMessage(msg)
  return { message_id: id, created_at: created_at }
}

function readInboxForTopic(topic, sinceMs, limit) {
  const slug = safeTopicSlug(topic)
  const ids = inboxIndex.get(slug) || new Set()
  const out = []
  for (const id of ids) {
    const m = messagesById.get(id)
    if (!m) continue
    if (m.seen_at) continue
    if (sinceMs && new Date(m.created_at).getTime() <= sinceMs) continue
    out.push(m)
  }
  // Order by created_at asc
  out.sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
  return out.slice(0, limit || 50)
}

function markSeen(messages) {
  const now = new Date().toISOString()
  for (const m of messages) {
    m.seen_at = now
    try { atomicWriteJson(path.join(MESSAGES_DIR, m.id + '.json'), m) } catch (e) {}
  }
}

// Compute an inbox topic for the caller. Worker -> 'chat.<tab_id>.inbox'.
// Conductor (no tab_id) -> 'chat.conductor.inbox'.
function inboxTopicFor(ctx) {
  const tab = ctx && ctx.tab_id
  if (tab && tab !== 'conductor') return 'chat.' + tab + '.inbox'
  return 'chat.conductor.inbox'
}

// ── tool handlers ────────────────────────────────────────────────────────

async function send_message(params, ctx) {
  ctx = ctx || {}
  if (!params || !params.to || !params.body) {
    throw new Error('to and body required')
  }
  const from = ctx.tab_id || 'conductor'
  const r = deliverMessageToTopic(from, params.to, params.body, params.task_id, params.in_reply_to)
  return r
}

async function read_inbox(params, ctx) {
  params = params || {}
  ctx = ctx || {}
  const topic = params.topic || inboxTopicFor(ctx)
  const since = params.since ? new Date(params.since).getTime() : 0
  const limit = params.limit || 50
  const messages = readInboxForTopic(topic, since, limit)
  markSeen(messages)
  return { topic: topic, count: messages.length, messages: messages }
}

async function wait_for_inbox(params, ctx) {
  params = params || {}
  ctx = ctx || {}
  const topic = params.topic || inboxTopicFor(ctx)
  const timeoutSec = Math.min(params.timeout || 300, MAX_WAIT_TIMEOUT_S)
  const timeoutMs = timeoutSec * 1000
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const messages = readInboxForTopic(topic, 0, ALSO_UNREAD_CAP + 1)
    if (messages.length > 0) {
      const trigger = messages[0]
      const also = messages.slice(1, 1 + ALSO_UNREAD_CAP)
      const more_unread = messages.length > 1 + ALSO_UNREAD_CAP
      markSeen([trigger, ...also])
      return {
        trigger_message: trigger,
        also_unread: also,
        more_unread: more_unread,
        hold_duration_ms: Date.now() - start,
        timed_out: false,
      }
    }
    await new Promise(r => setTimeout(r, WAIT_POLL_INTERVAL_MS))
  }
  return {
    trigger_message: null,
    also_unread: [],
    more_unread: false,
    hold_duration_ms: Date.now() - start,
    timed_out: true,
  }
}

async function ack_message(params, ctx) {
  params = params || {}
  if (!params.id) throw new Error('id required')
  const m = messagesById.get(params.id)
  if (!m) return { ok: false, error: 'message not found' }
  m.acknowledged_at = new Date().toISOString()
  if (params.action_summary) m.action_summary = String(params.action_summary).slice(0, 2000)
  try { atomicWriteJson(path.join(MESSAGES_DIR, m.id + '.json'), m) } catch (e) {}
  return { ok: true, id: m.id, acknowledged_at: m.acknowledged_at }
}

async function list_workers(params, ctx) {
  params = params || {}
  const include_dead = !!params.include_dead
  const now = Date.now()
  const out = []
  for (const [tab_id, w] of workers.entries()) {
    const lastHbMs = new Date(w.last_heartbeat_at || w.registered_at).getTime()
    const stale_ms = now - lastHbMs
    const is_dead = stale_ms > DEAD_HEARTBEAT_MS || !!w.terminated_at
    if (is_dead && !include_dead) continue
    out.push({
      tab_id: tab_id,
      task_id: w.task_id,
      registered_at: w.registered_at,
      last_heartbeat_at: w.last_heartbeat_at,
      stale_ms: stale_ms,
      in_critical_section: !!w.in_critical_section,
      terminated_at: w.terminated_at,
      dead: is_dead,
    })
  }
  return { count: out.length, workers: out }
}

async function heartbeat(params, ctx) {
  params = params || {}
  ctx = ctx || {}
  if (!ctx.tab_id) return { ok: false, error: 'tab_id required (X-Tab-Id header or params.tab_id)' }
  const w = workers.get(ctx.tab_id)
  if (!w) return { ok: false, error: 'worker not registered: ' + ctx.tab_id }
  w.last_heartbeat_at = new Date().toISOString()
  if (params.status) w.status = String(params.status).slice(0, 500)
  if (typeof params.in_critical_section === 'boolean') w.in_critical_section = params.in_critical_section
  try { atomicWriteJson(path.join(WORKERS_DIR, ctx.tab_id + '.json'), w) } catch (e) {}
  return { ok: true, last_heartbeat_at: w.last_heartbeat_at }
}

async function report_progress(params, ctx) {
  params = params || {}
  ctx = ctx || {}
  return send_message({
    to: 'chat.conductor.inbox',
    body: { type: 'progress', task_id: params.task_id, summary: params.summary },
    task_id: params.task_id,
  }, ctx)
}

async function signal_done(params, ctx) {
  params = params || {}
  ctx = ctx || {}
  const r = await send_message({
    to: 'chat.conductor.inbox',
    body: {
      type: 'done',
      task_id: params.task_id,
      result_summary: params.result_summary,
      result_pointer: params.result_pointer || null,
      terminate: !!params.terminate,
    },
    task_id: params.task_id,
  }, ctx)
  if (ctx.tab_id && workers.has(ctx.tab_id)) {
    const w = workers.get(ctx.tab_id)
    w.terminated_at = new Date().toISOString()
    try { atomicWriteJson(path.join(WORKERS_DIR, ctx.tab_id + '.json'), w) } catch (e) {}
  }
  return r
}

// ── exports ──────────────────────────────────────────────────────────────

module.exports = {
  send_message: send_message,
  read_inbox: read_inbox,
  wait_for_inbox: wait_for_inbox,
  ack_message: ack_message,
  list_workers: list_workers,
  heartbeat: heartbeat,
  report_progress: report_progress,
  signal_done: signal_done,
  // Internal API for the /api/comms/register-worker route - NOT exposed as a tool.
  _registerWorkerInternal: registerWorkerInternal,
  _inboxTopicFor: inboxTopicFor,
}
