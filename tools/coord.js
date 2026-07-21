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
const os = require('os')

// 2026-05-29: env-overridable so test harnesses can sandbox to a tmp dir
// without polluting the production registry.
//
// 2026-07-18: the default was the bare Windows path, which on the Mac canonical
// host resolves to a LITERAL './D:\.code\EcodiaOS\coordination' dir under the
// agent's cwd - a ghost whose workers/ is always empty. This is the same bug
// 037d422 fixed in cowork.js and left here. It was dormant only because the
// live process happened to carry COORD_ROOT in its env from an earlier
// bootstrap: the laptop-agent plist does NOT set COORD_ROOT (the usage-poller
// plist does), and `launchctl kickstart -k` preserves the loaded env rather
// than re-reading the plist. So a reboot or a bootout/bootstrap would have
// silently pointed the ENTIRE coord substrate (worker registry, inboxes,
// messages, conductor rows) at an empty ghost dir, and every worker would have
// looked unregistered. A ghost briefs file dated 2026-07-17 10:51 shows some
// process already resolving this way.
//
// Platform-aware default, matching cowork.js: correct with no env at all, so
// the substrate no longer depends on an env var that one plist forgot.
// Doctrine: [[substrate-path-coupling-survives-host-swap-as-silent-no-op]],
//           [[launchctl-kickstart-does-not-reload-plist-env-use-bootout-bootstrap]]
const COORD_ROOT = process.env.COORD_ROOT || (
  process.platform === 'win32'
    ? 'D:\\.code\\EcodiaOS\\coordination'
    : path.join(os.homedir(), '.ecodiaos', 'coordination')
)
const WORKERS_DIR = path.join(COORD_ROOT, 'workers')
const MESSAGES_DIR = path.join(COORD_ROOT, 'messages')
const BRIEFS_DIR = path.join(COORD_ROOT, 'briefs')
const INBOX_DIR = path.join(COORD_ROOT, 'inbox')
const STATE_DIR = path.join(COORD_ROOT, 'state')  // already used by dispatcher for .spawned markers
const CONDUCTORS_DIR = path.join(COORD_ROOT, 'conductors')  // conductor registration rows
const WAKE_POLICY_FILE = path.join(COORD_ROOT, 'wake_policy.json')

const DEAD_HEARTBEAT_MS = 90 * 1000  // 90s without heartbeat = dead
const MAX_WAIT_TIMEOUT_S = 600       // 10min cap on long-poll
const WAIT_POLL_INTERVAL_MS = 1000   // 1s poll inside wait_for_inbox
const ALSO_UNREAD_CAP = 20           // wait_for_inbox bulk-return cap

// Topics that trigger a conductor wake notification on persistMessage.
// Match-by-prefix so chat.conductor.inbox + chat.conductor.<scope>.inbox both wake.
const WAKE_TOPIC_PREFIXES = ['chat.conductor.']

// Default wake policy if none on disk. Tate can override via coord.set_wake_policy.
const DEFAULT_WAKE_POLICY = Object.freeze({
  mode: 'toast',                       // 'toast' | 'flash' | 'auto_type' | 'silent'
  // 2026-05-18: inbound_sms + inbound_telegram added. Per Tate verbatim
  // ("a chat is opened on the first text i send per session then subscribes
  // to further texts"). The session-subscription path routes inbound chat
  // messages via coord.send_message instead of opening a fresh CC tab on
  // every inbound. The conductor's wake substrate (flash/toast/auto_type)
  // then surfaces the new message in the existing tab.
  notify_types: ['done', 'error', 'inbound_sms', 'inbound_telegram'],
  toast_duration_ms: 6000,
  rate_limit_ms: 2000,                 // suppress consecutive wakes within this window
})

// 2026-05-18: conductor freshness threshold. A conductor whose last_seen_at
// is older than this is treated as gone - inbound webhooks fall back to
// reflex.fire (cold spawn) rather than coord-routing into a dead tab.
const CONDUCTOR_STALE_THRESHOLD_MS = 30 * 60 * 1000  // 30 min

// ── filesystem helpers ───────────────────────────────────────────────────

const CONDUCTORS_HISTORY_DIR = path.join(CONDUCTORS_DIR, 'history')

function ensureDirs() {
  for (const d of [COORD_ROOT, WORKERS_DIR, MESSAGES_DIR, INBOX_DIR, STATE_DIR, CONDUCTORS_DIR, CONDUCTORS_HISTORY_DIR]) {
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

// ── conductor wake substrate ─────────────────────────────────────────────
//
// Problem: coord.signal_done writes to chat.conductor.inbox at the file
// substrate, but the conductor is a Claude Code chat tab with no daemon
// polling the inbox. Without a wake hook, the message sits there until a
// human prompts the tab. This kills autonomous worker→conductor handoff.
//
// Fix: any persistMessage() targeting chat.conductor.* fires a non-blocking
// wakeConductor() that surfaces the message to the human (toast) and
// optionally to the conductor tab itself (flash / auto_type).
//
// Future-proof shape:
//   - Multiple conductors supported via parent_conductor_tab_id on the
//     worker row. v1: single global conductor; v2 trivially routes per-msg.
//   - Wake mode is policy, not hardcoded - opt-in to focus-stealing.
//   - Notify-types filter: 'progress' floods, 'done' is the load-bearing one.

let _lastWakeAt = 0  // in-memory rate-limit (across requests this process serves)

const IN_TURN_TTL_MS = 10 * 60 * 1000  // 10min: auto-clear in_turn if Stop hook never fired

function loadConductorRegistration() {
  try {
    // Prefer current.json (the 2026-05-19 canonical name); fall back to
    // default.json for backward compat.
    let row = readJsonSafe(path.join(CONDUCTORS_DIR, 'current.json'))
    if (!row) row = readJsonSafe(path.join(CONDUCTORS_DIR, 'default.json'))
    if (!row) {
      const files = (() => { try { return fs.readdirSync(CONDUCTORS_DIR).filter(f => f.endsWith('.json')) } catch { return [] } })()
      if (files.length === 0) return null
      row = readJsonSafe(path.join(CONDUCTORS_DIR, files[0]))
      if (!row) return null
    }
    // TTL escape on stuck in_turn (crashed turn, Stop hook never fired).
    if (row.in_turn && row.in_turn_set_at) {
      const ageMs = Date.now() - new Date(row.in_turn_set_at).getTime()
      if (ageMs > IN_TURN_TTL_MS) {
        row.in_turn = false
        row.in_turn_set_at = null
        try {
          atomicWriteJson(path.join(CONDUCTORS_DIR, 'current.json'), row)
          atomicWriteJson(path.join(CONDUCTORS_DIR, 'default.json'), row)
        } catch (e) {}
      }
    }
    return row
  } catch (e) { return null }
}

// 2026-05-18: return null when the registered conductor's last_seen_at is
// stale. Inbound webhooks use this to decide route-to-coord vs cold-spawn.
function loadActiveConductorRegistration() {
  const c = loadConductorRegistration()
  if (!c) return null
  const lastSeenIso = c.last_seen_at || c.registered_at
  if (!lastSeenIso) return null
  const ageMs = Date.now() - new Date(lastSeenIso).getTime()
  if (ageMs > CONDUCTOR_STALE_THRESHOLD_MS) return null
  return c
}

function loadWakePolicy() {
  const onDisk = readJsonSafe(WAKE_POLICY_FILE)
  if (!onDisk) return Object.assign({}, DEFAULT_WAKE_POLICY)
  return Object.assign({}, DEFAULT_WAKE_POLICY, onDisk)
}

function isWakeTopic(topic) {
  if (!topic) return false
  for (const prefix of WAKE_TOPIC_PREFIXES) {
    if (topic.indexOf(prefix) === 0) return true
  }
  return false
}

function shouldWake(msg, policy) {
  if (!isWakeTopic(msg.to)) return false
  if (policy.mode === 'silent') return false
  const types = policy.notify_types || ['done', 'error']
  if (types.indexOf('*') !== -1) return true
  const t = (msg.body && typeof msg.body === 'object') ? msg.body.type : null
  if (!t) return false  // body has no type field - don't wake (free-form messages are noise)
  return types.indexOf(t) !== -1
}

function buildWakeNotice(msg) {
  const body = (msg.body && typeof msg.body === 'object') ? msg.body : {}
  const t = body.type || 'message'
  const taskId = body.task_id || msg.task_id || ''
  const from = msg.from || 'unknown'
  // Title kept short for Win10/11 toast truncation tolerance.
  const title = 'EcodiaOS: ' + t + (taskId ? ' [' + taskId.slice(0, 32) + ']' : '')
  let line2 = ''
  if (t === 'done') {
    line2 = (body.result_summary || '').slice(0, 200)
    if (body.result_pointer) line2 += (line2 ? '  ->  ' : '') + body.result_pointer
  } else if (t === 'error') {
    line2 = (body.error || body.result_summary || '').slice(0, 200)
  } else if (t === 'progress') {
    line2 = (body.summary || '').slice(0, 200)
  } else {
    line2 = JSON.stringify(body).slice(0, 200)
  }
  if (!line2) line2 = 'from ' + from
  return { title: title, body: line2 }
}

// Non-blocking. Errors swallowed - wake is best-effort, message persist must succeed
// even if notification path is wedged (high memory pressure, PS daemon dead, etc).
async function wakeConductor(msg) {
  try {
    const policy = loadWakePolicy()
    if (!shouldWake(msg, policy)) return
    const now = Date.now()
    if (now - _lastWakeAt < (policy.rate_limit_ms || 0)) return
    _lastWakeAt = now
    const notice = buildWakeNotice(msg)

    // Tier A: toast - always fires (visible without focus-stealing).
    try {
      const notification = require('./notification')
      // Don't await - toast can take 6s+ under load; persistMessage must not wait.
      notification.toast({ title: notice.title, body: notice.body, durationMs: policy.toast_duration_ms || 6000 })
        .catch(() => {})
    } catch (e) {}

    // Tier B + C only if conductor is registered.
    const conductor = loadConductorRegistration()
    if (!conductor) return

    if (policy.mode === 'flash' || policy.mode === 'auto_type') {
      try {
        const notification = require('./notification')
        notification.flash_window({ titleContains: conductor.title_match || '', count: 4 }).catch(() => {})
      } catch (e) {}
    }

    if (policy.mode === 'auto_type') {
      // Focus-steals. Opt-in only. Tate must explicitly set mode='auto_type'.
      // Skips if the conductor window itself is already foreground (no need to wake).
      try {
        const win = require('./window')
        const fg = await win.foreground().catch(() => null)
        const titleMatch = conductor.title_match || ''
        const alreadyFocused = fg && titleMatch && (fg.title || '').indexOf(titleMatch) !== -1
        if (!alreadyFocused) {
          await win.focus_window({ titleContains: titleMatch })
          await new Promise(r => setTimeout(r, 300))
          const input = require('./input')
          // Compose a short wake message Tate/conductor sees in chat input pre-Enter.
          const wakeText = '[wake] ' + notice.title + '\n' + notice.body
          await input.type({ text: wakeText })
          await new Promise(r => setTimeout(r, 200))
          await input.key({ key: 'enter' })
        }
      } catch (e) {}
    }
  } catch (e) {
    // Never let wake break persistMessage
  }
}

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
    tab_handle: null,  // set later by setWorkerTabHandle once dispatch_worker captures it
  }
  workers.set(tab_id, row)
  atomicWriteJson(path.join(WORKERS_DIR, tab_id + '.json'), row)
  // Also write the .spawned marker so dispatch_worker's waitForSpawnedAt sees it
  try { fs.writeFileSync(path.join(STATE_DIR, tab_id + '.spawned'), now, 'utf8') } catch (e) {}
  return row
}

// setWorkerTabHandle - persist the spawned tab's identity (label, viewColumn,
// viewType) into the worker registry row. Called from cowork.dispatch_worker
// after the ide.tabs diff identifies the new tab. Read by close_my_tab to
// target the exact tab via ide.tabs_close instead of focus-dependent
// closeActiveEditor. Both the in-memory Map AND the on-disk JSON are updated.
function setWorkerTabHandle(tab_id, tab_handle) {
  if (!tab_id || !tab_handle) return { ok: false, error: 'tab_id and tab_handle required' }
  if (!workers.has(tab_id)) return { ok: false, error: 'unknown_tab_id' }
  const w = workers.get(tab_id)
  w.tab_handle = tab_handle
  w.tab_handle_set_at = new Date().toISOString()
  try { atomicWriteJson(path.join(WORKERS_DIR, tab_id + '.json'), w) } catch (e) {}
  return { ok: true, tab_id: tab_id, tab_handle: tab_handle }
}

// loadWorkerRegistry - read a worker row from disk by tab_id.
//
// 2026-05-29 ultracode audit C1 fix. cowork.kill_worker runs in the same
// process as coord but had no way to load a stored tab_handle:
//   - the in-memory `workers` Map is module-private and not exported
//   - even if exported, dispatch_worker writes the row across an HTTP
//     boundary, so the cowork process reads an empty Map
// Disk is the canonical substrate written by setWorkerTabHandle, so a
// disk-read fallback gives every caller (cowork.kill_worker, scheduler
// cleanup, manual operator) a single source of truth for stored handles.
// Returns null if the file does not exist or is unreadable.
function loadWorkerRegistry(tab_id) {
  if (!tab_id) return null
  if (workers.has(tab_id)) return workers.get(tab_id)  // hot path - same-process callers
  try {
    const filePath = path.join(WORKERS_DIR, tab_id + '.json')
    if (!fs.existsSync(filePath)) return null
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (e) {
    return null
  }
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
  // Fire conductor wake hook (non-blocking, swallowed errors). Only triggers
  // for chat.conductor.* topics and message types listed in wake_policy.
  if (isWakeTopic(msg.to)) {
    setImmediate(() => { wakeConductor(msg).catch(() => {}) })
  }
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

// 2026-06-18 scheduler-completion-race fix. The scheduler's completionPass and
// the interactive conductor are BOTH consumers of chat.conductor.inbox, but a
// message carries a single per-message seen flag. The conductor's read_inbox
// marks a worker's `done` signal seen within ~1s of arrival; readInboxForTopic
// (used by peek_inbox) then skips it forever via the `if (m.seen_at) continue`
// filter, so completionPass never matches it and the os_scheduled_tasks row
// rots in status=running until the 6h orphan timer - silently dropping up to
// five fires of an hourly cron with zero alarm. scanTopicByType reads the FULL
// in-memory index (seen or unseen), does NOT mark seen, and returns the NEWEST
// matching message per task_id so the scheduler can detect completion
// independently of whoever else drains the inbox. The in-memory index is fully
// hydrated from disk on boot, so this is restart-safe. Doctrine:
// patterns/scheduler-completion-must-not-share-seen-flag-with-conductor-inbox-2026-06-18.md
function scanTopicByType(topic, type, taskIds) {
  const slug = safeTopicSlug(topic)
  const ids = inboxIndex.get(slug) || new Set()
  const wantTasks = (taskIds && taskIds.length) ? new Set(taskIds.map(String)) : null
  const byTask = new Map()  // task_id -> newest matching msg
  for (const id of ids) {
    const m = messagesById.get(id)
    if (!m || !m.body || m.body.type !== type) continue
    const tid = m.body.task_id != null ? String(m.body.task_id)
      : (m.task_id != null ? String(m.task_id) : null)
    if (!tid) continue
    if (wantTasks && !wantTasks.has(tid)) continue
    const prev = byTask.get(tid)
    if (!prev || new Date(m.created_at).getTime() > new Date(prev.created_at).getTime()) {
      byTask.set(tid, m)
    }
  }
  return byTask
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
  let messages = readInboxForTopic(topic, since, limit)
  // 2026-07-08 targeted-consume. When `ids` is supplied, mark seen ONLY the
  // messages in that id set (still scoped to this topic + unseen); return them.
  // Why: the conductor turn hooks (conductor_heartbeat.py / conductor_turn_end.py)
  // surface inbound_* SMS/telegram messages and then consumed them by calling
  // read_inbox with a bare `limit`, which marked the ENTIRE conductor inbox seen.
  // That collaterally consumed worker done/signal_done/progress messages, which
  // coord_events_pending.py (the turn-start peek that builds <coord_events>)
  // surfaces via readInboxForTopic's `if (m.seen_at) continue` filter - so every
  // worker completion report was marked seen before the conductor could see it
  // and silently vanished. Passing the surfaced message ids confines the consume
  // to exactly the inbound messages the hook handled. Backward compatible: no
  // `ids` => prior whole-topic drain behaviour. See
  // [[scheduler-signal-done-lost-when-conductor-turn-hook-blanket-consumes-inbox-2026-07-08]].
  if (Array.isArray(params.ids) && params.ids.length) {
    const want = new Set(params.ids.map(String))
    messages = messages.filter(m => want.has(String(m.id)))
  }
  markSeen(messages)
  return { topic: topic, count: messages.length, messages: messages }
}

// coord.peek_inbox - same shape as read_inbox but does NOT mark messages seen.
// Used by gui.sequence wait_for {type: 'coord_inbox_has'} so the wait probe
// doesn't consume the message that the next read_inbox caller will want.
// Also useful for diagnostic / observer flows that want to see what's queued
// without claiming it.
async function peek_inbox(params, ctx) {
  params = params || {}
  ctx = ctx || {}
  const topic = params.topic || inboxTopicFor(ctx)
  const since = params.since ? new Date(params.since).getTime() : 0
  const limit = params.limit || 50
  const messages = readInboxForTopic(topic, since, limit)
  // intentionally NO markSeen(messages)
  return { topic: topic, count: messages.length, messages: messages, peek: true }
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

// 2026-06-01: side-channel heartbeat touch for the /api/tool middleware.
// ANY successful tool call from a registered worker tab counts as a liveness
// signal - models doing real coding work make many non-coord tool calls
// (Read, Bash, db_execute, etc) and shouldn't have to explicitly heartbeat
// between them. Non-throwing. Returns false silently for non-worker tabs
// (conductors, ad-hoc calls) so the middleware can call it unconditionally.
function _touchHeartbeatForTab(tab_id) {
  if (!tab_id) return false
  const w = workers.get(tab_id)
  if (!w) return false
  if (w.terminated_at) return false
  w.last_heartbeat_at = new Date().toISOString()
  try { atomicWriteJson(path.join(WORKERS_DIR, tab_id + '.json'), w) } catch (e) {}
  return true
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
  // Look up parent_conductor_tab_id from the worker row so the wake hook can
  // route per-conductor (v2). Falls through silently if not set.
  let parent_conductor_tab_id = null
  if (ctx.tab_id && workers.has(ctx.tab_id)) {
    parent_conductor_tab_id = workers.get(ctx.tab_id).parent_conductor_tab_id || null
  }
  // 2026-06-09: status MUST be persisted in the body. The scheduler's
  // markComplete reads signal.status to decide success vs failure; dropping
  // it routed every signal_done through markFailed and stamped result_summary
  // into last_error. Audit found 48/48 rows with last_error set, 0 clean
  // successes - every cron looked like a failure since this field was lost.
  // See [[scheduler-signal-done-status-must-survive-coord-to-inbox-2026-06-09]].
  const r = await send_message({
    to: 'chat.conductor.inbox',
    body: {
      type: 'done',
      task_id: params.task_id,
      status: params.status || 'success',
      result_summary: params.result_summary,
      result_pointer: params.result_pointer || null,
      terminate: !!params.terminate,
      parent_conductor_tab_id: parent_conductor_tab_id,
    },
    task_id: params.task_id,
  }, ctx)
  if (ctx.tab_id && workers.has(ctx.tab_id)) {
    const w = workers.get(ctx.tab_id)
    w.terminated_at = new Date().toISOString()
    w.terminated_reason = w.terminated_reason || 'signal_done'
    try { atomicWriteJson(path.join(WORKERS_DIR, ctx.tab_id + '.json'), w) } catch (e) {}
    // 2026-05-18 worker-registry-truth pattern: signal_done MUST unlink the
    // .spawned marker so any consumer reading mtime as a liveness proxy
    // (Cursor sweeper) gets a correct gone-is-not-running answer.
    try { fs.unlinkSync(path.join(STATE_DIR, ctx.tab_id + '.spawned')) } catch (e) {}
  }
  return r
}

// close_my_tab - worker self-closes its IDE chat tab after signal_done.
//
// Why: signal_done already marks the worker terminated in the registry, but
// the IDE chat tab stays open. Without this, tabs accumulate and burn memory
// (each Claude Code chat is a webview). The brief instructs workers to call
// this as the LAST action right after signal_done({terminate:true}).
//
// Mechanism: targets the worker's own active editor (the chat panel the
// worker is running inside) via the conductor's IDE bridge. Workers cannot
// access ide.* MCP directly, so coord proxies it. Best-effort - swallows
// failures rather than killing the worker arc on a transient IDE-bridge hiccup.
async function close_my_tab(params, ctx) {
  ctx = ctx || {}
  if (!ctx.tab_id) {
    return { ok: false, error: 'tab_id required (set X-Tab-Id header or pass tab_id param)' }
  }
  const conductor = loadConductorRegistration()
  if (!conductor || !conductor.ide_bridge_port) {
    return { ok: false, error: 'no_conductor_ide_port', tab_id: ctx.tab_id }
  }
  // Lazy-require ide to avoid circular deps.
  let ide
  try { ide = require('./ide') } catch (e) { return { ok: false, error: 'ide_module_unavailable' } }

  // 2026-05-28 patch v2. Target the worker's specific tab via ide.tabs_close
  // using the stored tab_handle ({label, viewColumn, viewType}) that
  // cowork.dispatch_worker captured at spawn time via ide.tabs diff. This
  // removes ALL focus dependencies from the close path - no matter what
  // Tate is currently looking at, the right tab gets closed.
  //
  // Three execution paths:
  //   Primary: stored tab_handle + match by (viewColumn, viewType) + label
  //     (tries label match first; if chat has auto-retitled, falls back to
  //     active-CC-chat-in-stored-viewColumn).
  //   Fallback: no stored tab_handle (legacy workers spawned before this
  //     patch landed). Use the safety gate: probe ide.tabs, only close if
  //     the active editor is a CC chat. Same as v1 patch.
  //   Refuse: nothing safely targetable. Mark refused, exit without closing.
  //
  // Doctrine:
  //   ~/ecodiaos/patterns/cowork-kill-worker-tab-handle-from-foreground-after-spawn-is-unsafe-2026-05-28.md
  const CC_CHAT_VIEW_TYPE = 'mainThreadWebview-claudeVSCodePanel'
  let closed = false
  let refused = null
  let error = null
  let close_strategy = null

  const stored = workers.has(ctx.tab_id) ? workers.get(ctx.tab_id).tab_handle : null

  // 2026-05-28 patch v3 (STRICT). Earlier versions had an active-tab fallback
  // that closed whatever Tate happened to be focused on at close time -
  // because CC chats auto-retitle from first message content, the stored
  // label rarely matched at close time, and the fallback path closed the
  // user's active chat instead. Mass-close incident (4+ CC chats lost).
  //
  // New behavior: STRICT exact-label match only. If the stored label still
  // matches a tab in the stored viewColumn + viewType, close it. Otherwise
  // refuse and leak the orphan tab. Better leak than wrong-close.
  //
  // The label-pinning architectural fix (rename the spawned tab to a
  // deterministic name via agentSession.rename or equivalent) failed at
  // probe time (rename command is interactive, hung 30s waiting for user
  // input). Position-based targeting and sentinel-first-message-auto-title
  // are open research items. Until one lands, tab leakage is acceptable.
  //
  // Doctrine: cowork-kill-worker-tab-handle-from-foreground-after-spawn-
  // is-unsafe-2026-05-28.md + this patch's new pattern (TODO).
  try {
    if (!stored || stored.viewType !== CC_CHAT_VIEW_TYPE || stored.viewColumn == null) {
      refused = 'no_stored_tab_handle_or_incomplete:' + JSON.stringify(stored || null).slice(0, 200)
    } else {
      // 2026-05-29 patch v5: POSITION HANDLE FIRST.
      //
      // Closure precedence:
      //   (a) tabIndex (bridge v2): direct close of tabGroups[vc].tabs[index],
      //       gated by viewType match. Stable spawn-and-close handle that
      //       SURVIVES auto-title summarisation. Primary path.
      //   (b) sentinel_prefix: chat label still startsWith stored prefix.
      //       Works when brief was short enough that auto-title preserved it.
      //   (c) exact_label fallback: chat label still matches stored
      //       label_at_spawn exactly (very rare post-autotitle).
      //
      // If none match -> REFUSE and leak. Better leak than wrong-close.
      // (v3 mass-close incident: 4+ CC chats lost.)
      const tabsResult = await ide.tabs({ ide_port: conductor.ide_bridge_port })
      const groups = (tabsResult && (tabsResult.groups || (tabsResult.result && tabsResult.result.groups))) || []

      let foundExact = null
      let matchedBy = null
      const storedTabIndex = (typeof stored.tabIndex === 'number') ? stored.tabIndex : null
      const sentinelPrefix = stored.sentinel_prefix || null
      const exactLabel = stored.label || stored.label_at_spawn || null
      // 2026-06-25. The default untitled CC chat label is 'Claude Code' - EVERY
      // freshly-spawned worker tab AND the conductor AND Tate's own new chats
      // carry it until they auto-retitle. It is therefore NOT an identity key:
      // matching a worker by exactLabel='Claude Code' grabs the first untitled
      // tab in the column, which is routinely the conductor or a sibling. That
      // is the wrong-MATCH half of the mass-close cascade (the multi-close half
      // is fixed by always sending a current tabIndex). A worker still showing
      // the generic label must be identified ONLY by sentinel_prefix or a
      // confirmed fingerprint; if neither matches, REFUSE and leak.
      // Doctrine: coord-close-my-tab-multi-close-on-shared-label-2026-06-25.
      const isGenericLabel = (s) => !s || s === 'Claude Code' || s === 'New Chat' || s === 'Cursor'
      const candidates = []
      let group = null
      for (const g of groups) {
        if (g.viewColumn !== stored.viewColumn) continue
        group = g
        for (const t of (g.tabs || [])) {
          if (t.viewType === CC_CHAT_VIEW_TYPE) candidates.push(t)
        }
        break
      }

      // (a) tabIndex match - REQUIRES label OR sentinel-prefix confirmation.
      //
      // 2026-05-29 ultracode audit C2 fix. Previous version accepted tier (a)
      // on viewType match alone. storedTabIndex is captured once at spawn and
      // never refreshed; any tab insert/close/reorder at a LOWER index before
      // close shifts our worker's position. The index then resolves to a
      // DIFFERENT live CC chat - wrong-close reintroduced (Woodford-murder).
      //
      // Fix: require the tab AT storedTabIndex to ALSO match label_at_spawn
      // OR startsWith(sentinel_prefix). If both stale, fall through to (b)/(c).
      // tabIndex becomes a fast-path tiebreaker WITHIN the identity-confirmed
      // set, never a standalone key.
      if (group && storedTabIndex != null) {
        const tabAtIndex = (group.tabs || [])[storedTabIndex]
        if (tabAtIndex && tabAtIndex.viewType === CC_CHAT_VIEW_TYPE) {
          const labelMatch = exactLabel && !isGenericLabel(exactLabel) && tabAtIndex.label === exactLabel
          const sentinelMatch = sentinelPrefix && tabAtIndex.label && tabAtIndex.label.startsWith(sentinelPrefix)
          if (labelMatch || sentinelMatch) {
            foundExact = tabAtIndex
            matchedBy = 'tabIndex+' + (sentinelMatch ? 'sentinel' : 'label') + ':' + storedTabIndex
          }
        }
      }

      // (b) sentinel_prefix match
      if (!foundExact && sentinelPrefix) {
        const hit = candidates.find(t => t.label && t.label.startsWith(sentinelPrefix))
        if (hit) { foundExact = hit; matchedBy = 'sentinel_prefix:' + sentinelPrefix }
      }

      // (c) exact_label match (legacy fallback) - NEVER on the generic default
      // label, which matches every untitled tab including the conductor.
      if (!foundExact && exactLabel && !isGenericLabel(exactLabel)) {
        const hit = candidates.find(t => t.label === exactLabel)
        if (hit) { foundExact = hit; matchedBy = 'exact_label:' + exactLabel }
      }

      // (d) auto-title fingerprint match. 2026-06-22. The sentinel + spawn label
      // are gone once Claude Code summarises the brief into the tab title, so
      // (a)/(b)/(c) all miss for any worker that ran long enough to be retitled
      // (the common case). The auto-title is drawn from the brief, so a
      // fingerprint of the brief's salient tokens recognises it. Uniqueness-
      // gated inside pickByFingerprint: closes ONLY on a single decisive winner,
      // else returns null and we still refuse + leak (never wrong-close).
      // Doctrine: cc-auto-title-summarizer-strips-eos-w-sentinel-tabs-leak-2026-06-08.
      let fingerprintReason = null
      if (!foundExact && stored.autotitle_fingerprint) {
        try {
          const ttm = require('./tab-title-match')
          const picked = ttm.pickByFingerprint(candidates, stored.autotitle_fingerprint, sentinelPrefix)
          fingerprintReason = picked.reason
          if (picked.match) { foundExact = picked.match; matchedBy = 'autotitle_' + picked.reason }
        } catch (e) { fingerprintReason = 'fingerprint_error:' + (e.message || String(e)) }
      }

      if (!foundExact) {
        // 2026-05-29 Fix C: echo the candidate set inline so a no_match is
        // debuggable in ONE round-trip (was just a count, which forced a
        // separate ide.tabs probe to see what was actually there).
        const candLabels = candidates.map((t, i) => (typeof t.index === 'number' ? t.index : i) + ':"' + (t.label || '') + '"').join(', ')
        refused = 'no_match:tabIndex=' + (storedTabIndex == null ? 'null' : storedTabIndex)
          + '|sentinel=' + (sentinelPrefix || 'null')
          + '|exact=' + (exactLabel || 'null')
          + '|fp=' + (fingerprintReason || (stored.autotitle_fingerprint ? 'no_match' : 'absent'))
          + '|vc' + stored.viewColumn + ' (candidates=' + candidates.length + ': [' + candLabels + '])'
      } else {
        // Compose close request. 2026-06-25 multi-close fix: ALWAYS send the
        // CURRENT index of the matched tab, regardless of which tier (a/b/c/d)
        // resolved it. foundExact came from the fresh ide.tabs() probe a few
        // lines up, so foundExact.index is its live position, NOT the stale
        // spawn-time storedTabIndex. This routes the close through the bridge's
        // deterministic Path A (closes exactly tabGroups[vc].tabs[index], gated
        // by exactLabel + viewType) for EVERY tier - the bridge's else-branch
        // label loop can match and close MULTIPLE tabs when two CC chats share
        // an identical auto-summarised title, which is the "closed itself AND
        // another chat" wrong-close. tiers (c) exact_label and (d) autotitle
        // previously sent no tabIndex and took that multi-close-capable branch.
        // exactLabel stays as the race guard: if the tab shifted in the ms
        // between probe and close, the bridge refuses rather than wrong-closes.
        // Doctrine: coord-close-my-tab-multi-close-on-shared-label-2026-06-25.
        const closeReq = {
          viewColumn: stored.viewColumn,
          viewType: CC_CHAT_VIEW_TYPE,
          exactLabel: foundExact.label,  // single-target race guard + sanity check
          ide_port: conductor.ide_bridge_port,
        }
        if (typeof foundExact.index === 'number') {
          closeReq.tabIndex = foundExact.index  // current index from the fresh probe -> deterministic single close
        } else {
          // No positional handle from the probe (should not happen) - fall back
          // to exact-label; the bridge refuses on exactLabel ambiguity so this
          // still cannot mass-close.
          closeReq.label = foundExact.label  // legacy substring fallback for pre-v2 bridges
        }
        const closeResult = await ide.tabs_close(closeReq)
        const inner = (closeResult && closeResult.result) || closeResult || {}
        closed = (typeof inner.closed === 'number' ? inner.closed > 0 : !!inner.ok)
        close_strategy = closed ? matchedBy : 'match_found_but_close_failed:' + matchedBy + ':' + (inner.refused || 'closed=0')
        if (!closed) refused = 'tabs_close_returned_no_close:matched=' + (inner.matched || 0) + ' refused=' + (inner.refused || 'none')
      }
    }
  } catch (e) {
    error = e.message || String(e)
  }
  // Worker is done either way - mark closed_tab_at so the sweep can tell
  // tabs-leaked from clean-exits-that-refused-to-close.
  if (workers.has(ctx.tab_id)) {
    const w = workers.get(ctx.tab_id)
    w.closed_tab_at = new Date().toISOString()
    w.closed_tab_ok = closed
    w.closed_tab_strategy = close_strategy
    if (refused) w.closed_tab_refused_reason = refused
    try { atomicWriteJson(path.join(WORKERS_DIR, ctx.tab_id + '.json'), w) } catch (e) {}
  }
  return {
    ok: true,
    tab_id: ctx.tab_id,
    closed: closed,
    strategy: close_strategy,
    refused: refused,
    error: error,
    used_stored_handle: !!stored,
  }
}

// signal_bound - sent by a spawned worker on first turn to confirm it launched
// successfully, read its brief, and connected to MCP. Releases the scheduler's
// launch-lock (dispatch_worker's worker_acknowledgment_timeout_ms window).
//
// Mirrors signal_done in structure: posts to chat.conductor.inbox with a typed
// body so the conductor can filter by body.type === "bound". Does NOT terminate
// the worker row or unlink the .spawned marker - those are done-specific side
// effects. The .spawned marker must stay alive until the worker signals done.
async function signal_bound(params, ctx) {
  params = params || {}
  ctx = ctx || {}
  // Look up parent_conductor_tab_id from the worker row, same as signal_done.
  let parent_conductor_tab_id = null
  if (ctx.tab_id && workers.has(ctx.tab_id)) {
    parent_conductor_tab_id = workers.get(ctx.tab_id).parent_conductor_tab_id || null
  }
  const r = await send_message({
    to: 'chat.conductor.inbox',
    body: {
      type: 'bound',
      task_id: params.task_id,
      parent_conductor_tab_id: parent_conductor_tab_id,
    },
    task_id: params.task_id,
  }, ctx)
  // No worker-row termination and no .spawned unlink here.
  // The worker is confirming it is ALIVE and has read its brief; it will
  // keep running until it sends signal_done.
  return r
}

// ── kill_worker (conductor-callable HARD stop) ───────────────────────────
//
// 2026-07-18. close_my_tab is SELF-only: a worker that never polls its inbox
// cannot be reached, so a stand-down had no enforcement and Tate had to close
// the tab by hand. cowork.kill_worker already did the safe single-tab close for
// the scheduler's orphan sweep, but it was never on the MCP surface, so the
// conductor could not call it. This is that exposure, plus the guards a
// conductor-facing kill needs that an internal sweep did not.
//
// The target is named target_tab_id, NOT tab_id, on purpose. Every other coord.*
// tool reads tab_id as "who am I" (the caller identity ctx), and mcpCoord.js
// injects tab_id into every tool schema for exactly that reason. Reusing tab_id
// for "who do I kill" would collide the two meanings in one call, which is how a
// caller ends up killing itself or the wrong tab. A distinct name makes the
// target explicit and unambiguous at every layer.
//
// Mass-close is impossible BY CONSTRUCTION, not by convention: this takes one
// exact string, never a filter object, and resolves it through the worker
// registry to a single stored tab_handle. There is no code path here that can
// produce a multi-tab match. That is the structural lesson of the mass-close
// incident (a {viewColumn, viewType} filter matched every chat tab in the
// column); the bridge refuses identity-less filters as the backstop, and this
// layer never builds one in the first place.
// Doctrine: [[worker-interruptibility-soft-poll-hard-kill-2026-07-18]],
//           [[coord-close-my-tab-multi-close-on-shared-label-2026-06-25]].

// tab_id is interpolated into a filesystem path by loadWorkerRegistry
// (path.join(WORKERS_DIR, tab_id + '.json')), so a traversal-shaped id must
// never reach it. Real ids look like tab_1784292867909_94dddf94.
const SAFE_TAB_ID_RE = /^[A-Za-z0-9._-]+$/

async function kill_worker(params, ctx) {
  params = params || {}
  ctx = ctx || {}
  const killed_by = ctx.tab_id || 'conductor'
  const reason = params.reason || null
  const raw = params.target_tab_id

  const refuse = (refused, extra) => {
    const out = Object.assign({ ok: false, closed: false, refused: refused, killed_by: killed_by }, extra || {})
    try {
      process.stderr.write('[coord] kill_worker REFUSED by=' + killed_by + ' target=' +
        (typeof raw === 'string' ? raw : typeof raw) + ' reason=' + refused + '\n')
    } catch (e) {}
    return out
  }

  // GUARD 1: identity-less kill. No target, no kill. This is the same refusal
  // the IDE bridge makes on a filter carrying no identity (2d980f88); enforcing
  // it here too means a caller bug cannot even reach the bridge to be refused.
  if (typeof raw !== 'string' || !raw.trim()) {
    return refuse('identity_less_kill: target_tab_id required (exact worker tab id, never a filter or wildcard)')
  }
  const target_tab_id = raw.trim()

  // GUARD 2: no wildcard / glob / "all". There is no bulk kill and there will
  // not be one: bulk is what cleanup_orphan_workers does, per-orphan, through
  // this same single-target path.
  if (!SAFE_TAB_ID_RE.test(target_tab_id) || target_tab_id.toLowerCase() === 'all') {
    return refuse('unsafe_or_wildcard_target: target_tab_id must match ' + String(SAFE_TAB_ID_RE), { target_tab_id: target_tab_id })
  }

  // GUARD 3: never the conductor. The conductor is not a worker and killing it
  // takes down the session driving the fleet. Checks the literal default id and
  // the registered row, stale or not (a stale registration still means that tab
  // is a conductor, not a worker).
  const conductorRow = loadConductorRegistration()
  const conductorIds = new Set(['conductor'])
  if (conductorRow && conductorRow.tab_id) conductorIds.add(conductorRow.tab_id)
  if (conductorIds.has(target_tab_id)) {
    return refuse('conductor_tab_refused: kill_worker targets dispatched workers only', { target_tab_id: target_tab_id })
  }

  // GUARD 4: must be a registered worker with a stored handle. An unregistered
  // id has no tab_handle, so cowork.kill_worker would refuse-and-leak anyway;
  // failing here makes the reason legible instead of surfacing as a no_match.
  const row = loadWorkerRegistry(target_tab_id)
  if (!row) {
    return refuse('unknown_worker: no registry row for target_tab_id', { target_tab_id: target_tab_id })
  }

  // Delegate the close itself. cowork.kill_worker owns the tab-handle
  // resolution precedence (tabIndex+identity / sentinel / exact label /
  // fingerprint), refuses on a generic label, and always sends a live index +
  // exactLabel so the bridge routes through its deterministic single-target
  // path. Do not reimplement that here; one owner for the close.
  // Lazy require: cowork requires coord, so a top-level require is circular.
  let closed = false
  let refused = null
  let error = null
  try {
    const cowork = require('./cowork')
    const res = await cowork.kill_worker({ tab_id: target_tab_id })
    closed = !!(res && res.closed)
    refused = (res && res.refused) || null
    error = (res && res.error) || null
  } catch (e) {
    error = e.message || String(e)
  }

  try {
    process.stderr.write('[coord] kill_worker by=' + killed_by + ' target=' + target_tab_id +
      ' closed=' + closed + (refused ? ' refused=' + refused : '') +
      (reason ? ' reason=' + JSON.stringify(reason) : '') + '\n')
  } catch (e) {}

  return {
    ok: true,
    target_tab_id: target_tab_id,
    closed: closed,
    refused: refused,
    error: error,
    killed_by: killed_by,
    reason: reason,
  }
}

// ── sweep loop ───────────────────────────────────────────────────────────
// Periodic janitor: mark stale workers terminated + unlink their .spawned
// markers. Per pattern worker-registry-truth-is-on-disk-not-mtime-2026-05-18.
// Workers that crash or have their tab closed never call signal_done; their
// registry rows would stay ALIVE forever without this sweep.
// Cadence: every 60s. Threshold bumped 2026-06-01: workers doing real coding
// work (reading large files, planning, running tests, multi-step refactors)
// routinely go 3-8min between explicit coord.heartbeat calls. The previous
// 180s threshold was killing ~40% of workers mid-task ("heartbeat-then-die"
// failure mode observed during Phase A1 scheduler-unification dispatches).
// Combined with the touch_heartbeat_for_tab middleware in index.js, ANY
// successful tool call from a registered worker now bumps last_heartbeat_at,
// so the sweep only catches genuinely-dead tabs.

const SWEEP_INTERVAL_MS = 60 * 1000
// 2026-06-01: bumped 10min -> 60min after Phase A2 incident. The auto-heartbeat
// middleware in /api/tool only catches MCP tool calls hitting the laptop-agent;
// Claude Code's built-in Bash/Read/Grep/Edit bypass it entirely. So a worker
// can be doing real coding work for >10min using only built-ins and get swept.
// 60min gives substantial coding tasks room without masking genuine deaths.
const SWEEP_STALE_THRESHOLD_MS = 60 * 60 * 1000  // 60 min

// 2026-06-29 disk-leak root-cause fix. Terminated worker .json files were NEVER
// unlinked by ANY code path: this sweep only removed the STATE_DIR .spawned
// marker, and cleanup_orphan_workers only closes IDE tabs + stamps
// closed_tab_ok=true on the .json. So the registry grew unbounded (3468 stale
// files on 2026-06-29, oldest 2026-06-08), forcing countActiveWorkers() and
// loadFromDisk() to readdir+JSON.parse the whole pile on every rotate_to /
// startup. A terminated row has no remaining consumer once its tab is confirmed
// closed (countActiveWorkers + hasLiveWorkerForTask both skip terminated rows;
// cleanup_orphan_workers can no longer tabIndex-match a long-gone tab), so GC it.
// closed_tab_ok=true -> unlink immediately (common signal_done -> close_my_tab
// path). Otherwise keep until WORKER_JSON_RETENTION_MS as a backstop so a
// not-yet-closed tab still has a window for cleanup_orphan_workers to match it
// against live ide.tabs(); a tab gone longer than that is unmatchable anyway.
const WORKER_JSON_RETENTION_MS = 24 * 60 * 60 * 1000  // 24h

function sweepStaleWorkers() {
  const now = Date.now()
  const nowIso = new Date(now).toISOString()
  let marked = 0
  let unlinked = 0
  let purged = 0
  // 2026-07-21 conductor-exemption. The interactive conductor tab registers via
  // register_conductor and emits conductor_heartbeat, NOT a coord WORKER
  // heartbeat. If a row bearing the conductor's tab_id ever lands in the worker
  // map (stray register-worker, replayed row, tab_id reuse), the stale-heartbeat
  // sweep below would mark it terminated + unlink its .spawned marker every
  // cycle, which the downstream cleanup_orphan_workers close path can then turn
  // into a real IDE-tab close of the live conductor. A registered conductor is
  // NEVER a stale worker. Read the registered conductor tab_id once and skip it.
  // Doctrine: coord-sweep-must-exempt-registered-conductor-tab-2026-07-21,
  //           grace-timer-must-not-kill-chat-session.
  let conductorTabId = null
  try { const c = loadConductorRegistration(); if (c && c.tab_id) conductorTabId = c.tab_id } catch (e) {}
  for (const [tab_id, w] of workers.entries()) {
    if (conductorTabId && tab_id === conductorTabId) {
      try { process.stderr.write('[coord-sweep] skipped registered conductor tab ' + tab_id + ' (never a stale worker)\n') } catch (e) {}
      continue
    }
    if (w.terminated_at) {
      // Already terminated - ensure .spawned is gone too (cheap idempotent op).
      try {
        if (fs.existsSync(path.join(STATE_DIR, tab_id + '.spawned'))) {
          fs.unlinkSync(path.join(STATE_DIR, tab_id + '.spawned'))
          unlinked++
        }
      } catch (e) {}
      // GC the registry .json once the tab is confirmed closed, or after the
      // retention backstop. See WORKER_JSON_RETENTION_MS note above.
      const termMs = Date.parse(w.terminated_at)
      const ageOk = Number.isFinite(termMs) && (now - termMs) > WORKER_JSON_RETENTION_MS
      if (w.closed_tab_ok === true || ageOk) {
        try {
          fs.unlinkSync(path.join(WORKERS_DIR, tab_id + '.json'))
          workers.delete(tab_id)
          purged++
        } catch (e) {}
      }
      continue
    }
    const lastHbMs = new Date(w.last_heartbeat_at || w.registered_at).getTime()
    const stale_ms = now - lastHbMs
    if (stale_ms > SWEEP_STALE_THRESHOLD_MS) {
      w.terminated_at = nowIso
      w.terminated_reason = 'stale_heartbeat'
      w.stale_at_termination_ms = stale_ms
      try { atomicWriteJson(path.join(WORKERS_DIR, tab_id + '.json'), w) } catch (e) {}
      try {
        if (fs.existsSync(path.join(STATE_DIR, tab_id + '.spawned'))) {
          fs.unlinkSync(path.join(STATE_DIR, tab_id + '.spawned'))
          unlinked++
        }
      } catch (e) {}
      marked++
    }
  }
  if (marked > 0 || unlinked > 0 || purged > 0) {
    try { process.stderr.write(`[coord-sweep] marked=${marked} unlinked=${unlinked} purged=${purged}\n`) } catch (e) {}
  }
  return { marked, unlinked, purged }
}

// Start the sweep loop unless explicitly disabled (e.g. for unit tests).
let _sweepTimer = null
function startSweepLoop() {
  if (_sweepTimer) return
  _sweepTimer = setInterval(sweepStaleWorkers, SWEEP_INTERVAL_MS)
  if (_sweepTimer.unref) _sweepTimer.unref()
}
function stopSweepLoop() {
  if (_sweepTimer) { clearInterval(_sweepTimer); _sweepTimer = null }
}
if (process.env.COORD_DISABLE_SWEEP !== '1') {
  startSweepLoop()
}

// 2026-05-18 brief-on-disk-canonical: workers call this on first turn to get
// the authoritative brief from disk (the dispatcher's audit file). Clipboard
// paste then becomes just an identity-trigger; brief content authority lives
// on the filesystem where it can't be truncated by a paste race. See pattern
// brief-on-disk-is-canonical-not-chat-paste-2026-05-18.
async function verify_paste(params, ctx) {
  params = params || {}
  ctx = ctx || {}
  if (!ctx.tab_id) return { ok: false, error: 'tab_id required (X-Tab-Id header or params.tab_id)' }
  const w = workers.get(ctx.tab_id)
  if (!w) return { ok: false, error: 'worker not registered: ' + ctx.tab_id }
  // task_id either from caller or from the worker row written at register time.
  const task_id = params.task_id || w.task_id
  if (!task_id) return { ok: false, error: 'task_id required (no task_id on worker row)' }
  const briefFile = path.join(BRIEFS_DIR, task_id + '.md')
  let brief_body = null
  try { brief_body = fs.readFileSync(briefFile, 'utf8') } catch (e) {
    return { ok: false, error: 'brief file unreadable: ' + briefFile + ' (' + e.message + ')' }
  }
  const brief_sha256 = crypto.createHash('sha256').update(brief_body).digest('hex')
  return {
    ok: true,
    task_id: task_id,
    tab_id: ctx.tab_id,
    brief_file: briefFile.replace(/\\/g, '/'),
    brief_size_bytes: Buffer.byteLength(brief_body, 'utf8'),
    brief_sha256: brief_sha256,
    brief_body: brief_body,
    registered_at: w.registered_at,
    parent_conductor_tab_id: w.parent_conductor_tab_id || null,
    note: 'Authoritative brief from disk. Treat this as the source-of-truth, NOT whatever was pasted into your chat (the paste may have been truncated by a clipboard race under memory pressure).',
  }
}

// ── conductor wake tools ─────────────────────────────────────────────────

async function register_conductor(params, ctx) {
  params = params || {}
  ctx = ctx || {}
  ensureDirs()
  // tab_id can come from ctx (worker-style header) OR explicit param.
  // For the conductor, ctx.tab_id is usually absent so the param is canonical.
  const tab_id = params.tab_id || ctx.tab_id || 'conductor'
  const ide = params.ide || 'cursor'  // cursor | stable | insiders
  // title_match: substring to look up the conductor's window during wake.
  // If not provided, try foreground at register-time as a one-shot probe.
  let title_match = params.title_match || null
  let hwnd = params.hwnd || null
  let exe = params.exe || null

  if (!title_match) {
    try {
      const win = require('./window')
      const fg = await win.foreground()
      if (fg) {
        title_match = fg.title || ''
        hwnd = fg.hwnd
        exe = fg.exe
      }
    } catch (e) {}
  }

  // 2026-05-19 one-conductor-many-channels: richer fields for IDE-bridge
  // targeting. Caller (conductor_heartbeat.py) passes claude_port, ide_pid,
  // ide_bridge_port, workspace_root. We also detect takeover: if an existing
  // conductor record has a DIFFERENT claude_port, archive it to history
  // and the new claim wins. Same claude_port = same chat, just refresh.
  const claude_port = params.claude_port || null
  const ide_pid = params.ide_pid || null
  const ide_bridge_port = params.ide_bridge_port || null
  const workspace_root = params.workspace_root || null

  const existing = loadConductorRegistration()
  let prior_conductor_tab_id = null
  let took_over = false
  if (existing && claude_port && existing.claude_port && existing.claude_port !== claude_port) {
    // Different Claude Code chat = takeover. Archive old.
    prior_conductor_tab_id = existing.tab_id || existing.claude_port
    try {
      const archiveName = (existing.tab_id || 'conductor') + '-' + (existing.registered_at || Date.now()).replace(/[:.]/g, '-') + '.json'
      atomicWriteJson(path.join(CONDUCTORS_HISTORY_DIR, archiveName), existing)
    } catch (e) {}
    took_over = true
  } else if (existing && (!existing.claude_port || !claude_port)) {
    // Backward-compat: existing record lacks claude_port. Treat as same conductor.
    prior_conductor_tab_id = existing.tab_id || null
  }

  const now = new Date().toISOString()
  const row = {
    tab_id: tab_id,
    ide: ide,
    title_match: title_match || '',
    hwnd: hwnd || null,
    exe: exe || null,
    // 2026-05-19 extensions:
    claude_port: claude_port,
    ide_pid: ide_pid,
    ide_bridge_port: ide_bridge_port,
    workspace_root: workspace_root,
    prior_conductor_tab_id: prior_conductor_tab_id,
    in_turn: false,
    in_turn_set_at: null,
    registered_at: now,
    last_seen_at: now,
  }
  // v1: persist as default conductor. v2: keyed by tab_id when multi-conductor lands.
  atomicWriteJson(path.join(CONDUCTORS_DIR, 'default.json'), row)
  // Also write to current.json (the new canonical name per spec).
  atomicWriteJson(path.join(CONDUCTORS_DIR, 'current.json'), row)
  if (tab_id !== 'conductor') {
    atomicWriteJson(path.join(CONDUCTORS_DIR, tab_id + '.json'), row)
  }
  return { ok: true, conductor: row, took_over: took_over, prior_conductor_tab_id: prior_conductor_tab_id }
}

/**
 * Set / clear the in_turn mutex on the active conductor record. The
 * UserPromptSubmit hook sets in_turn=true at turn-start; the Stop hook clears
 * it at turn-end. While true, reflex.append_to_conductor defers paste and
 * leaves messages in coord inbox.
 *
 * Includes a 10-min TTL escape: if in_turn_set_at is older than that, the
 * mutex auto-clears on read (handles crashed turns where Stop hook didn't fire).
 */
async function set_conductor_in_turn(params, _ctx) {
  params = params || {}
  ensureDirs()
  const conductor = loadConductorRegistration()
  if (!conductor) return { ok: false, error: 'no_conductor_registered' }
  const desired = !!params.in_turn
  conductor.in_turn = desired
  conductor.in_turn_set_at = desired ? new Date().toISOString() : null
  try {
    atomicWriteJson(path.join(CONDUCTORS_DIR, 'default.json'), conductor)
    atomicWriteJson(path.join(CONDUCTORS_DIR, 'current.json'), conductor)
    if (conductor.tab_id && conductor.tab_id !== 'conductor') {
      atomicWriteJson(path.join(CONDUCTORS_DIR, conductor.tab_id + '.json'), conductor)
    }
  } catch (e) {}
  return { ok: true, in_turn: conductor.in_turn, in_turn_set_at: conductor.in_turn_set_at }
}

async function unregister_conductor(params, ctx) {
  params = params || {}
  const tab_id = params.tab_id || (ctx && ctx.tab_id) || null
  ensureDirs()
  const removed = []
  try { fs.unlinkSync(path.join(CONDUCTORS_DIR, 'default.json')); removed.push('default') } catch (e) {}
  if (tab_id && tab_id !== 'conductor') {
    try { fs.unlinkSync(path.join(CONDUCTORS_DIR, tab_id + '.json')); removed.push(tab_id) } catch (e) {}
  }
  return { ok: true, removed: removed }
}

async function get_conductor_state(_params) {
  const conductor = loadConductorRegistration()
  const active = loadActiveConductorRegistration()
  const policy = loadWakePolicy()
  let stale_ms = null
  if (conductor) {
    const lastSeenIso = conductor.last_seen_at || conductor.registered_at
    if (lastSeenIso) stale_ms = Date.now() - new Date(lastSeenIso).getTime()
  }
  return {
    conductor: conductor,
    // 2026-05-18: explicit liveness signal for inbound-channel-bridge callers.
    // is_active=true means coord.send_message to chat.conductor.inbox will
    // wake a real tab; false means callers should fall back to reflex.fire.
    is_active: !!active,
    stale_ms: stale_ms,
    stale_threshold_ms: CONDUCTOR_STALE_THRESHOLD_MS,
    wake_policy: policy,
    wake_topic_prefixes: WAKE_TOPIC_PREFIXES,
    last_wake_at: _lastWakeAt ? new Date(_lastWakeAt).toISOString() : null,
  }
}

// 2026-05-18: conductor heartbeat. Called by the Corazon UserPromptSubmit
// hook each turn-start. Updates last_seen_at so loadActiveConductorRegistration
// returns the row. Without this, every conductor goes stale 30min after
// register_conductor and falls through to cold-spawn.
async function conductor_heartbeat(params, _ctx) {
  params = params || {}
  ensureDirs()
  const conductor = loadConductorRegistration()
  if (!conductor) return { ok: false, error: 'no_conductor_registered' }
  conductor.last_seen_at = new Date().toISOString()
  // 2026-05-19: heartbeat may refresh moving fields. Title/hwnd can shift when
  // Tate resizes; ide_pid stable but workspace_root may change if he re-opens
  // a different folder. Accept refresh of any of these.
  if (params.title_match) conductor.title_match = String(params.title_match)
  if (params.hwnd) conductor.hwnd = Number(params.hwnd)
  if (params.exe) conductor.exe = String(params.exe)
  if (params.claude_port) conductor.claude_port = Number(params.claude_port)
  if (params.ide_pid) conductor.ide_pid = Number(params.ide_pid)
  if (params.ide_bridge_port) conductor.ide_bridge_port = Number(params.ide_bridge_port)
  if (params.workspace_root) conductor.workspace_root = String(params.workspace_root)
  try {
    atomicWriteJson(path.join(CONDUCTORS_DIR, 'current.json'), conductor)
    atomicWriteJson(path.join(CONDUCTORS_DIR, 'default.json'), conductor)
    if (conductor.tab_id && conductor.tab_id !== 'conductor') {
      atomicWriteJson(path.join(CONDUCTORS_DIR, conductor.tab_id + '.json'), conductor)
    }
  } catch (e) {}
  return { ok: true, last_seen_at: conductor.last_seen_at, in_turn: !!conductor.in_turn }
}

async function set_wake_policy(params, _ctx) {
  params = params || {}
  ensureDirs()
  const current = loadWakePolicy()
  const next = Object.assign({}, current)
  if (typeof params.mode === 'string') {
    const valid = ['toast', 'flash', 'auto_type', 'silent']
    if (valid.indexOf(params.mode) === -1) throw new Error('mode must be one of: ' + valid.join(', '))
    next.mode = params.mode
  }
  if (Array.isArray(params.notify_types)) next.notify_types = params.notify_types.slice()
  if (typeof params.toast_duration_ms === 'number') next.toast_duration_ms = Math.max(1500, Math.min(params.toast_duration_ms, 15000))
  if (typeof params.rate_limit_ms === 'number') next.rate_limit_ms = Math.max(0, Math.min(params.rate_limit_ms, 60000))
  atomicWriteJson(WAKE_POLICY_FILE, next)
  return { ok: true, wake_policy: next }
}

// ── exports ──────────────────────────────────────────────────────────────

module.exports = {
  send_message: send_message,
  read_inbox: read_inbox,
  peek_inbox: peek_inbox,
  scanTopicByType: scanTopicByType,
  wait_for_inbox: wait_for_inbox,
  ack_message: ack_message,
  list_workers: list_workers,
  heartbeat: heartbeat,
  report_progress: report_progress,
  signal_done: signal_done,
  signal_bound: signal_bound,
  close_my_tab: close_my_tab,
  kill_worker: kill_worker,
  setWorkerTabHandle: setWorkerTabHandle,
  loadWorkerRegistry: loadWorkerRegistry,
  verify_paste: verify_paste,
  register_conductor: register_conductor,
  unregister_conductor: unregister_conductor,
  get_conductor_state: get_conductor_state,
  conductor_heartbeat: conductor_heartbeat,
  set_conductor_in_turn: set_conductor_in_turn,
  set_wake_policy: set_wake_policy,
  // Internal API for the /api/comms/register-worker route - NOT exposed as a tool.
  _registerWorkerInternal: registerWorkerInternal,
  _inboxTopicFor: inboxTopicFor,
  _loadConductorRegistration: loadConductorRegistration,
  // Sweep API for tests and for the daemon harness.
  _sweepStaleWorkers: sweepStaleWorkers,
  _startSweepLoop: startSweepLoop,
  _stopSweepLoop: stopSweepLoop,
  // Side-channel heartbeat touch for the /api/tool middleware (any tool
  // call from a registered worker tab = liveness signal).
  _touchHeartbeatForTab: _touchHeartbeatForTab,
}
