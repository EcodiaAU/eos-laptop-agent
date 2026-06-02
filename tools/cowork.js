// cowork.js - conductor-to-worker dispatch primitives.
//
// `cowork.dispatch_worker` is the load-bearing primitive that:
//   1. Generates tab_id + tab_credential UUIDs
//   2. Snapshots windows (for tab_handle capture)
//   3. (v1) Acquires swap_lock if account != current; swaps creds (TODO when PG lock + creds-swap path ships)
//   4. Spawns a new Claude Code chat tab in VS Code Stable via vscode.new_claude_code_chat
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

const vscode = require('./vscode')
const input = require('./input')
const clipboard = require('./clipboard')
const screenshot = require('./screenshot')
const win = require('./window')
const ide = require('./ide')

const COORD_ROOT = 'D:\\.code\\EcodiaOS\\coordination'
const BRIEFS_DIR = path.join(COORD_ROOT, 'briefs')
const STATE_DIR = path.join(COORD_ROOT, 'state')

// 2026-06-02: read the user's effective CC submit key from VS Code settings.
// The CC chat extension exposes `claudeCode.useCtrlEnterToSend` (default false):
//   false (default) -> Enter submits, Shift+Enter newline
//   true            -> Ctrl+Enter submits, Enter newline
// Pre-this-fix dispatch_worker hardcoded ctrl+enter, which silently failed
// on default-config installs (today's two scheduler dispatches landed in
// prefilled input boxes that never submitted - workers' last_heartbeat_at
// never advanced past registered_at). Reading the setting per-dispatch makes
// the path robust to either user config without requiring settings mutation.
function readCcSubmitKey() {
  // VS Code Stable user settings on Windows
  const candidatePaths = [
    path.join(os.homedir(), 'AppData', 'Roaming', 'Code', 'User', 'settings.json'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'Code - Insiders', 'User', 'settings.json'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'Cursor', 'User', 'settings.json'),
  ]
  for (const p of candidatePaths) {
    try {
      if (!fs.existsSync(p)) continue
      const raw = fs.readFileSync(p, 'utf8')
      // VS Code settings.json allows JSONC (// and /* */ comments + trailing commas).
      // Cheap, lossy strip - just enough to JSON.parse the common case.
      const stripped = raw
        .replace(/\/\/[^\n]*/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/,(\s*[\]}])/g, '$1')
      const cfg = JSON.parse(stripped)
      if (cfg && cfg['claudeCode.useCtrlEnterToSend'] === true) return 'ctrl+enter'
    } catch (e) {
      // ignore - try next file or fall through to default
    }
  }
  return 'enter'  // CC extension default
}
const WORKERS_DIR = path.join(COORD_ROOT, 'workers')
const MESSAGES_DIR = path.join(COORD_ROOT, 'messages')
const BRIEF_INLINE_CAP_BYTES = 100 * 1024  // 100KB - over this, paste pointer instead
const SPAWNED_AT_TIMEOUT_MS = 60000
const SPAWNED_AT_POLL_INTERVAL_MS = 750
const MAX_RECOVERY_ATTEMPTS = 3
// 2026-05-18 drift-audit hardening: workers that never call any coord.* primitive
// after dispatch are orphans (model never started, clipboard race under memory
// pressure, OOM, or stuck on auth gate). Default-on detection at 90s; callers
// can opt out via worker_acknowledgment_timeout_ms=0 for fire-and-forget.
// 2026-05-31: bumped default 90s -> 180s. CC worker boot (skills + auto-memory +
// MCP servers + first model call) routinely takes 60-90s on Opus 4.7; the prior
// 90s default produced false-orphan reports for dispatches that actually
// submitted cleanly. Callers can still override per-call. See
// [[worker-ack-timeout-default-90s-too-tight-for-cold-mcp-load-2026-05-28]].
const DEFAULT_WORKER_ACK_TIMEOUT_MS = 180000
const WORKER_ACK_POLL_INTERVAL_MS = 2000

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

function diffNewWindows(pre, post, exeFilter) {
  const added = []
  for (const [hwnd, w] of post.entries()) {
    if (pre.has(hwnd)) continue
    if (exeFilter && w.exe !== exeFilter) continue
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
    '\n' +
    'CRITICAL - MCP coord tool calling convention:\n' +
    'The MCP coord connector is workspace-wide (shared by ALL tabs), so it CANNOT auto-detect\n' +
    'which tab is calling. You MUST include your tab_id + tab_credential as ARGUMENTS in EVERY\n' +
    'coord.* call. Example:\n' +
    '  mcp__coord__coord_heartbeat({tab_id:"' + tab_id + '", tab_credential:"' + tab_credential + '", status:"alive"})\n' +
    '  mcp__coord__coord_signal_done({tab_id:"' + tab_id + '", tab_credential:"' + tab_credential + '", task_id:"' + task_id + '", result_summary:"...", terminate:true})\n' +
    'If you omit tab_id/tab_credential the call will return {ok:false, error:"tab_id required"}.\n' +
    'Do NOT try direct HTTP to localhost:7456 - that requires the AGENT_TOKEN bearer which workers\n' +
    'do not have. Always use the MCP coord connector with identity-in-args.\n'

  const verifyFirst =
    'FIRST ACTION (mandatory, before any task work):\n' +
    '  mcp__coord__coord_verify_paste({tab_id:"' + tab_id + '", tab_credential:"' + tab_credential + '", task_id:"' + task_id + '"})\n' +
    'This returns {ok, brief_body, brief_sha256, brief_size_bytes, ...} from the dispatcher audit\n' +
    'file on disk. The text below YOUR TASK in this chat is the brief AT-PASTE-TIME and may have\n' +
    'been truncated by a clipboard race under memory pressure (it is the known load-bearing\n' +
    'failure mode). The audit file is written BEFORE the paste and cannot be corrupted by paste\n' +
    'issues, so it is the canonical source of truth.\n' +
    'Discipline: use verify_paste result brief_body as your authoritative task spec. If the\n' +
    'pasted task below disagrees with verify_paste.brief_body, trust verify_paste. If\n' +
    'verify_paste returns ok:false, send a coord.send_message error and terminate.\n'

  const taskBlock = brief_storage === 'file'
    ? 'YOUR TASK:\nThe full task brief is at:\n  ' + brief_file_path + '\nRead that file in full, then execute.\n'
    : 'YOUR TASK:\n' + brief_body + '\n'

  const constraints =
    'CONSTRAINTS (non-negotiable):\n' +
    '- You are NOT the conductor. Do not orchestrate. Do not spawn workers.\n' +
    '- Report progress via coord.send_message (to: chat.conductor.inbox).\n' +
    '- When the task is complete, call coord.signal_done({task_id, result_summary, terminate: true}).\n' +
    '- Then call mcp__coord__coord_close_my_tab({tab_id:"' + tab_id + '", tab_credential:"' + tab_credential + '"}) as your FINAL action.\n' +
    '  This closes your IDE chat tab. Without it, every worker tab accumulates in the IDE.\n' +
    '  The conductor reads your signal_done from the inbox - tab closure does not delete the message.\n' +
    '- You can only emit messages TO chat.conductor.inbox or chat.' + tab_id + '.scratch.\n' +
    '- Heartbeat via coord.heartbeat() at start + end of every turn.\n'

  return [header, '', identity, '', verifyFirst, '', taskBlock, '', constraints].join('\n')
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
      await vscode.focus({ ide: 'stable' })
      await sleep(400)
    } catch (e) {}
  }
  // Focus the CC chat input - same brief-paste-into-wrong-target bug fix as
  // the primary paste loop. Best-effort.
  try {
    await ide.command({ cmd: 'claude-vscode.focus' })
    await sleep(150)
  } catch (_e) {
    try { await ide.command({ cmd: 'claude-dev.SidebarProvider.focus' }); await sleep(150) } catch (_e2) {}
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
  // Auto-stamp parent_conductor_tab_id from the registered conductor so the
  // worker row records WHO dispatched it. Enables future multi-conductor wake
  // routing. Falls through to null if no conductor registered (matches v1).
  let parent_conductor_tab_id = params.parent_conductor_tab_id || null
  if (!parent_conductor_tab_id) {
    try {
      const coord = require('./coord')
      const reg = coord._loadConductorRegistration && coord._loadConductorRegistration()
      if (reg && reg.tab_id) parent_conductor_tab_id = reg.tab_id
    } catch (e) {}
  }
  // coord_url default points at the laptop-agent's own coord substrate (port 7456).
  // Earlier prototype used a separate stub on 7457; that path is deprecated.
  const coord_url = params.coord_url || 'http://localhost:7456'

  if (!brief_body) throw new Error('brief required')

  ensureDirs()

  const tab_id = 'tab_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex')
  const tab_credential = uuid()

  // 2026-05-29 patch: SENTINEL-PREFIX label pinning.
  // Prepend a deterministic sentinel as the first user message so the chat
  // auto-titles include it. close_my_tab + kill_worker target via prefix-match
  // (probe ide.tabs, find tab whose label startsWith sentinel, close by exact
  // resolved label). Removes the diff-by-label-vs-existing-Claude-Code-tab
  // ambiguity and the auto-retitle drift problem in one shot.
  //
  // worker_name (optional) lets the caller pin a human-readable label
  // ("audit", "deploy") for visual coordination. Falls back to EOS-W-<short>.
  // The sentinel is the literal text between [ and ] - close-time match is
  // `label.startsWith('[' + sentinel_inner + ']')`.
  const sentinel_inner = (params.worker_name && /^[A-Za-z0-9_\- ]{1,40}$/.test(String(params.worker_name)))
    ? String(params.worker_name)
    : ('EOS-W-' + tab_id.slice(-8))
  const sentinel_prefix = '[' + sentinel_inner + ']'
  const briefed_body = sentinel_prefix + ' ' + brief_body

  // Decide inline vs file (use briefed body for size calc + paste)
  const brief_size_bytes = Buffer.byteLength(briefed_body, 'utf8')
  let brief_storage = 'inline'
  let brief_file_path = null
  if (brief_size_bytes > BRIEF_INLINE_CAP_BYTES) {
    brief_storage = 'file'
    brief_file_path = path.join(BRIEFS_DIR, task_id + '.md').replace(/\\/g, '/')
  }

  // Always write brief to file for audit + recovery, even if inline (sentinel-prefixed)
  const auditFilePath = path.join(BRIEFS_DIR, task_id + '.md')
  try { fs.writeFileSync(auditFilePath, briefed_body, 'utf8') } catch (e) {}

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
  // Sentinel-prefix the brief so the chat auto-titles include it for prefix-match close.
  // The sentinel needs to be the FIRST chars of the chat's first message - prepend it
  // OUTSIDE the composedBrief so it sits before the <dispatched> header.
  const composedBriefInner = composeBrief({
    tab_id: tab_id,
    task_id: task_id,
    tab_credential: tab_credential,
    parent_conductor_tab_id: parent_conductor_tab_id,
    brief_body: brief_storage === 'inline' ? brief_body : '',
    brief_size_bytes: brief_size_bytes,
    brief_storage: compose_brief_storage,
    brief_file_path: compose_brief_file,
  })
  const composedBrief = sentinel_prefix + '\n' + composedBriefInner

  // Spawn a new Claude Code chat tab via the IDE bridge command
  // claude-vscode.newConversation (2026-05-28 patch). Replaces the previous
  // Ctrl+Alt+Shift+C keystroke path because:
  //  1. Keystroke landed in whatever window was foreground when input.shortcut
  //     fired - if VS Code wasn't focused, the spawn went to the wrong app
  //     entirely or nowhere visible.
  //  2. CC extension's findUnusedColumn() routes the new panel to a NEW
  //     editor group (viewColumn 2+) when no CC chat exists in viewColumn 1.
  //     With Tate working in viewColumn 1 (text/code files), every worker
  //     spawned in a split view - bad UX.
  //
  // The IDE-bridge command runs in-process inside the extension host,
  // bypasses focus, and the CC extension still uses findUnusedColumn but
  // generally lands the chat in viewColumn 1 when there's at least one
  // existing CC chat there (the common case while Tate works).
  //
  // We also snapshot ide.tabs before/after to identify the spawned tab
  // deterministically by (label, viewColumn) - that pair gets stored in the
  // worker registry and used by coord.close_my_tab to target the close via
  // ide.tabs_close without any focus dependency.

  const ideRoutes = require('./ide')

  // 2026-05-29 v6: FOCUSLESS POPULATE via the IDE bridge (claude-vscode.editor.open).
  //
  // Supersedes the newConversation + clipboard.write + Ctrl+V chain. That chain
  // had a ~2.5s focus-dependent window between the tab opening and the Ctrl+V
  // keystroke; a foreground console-flash (a separate, unresolved bash-level
  // issue on this host) could steal that window, sending the paste to the wrong
  // window -> EMPTY worker tabs with no brief (the 3-empty-tabs symptom seen on
  // the 2026-05-29 wave-killer scheduler dispatch).
  //
  // ide.chat_send_message runs claude-vscode.editor.open(session, prompt) entirely
  // inside the extension host, prefilling the chat input REGARDLESS of OS focus,
  // and returns the new tab's identity ({label, viewColumn, viewType, index}) for
  // the close handle. Verified live 2026-05-29: editor.open opens the tab and the
  // tabs_close({viewColumn, tabIndex}) handle round-trips cleanly. The ONLY
  // residual focus-dependent step is the single Enter to submit; if it lands
  // nowhere the brief still sits in the input (recoverable), never in the wrong
  // window. Recovery re-Enters the SAME tab and NEVER re-spawns (the old
  // re-spawn-on-orphan path is what produced 3 empty tabs per failed dispatch).
  let tab_handle = null
  let spawn_error = null
  let ide_exe = 'Code.exe'  // VS Code Stable (the worker host); refined from the bridge's ide name below
  // 2026-06-02: capture the bridge's pid so focus_and_send can target the
  // EXACT VS Code window hosting the new chat tab via ahk_pid, not just
  // ahk_exe Code.exe (which matches any Code.exe window). Multi-window
  // installs were dispatching Enter into Tate's working window instead of
  // the new chat tab.
  let bridge_pid = null
  try {
    const sendRes = await ideRoutes.chat_send_message({ prompt: composedBrief, submit: false })
    const inner = (sendRes && (sendRes.result || sendRes)) || {}
    const ideName = String(inner.ide || '').toLowerCase()
    if (ideName.includes('insiders')) ide_exe = 'Code - Insiders.exe'
    else if (ideName.includes('cursor')) ide_exe = 'Cursor.exe'
    // pid comes from ide.js call() wrapper: { ide, pid, port, ...result }
    if (sendRes && Number.isInteger(Number(sendRes.pid))) bridge_pid = Number(sendRes.pid)
    if (inner.open_command_ok === false) {
      spawn_error = 'editor.open failed: ' + (inner.open_error || 'unknown')
    }
    const ot = inner.opened_tab
    if (ot && ot.viewColumn != null) {
      tab_handle = {
        sentinel_prefix: sentinel_prefix,
        viewColumn: ot.viewColumn,
        viewType: ot.viewType || 'mainThreadWebview-claudeVSCodePanel',
        label_at_spawn: ot.label,
        tabIndex: (typeof ot.index === 'number') ? ot.index : null,
        captured_via: 'bridge_chat_send_message',
        captured_label_is_provisional: true,
      }
    }
  } catch (e) {
    spawn_error = e.message
  }
  if (!tab_handle) {
    try {
      if (account_active_when_spawned && account_active_when_spawned !== 'current-process') {
        const usage = require('./usage')
        usage._markFlaky(account_active_when_spawned, 'dispatch_populate_failed: ' + (spawn_error || 'unknown'))
      }
    } catch (e) {}
    return { ok: false, tab_id: tab_id, error: 'populate failed (editor.open): ' + (spawn_error || 'no opened_tab returned'), account_marked_flaky: account_active_when_spawned }
  }

  // Persist tab_handle into the worker registry row so coord.close_my_tab can
  // target this exact tab via ide.tabs_close({viewColumn, tabIndex, viewType}).
  try {
    const coord = require('./coord')
    if (typeof coord.setWorkerTabHandle === 'function') {
      coord.setWorkerTabHandle(tab_id, tab_handle)
    }
  } catch (e) {}

  // Submit: bring the IDE OS-window to the foreground AND send Enter in a SINGLE
  // atomic AHK script (window.focus_and_send). Replaces the prior two-call dance
  // (window.focus_window -> sleep 300 -> input.key) which had a 300ms+ Node-side
  // window between activation and keystroke during which focus drifted off the
  // CC chat textarea ~70% of the time, leaving the brief prefilled but never
  // submitted - the empirical "scheduler-spawned tabs not hitting enter" failure
  // mode observed in the workers/ ack rates 2026-05-29 → 2026-05-31.
  //
  // BEFORE the AHK call we also re-activate the just-opened chat tab via a
  // VS Code command. editor.open made the tab active inside the bridge, but
  // between bridge-return and AHK-fire (~100-500ms) Tate's interactive actions
  // (clicking another file in the file tree, switching tabs) can shift the
  // active editor in VS Code's internal state - WinActivate then foregrounds
  // the Code.exe OS window but Enter lands in whatever editor is now active
  // (often a code/HTML file, where it just inserts a newline). Re-asserting
  // tab focus via workbench.action.openEditorAtIndex<N> (1-9) right before
  // the AHK call closes that race. The CC extension also accepts
  // workbench.action.focusMostRecentlyUsedEditor as a fallback when the
  // tab index is >= 9.
  const windowRoutes = require('./window')
  let pasted = false
  let paste_error = null
  let paste_attempts = []
  let refocus_result = null
  // Diagnostic: capture what window was foreground at the moment we tried
  // the AHK activation. When activate_failed_within_1500ms fires, this tells
  // us what stole the foreground (a terminal, an antivirus toast, another
  // VS Code window, the Bash tool's PowerShell child, etc).
  let foreground_at_paste = null
  try {
    foreground_at_paste = await windowRoutes.foreground()
  } catch (e) {
    foreground_at_paste = { error: e.message }
  }

  // V8 path: no bridge-side refocus call. The previous focusActiveEditor name
  // turned out to be invalid (HTTP 500 "command not found") - and dispatches
  // worked anyway because the AHK script's AttachThreadInput fallback
  // recovers when the terminal-flash or another window steals foreground.
  // editor.open + 1200ms bridge wait leaves the new tab as VS Code's active
  // editor and CC's React useEffect focuses the textarea inside the webview.
  // The atomic AHK (WinActivate → AttachThreadInput → Alt-as-last-resort →
  // SendInput Enter) is sufficient when the new tab is still active.
  // Anti-pattern: positional openEditorAtIndex<N> - the tab index returned
  // by the bridge's tab-diff is unreliable when multiple "Claude Code"-
  // labeled tabs exist (the diff matches by viewColumn|label, which is
  // identical for default-empty CC chats; falls back to active-tab which
  // is Tate's working tab, not the just-opened dispatch tab).
  // 2026-06-02: read the submit key from CC's `useCtrlEnterToSend` setting
  // (default false -> Enter; opt-in true -> Ctrl+Enter). Hardcoded ctrl+enter
  // was silently no-op'ing on the default-config install and orphaning every
  // scheduler dispatch (workers' heartbeat never advanced past registration).
  const submitKey = readCcSubmitKey()
  try {
    const r = await windowRoutes.focus_and_send({ exe: ide_exe, pid: bridge_pid, key: submitKey, settleMs: 250 })
    paste_attempts.push({ attempt: 1, settleMs: 250, key: submitKey, pid: bridge_pid, ok: r && r.ok, reason: r && r.reason })
    if (r && r.ok) pasted = true
    else paste_error = 'focus_and_send: ' + (r && r.reason || 'unknown')
  } catch (e) {
    paste_attempts.push({ attempt: 1, key: submitKey, error: e.message })
    paste_error = e.message
  }
  // If activation failed (window not found in 1.5s), second try with a longer
  // settle. The tab refocus is already done; just retry the AHK keystroke.
  if (!pasted) {
    await sleep(400)
    try {
      const r2 = await windowRoutes.focus_and_send({ exe: ide_exe, pid: bridge_pid, key: submitKey, settleMs: 600 })
      paste_attempts.push({ attempt: 2, settleMs: 600, key: submitKey, pid: bridge_pid, ok: r2 && r2.ok, reason: r2 && r2.reason })
      if (r2 && r2.ok) pasted = true
      else paste_error = (paste_error || '') + '; retry: ' + (r2 && r2.reason || 'unknown')
    } catch (e) {
      paste_attempts.push({ attempt: 2, error: e.message })
      paste_error = (paste_error || '') + '; retry threw: ' + e.message
    }
  }
  if (!pasted) {
    return {
      ok: false,
      tab_id: tab_id,
      tab_credential: tab_credential,
      registered_at: register_result.body.registered_at,
      task_id: task_id,
      tab_handle: tab_handle,
      orphan: true,
      error: 'brief enter-submit failed (atomic focus_and_send): ' + paste_error,
      paste_attempts: paste_attempts,
      refocus_result: refocus_result,
      foreground_at_paste: foreground_at_paste,
      note: 'Worker tab is open + brief PREFILLED in the input box (editor.open succeeded), but the WinActivate / SendInput AHK script could not bring Code.exe to foreground within 1.5s. foreground_at_paste shows what stole the foreground. Recoverable: focus the tab and press Enter. No re-spawn performed (avoids empty-tab leak).',
    }
  }

  // PASTE-VERIFY flag: workers can read this to confirm clipboard didn't truncate
  // or corrupt their brief. Contains task_id + checksum of brief_body the worker
  // expects to have received.
  try {
    const verifyFlag = {
      task_id: task_id,
      tab_id: tab_id,
      brief_size_bytes: brief_size_bytes,
      brief_sha256: crypto.createHash('sha256').update(brief_body).digest('hex'),
      pasted_at: new Date().toISOString(),
    }
    fs.writeFileSync(path.join(BRIEFS_DIR, task_id + '-PASTE-VERIFY.flag'), JSON.stringify(verifyFlag, null, 2), 'utf8')
  } catch (e) {}

  // Orphan-tab detection (2026-05-18 hardening). Wait up to N ms for any sign
  // of life from the spawned worker:
  //   (a) workers/<tab_id>.json.last_heartbeat_at advances past registered_at
  //       (worker called coord.heartbeat)
  //   (b) any message in messages/ has body.from === tab_id (worker called
  //       coord.send_message / report_progress / signal_done)
  // If timeout fires with no signal, the worker is classified as orphan_tab.
  // Optional redispatch_on_orphan=true triggers a single auto-retry.
  const ackTimeoutMs = (typeof params.worker_acknowledgment_timeout_ms === 'number')
    ? Math.max(0, Math.min(600000, params.worker_acknowledgment_timeout_ms))
    : DEFAULT_WORKER_ACK_TIMEOUT_MS
  let acknowledged = false
  let ack_via = null
  let ack_elapsed_ms = 0
  let re_enter_fired = false
  let re_enter_result = null
  if (ackTimeoutMs > 0) {
    const workerFile = path.join(WORKERS_DIR, tab_id + '.json')
    const start = Date.now()
    let baseline_heartbeat = null
    try {
      const data = JSON.parse(fs.readFileSync(workerFile, 'utf8'))
      baseline_heartbeat = data.last_heartbeat_at
    } catch (e) {}
    // Recovery re-Enter threshold: if no ack at this elapsed point, the most
    // likely cause is the first Enter landed in the wrong target (focus drift
    // between bridge return and SendInput). The brief is still in the chat
    // input box, so re-issuing focus_and_send is idempotent: if submit already
    // happened, Enter on the now-empty CC chat is a no-op; if it didn't, this
    // catches it. We fire this ONCE at ~half the timeout - waiting until
    // expiry would mean the scheduler row times out before recovery completes.
    const reEnterAtMs = Math.max(15000, Math.floor(ackTimeoutMs * 0.5))
    while (Date.now() - start < ackTimeoutMs) {
      // Check 1: heartbeat advanced past baseline
      try {
        const data = JSON.parse(fs.readFileSync(workerFile, 'utf8'))
        if (data.last_heartbeat_at && data.last_heartbeat_at > baseline_heartbeat) {
          acknowledged = true
          ack_via = 'heartbeat'
          break
        }
      } catch (e) {}
      // Check 2: any message from this tab_id in messages/
      try {
        const files = fs.readdirSync(MESSAGES_DIR).filter(f => f.endsWith('.json'))
        // Newest-first scan up to last 60 files
        files.sort((a, b) => b.localeCompare(a))
        for (const mf of files.slice(0, 60)) {
          try {
            const m = JSON.parse(fs.readFileSync(path.join(MESSAGES_DIR, mf), 'utf8'))
            // body.from is the convention this codebase uses (outer from
            // defaults to 'conductor' for chat.conductor.inbox writes)
            const fromTab = (m && m.body && m.body.from) || (m && m.from)
            if (fromTab === tab_id) {
              acknowledged = true
              ack_via = 'message:' + ((m && m.body && m.body.type) || 'unknown')
              break
            }
          } catch (e) {}
        }
      } catch (e) {}
      if (acknowledged) break
      // Mid-wait recovery: one (refocus-tab + focus_and_send) re-fire if we
      // cross the threshold without an ack. Idempotent on the brief side -
      // Enter on a now-empty CC chat is a no-op. The refocus step matters
      // more here than on the first attempt: at this point ~30-90s have
      // elapsed, Tate has likely touched another editor, so the chat tab is
      // definitely not active any more.
      if (!re_enter_fired && (Date.now() - start) >= reEnterAtMs) {
        re_enter_fired = true
        // V8 recovery: just the atomic AHK. No bridge-side refocus.
        try {
          const windowRoutes = require('./window')
          // 2026-06-02: setting-aware submit key + bridge_pid target.
          re_enter_result = await windowRoutes.focus_and_send({ exe: ide_exe, pid: bridge_pid, key: submitKey, settleMs: 500 })
        } catch (e) {
          re_enter_result = { ok: false, error: e.message }
        }
      }
      await sleep(WORKER_ACK_POLL_INTERVAL_MS)
    }
    ack_elapsed_ms = Date.now() - start
  }

  // Orphan case: timeout fired with no acknowledgment.
  if (ackTimeoutMs > 0 && !acknowledged) {
    const redispatch_on_orphan = params.redispatch_on_orphan === true
    let redispatched = null
    if (redispatch_on_orphan && !params._is_redispatch) {
      // Single redispatch with the same brief; recurse-once via _is_redispatch sentinel.
      try {
        const retryParams = Object.assign({}, params, { _is_redispatch: true, redispatch_on_orphan: false })
        redispatched = await dispatch_worker(retryParams)
      } catch (e) {
        redispatched = { ok: false, error: 'redispatch threw: ' + e.message }
      }
    }
    return {
      ok: false,
      tab_id: tab_id,
      tab_credential: tab_credential,
      account_active_when_spawned: account_active_when_spawned,
      registered_at: register_result.body.registered_at,
      task_id: task_id,
      tab_handle: tab_handle,
      orphan: true,
      orphan_reason: 'no coord.* call from spawned worker within ' + ackTimeoutMs + 'ms',
      ack_elapsed_ms: ack_elapsed_ms,
      paste_attempts: paste_attempts,
      refocus_result: refocus_result,
      foreground_at_paste: foreground_at_paste,
      re_enter_fired: re_enter_fired,
      re_enter_result: re_enter_result,
      brief_file_audit: auditFilePath.replace(/\\/g, '/'),
      redispatched: redispatched,
      note: 'Worker tab spawned + brief pasted but model never sent a coord.* call (heartbeat/progress/done). Causes: model never started, clipboard race under memory pressure, OOM, or auth gate. Call cowork.kill_worker({tab_id}) and retry, or pass redispatch_on_orphan=true to auto-retry once.',
    }
  }

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
    acknowledged: acknowledged,
    ack_via: ack_via,
    ack_elapsed_ms: ack_elapsed_ms,
    paste_attempts: paste_attempts,
    re_enter_fired: re_enter_fired,
    re_enter_result: re_enter_result,
    note: ackTimeoutMs > 0
      ? ('Worker acknowledged in ' + ack_elapsed_ms + 'ms via ' + ack_via + (re_enter_fired ? ' (recovery re-Enter fired)' : '') + '. Task execution from here is the worker model\'s responsibility.')
      : 'Fire-and-forget mode (ack timeout=0). Worker registered + brief pasted; no acknowledgment wait performed.',
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

  // 2026-05-28 EMERGENCY PATCH. Previous version sent blind Ctrl+W to whatever
  // was foreground - mass-closed Tate's CC chats when the scheduler's
  // completionPass triggered markComplete -> kill_worker for accumulated
  // signal_done messages on agent restart. Same class of bug as the
  // close_my_tab targeted_active_fallback_label incident.
  //
  // New behaviour: STRICT exact-label match via ide.tabs_close using the
  // worker's stored tab_handle (label + viewColumn + viewType) from the
  // worker registry. Refuses if no stored handle or no exact match. Better
  // leak than wrong-close.
  //
  // The hwnd/title-prefix-focus path is dead: webview tab titles change
  // (Claude Code chats auto-retitle from first message), and even when the
  // prefix matches it could match Tate's own tab. Never blind keystroke.
  //
  // Doctrine: ~/ecodiaos/patterns/vs-code-webview-tabs-have-no-stable-id-pin-label-or-leak-2026-05-28.md
  //           ~/ecodiaos/patterns/cowork-kill-worker-tab-handle-from-foreground-after-spawn-is-unsafe-2026-05-28.md
  let closed = false
  let refused = null
  let error = null
  try {
    // 2026-05-29 ultracode audit C1 fix. Previous lookup tried
    // coord._loadWorkerRegistry || coord.workers.get(tab_id) - NEITHER
    // existed on the coord exports. Every scheduler-spawned worker hit the
    // refuse-and-leak branch. Now uses coord.loadWorkerRegistry which checks
    // in-memory cache first, then falls back to disk-read of the registry
    // file (canonical substrate that setWorkerTabHandle writes).
    const coord = require('./coord')
    const stored = (typeof coord.loadWorkerRegistry === 'function')
      ? coord.loadWorkerRegistry(tab_id)
      : null
    const tab_handle = (stored && stored.tab_handle) || params.tab_handle || null
    const CC_CHAT_VIEW_TYPE = 'mainThreadWebview-claudeVSCodePanel'
    if (!tab_handle || tab_handle.viewType !== CC_CHAT_VIEW_TYPE || tab_handle.viewColumn == null) {
      refused = 'no_safe_tab_handle_or_incomplete'
    } else {
      // Mirrors coord.close_my_tab v5 precedence:
      //   (a) tabIndex from bridge v2 (stable handle, survives autotitle)
      //   (b) sentinel_prefix match
      //   (c) exact_label match (legacy fallback)
      const ide = require('./ide')
      const tabsResult = await ide.tabs({})
      const groups = (tabsResult && (tabsResult.groups || (tabsResult.result && tabsResult.result.groups))) || []
      const storedTabIndex = (typeof tab_handle.tabIndex === 'number') ? tab_handle.tabIndex : null
      const sentinelPrefix = tab_handle.sentinel_prefix || null
      const exactLabel = tab_handle.label || tab_handle.label_at_spawn || null
      let group = null
      const candidates = []
      for (const g of groups) {
        if (g.viewColumn !== tab_handle.viewColumn) continue
        group = g
        for (const t of (g.tabs || [])) {
          if (t.viewType === CC_CHAT_VIEW_TYPE) candidates.push(t)
        }
        break
      }
      // Mirrors coord.close_my_tab post-2026-05-29 C2-audit precedence:
      // tabIndex is a fast-path tiebreaker WITHIN the identity-confirmed set,
      // never a standalone key. Position drifts on any sibling tab churn.
      let foundExact = null
      let matchedBy = null
      if (group && storedTabIndex != null) {
        const tabAtIndex = (group.tabs || [])[storedTabIndex]
        if (tabAtIndex && tabAtIndex.viewType === CC_CHAT_VIEW_TYPE) {
          const labelMatch = exactLabel && tabAtIndex.label === exactLabel
          const sentinelMatch = sentinelPrefix && tabAtIndex.label && tabAtIndex.label.startsWith(sentinelPrefix)
          if (labelMatch || sentinelMatch) {
            foundExact = tabAtIndex
            matchedBy = 'tabIndex+' + (sentinelMatch ? 'sentinel' : 'label') + ':' + storedTabIndex
          }
        }
      }
      if (!foundExact && sentinelPrefix) {
        const hit = candidates.find(t => t.label && t.label.startsWith(sentinelPrefix))
        if (hit) { foundExact = hit; matchedBy = 'sentinel_prefix:' + sentinelPrefix }
      }
      if (!foundExact && exactLabel) {
        const hit = candidates.find(t => t.label === exactLabel)
        if (hit) { foundExact = hit; matchedBy = 'exact_label:' + exactLabel }
      }
      if (!foundExact) {
        refused = 'no_match:tabIndex=' + (storedTabIndex == null ? 'null' : storedTabIndex)
          + '|sentinel=' + (sentinelPrefix || 'null')
          + '|exact=' + (exactLabel || 'null')
          + '|vc' + tab_handle.viewColumn
      } else {
        const closeReq = { viewColumn: tab_handle.viewColumn, viewType: CC_CHAT_VIEW_TYPE }
        if (matchedBy && matchedBy.startsWith('tabIndex')) {
          closeReq.tabIndex = storedTabIndex
          closeReq.exactLabel = foundExact.label
        } else {
          closeReq.exactLabel = foundExact.label
          closeReq.label = foundExact.label  // legacy substring fallback
        }
        const closeResult = await ide.tabs_close(closeReq)
        const inner = (closeResult && closeResult.result) || closeResult || {}
        closed = (typeof inner.closed === 'number' ? inner.closed > 0 : !!inner.ok)
      }
    }
  } catch (e) {
    error = e.message || String(e)
  }

  // Cleanup state marker - always safe to do.
  try { fs.unlinkSync(markerPath) } catch (e) {}

  return { ok: true, tab_id: tab_id, closed: closed, refused: refused, error: error, marker_removed: !fs.existsSync(markerPath) }
}

// cowork.cleanup_orphan_workers - sweep recent orphan worker tabs.
//
// Every dispatched worker registers a file at coordination/workers/<tab_id>.json.
// On signal_done -> coord.close_my_tab, the close may refuse when the tab label
// has auto-retitled away from the sentinel prefix (CC summarises long briefs
// into a title-case headline that does not preserve the literal prefix).
// Refuse-and-leak is the right safety call at close-time but tabs accumulate.
//
// This sweep periodically (or on-demand) cross-references the worker registry
// against current ide.tabs() state and closes orphan tabs the strict close
// path could not match. SAFETY: sentinel-prefix match only by default. The
// untitled "Claude Code" match is gated behind force_untitled because Tate's
// own fresh chat tabs also carry that label.
//
// Params:
//   dry_run        : (bool, default false) report what WOULD close, do nothing
//   max_age_days   : (number, default 7)   only consider orphans terminated within window
//   force_untitled : (bool, default false) ALSO match exact "Claude Code" tabs
//                                          (RISK: may match Tate's own fresh chats)
//
// Returns: { ok, dry_run, max_age_days, force_untitled, candidates, closed, results: [...] }
async function cleanup_orphan_workers(params) {
  params = params || {}
  const dry_run = !!params.dry_run
  const max_age_days = Number.isFinite(params.max_age_days) ? params.max_age_days : 7
  const force_untitled = !!params.force_untitled

  ensureDirs()
  const CC_CHAT_VIEW_TYPE = 'mainThreadWebview-claudeVSCodePanel'
  const cutoffMs = Date.now() - max_age_days * 86_400_000

  // Load candidate orphans from registry
  let files = []
  try { files = fs.readdirSync(WORKERS_DIR).filter(f => f.endsWith('.json')) } catch (e) {}
  const orphans = []
  for (const f of files) {
    const filePath = path.join(WORKERS_DIR, f)
    try {
      const w = JSON.parse(fs.readFileSync(filePath, 'utf8'))
      if (!w.terminated_at) continue
      if (w.closed_tab_ok === true) continue
      const ts = Date.parse(w.terminated_at)
      if (!Number.isFinite(ts) || ts < cutoffMs) continue
      const th = w.tab_handle
      if (!th || th.viewColumn == null) continue
      orphans.push({ filePath: filePath, worker: w })
    } catch (e) {}
  }

  if (orphans.length === 0) {
    return { ok: true, dry_run: dry_run, max_age_days: max_age_days, force_untitled: force_untitled,
             candidates: 0, closed: 0, results: [], message: 'no recent orphans with viewColumn-bearing tab_handle' }
  }

  // Snapshot current tab state (single ide.tabs probe)
  let groups = []
  try {
    const tabsResult = await ide.tabs({})
    groups = (tabsResult && (tabsResult.groups || (tabsResult.result && tabsResult.result.groups))) || []
  } catch (e) {
    return { ok: false, error: 'ide.tabs probe failed: ' + (e.message || String(e)) }
  }

  // viewColumn -> { allTabs (ordered, preserves index), ccTabs (mutable, dedup tracking) }
  const groupByCol = {}
  for (const g of groups) {
    groupByCol[g.viewColumn] = {
      allTabs: (g.tabs || []).slice(),
      ccTabs: (g.tabs || []).filter(t => t.viewType === CC_CHAT_VIEW_TYPE),
      claimed: new Set(),  // labels already claimed by a previous orphan this sweep
    }
  }

  const results = []
  let closedCount = 0

  for (const { filePath, worker } of orphans) {
    const th = worker.tab_handle
    const sp = th.sentinel_prefix || null
    const labelAtSpawn = th.label || th.label_at_spawn || null
    const ti = (typeof th.tabIndex === 'number') ? th.tabIndex : null
    const vc = th.viewColumn
    const ctx = groupByCol[vc]
    const cands = ctx ? ctx.ccTabs : []

    let match = null
    let strategy = null
    let usedTabIndex = null

    // Pass 1: tabIndex direct lookup, REQUIRES label OR sentinel confirmation.
    // 2026-05-29 audit C2 fix - tabIndex alone is identity-blind under tab
    // churn. Require label_at_spawn match OR sentinel_prefix match.
    if (ctx && ti != null) {
      const tabAtIndex = ctx.allTabs[ti]
      if (tabAtIndex && tabAtIndex.viewType === CC_CHAT_VIEW_TYPE && !ctx.claimed.has(tabAtIndex.label + '#' + ti)) {
        const labelMatch = labelAtSpawn && tabAtIndex.label === labelAtSpawn
        const sentinelMatch = sp && tabAtIndex.label && tabAtIndex.label.startsWith(sp)
        if (labelMatch || sentinelMatch) {
          match = tabAtIndex
          strategy = 'tabIndex+' + (sentinelMatch ? 'sentinel' : 'label')
          usedTabIndex = ti
        }
      }
    }

    // Pass 2: sentinel-prefix exact match (SAFE - never matches Tate's tabs).
    if (!match && sp) {
      const hit = cands.find(t => t.label && t.label.startsWith(sp) && !ctx.claimed.has(t.label + '#sp'))
      if (hit) { match = hit; strategy = 'sentinel_prefix' }
    }

    // Pass 3 (opt-in): exact "Claude Code" untitled match - RISKY.
    if (!match && force_untitled && ctx) {
      const hit = cands.find(t => t.label === 'Claude Code' && !t.active && !ctx.claimed.has('Claude Code#' + cands.indexOf(t)))
      if (hit) { match = hit; strategy = 'untitled_claude_code_force' }
    }

    if (!match) {
      results.push({ tab_id: worker.tab_id, action: 'leak', reason: 'no_match',
                     tabIndex: ti, sentinel: sp, viewColumn: vc,
                     candidates_in_col: cands.length })
      continue
    }

    if (dry_run) {
      results.push({ tab_id: worker.tab_id, action: 'would_close', label: match.label, strategy: strategy, viewColumn: vc, tabIndex: usedTabIndex })
      if (ctx) ctx.claimed.add(match.label + '#' + (strategy === 'tabIndex' ? usedTabIndex : (strategy === 'sentinel_prefix' ? 'sp' : cands.indexOf(match))))
      continue
    }

    // Close
    try {
      const closeReq = { viewColumn: vc, viewType: CC_CHAT_VIEW_TYPE }
      if (strategy === 'tabIndex') {
        closeReq.tabIndex = usedTabIndex
        closeReq.exactLabel = match.label  // sanity check on bridge v2
      } else {
        closeReq.exactLabel = match.label
        closeReq.label = match.label  // legacy substring fallback
      }
      const cr = await ide.tabs_close(closeReq)
      const inner = (cr && cr.result) || cr || {}
      const closedOk = (typeof inner.closed === 'number' ? inner.closed > 0 : !!inner.ok)
      if (closedOk) {
        try {
          const cur = JSON.parse(fs.readFileSync(filePath, 'utf8'))
          cur.closed_tab_at = new Date().toISOString()
          cur.closed_tab_ok = true
          cur.closed_tab_strategy = 'cleanup_orphan:' + strategy
          cur.closed_tab_label = match.label
          if (usedTabIndex != null) cur.closed_tab_index = usedTabIndex
          fs.writeFileSync(filePath, JSON.stringify(cur, null, 2))
        } catch (e) {}
        if (ctx) ctx.claimed.add(match.label + '#' + (strategy === 'tabIndex' ? usedTabIndex : (strategy === 'sentinel_prefix' ? 'sp' : cands.indexOf(match))))
        closedCount++
        results.push({ tab_id: worker.tab_id, action: 'closed', label: match.label, strategy: strategy, viewColumn: vc, tabIndex: usedTabIndex })
      } else {
        results.push({ tab_id: worker.tab_id, action: 'close_failed', label: match.label, strategy: strategy, refused: inner.refused, raw: inner })
      }
    } catch (e) {
      results.push({ tab_id: worker.tab_id, action: 'close_error', label: match.label, strategy: strategy, error: e.message })
    }
  }

  return {
    ok: true,
    dry_run: dry_run,
    max_age_days: max_age_days,
    force_untitled: force_untitled,
    candidates: orphans.length,
    closed: closedCount,
    leaked: results.filter(r => r.action === 'leak').length,
    results: results,
  }
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
  const force = !!params.force  // ignore in_critical_section (use with care)
  if (!params.account) throw new Error('account required')

  // Normalize account input. Accepts short ("tate") OR full ("tate@ecodia.au");
  // returns canonical full form. Backups on disk use short form (tate.json) by
  // convention; we look up that path via shortForm(canonical).
  const usage = require('./usage')
  const canonical = usage._normalizeAccount(params.account)
  if (!canonical) {
    throw new Error('unknown account: ' + params.account + ' (accepts short "tate"/"code"/"money" or full "tate@ecodia.au"; known: ' + usage._KNOWN_ACCOUNTS.join(',') + ')')
  }
  const targetShort = usage._shortForm(canonical)

  ensureDirs()
  const t0 = Date.now()
  const holder = (ctx && ctx.tab_id) || 'conductor'

  // Locate backup file. Try short ("tate.json") first per current convention,
  // fall back to full ("tate@ecodia.au.json") if some operator named it that way.
  let backupPath = path.join(CREDS_BACKUP_DIR, targetShort + '.json')
  if (!fs.existsSync(backupPath)) {
    const altBackup = path.join(CREDS_BACKUP_DIR, canonical + '.json')
    if (fs.existsSync(altBackup)) {
      backupPath = altBackup
    } else {
      return {
        ok: false,
        error: 'creds_backup_missing',
        detail: 'no backup at ' + backupPath + ' or ' + altBackup,
        hint: 'capture via: cp ~/.claude/.credentials.json ~/.ecodia-creds/' + targetShort + '.json after manually logging into ' + canonical,
      }
    }
  }

  // Pre-compute SHAs so the noop check is file-content-based, not label-based.
  // Label-based noop was the load-bearing bug: after a prior swap where the
  // label-update silently failed, the label would lie and we'd noop a swap that
  // SHOULD have actually moved the file.
  const backupBuf = fs.readFileSync(backupPath)
  const backup_sha = sha256Hex(backupBuf)

  let current_sha = null
  let current_mtime = null
  try {
    const buf = fs.readFileSync(CREDENTIALS_FILE)
    current_sha = sha256Hex(buf)
    current_mtime = fs.statSync(CREDENTIALS_FILE).mtimeMs
  } catch (e) {}

  // SHA-based noop: the file is ALREADY what we'd write. Still resync the label
  // in case it drifted from a prior failed swap.
  if (current_sha && current_sha === backup_sha) {
    let label_synced = false
    try {
      usage._setActiveAccount(canonical, 'swap_creds:noop-label-sync:' + holder)
      label_synced = true
    } catch (e) {}
    return {
      ok: true,
      noop: true,
      to_account: canonical,
      reason: 'creds_file_already_matches_target',
      current_sha256: current_sha,
      label_synced: label_synced,
      swap_ms: Date.now() - t0,
    }
  }

  // Best-effort read of the prior label for audit (may be stale; we no longer
  // gate on it).
  let from_account_label = 'unknown'
  try { from_account_label = usage._getActiveAccount() } catch (e) {}

  // Acquire lock
  const lock = await acquireSwapLock(holder)
  if (!lock.ok) return { ok: false, error: lock.error }

  try {
    // Check in-flight critical workers
    const critCount = inFlightCriticalCount()
    if (critCount > 0 && !force) {
      return { ok: false, error: 'critical_section_active', in_flight_count_at_swap: critCount, hint: 'pass force=true to override (worker may corrupt mid-write)' }
    }

    // Atomic swap: write to tmp in same dir, rename over .credentials.json
    const credsDir = path.dirname(CREDENTIALS_FILE)
    const tmpPath = path.join(credsDir, '.credentials.json.swap-' + process.pid + '-' + Date.now())
    fs.writeFileSync(tmpPath, backupBuf)
    fs.renameSync(tmpPath, CREDENTIALS_FILE)

    // Update active_account label. Pass canonical FULL form (e.g. "tate@ecodia.au")
    // so usage._setActiveAccount's KNOWN_ACCOUNTS validation passes. This was
    // bug #1: cowork was passing the same input the user provided (often short
    // "tate") and the validation silently rejected, leaving the label stuck on
    // whatever it was before.
    let label_updated = false
    let label_error = null
    try {
      usage._setActiveAccount(canonical, 'swap_creds:' + holder)
      label_updated = true
    } catch (e) {
      label_error = e.message
    }

    // Clobber detection. The parent CC session writes its in-memory OAuth bearer
    // back to .credentials.json on refresh, silently reverting in-session swaps.
    // We sleep briefly, re-read SHA, and surface a warning if the post-swap
    // content has drifted. Default 1500ms; opt out with clobber_detection_ms=0.
    let clobbered_by_parent = false
    let post_sha = null
    const clobberWindow = (typeof params.clobber_detection_ms === 'number')
      ? Math.max(0, Math.min(10000, params.clobber_detection_ms))
      : 1500
    if (clobberWindow > 0) {
      await sleep(clobberWindow)
      try {
        post_sha = sha256Hex(fs.readFileSync(CREDENTIALS_FILE))
        if (post_sha !== backup_sha) clobbered_by_parent = true
      } catch (e) {}
    }

    const swap_ms = Date.now() - t0
    const histEntry = {
      ts: new Date().toISOString(),
      from_account: from_account_label,
      to_account: canonical,
      swap_ms: swap_ms,
      in_flight_count_at_swap: critCount,
      prior_sha256: current_sha,
      new_sha256: backup_sha,
      post_sha256: post_sha,
      prior_mtime_ms: current_mtime,
      label_updated: label_updated,
      label_error: label_error,
      clobbered_by_parent: clobbered_by_parent,
      clobber_detection_ms: clobberWindow,
      holder: holder,
      forced: force,
    }
    const histPos = appendSwapHistory(histEntry)

    return {
      ok: !clobbered_by_parent && label_updated,
      from_account: from_account_label,
      to_account: canonical,
      swap_ms: swap_ms,
      in_flight_count_at_swap: critCount,
      prior_sha256: current_sha,
      new_sha256: backup_sha,
      post_sha256: post_sha,
      label_updated: label_updated,
      label_error: label_error,
      clobbered_by_parent: clobbered_by_parent,
      swap_history_position: histPos,
      hint: clobbered_by_parent
        ? 'parent_session_oauth_refresh_reverted_swap: the file was rewritten back within ' + clobberWindow + 'ms by the parent Claude Code session\'s OAuth refresh. swap_creds is reliable for FRESH worker dispatch (worker reads creds at spawn before parent overwrites). For in-session swap of the current process, swap survival is not guaranteed.'
        : undefined,
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
  cleanup_orphan_workers: cleanup_orphan_workers,
  swap_creds: swap_creds,
  swap_history: swap_history,
}
