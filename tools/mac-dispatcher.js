// mac-dispatcher.js - Mac-native cowork.dispatch_worker.
//
// Authored 2026-06-08 (Mac-mini day-1). The Corazon-era cowork.js dispatch
// chain depends on AutoHotkey + Win32 WinActivate/SendInput/GetForegroundWindow
// + ahk_exe Code.exe matching, none of which exist on macOS. Rather than
// branch every line in cowork.js, this module re-implements ONLY the
// dispatch_worker function for darwin and re-exports kill_worker +
// cleanup_orphan_workers from cowork.js (they use cross-platform
// ide.tabs / ide.tabs_close - already platform-agnostic).
//
// Critical architectural shift on Mac: ide.chat_send_message accepts
// {submit: true} which runs the open + populate + submit chain entirely
// inside the extension host. NO OS keystroke, NO focus dependency, NO AHK.
// The bridge's claude-vscode.editor.open does the same work the Windows path
// did across the 1500-line cowork.js dispatch_worker, in one extension-host
// tick.
//
// This module wires into scheduler.js via the existing _setDispatcher seam.
// index.js calls scheduler._setDispatcher(macDispatcher) when process.platform
// === 'darwin'. cowork.js stays untouched (except for the COORD_ROOT env-var
// fix) so the Windows path remains intact for Corazon.

'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')

const ide = require('./ide')
const applescript = require('./applescript')
const cowork = require('./cowork')  // for kill_worker, cleanup_orphan_workers, helpers

// Match cowork.js path resolution exactly (env var > platform default).
const COORD_ROOT = process.env.COORD_ROOT
  || path.join(os.homedir(), '.ecodiaos', 'coordination')
const BRIEFS_DIR = path.join(COORD_ROOT, 'briefs')
const STATE_DIR = path.join(COORD_ROOT, 'state')
const WORKERS_DIR = path.join(COORD_ROOT, 'workers')
const MESSAGES_DIR = path.join(COORD_ROOT, 'messages')

const BRIEF_INLINE_CAP_BYTES = 100 * 1024
const DEFAULT_WORKER_ACK_TIMEOUT_MS = 180000
const WORKER_ACK_POLL_INTERVAL_MS = 2000

function ensureDirs() {
  for (const d of [COORD_ROOT, BRIEFS_DIR, STATE_DIR, WORKERS_DIR, MESSAGES_DIR]) {
    try { fs.mkdirSync(d, { recursive: true }) } catch (e) {}
  }
}

function uuid() { return crypto.randomUUID() }
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function loadLaptopAgentToken() {
  try {
    return fs.readFileSync(path.join(os.homedir(), '.ecodiaos', 'laptop-agent.token'), 'utf8').trim()
  } catch (e) { return '' }
}

// HTTP POST (no external deps - mirrors cowork.js postJson).
function postJson(urlStr, body, bearerToken) {
  return new Promise((resolve, reject) => {
    const u = require('url').parse(urlStr)
    const httpMod = u.protocol === 'https:' ? require('https') : require('http')
    const payload = JSON.stringify(body)
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    }
    if (bearerToken) headers['Authorization'] = 'Bearer ' + bearerToken
    const req = httpMod.request({
      hostname: u.hostname, port: u.port, path: u.path, method: 'POST', headers, timeout: 5000,
    }, res => {
      let chunks = ''
      res.on('data', c => chunks += c)
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(chunks) }) }
        catch (e) { resolve({ status: res.statusCode, body: chunks, parse_error: e.message }) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('register-worker timed out')) })
    req.write(payload)
    req.end()
  })
}

// composeBrief - the dispatcher's identity + plumbing wrapper around the cron
// prompt body. The cron prompt is itself a fully-formed agentic brief per
// patterns/cron-worker-prompt-template.md (HEADER + CONTEXT + OBJECTIVE +
// AGENCY + HARD CONSTRAINTS + DELIVERABLE + QUALITY BAR). This wrapper must
// NOT contradict the cron's AGENCY section. The old wrapper had
// "Do not orchestrate. Do not spawn workers" which directly contradicted the
// cron template's "You may schedule_delayed in 0m to spawn an immediate
// sibling worker." Workers read both and followed the more restrictive line.
//
// This rewrite keeps ONLY plumbing the worker can't infer from the cron body:
// - Worker identity (tab_id, task_id, tab_credential)
// - MCP coord calling convention (identity-in-args)
// - First action: verify_paste against the audit file (recovery)
// - Closing actions: signal_done + close_my_tab
// Heartbeat is auto-fired by the coord MCP server on any tool call, no
// explicit instruction needed. Everything else is the cron's responsibility.
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
    'YOU ARE A DISPATCHED WORKER. Your identity for the coord substrate:\n' +
    '  tab_id: ' + tab_id + '\n' +
    '  task_id: ' + task_id + '\n' +
    '  tab_credential: ' + tab_credential + '\n' +
    'Registration is already done. Do NOT run any curl bootstrap.\n' +
    '\n' +
    'MCP coord calling convention:\n' +
    'The coord MCP connector is workspace-wide so it cannot auto-detect which tab is calling.\n' +
    'Include tab_id + tab_credential as ARGUMENTS in every coord.* call:\n' +
    '  mcp__coord__coord_signal_done({tab_id:"' + tab_id + '", tab_credential:"' + tab_credential + '", task_id:"' + task_id + '", result_summary:"...", status:"success", terminate:true})\n' +
    '  mcp__coord__coord_close_my_tab({tab_id:"' + tab_id + '", tab_credential:"' + tab_credential + '"})\n' +
    'Direct HTTP to localhost:7456 needs the agent bearer (workers do not have it). Use MCP.\n'

  const verifyFirst =
    'FIRST ACTION (recommended, before task work):\n' +
    '  mcp__coord__coord_verify_paste({tab_id:"' + tab_id + '", tab_credential:"' + tab_credential + '", task_id:"' + task_id + '"})\n' +
    'Returns the canonical brief from the dispatcher audit file. If the brief pasted below\n' +
    'looks truncated or corrupted, trust verify_paste.brief_body over the in-chat copy.\n'

  const taskBlock = brief_storage === 'file'
    ? 'YOUR TASK (full brief at: ' + brief_file_path + ' - read in full, then execute):\n'
    : 'YOUR TASK:\n' + brief_body + '\n'

  // Plumbing-only closing actions. Agency, scope, scheduling permissions all
  // come from the cron's AGENCY block above. The dispatcher wrapper imposes
  // NO restrictions on what the worker can do - the cron prompt's HARD
  // CONSTRAINTS section is the only authoritative restriction layer.
  const closing =
    'CLOSING (mandatory at exit):\n' +
    '1. mcp__coord__coord_signal_done({tab_id:"' + tab_id + '", tab_credential:"' + tab_credential + '", task_id:"' + task_id + '", status:"success"|"failed", result_summary:"...", terminate:true})\n' +
    '2. mcp__coord__coord_close_my_tab({tab_id:"' + tab_id + '", tab_credential:"' + tab_credential + '"})\n' +
    'Without close_my_tab as your final tool call, every worker tab accumulates in the IDE.\n'

  return [header, '', identity, '', verifyFirst, '', taskBlock, '', closing].join('\n')
}

async function dispatch_worker(params) {
  params = params || {}
  const account = params.account || 'current'
  const brief_body = params.brief || ''
  const task_id = params.task_id || uuid()
  let parent_conductor_tab_id = params.parent_conductor_tab_id || null
  if (!parent_conductor_tab_id) {
    try {
      const coord = require('./coord')
      const reg = coord._loadConductorRegistration && coord._loadConductorRegistration()
      if (reg && reg.tab_id) parent_conductor_tab_id = reg.tab_id
    } catch (e) {}
  }
  const coord_url = params.coord_url || 'http://localhost:7456'

  if (!brief_body) throw new Error('brief required')
  ensureDirs()

  const tab_id = 'tab_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex')
  const tab_credential = uuid()

  // Sentinel-prefix label pinning - same shape as cowork.js so kill_worker /
  // close_my_tab tab-resolution code works identically.
  const sentinel_inner = (params.worker_name && /^[A-Za-z0-9_\- ]{1,40}$/.test(String(params.worker_name)))
    ? String(params.worker_name)
    : ('EOS-W-' + tab_id.slice(-8))
  const sentinel_prefix = '[' + sentinel_inner + ']'
  const briefed_body = sentinel_prefix + ' ' + brief_body

  const brief_size_bytes = Buffer.byteLength(briefed_body, 'utf8')
  let brief_storage = 'inline'
  let brief_file_path = null
  if (brief_size_bytes > BRIEF_INLINE_CAP_BYTES) {
    brief_storage = 'file'
    brief_file_path = path.join(BRIEFS_DIR, task_id + '.md')
  }

  // Always write audit copy for verify_paste recovery.
  const auditFilePath = path.join(BRIEFS_DIR, task_id + '.md')
  try { fs.writeFileSync(auditFilePath, briefed_body, 'utf8') } catch (e) {}

  // Resolve current account label.
  let resolved_account = account
  if (account === 'current') {
    try {
      const usage = require('./usage')
      resolved_account = usage._getActiveAccount()
    } catch (e) {
      resolved_account = 'current-process'
    }
  }
  const account_active_when_spawned = resolved_account

  // Synchronous worker registration (conductor-side).
  let register_result = null
  try {
    register_result = await postJson(
      coord_url + '/api/comms/register-worker',
      {
        tab_id, task_id, tab_credential,
        parent_conductor_tab_id,
        account_active_when_spawned,
      },
      loadLaptopAgentToken()
    )
    if (register_result.status !== 200) {
      return {
        ok: false, tab_id, task_id,
        error: 'register-worker rejected: ' + register_result.status,
        register_body: register_result.body,
      }
    }
  } catch (e) {
    return { ok: false, tab_id, task_id, error: 'register-worker failed: ' + e.message }
  }

  // Compose brief.
  const composedBriefInner = composeBrief({
    tab_id, task_id, tab_credential, parent_conductor_tab_id,
    brief_body: brief_storage === 'inline' ? brief_body : '',
    brief_size_bytes,
    brief_storage,
    brief_file_path: brief_storage === 'file' ? brief_file_path : null,
  })
  const composedBrief = sentinel_prefix + '\n' + composedBriefInner

  // THE LOAD-BEARING MAC SHIFT: ide.chat_send_message opens + populates the
  // chat input in extension-host space (no AHK, no focus race for that part).
  // BUT submit is harder: workbench.action.chat.submit targets VS Code's
  // built-in Copilot chat surface, not the CC webview, and the extension host
  // cannot dispatch DOM events into another extension's webview iframe. So
  // the bridge leaves submit_command_ok: false and the caller (this dispatcher)
  // has to send one Enter via System Events. Mirror cowork.js's
  // window.focus_and_send AHK chain with applescript.activate_app +
  // applescript.keystroke. Apple Events activate is the gentlest available
  // path - doesn't steal keyboard focus the way Win32 WinActivate does, but
  // does ensure VS Code is the keystroke target.
  let tab_handle = null
  let spawn_error = null
  let submit_path = null
  try {
    const sendRes = await ide.chat_send_message({ prompt: composedBrief, submit: false })
    const inner = (sendRes && (sendRes.result || sendRes)) || {}
    if (inner.open_command_ok === false) {
      spawn_error = 'editor.open failed: ' + (inner.open_error || 'unknown')
    }
    const ot = inner.opened_tab
    if (ot && ot.viewColumn != null) {
      tab_handle = {
        sentinel_prefix,
        viewColumn: ot.viewColumn,
        viewType: ot.viewType || 'mainThreadWebview-claudeVSCodePanel',
        label_at_spawn: ot.label,
        tabIndex: (typeof ot.index === 'number') ? ot.index : null,
        captured_via: 'bridge_chat_send_message',
        captured_label_is_provisional: true,
      }
    }
    // Submit step. The bridge has populated the textarea; the 1200ms settle
    // below guarantees populate has finished before the Enter lands, so a
    // single Return reliably submits the already-prefilled brief. (History:
    // this used to fire 4x Enter spaced 800ms as belt-and-suspenders against a
    // populate/submit race, but the settle already closes that race and the
    // first Enter is the only one that ever submitted - the extra 3 were
    // no-ops landing on whatever surface had focus. Cut to 1x on 2026-06-21
    // per Tate: the trailing presses were disruptive, not load-bearing.)
    // Mac mirror:
    //   1) bridge ide.command focusNthEditorGroup (by viewColumn) - already
    //      moves keyboard focus into that group from the extension host
    //   2) applescript.activate_app (Apple Events activate, no focus steal
    //      beyond bringing VS Code forward)
    //   3) 1200ms settle for populate to finish
    //   4) 1x applescript.keystroke 'return'
    if (tab_handle && !spawn_error) {
      try {
        // 1. Focus the editor group hosting the new chat tab via bridge.
        const focusGroupCmd = (vc) => {
          if (vc === 1) return 'workbench.action.focusFirstEditorGroup'
          if (vc === 2) return 'workbench.action.focusSecondEditorGroup'
          if (vc === 3) return 'workbench.action.focusThirdEditorGroup'
          if (vc === 4) return 'workbench.action.focusFourthEditorGroup'
          if (vc === 5) return 'workbench.action.focusFifthEditorGroup'
          return null
        }
        const focusCmd = focusGroupCmd(tab_handle.viewColumn)
        if (focusCmd) {
          try {
            await Promise.race([
              ide.command({ cmd: focusCmd }),
              new Promise((_, rej) => setTimeout(() => rej(new Error('focus_cmd_timeout_3s')), 3000)),
            ])
            await sleep(200)
          } catch (_e) { /* tolerate */ }
        }
        // 2. Activate VS Code (Apple Events; gentler than Win32 WinActivate).
        await applescript.activate_app({ app: 'Visual Studio Code' })
        // 3. Settle for the bridge's editor.open + textarea-populate to finish.
        await sleep(1200)
        // 4. Single Enter. The 1200ms settle above guarantees the populated
        //    textarea is ready, so one Return submits the brief.
        try {
          await applescript.keystroke({ key: 36 })  // key code 36 = Return; passing string 'return' types the literal word
        } catch (e) {
          // tolerate keystroke failure; tab is open + prefilled, recoverable by hand
        }
        submit_path = 'focus_group+activate+1200ms_settle+1x_return'
      } catch (e) {
        submit_path = 'submit_chain_threw: ' + e.message
      }
    }
  } catch (e) {
    spawn_error = e.message
  }

  if (!tab_handle) {
    try {
      if (account_active_when_spawned && account_active_when_spawned !== 'current-process') {
        const usage = require('./usage')
        usage._markFlaky(account_active_when_spawned, 'mac_dispatch_populate_failed: ' + (spawn_error || 'unknown'))
      }
    } catch (e) {}
    return {
      ok: false, tab_id,
      error: 'populate failed (editor.open): ' + (spawn_error || 'no opened_tab returned'),
      account_marked_flaky: account_active_when_spawned,
    }
  }

  // Persist tab_handle for kill_worker / close_my_tab.
  try {
    const coord = require('./coord')
    if (typeof coord.setWorkerTabHandle === 'function') {
      coord.setWorkerTabHandle(tab_id, tab_handle)
    }
  } catch (e) {}

  // Write paste-verify flag (same shape as cowork.js).
  try {
    const verifyFlag = {
      task_id, tab_id,
      brief_size_bytes,
      brief_sha256: crypto.createHash('sha256').update(brief_body).digest('hex'),
      pasted_at: new Date().toISOString(),
    }
    fs.writeFileSync(path.join(BRIEFS_DIR, task_id + '-PASTE-VERIFY.flag'),
      JSON.stringify(verifyFlag, null, 2), 'utf8')
  } catch (e) {}

  // Orphan-tab detection: wait for the worker to issue ANY coord.* call.
  const ackTimeoutMs = (typeof params.worker_acknowledgment_timeout_ms === 'number')
    ? Math.max(0, Math.min(600000, params.worker_acknowledgment_timeout_ms))
    : DEFAULT_WORKER_ACK_TIMEOUT_MS
  let acknowledged = false
  let ack_via = null
  let ack_elapsed_ms = 0
  if (ackTimeoutMs > 0) {
    const workerFile = path.join(WORKERS_DIR, tab_id + '.json')
    const start = Date.now()
    let baseline_heartbeat = null
    try {
      const data = JSON.parse(fs.readFileSync(workerFile, 'utf8'))
      baseline_heartbeat = data.last_heartbeat_at
    } catch (e) {}
    while (Date.now() - start < ackTimeoutMs) {
      try {
        const data = JSON.parse(fs.readFileSync(workerFile, 'utf8'))
        if (data.last_heartbeat_at && data.last_heartbeat_at > baseline_heartbeat) {
          acknowledged = true
          ack_via = 'heartbeat'
          break
        }
      } catch (e) {}
      try {
        const files = fs.readdirSync(MESSAGES_DIR).filter(f => f.endsWith('.json'))
        files.sort((a, b) => b.localeCompare(a))
        for (const mf of files.slice(0, 60)) {
          try {
            const m = JSON.parse(fs.readFileSync(path.join(MESSAGES_DIR, mf), 'utf8'))
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
      await sleep(WORKER_ACK_POLL_INTERVAL_MS)
    }
    ack_elapsed_ms = Date.now() - start
  }

  if (ackTimeoutMs > 0 && !acknowledged) {
    return {
      ok: false, tab_id, tab_credential, task_id,
      account_active_when_spawned,
      registered_at: register_result.body.registered_at,
      tab_handle,
      orphan: true,
      orphan_reason: 'no coord.* call from spawned worker within ' + ackTimeoutMs + 'ms',
      ack_elapsed_ms,
      brief_file_audit: auditFilePath,
      note: 'Mac dispatch: worker tab spawned via ide.chat_send_message({submit:true}) ' +
            'but model never sent a coord.* call (heartbeat/progress/done). Causes: model never started, ' +
            'extension host wedge, OOM, or auth gate. Call cowork.kill_worker({tab_id}) and retry.',
    }
  }

  return {
    ok: true,
    tab_id, tab_credential, task_id,
    account_active_when_spawned,
    registered_at: register_result.body.registered_at,
    brief_size_bytes,
    brief_storage,
    brief_file_audit: auditFilePath,
    role: 'worker',
    recovery_attempts: 0,
    tab_handle,
    coord_url,
    acknowledged,
    ack_via,
    ack_elapsed_ms,
    dispatcher: 'mac-dispatcher',
    submit_path,
    note: ackTimeoutMs > 0
      ? ('Worker acknowledged in ' + ack_elapsed_ms + 'ms via ' + ack_via +
         '. Mac path: ide.chat_send_message + applescript Enter.')
      : 'Fire-and-forget mode (ack timeout=0). Worker registered + brief populated + Enter sent.',
  }
}

// Re-export the cross-platform kill / cleanup / list from cowork.js.
// Those use ide.tabs / ide.tabs_close which run in extension-host space,
// no platform dependency.
module.exports = {
  dispatch_worker,
  kill_worker: cowork.kill_worker,
  cleanup_orphan_workers: cowork.cleanup_orphan_workers,
  list_workers: cowork.list_workers,
  swap_creds: cowork.swap_creds,
  swap_history: cowork.swap_history,
}
