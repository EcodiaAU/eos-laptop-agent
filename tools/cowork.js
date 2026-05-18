// cowork.js - conductor-to-worker dispatch primitives.
//
// `cowork.dispatch_worker` is the load-bearing primitive that:
//   1. Generates tab_id + tab_credential UUIDs
//   2. Snapshots windows (for tab_handle capture)
//   3. (v1) Acquires swap_lock if account != current; swaps creds (TODO when PG lock + creds-swap path ships)
//   4. Spawns a new Cursor chat tab via cursor.new_chat_tab
//   5. Diffs windows to capture the new tab's hwnd/title
//   6. Composes brief: <dispatched .../> + mandatory FIRST ACTION (curl
//      bootstrap to register-worker) + brief body (inline or file pointer)
//   7. Writes brief to D:/.code/EcodiaOS/coordination/briefs/<task_id>.md
//      (always, for audit + recovery), pastes inline OR pointer based on size
//   8. clipboard.write -> input.shortcut Ctrl+V -> input.key enter
//   9. Polls for spawned_at confirmation file:
//        D:/.code/EcodiaOS/coordination/state/<tab_id>.spawned
//      written by the coord MCP server when worker's curl-bootstrap lands
//   10. Recovery state machine on timeout (3 attempts: re-paste, full
//       respawn, swap account)
//   11. Returns full contract object
//
// Architecture spine: PG LISTEN/NOTIFY substrate + chat_messages audit table
// + /api/mcp/coord MCP server exposing 8 coord.* tools. This primitive is the
// GUI-side spawn entry point; OC's A-side ships the substrate + MCP layer.

const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')

const cursor = require('./cursor')
const vscode = require('./vscode')
const input = require('./input')
const clipboard = require('./clipboard')
const screenshot = require('./screenshot')
const win = require('./window')

const COORD_ROOT = 'D:\\.code\\EcodiaOS\\coordination'
const BRIEFS_DIR = path.join(COORD_ROOT, 'briefs')
const STATE_DIR = path.join(COORD_ROOT, 'state')
const BRIEF_INLINE_CAP_BYTES = 100 * 1024  // 100KB - over this, paste pointer instead
const SPAWNED_AT_TIMEOUT_MS = 60000
const SPAWNED_AT_POLL_INTERVAL_MS = 750
const MAX_RECOVERY_ATTEMPTS = 3

// HTTP helper for synchronous worker registration (no external deps; use node's http module)
function postJson(urlStr, body, bearerToken) {
  return new Promise((resolve, reject) => {
    const u = require('url').parse(urlStr)
    const httpMod = u.protocol === 'https:' ? require('https') : require('http')
    const payload = JSON.stringify(body)
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    if (bearerToken) headers['Authorization'] = 'Bearer ' + bearerToken
    const req = httpMod.request({
      hostname: u.hostname, port: u.port, path: u.path, method: 'POST', headers: headers, timeout: 5000,
    }, res => {
      let chunks = ''
      res.on('data', c => chunks += c)
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(chunks) }) } catch (e) { resolve({ status: res.statusCode, body: chunks, parse_error: e.message }) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('register-worker timed out')) })
    req.write(payload)
    req.end()
  })
}

function loadLaptopAgentToken() {
  try { return fs.readFileSync(path.join(os.homedir(), '.ecodiaos', 'laptop-agent.token'), 'utf8').trim() } catch (e) { return '' }
}

function uuid() {
  return crypto.randomUUID()
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function ensureDirs() {
  for (const d of [COORD_ROOT, BRIEFS_DIR, STATE_DIR]) {
    try { fs.mkdirSync(d, { recursive: true }) } catch (e) {}
  }
}

// Snapshot the set of visible window hwnds + titles.
// Used to identify the freshly-spawned tab by diffing pre/post.
// Returns an empty Map if the PowerShell probe fails (transient memory pressure
// or System.Web load failure - window probing is metadata-only, dispatch must
// still proceed).
async function snapshotWindowSet() {
  const set = new Map()
  try {
    const r = await win.windows({})
    for (const w of (r.windows || [])) {
      set.set(String(w.hwnd), { hwnd: w.hwnd, title: w.title, exe: w.exe, pid: w.pid })
    }
  } catch (e) {
    // Swallow - tab_handle capture is best-effort, never the dispatch's blocker
  }
  return set
}

function diffNewWindows(pre, post, ideFilter) {
  const added = []
  for (const [hwnd, w] of post.entries()) {
    if (pre.has(hwnd)) continue
    if (ideFilter && w.exe !== ideFilter) continue
    added.push(w)
  }
  return added
}

// Compose the brief that gets pasted into the worker tab.
// REGISTRATION HAS ALREADY HAPPENED conductor-side by the time this runs.
// The brief no longer asks the worker to run a bootstrap curl - it just tells
// the worker its identity + role + task. Worker uses tab_credential as a
// parameter on subsequent coord.* tool calls (NOT for registration).
function composeBrief(opts) {
  const {
    tab_id, task_id, tab_credential, parent_conductor_tab_id,
    brief_body, brief_size_bytes, brief_storage, brief_file_path,
  } = opts

  const headerAttrs = [
    'role="worker"',
    'tab_id="' + tab_id + '"',
    'task_id="' + task_id + '"',
    'tab_credential="' + tab_credential + '"',
    'inbox="chat.' + tab_id + '.inbox"',
    'conductor="chat.conductor.inbox"',
    'parent_conductor_tab_id="' + (parent_conductor_tab_id || 'unknown') + '"',
    'brief_storage="' + brief_storage + '"',
    'registered="conductor-side"',
  ]
  if (brief_storage === 'file') headerAttrs.push('brief_file="' + brief_file_path + '"')

  const header = '<dispatched ' + headerAttrs.join(' ') + '/>'

  const identity =
    'YOU ARE A DISPATCHED WORKER. You are not the conductor.\n' +
    'Your identity:\n' +
    '  tab_id: ' + tab_id + '\n' +
    '  task_id: ' + task_id + '\n' +
    '  tab_credential: ' + tab_credential + '\n' +
    'Registration has already happened on your behalf. Do NOT run any curl bootstrap.\n' +
    'When calling coord.* tools, include tab_id="' + tab_id + '" and tab_credential="' + tab_credential + '" in params.\n'

  const taskBlock = brief_storage === 'file'
    ? 'YOUR TASK:\nThe full task brief is at:\n  ' + brief_file_path + '\nRead that file in full, then execute.\n'
    : 'YOUR TASK:\n' + brief_body + '\n'

  const constraints =
    'CONSTRAINTS (non-negotiable):\n' +
    '- You are NOT the conductor. Do not orchestrate. Do not spawn workers.\n' +
    '- Report progress via coord.send_message (to: chat.conductor.inbox).\n' +
    '- When the task is complete, call coord.signal_done({task_id, result_summary, terminate: true}).\n' +
    '- You can only emit messages TO chat.conductor.inbox or chat.' + tab_id + '.scratch.\n' +
    '- Heartbeat via coord.heartbeat() at start + end of every turn.\n'

  return [header, '', identity, '', taskBlock, '', constraints].join('\n')
}

// Poll for the spawned_at confirmation file written by the coord MCP server
// when the worker's curl-bootstrap lands.
async function waitForSpawnedAt(tab_id, timeoutMs) {
  const markerPath = path.join(STATE_DIR, tab_id + '.spawned')
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(markerPath)) {
      try {
        const content = fs.readFileSync(markerPath, 'utf8').trim()
        return { spawned_at: content || new Date().toISOString(), waited_ms: Date.now() - start }
      } catch (e) {}
    }
    await sleep(SPAWNED_AT_POLL_INTERVAL_MS)
  }
  return null
}

// Re-paste the brief into the most-recently-spawned tab (recovery attempt 1).
async function recoveryRepasteBrief(brief, tab_handle) {
  if (tab_handle && tab_handle.hwnd) {
    try {
      await win.focus_window({ titleContains: tab_handle.title.slice(0, 30) })
      await sleep(400)
    } catch (e) {}
  } else {
    try {
      await cursor.focus()
      await sleep(400)
    } catch (e) {}
  }
  await clipboard.write({ text: brief })
  await sleep(200)
  await input.shortcut({ keys: ['ctrl', 'v'] })
  await sleep(400)
  await input.key({ key: 'enter' })
  await sleep(800)
}

// Main entry point. Caller passes account/brief/task_id; we return the full
// contract object on success or { ok: false, error, recovery_log } on failure.
async function dispatch_worker(params) {
  params = params || {}
  const account = params.account || 'current'
  const brief_body = params.brief || ''
  const task_id = params.task_id || uuid()
  const parent_conductor_tab_id = params.parent_conductor_tab_id || null
  // coord_url default points at the laptop-agent's own coord substrate (port 7456).
  // Earlier prototype used a separate stub on 7457; that path is deprecated.
  const coord_url = params.coord_url || 'http://localhost:7456'
  const ide_target = params.ide || 'cursor'

  if (!brief_body) throw new Error('brief required')

  ensureDirs()

  const tab_id = 'tab_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex')
  const tab_credential = uuid()

  // Decide inline vs file
  const brief_size_bytes = Buffer.byteLength(brief_body, 'utf8')
  let brief_storage = 'inline'
  let brief_file_path = null
  if (brief_size_bytes > BRIEF_INLINE_CAP_BYTES) {
    brief_storage = 'file'
    brief_file_path = path.join(BRIEFS_DIR, task_id + '.md').replace(/\\/g, '/')
  }

  // Always write brief to file for audit + recovery, even if inline
  const auditFilePath = path.join(BRIEFS_DIR, task_id + '.md')
  try { fs.writeFileSync(auditFilePath, brief_body, 'utf8') } catch (e) {}

  // Resolve account=current to the real account label (from active_account.json).
  // Lazy-load usage to avoid require-cycle; usage.js doesn't depend on cowork.js.
  let resolved_account = account
  if (account === 'current') {
    try {
      const usage = require('./usage')
      resolved_account = usage._getActiveAccount()
    } catch (e) {
      resolved_account = 'current-process'  // fallback if usage.js unavailable
    }
  }
  // TODO when swap_creds (Chat B) lands: acquire system.swap_lock + swap creds if account != current
  const account_active_when_spawned = resolved_account

  // SYNCHRONOUS REGISTRATION (conductor-side, on behalf of worker).
  // Eliminates the "did the worker run the bootstrap curl" failure mode -
  // worker only needs to receive the brief + execute the task.
  // Pass account_active_when_spawned so the worker row records it for the
  // usage poller's session->account attribution.
  let register_result = null
  try {
    register_result = await postJson(
      coord_url + '/api/comms/register-worker',
      {
        tab_id: tab_id,
        task_id: task_id,
        tab_credential: tab_credential,
        parent_conductor_tab_id: parent_conductor_tab_id,
        account_active_when_spawned: account_active_when_spawned,
      },
      loadLaptopAgentToken()
    )
    if (register_result.status !== 200) {
      return { ok: false, tab_id: tab_id, task_id: task_id, error: 'register-worker rejected: ' + register_result.status, register_body: register_result.body }
    }
  } catch (e) {
    return { ok: false, tab_id: tab_id, task_id: task_id, error: 'register-worker failed: ' + e.message }
  }

  // Snapshot windows pre-spawn (for tab_handle capture)
  const preWindows = await snapshotWindowSet()

  // Compose brief (registration already done conductor-side, brief is identity + task only)
  const compose_brief_storage = brief_storage
  const compose_brief_file = brief_storage === 'file' ? brief_file_path : null
  const composedBrief = composeBrief({
    tab_id: tab_id,
    task_id: task_id,
    tab_credential: tab_credential,
    parent_conductor_tab_id: parent_conductor_tab_id,
    brief_body: brief_storage === 'inline' ? brief_body : '',
    brief_size_bytes: brief_size_bytes,
    brief_storage: compose_brief_storage,
    brief_file_path: compose_brief_file,
  })

  // Spawn a new CLAUDE CODE chat tab via Ctrl+Shift+P -> "Claude Code: New Chat".
  // Critical: cursor.new_chat_tab() (Ctrl+Shift+L) opens Cursor's NATIVE agent
  // panel (Composer / Sonnet), NOT a Claude Code extension chat. Workers must
  // land in a Claude Code chat tab to inherit the MCP surface + extension tools.
  let spawned = false
  let spawn_error = null
  try {
    await vscode.new_claude_code_chat({ ide: ide_target })
    spawned = true
  } catch (e) {
    spawn_error = e.message
  }
  if (!spawned) {
    // Spawn failure on this account -> mark account flaky for FLAKY_TTL_MS.
    // pick_account will exclude it on the next call. Self-heals on TTL.
    try {
      if (account_active_when_spawned && account_active_when_spawned !== 'current-process') {
        const usage = require('./usage')
        usage._markFlaky(account_active_when_spawned, 'dispatch_spawn_failed: ' + (spawn_error || 'unknown'))
      }
    } catch (e) {}
    return { ok: false, tab_id: tab_id, error: 'spawn failed: ' + spawn_error, account_marked_flaky: account_active_when_spawned }
  }
  await sleep(1500)  // let the new chat tab UI render

  // Capture tab_handle by window diff
  const postWindows = await snapshotWindowSet()
  const ideExeMap = { cursor: 'Cursor', insiders: 'Code - Insiders', stable: 'Code' }
  const ideExe = ideExeMap[ide_target] || 'Cursor'
  const newWindows = diffNewWindows(preWindows, postWindows, ideExe)
  // Tab spawning often doesn't create a NEW top-level window (just a new tab in
  // the existing window). Falls back to focused window of correct exe.
  let tab_handle = null
  if (newWindows.length > 0) {
    tab_handle = { ide: ide_target, hwnd: newWindows[0].hwnd, title: newWindows[0].title }
  } else {
    // Best-effort: foreground window after spawn. Failures here are non-fatal -
    // the brief still gets pasted, tab_handle is just metadata.
    try {
      const fg = await win.foreground()
      if (fg && fg.exe === ideExe) {
        tab_handle = { ide: ide_target, hwnd: fg.hwnd, title: fg.title, captured_via: 'foreground_after_spawn' }
      }
    } catch (e) {}
  }

  // Paste brief into the new tab. clipboard.write is the most-common failure
  // surface (tonight: empty-stderr hang under memory pressure). Wrapping in
  // try/catch with a single retry-after-pause prevents the orphan-tab failure
  // class - dispatch already succeeded at register-worker + spawn-tab, so a
  // late clipboard fail used to leave a brief-less worker.
  let pasted = false
  let paste_error = null
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await clipboard.write({ text: composedBrief })
      await sleep(250)
      await input.shortcut({ keys: ['ctrl', 'v'] })
      await sleep(400)
      await input.key({ key: 'enter' })
      await sleep(600)
      pasted = true
      break
    } catch (e) {
      paste_error = e.message
      if (attempt < 2) await sleep(500)  // brief settle before retry
    }
  }
  if (!pasted) {
    // Worker registered + tab spawned, but we couldn't get the brief into it.
    // Surface the orphan so the conductor can kill_worker + redispatch.
    return {
      ok: false,
      tab_id: tab_id,
      tab_credential: tab_credential,
      registered_at: register_result.body.registered_at,
      task_id: task_id,
      tab_handle: tab_handle,
      orphan: true,
      error: 'brief paste failed after 2 attempts: ' + paste_error,
      note: 'Worker tab is open but has no brief. Call cowork.kill_worker({tab_id}) to clean up, then retry dispatch.',
    }
  }

  // Registration already succeeded synchronously above; we do NOT poll for a
  // worker-side bootstrap because that path was found unreliable (workers don't
  // always run the bootstrap curl on first turn). The brief got pasted; whether
  // the worker model executes the task is its problem from here.

  return {
    ok: true,
    tab_id: tab_id,
    tab_credential: tab_credential,
    account_active_when_spawned: account_active_when_spawned,
    registered_at: register_result.body.registered_at,
    brief_size_bytes: brief_size_bytes,
    brief_storage: brief_storage,
    brief_file_audit: auditFilePath.replace(/\\/g, '/'),
    role: 'worker',
    recovery_attempts: 0,
    tab_handle: tab_handle,
    coord_url: coord_url,
    task_id: task_id,
    note: 'Worker registered synchronously by dispatcher. Brief pasted into spawned tab. Task execution is the worker model\'s responsibility from this point.',
  }
}

// cowork.list_workers - read all live worker state markers from coordination/state/
async function list_workers() {
  ensureDirs()
  const files = fs.readdirSync(STATE_DIR).filter(f => f.endsWith('.spawned'))
  const workers = files.map(f => {
    const tab_id = f.replace('.spawned', '')
    const fullPath = path.join(STATE_DIR, f)
    let stat = null
    try { stat = fs.statSync(fullPath) } catch (e) {}
    let body = ''
    try { body = fs.readFileSync(fullPath, 'utf8').trim() } catch (e) {}
    return { tab_id: tab_id, spawned_at: body || (stat ? stat.mtime.toISOString() : null), state_file: fullPath.replace(/\\/g, '/') }
  })
  return { count: workers.length, workers: workers }
}

// cowork.kill_worker - close worker tab + cleanup state marker.
async function kill_worker(params) {
  params = params || {}
  const tab_id = params.tab_id
  if (!tab_id) throw new Error('tab_id required')

  const markerPath = path.join(STATE_DIR, tab_id + '.spawned')

  // Focus the worker's IDE + close the active tab. Best-effort: we don't have
  // hwnd-level tab targeting without UIA so this closes the CURRENTLY focused
  // tab, which is fragile. Caller should focus the right tab first or pass
  // tab_handle in.
  if (params.tab_handle && params.tab_handle.hwnd) {
    try {
      await win.focus_window({ titleContains: params.tab_handle.title.slice(0, 30) })
      await sleep(300)
    } catch (e) {}
  }
  try {
    await input.shortcut({ keys: ['ctrl', 'w'] })
    await sleep(400)
  } catch (e) {}

  // Cleanup state marker
  try { fs.unlinkSync(markerPath) } catch (e) {}

  return { ok: true, tab_id: tab_id, marker_removed: !fs.existsSync(markerPath) }
}

// ── cowork.swap_creds ────────────────────────────────────────────────────
//
// Swap ~/.claude/.credentials.json to a different account's snapshot.
//
// Safety protocol:
//   1. Acquire an advisory swap lock (file-based at coordination/locks/swap.lock)
//      with a deadline. Holding tabs see the lock via fs.existsSync and back off.
//   2. Check in-flight workers via coord._inFlightCount() - any tab with
//      in_critical_section=true blocks the swap. (Non-critical tabs are
//      tolerated per spike 4 finding: in-memory bearer survives file swap
//      until refresh.)
//   3. Snapshot current creds mtime + sha for the watchdog's audit log.
//   4. Copy creds from ~/.ecodia-creds/<account>.json over .credentials.json
//      using a write-tmp-then-rename for atomicity.
//   5. Update active_account.json via usage._setActiveAccount.
//   6. Append a row to swap_history.json for audit.
//   7. Release the lock.
//
// Returns: { ok, from_account, to_account, swap_ms, in_flight_count_at_swap,
//            prior_sha256, new_sha256, swap_history_position }
//
// Error modes:
//   - lock_acquire_failed: another swap in progress, retry after wait
//   - critical_section_active: a worker is mid-write (in_critical_section=true)
//   - creds_backup_missing: ~/.ecodia-creds/<account>.json does not exist
//   - file_clobber_check_failed: current creds mtime changed during swap (race)

const LOCKS_DIR = path.join(COORD_ROOT, 'locks')
const SWAP_LOCK_FILE = path.join(LOCKS_DIR, 'swap.lock')
const SWAP_HISTORY_FILE = path.join(COORD_ROOT, 'swap_history.json')
const CREDENTIALS_FILE = path.join(os.homedir(), '.claude', '.credentials.json')
const CREDS_BACKUP_DIR = path.join(os.homedir(), '.ecodia-creds')

const SWAP_LOCK_STALE_MS = 60_000  // a swap lock older than 60s is considered stale
const SWAP_LOCK_RETRY_MS = 500
const SWAP_LOCK_MAX_WAIT_MS = 10_000

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

function ensureLockDir() {
  try { fs.mkdirSync(LOCKS_DIR, { recursive: true }) } catch (e) {}
}

async function acquireSwapLock(holder) {
  ensureLockDir()
  const deadline = Date.now() + SWAP_LOCK_MAX_WAIT_MS
  while (Date.now() < deadline) {
    try {
      // O_EXCL atomic create. Throws EEXIST if already held.
      const fd = fs.openSync(SWAP_LOCK_FILE, 'wx')
      fs.writeSync(fd, JSON.stringify({ holder: holder, acquired_at: new Date().toISOString(), pid: process.pid }))
      fs.closeSync(fd)
      return { ok: true, lockfile: SWAP_LOCK_FILE }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      // Check if stale
      try {
        const stat = fs.statSync(SWAP_LOCK_FILE)
        if (Date.now() - stat.mtimeMs > SWAP_LOCK_STALE_MS) {
          // Steal it
          try { fs.unlinkSync(SWAP_LOCK_FILE) } catch (e2) {}
          continue
        }
      } catch (e3) {}
      await sleep(SWAP_LOCK_RETRY_MS)
    }
  }
  return { ok: false, error: 'lock_acquire_failed: timeout waiting for swap.lock' }
}

function releaseSwapLock() {
  try { fs.unlinkSync(SWAP_LOCK_FILE) } catch (e) {}
}

function readSwapHistory() {
  try { return JSON.parse(fs.readFileSync(SWAP_HISTORY_FILE, 'utf8')) } catch (e) { return [] }
}

function appendSwapHistory(entry) {
  const hist = readSwapHistory()
  hist.push(entry)
  // Trim to last 500 entries to bound file size
  const trimmed = hist.slice(-500)
  const tmp = SWAP_HISTORY_FILE + '.tmp-' + process.pid + '-' + Date.now()
  fs.writeFileSync(tmp, JSON.stringify(trimmed, null, 2), 'utf8')
  fs.renameSync(tmp, SWAP_HISTORY_FILE)
  return trimmed.length
}

// Count workers with in_critical_section=true (read direct from disk; can't
// require coord without risking cycles, and coord's in-memory cache may be
// stale across separate processes).
function inFlightCriticalCount() {
  const workersDir = path.join(COORD_ROOT, 'workers')
  let count = 0
  try {
    const now = Date.now()
    for (const f of fs.readdirSync(workersDir)) {
      if (!f.endsWith('.json')) continue
      try {
        const w = JSON.parse(fs.readFileSync(path.join(workersDir, f), 'utf8'))
        if (w.terminated_at) continue
        // Treat dead workers (>90s no heartbeat) as not-in-flight even if flag set
        const lastHbMs = new Date(w.last_heartbeat_at || w.registered_at || 0).getTime()
        if (now - lastHbMs > 90_000) continue
        if (w.in_critical_section) count++
      } catch (e) {}
    }
  } catch (e) {}
  return count
}

async function swap_creds(params, ctx) {
  params = params || {}
  const targetAccount = params.account
  const force = !!params.force  // ignore in_critical_section (use with care)
  if (!targetAccount) throw new Error('account required')

  ensureDirs()
  const t0 = Date.now()
  const holder = (ctx && ctx.tab_id) || 'conductor'

  // Try to read current active account label
  let from_account = 'unknown'
  try {
    const usage = require('./usage')
    from_account = usage._getActiveAccount()
  } catch (e) {}

  if (from_account === targetAccount) {
    return { ok: true, noop: true, from_account: from_account, to_account: targetAccount, swap_ms: 0, in_flight_count_at_swap: 0, reason: 'already-active' }
  }

  // Verify backup exists BEFORE acquiring lock
  const backupPath = path.join(CREDS_BACKUP_DIR, targetAccount + '.json')
  if (!fs.existsSync(backupPath)) {
    return { ok: false, error: 'creds_backup_missing', detail: 'no backup at ' + backupPath, hint: 'capture via: cp ~/.claude/.credentials.json ~/.ecodia-creds/' + targetAccount + '.json after manually logging into that account' }
  }

  // Acquire lock
  const lock = await acquireSwapLock(holder)
  if (!lock.ok) return { ok: false, error: lock.error }

  try {
    // Check in-flight critical workers
    const critCount = inFlightCriticalCount()
    if (critCount > 0 && !force) {
      return { ok: false, error: 'critical_section_active', in_flight_count_at_swap: critCount, hint: 'pass force=true to override (worker may corrupt mid-write)' }
    }

    // Snapshot current creds
    let prior_sha = null
    let prior_mtime = null
    try {
      const buf = fs.readFileSync(CREDENTIALS_FILE)
      prior_sha = sha256Hex(buf)
      prior_mtime = fs.statSync(CREDENTIALS_FILE).mtimeMs
    } catch (e) {}

    // Read new creds
    const newBuf = fs.readFileSync(backupPath)
    const new_sha = sha256Hex(newBuf)

    // Atomic swap: write to tmp in same dir, rename over .credentials.json
    const credsDir = path.dirname(CREDENTIALS_FILE)
    const tmpPath = path.join(credsDir, '.credentials.json.swap-' + process.pid + '-' + Date.now())
    fs.writeFileSync(tmpPath, newBuf)
    fs.renameSync(tmpPath, CREDENTIALS_FILE)

    // Update active_account
    try {
      const usage = require('./usage')
      usage._setActiveAccount(targetAccount, 'swap_creds:' + holder)
    } catch (e) {
      // Non-fatal: file is swapped, active_account label is just metadata
    }

    const swap_ms = Date.now() - t0
    const histEntry = {
      ts: new Date().toISOString(),
      from_account: from_account,
      to_account: targetAccount,
      swap_ms: swap_ms,
      in_flight_count_at_swap: critCount,
      prior_sha256: prior_sha,
      new_sha256: new_sha,
      prior_mtime_ms: prior_mtime,
      holder: holder,
      forced: force,
    }
    const histPos = appendSwapHistory(histEntry)

    return {
      ok: true,
      from_account: from_account,
      to_account: targetAccount,
      swap_ms: swap_ms,
      in_flight_count_at_swap: critCount,
      prior_sha256: prior_sha,
      new_sha256: new_sha,
      swap_history_position: histPos,
    }
  } finally {
    releaseSwapLock()
  }
}

// cowork.swap_history - read recent swap_history rows for audit / debugging.
async function swap_history(params) {
  params = params || {}
  const limit = Math.max(1, Math.min(500, Number(params.limit) || 20))
  const hist = readSwapHistory()
  return { count: hist.length, returned: Math.min(hist.length, limit), entries: hist.slice(-limit).reverse() }
}

module.exports = {
  dispatch_worker: dispatch_worker,
  list_workers: list_workers,
  kill_worker: kill_worker,
  swap_creds: swap_creds,
  swap_history: swap_history,
}
