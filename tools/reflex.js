/**
 * reflex.js - the firing primitive that opens a new Claude Code chat tab
 * on this laptop (Corazon). This is how I open additional mouths.
 *
 * Background: post-VPS-cutover (Phase 2 status_board 7830e176), VS Code on
 * Corazon with the Claude Code extension is my native anatomy. Cron and
 * webhook fires open a fresh interactive Claude Code chat tab in this body.
 * Each fire is a new interactive session - full Max subscription budget
 * across all 3 accounts, uncapped, no Routine 15/day ceiling.
 *
 * Firing primitive (chosen 2026-05-16 after URI handler path failed live test):
 *   AHK v2 macro -> activate VS Code window -> Ctrl+Shift+P (command palette)
 *   -> type "Claude Code: Open in New Tab" -> Enter -> wait for panel ->
 *   clipboard-paste prompt -> Send Ctrl+V. We do NOT auto-submit by default
 *   so the conductor (the chat session that opens) can decide to edit before
 *   sending. Pass auto_submit=true to fire Enter after the paste.
 *
 * The URI handler vscode://anthropic.claude-code/open?prompt=... was the
 * first hypothesis (registerUriHandler is in the extension code) but live
 * tests with Start-Process AND direct Code.exe --open-url both failed to
 * open a chat - no extension log trace, no new tab. Falling back to the
 * GUI-macro path which is the same primitive a human uses, so it cannot be
 * silently disabled.
 *
 * Window targeting via the macro: we activate by partial window title. If
 * multiple VS Code windows are open the most recently active one matching
 * the title wins. Multi-account targeting is via different editors (VS Code
 * stable / Insiders / Cursor) which each have distinct window titles + exe.
 *
 * Dedupe lives in a per-laptop JSON log so the same idempotency_key fired
 * twice within DEDUPE_WINDOW_HOURS is a no-op.
 */

const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { CREATE_NO_WINDOW } = require('./_lib/silentExec')

const IDE_LOCK_DIR = path.join(os.homedir(), '.claude', 'ide')
const REFLEX_LOG_PATH = path.join(os.homedir(), '.claude', 'ecodia-reflex-log.json')
const TELEGRAM_MASTER_STATE_PATH = path.join(os.homedir(), '.claude', 'telegram-master-state.json')
const TELEGRAM_WORKSPACE_PATH = 'D:\\.code\\telegram-conductor'
const TELEGRAM_WINDOW_TITLE = 'telegram-conductor - Visual Studio Code'
const DEDUPE_WINDOW_HOURS = 24
const LOG_CAP = 500
const MAX_PROMPT_CHARS = 64 * 1024
const AHK_EXE = 'C:\\Users\\tjdTa\\AppData\\Local\\Programs\\AutoHotkey\\v2\\AutoHotkey64.exe'

const EDITOR_PROFILES = {
  vscode: {
    // Target the backend workspace window specifically so multi-window VS Code
    // doesn't grab some random instance. WinActivate accepts substring match
    // on title; "backend - Visual Studio Code" is unique among Tate's open
    // windows (.code workspace shows ".code -", the backend workspace shows
    // "backend -"). Fallback path used by spawn_window_if_missing still uses
    // generic "Visual Studio Code" for any-window-up check.
    window_title_hint: 'backend - Visual Studio Code',
    window_title_fallback: 'Visual Studio Code',
    exe_basename: 'Code.exe',
    exe_path: 'C:\\Users\\tjdTa\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe',
  },
  'vscode-insiders': {
    window_title_hint: 'Visual Studio Code - Insiders',
    window_title_fallback: 'Visual Studio Code - Insiders',
    exe_basename: 'Code - Insiders.exe',
    exe_path: 'D:\\SSD_Turbo\\Microsoft VS Code Insiders\\Code - Insiders.exe',
  },
  cursor: {
    window_title_hint: 'Cursor',
    window_title_fallback: 'Cursor',
    exe_basename: 'Cursor.exe',
    exe_path: 'D:\\SSD_Turbo\\Cursor\\Cursor.exe',
  },
}
const DEFAULT_EDITOR = 'vscode'

function readLog() {
  try {
    const raw = fs.readFileSync(REFLEX_LOG_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed.fires)) return parsed
  } catch {}
  return { fires: [] }
}

function writeLog(log) {
  const trimmed = { fires: log.fires.slice(-LOG_CAP) }
  fs.writeFileSync(REFLEX_LOG_PATH, JSON.stringify(trimmed, null, 2))
}

function isDuplicate(log, idempotencyKey) {
  if (!idempotencyKey) return false
  const cutoff = Date.now() - DEDUPE_WINDOW_HOURS * 3600 * 1000
  return log.fires.some(f => f.idempotency_key === idempotencyKey && new Date(f.fired_at).getTime() > cutoff)
}

function appendFire(log, entry) {
  log.fires.push(entry)
  writeLog(log)
}

function resolveEditor(editor) {
  const e = (editor || DEFAULT_EDITOR).toLowerCase()
  const profile = EDITOR_PROFILES[e]
  if (!profile) throw new Error(`Unknown editor '${e}'. Allowed: ${Object.keys(EDITOR_PROFILES).join(', ')}`)
  return { editor: e, ...profile }
}

/**
 * Run an AHK v2 macro script with env vars set. Writes script to temp file,
 * spawns AHK with the env, returns { exit_code, duration_ms }. Throws on
 * spawn error or timeout.
 */
function runAhkMacro({ script, env, timeout_ms = 15000 }) {
  if (!fs.existsSync(AHK_EXE)) {
    throw new Error(`AutoHotkey v2 not found at ${AHK_EXE}`)
  }
  const tmp = path.join(os.tmpdir(), `reflex-${Date.now()}-${Math.random().toString(36).slice(2)}.ahk`)
  fs.writeFileSync(tmp, '#Requires AutoHotkey v2.0\n' + script + '\nExitApp(0)', 'utf8')
  const startedAt = Date.now()
  try {
    const result = spawnSync(AHK_EXE, [tmp], {
      env: { ...process.env, ...env },
      timeout: timeout_ms,
      windowsHide: true,
      creationFlags: CREATE_NO_WINDOW,
      encoding: 'utf8',
    })
    return { exit_code: typeof result.status === 'number' ? result.status : null, duration_ms: Date.now() - startedAt, error: result.error?.message || null, stdout: (result.stdout || '').trim(), stderr: (result.stderr || '').trim() }
  } finally {
    try { fs.unlinkSync(tmp) } catch {}
  }
}

/**
 * The macro itself. Reads REFLEX_PROMPT, REFLEX_WINDOW_TITLE,
 * REFLEX_WINDOW_TITLE_FALLBACK, REFLEX_AUTO_SUBMIT from env. Exit codes:
 *   0 success
 *   2 could not activate target editor window (title hint+fallback mismatch)
 *   3 clipboard wait timed out
 *
 * V2 macro (2026-05-16 18:00) hardened after Tate observed:
 *   - "Claude Code:" typed into his active chat input (Ctrl+Shift+P got
 *     absorbed by the input control before palette opened)
 *   - new tab opened in some other window (WinActivate hit wrong window
 *     among Tate's 3+ open VS Code instances)
 * Fixes:
 *   - Prefer specific workspace title (e.g. "backend - Visual Studio Code")
 *     so multi-window VS Code doesn't grab a random instance
 *   - Double-Esc before opening palette to clear any modal/popup/input
 *     focus that might absorb the Ctrl+Shift+P keystroke
 *   - Longer settle pauses throughout (~3x what worked in the smoke test
 *     when no other input was contesting focus)
 *   - Verify the palette opened by checking that the previously-focused
 *     control changed (via WinWait on the palette element; AHK can't see
 *     VS Code's internal widgets so we rely on time + retry)
 */
const MACRO_SCRIPT = `
promptText := EnvGet("REFLEX_PROMPT")
titleHint := EnvGet("REFLEX_WINDOW_TITLE")
titleFallback := EnvGet("REFLEX_WINDOW_TITLE_FALLBACK")
autoSubmit := EnvGet("REFLEX_AUTO_SUBMIT")
if (titleHint = "") {
  titleHint := "Visual Studio Code"
}
if (titleFallback = "") {
  titleFallback := titleHint
}

; Try specific workspace-titled window first; fall back to generic match.
activated := false
if WinExist(titleHint) {
  WinActivate titleHint
  if WinWaitActive(titleHint, , 3) {
    activated := true
  }
}
if (!activated && WinExist(titleFallback)) {
  WinActivate titleFallback
  if WinWaitActive(titleFallback, , 3) {
    activated := true
  }
}
if (!activated) {
  ExitApp(2)
}

; Settle pause after window activation - some Windows builds need this for
; subsequent keystrokes to land in the right input layer.
Sleep 500

; Clear any modal / popup / input focus that could absorb the next keystroke.
; Single Esc dismisses menus, popups, and unfocuses the active input.
; Double-Esc is intentionally avoided: in Claude Code chat tabs (which is
; what WinActivate often lands on first when Tate has CC open), double-Esc
; is the "rewind to message" accelerator and opens a modal in the
; previously-focused chat. Single Esc clears focus without that side-effect.
Send "{Esc}"
Sleep 250

; Open VS Code command palette. F1 is an alternate accelerator that's less
; likely to be intercepted by input controls than Ctrl+Shift+P, but use
; both for redundancy.
Send "{F1}"
Sleep 700

; Type the command name. SendText is literal (no escape interpretation).
SendText "Claude Code: Open in New Tab"
Sleep 500

; Execute - opens a new Claude Code chat in a new editor tab.
Send "{Enter}"

; Wait for the new chat panel to mount + auto-focus the input. Generous
; wait because the panel is a webview that takes 1-2s to render its DOM.
Sleep 2500

; Set clipboard to the prompt body, paste via Ctrl+V into the (hopefully)
; auto-focused new-chat input.
A_Clipboard := promptText
if !ClipWait(2) {
  ExitApp(3)
}
Send "^v"
Sleep 400

; Optional auto-submit. Default false so the prompt sits in the input box
; visible for human inspection; SMS path passes true so the chat starts
; running immediately.
if (autoSubmit = "true" || autoSubmit = "1") {
  Send "{Enter}"
}
`

/**
 * Fire a new Claude Code chat tab on this laptop with the prompt pre-loaded.
 *
 * params:
 *   prompt: string (required, max 64KB) - the prompt text the chat will start with
 *   source: string (optional) - origin tag for audit (e.g. 'twilio-sms', 'cron-meta-loop')
 *   idempotency_key: string (optional) - dedupe key, repeats within 24h no-op
 *   editor: string (optional, default 'vscode') - which editor profile to fire
 *           ('vscode' | 'vscode-insiders' | 'cursor'); each is a separate Max account
 *   auto_submit: bool (optional, default false) - press Enter after pasting the prompt
 *   spawn_window_if_missing: bool (optional, default false) - launch the editor exe
 *           with -n if no window matching the title is currently up
 *   dry_run: bool (optional) - validate inputs and return the macro plan without firing
 *
 * returns: { ok, fired, dedupe?, editor, window_title_hint, exit_code?, duration_ms?, fired_at? }
 */
async function fire({ prompt, source, idempotency_key, editor, auto_submit, spawn_window_if_missing, dry_run } = {}) {
  if (typeof prompt !== 'string' || prompt.length === 0) {
    throw new Error('prompt is required and must be a non-empty string')
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new Error(`prompt exceeds ${MAX_PROMPT_CHARS} chars (got ${prompt.length})`)
  }
  const ed = resolveEditor(editor)

  if (dry_run) {
    return { ok: true, fired: false, dry_run: true, editor: ed.editor, window_title_hint: ed.window_title_hint, exe_path: ed.exe_path }
  }

  const log = readLog()
  if (isDuplicate(log, idempotency_key)) {
    return { ok: true, fired: false, dedupe: 'duplicate', idempotency_key, editor: ed.editor }
  }

  if (spawn_window_if_missing && !isEditorWindowUp(ed.window_title_hint)) {
    if (!fs.existsSync(ed.exe_path)) {
      throw new Error(`spawn_window_if_missing requested but editor exe not found at ${ed.exe_path}`)
    }
    const child = spawn(ed.exe_path, ['-n'], { detached: true, stdio: 'ignore', windowsHide: true, creationFlags: CREATE_NO_WINDOW })
    child.unref()
    await new Promise(r => setTimeout(r, 2500))
  }

  const firedAt = new Date().toISOString()
  const result = runAhkMacro({
    script: MACRO_SCRIPT,
    env: {
      REFLEX_PROMPT: prompt,
      REFLEX_WINDOW_TITLE: ed.window_title_hint,
      REFLEX_WINDOW_TITLE_FALLBACK: ed.window_title_fallback || ed.window_title_hint,
      REFLEX_AUTO_SUBMIT: auto_submit ? 'true' : 'false',
    },
    timeout_ms: 20000,
  })

  appendFire(log, {
    fired_at: firedAt,
    editor: ed.editor,
    source: source || null,
    idempotency_key: idempotency_key || null,
    auto_submit: !!auto_submit,
    prompt_preview: prompt.slice(0, 120),
    prompt_chars: prompt.length,
    exit_code: result.exit_code,
    duration_ms: result.duration_ms,
  })

  return {
    ok: result.exit_code === 0,
    fired: true,
    fired_at: firedAt,
    editor: ed.editor,
    window_title_hint: ed.window_title_hint,
    exit_code: result.exit_code,
    duration_ms: result.duration_ms,
    error: result.error,
    macro_exit_meaning: macroExitMeaning(result.exit_code),
  }
}

function macroExitMeaning(code) {
  switch (code) {
    case 0: return 'success'
    case 2: return 'could_not_activate_window'
    case 3: return 'clipboard_wait_timed_out'
    case null: return 'spawn_error_or_timeout'
    default: return `ahk_exit_${code}`
  }
}

function isEditorWindowUp(titleHint) {
  try {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', `Get-Process | Where-Object { $_.MainWindowTitle -like "*${titleHint.replace(/"/g, '`"')}*" } | Measure-Object | ForEach-Object { $_.Count }`], { encoding: 'utf8', timeout: 5000, windowsHide: true, creationFlags: 0x08000000 })
    const count = parseInt((result.stdout || '0').trim(), 10)
    return count > 0
  } catch {
    return false
  }
}

function readTelegramMasterState() {
  try {
    const raw = fs.readFileSync(TELEGRAM_MASTER_STATE_PATH, 'utf8')
    return JSON.parse(raw) || {}
  } catch {
    return {}
  }
}

function writeTelegramMasterState(patch) {
  const current = readTelegramMasterState()
  const next = { ...current, ...patch }
  try {
    fs.writeFileSync(TELEGRAM_MASTER_STATE_PATH, JSON.stringify(next, null, 2))
  } catch (err) {
    // Non-fatal: state file is a cache, not authoritative.
  }
  return next
}

function hasTelegramWorkspaceMouth() {
  try {
    if (!fs.existsSync(IDE_LOCK_DIR)) return false
    const files = fs.readdirSync(IDE_LOCK_DIR).filter(f => f.endsWith('.lock'))
    const wsLower = TELEGRAM_WORKSPACE_PATH.toLowerCase()
    for (const f of files) {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(IDE_LOCK_DIR, f), 'utf8'))
        const folders = Array.isArray(parsed.workspaceFolders) ? parsed.workspaceFolders : []
        if (folders.some(p => String(p || '').toLowerCase() === wsLower)) {
          // Only count VS Code stable (the editor we target by window title)
          if (parsed.ideName === 'Visual Studio Code') return true
        }
      } catch {}
    }
    return false
  } catch {
    return false
  }
}

/**
 * Macro for the SEED path - opens a new Claude Code chat in the dedicated
 * telegram-conductor workspace and pastes the seed prompt.
 *
 * Used when: (a) no prior seed has ever happened (first-ever inbound),
 * (b) the master window/mouth is missing and we're cold-starting recovery,
 * (c) caller passes force_seed=true.
 *
 * Exit codes:
 *   0 success (chat opened + prompt pasted + submitted)
 *   2 could not activate window even after launch
 *   3 clipboard wait timed out
 *   4 seed requested but VS Code exe path missing
 *   5 window failed to appear within timeout after launch
 */
const TELEGRAM_SEED_MACRO_SCRIPT = `
promptText := EnvGet("REFLEX_PROMPT")
windowTitle := EnvGet("REFLEX_WINDOW_TITLE")
workspacePath := EnvGet("REFLEX_WORKSPACE_PATH")
vsCodeExe := EnvGet("REFLEX_VSCODE_EXE")

; If the dedicated window is not up, launch VS Code with the workspace.
if !WinExist(windowTitle) {
  if (vsCodeExe = "" || workspacePath = "") {
    ExitApp(4)
  }
  Run('"' vsCodeExe '" "' workspacePath '"')
  if !WinWait(windowTitle, , 20) {
    ExitApp(5)
  }
  Sleep 2500
}

WinActivate windowTitle
if !WinWaitActive(windowTitle, , 5) {
  ExitApp(2)
}
Sleep 600

; Single Esc to clear any modal/popup. NEVER double-Esc (Claude Code's
; rewind-to-message accelerator opens a modal on double-Esc).
Send "{Esc}"
Sleep 250

; Open a new Claude Code chat tab. We CANNOT use the native Ctrl+Shift+Escape
; keybinding for claude-vscode.editor.open because Windows intercepts that
; globally as the Task Manager shortcut (it never reaches VS Code).
; Use the command palette path instead - F1 opens it (less likely than
; Ctrl+Shift+P to be intercepted by an active input control).
Send "{F1}"
Sleep 700
SendText "Claude Code: Open in New Tab"
Sleep 500
Send "{Enter}"
Sleep 3000  ; webview mount

; The newly opened chat tab auto-focuses its input. Paste + submit.
A_Clipboard := promptText
if !ClipWait(2) {
  ExitApp(3)
}
Send "^v"
Sleep 500
Send "{Enter}"
`

/**
 * Macro for the APPEND path - focuses the existing Telegram master chat
 * in the dedicated workspace and pastes the new inbound message as a
 * continuation turn.
 *
 * Requires: (a) telegram-conductor workspace window is up,
 * (b) a Claude Code chat exists in that workspace (recent or current).
 * If either is missing the caller should route through the seed macro
 * instead - this macro's recovery semantics are limited to "openLast" which
 * only works when there IS a last chat in the workspace history.
 *
 * Uses two custom user keybindings configured in keybindings.json:
 *   Ctrl+Alt+T -> claude-vscode.editor.openLast (reopen or focus last chat)
 *   Ctrl+Alt+F -> claude-vscode.focus           (focus chat input, one-way)
 *
 * Exit codes:
 *   0 success
 *   2 could not activate window
 *   3 clipboard wait timed out
 */
const TELEGRAM_APPEND_MACRO_SCRIPT = `
promptText := EnvGet("REFLEX_PROMPT")
windowTitle := EnvGet("REFLEX_WINDOW_TITLE")

if !WinExist(windowTitle) {
  ExitApp(2)
}
WinActivate windowTitle
if !WinWaitActive(windowTitle, , 5) {
  ExitApp(2)
}
Sleep 500

; Single Esc to clear any modal/popup. NEVER double-Esc.
Send "{Esc}"
Sleep 200

; Reopen / focus the last (= only, in this dedicated workspace) Claude chat.
; Custom user binding for claude-vscode.editor.openLast.
Send "^!t"
Sleep 1200

; Force focus into chat input (one-way, no toggle).
; Custom user binding for claude-vscode.focus.
Send "^!f"
Sleep 400

; Paste the new inbound message and submit.
A_Clipboard := promptText
if !ClipWait(2) {
  ExitApp(3)
}
Send "^v"
Sleep 400
Send "{Enter}"
`

/**
 * Append a new inbound message to the dedicated Telegram-conductor Claude
 * Code chat tab. ONE persistent chat handles all Telegram traffic; this is
 * how each new Telegram message becomes a fresh turn in that chat instead
 * of opening an amnesiac new tab via reflex.fire.
 *
 * Behaviour:
 *   - Probes local state + window + lock-file to determine seed vs append.
 *   - On first ever fire, or when the workspace window / Claude mouth has
 *     gone away, runs the SEED macro which (re)launches VS Code with the
 *     dedicated workspace and opens a fresh chat. Caller should pass the
 *     full seed prompt (including the kv_store thread mirror summary) so
 *     the new chat has bootstrap context.
 *   - On subsequent fires with master alive, runs the APPEND macro which
 *     focuses the existing chat input and pastes the new turn. Caller
 *     should pass a SHORT prompt (just the new Telegram body + sender +
 *     timestamp) - the chat already holds its own history natively.
 *
 * params:
 *   prompt: string (required, max 64KB) - text to paste into the chat input
 *           when running in APPEND mode (the existing master chat has its
 *           own native history + workspace CLAUDE.md; pass a short header
 *           + body, nothing more).
 *   seed_prompt: string (optional) - text to paste when running in SEED
 *           mode (fresh chat, no history yet). If omitted, `prompt` is
 *           used for both modes (caller's responsibility to make it work
 *           in either context). Recommended: pass a longer bootstrap prompt
 *           that includes thread-mirror context.
 *   source: string (optional) - audit tag (e.g. 'telegram-webhook')
 *   idempotency_key: string (optional) - dedupe key, 24h window
 *   force_seed: bool (optional) - skip probes, run seed path unconditionally
 *   seed_if_missing: bool (optional, default true) - if window/mouth missing,
 *                    run seed; if false, return error on missing master
 *   dry_run: bool (optional) - return planned mode + reasons without firing
 *
 * returns: { ok, fired, mode: 'seed'|'append', master_state, ... }
 */
async function append_to_master({ prompt, seed_prompt, source, idempotency_key, force_seed, seed_if_missing = true, dry_run } = {}) {
  if (typeof prompt !== 'string' || prompt.length === 0) {
    throw new Error('prompt is required and must be a non-empty string')
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new Error(`prompt exceeds ${MAX_PROMPT_CHARS} chars (got ${prompt.length})`)
  }
  if (typeof seed_prompt === 'string' && seed_prompt.length > MAX_PROMPT_CHARS) {
    throw new Error(`seed_prompt exceeds ${MAX_PROMPT_CHARS} chars (got ${seed_prompt.length})`)
  }

  const ed = resolveEditor('vscode')

  // Decide seed vs append based on local state + live probes.
  const state = readTelegramMasterState()
  const windowUp = isEditorWindowUp(TELEGRAM_WINDOW_TITLE)
  const mouthUp = hasTelegramWorkspaceMouth()
  const everSeeded = !!state.seeded_at

  let mode
  let reason
  if (force_seed) {
    mode = 'seed'; reason = 'force_seed'
  } else if (!everSeeded) {
    mode = 'seed'; reason = 'never_seeded'
  } else if (!windowUp) {
    mode = seed_if_missing ? 'seed' : null
    reason = 'window_missing'
  } else if (!mouthUp) {
    mode = seed_if_missing ? 'seed' : null
    reason = 'mouth_missing'
  } else {
    mode = 'append'; reason = 'master_alive'
  }

  if (dry_run) {
    return {
      ok: true, fired: false, dry_run: true, mode, reason,
      window_up: windowUp, mouth_up: mouthUp, ever_seeded: everSeeded,
      window_title: TELEGRAM_WINDOW_TITLE, workspace_path: TELEGRAM_WORKSPACE_PATH,
    }
  }

  if (mode === null) {
    return { ok: false, fired: false, mode: null, reason, window_up: windowUp, mouth_up: mouthUp }
  }

  const log = readLog()
  if (isDuplicate(log, idempotency_key)) {
    return { ok: true, fired: false, dedupe: 'duplicate', idempotency_key, mode, reason }
  }

  const firedAt = new Date().toISOString()
  const promptForMode = mode === 'seed' ? (seed_prompt || prompt) : prompt
  const env = {
    REFLEX_PROMPT: promptForMode,
    REFLEX_WINDOW_TITLE: TELEGRAM_WINDOW_TITLE,
  }
  let macroScript
  if (mode === 'seed') {
    env.REFLEX_WORKSPACE_PATH = TELEGRAM_WORKSPACE_PATH
    env.REFLEX_VSCODE_EXE = ed.exe_path
    macroScript = TELEGRAM_SEED_MACRO_SCRIPT
  } else {
    macroScript = TELEGRAM_APPEND_MACRO_SCRIPT
  }

  const result = runAhkMacro({
    script: macroScript,
    env,
    timeout_ms: mode === 'seed' ? 35000 : 15000,
  })

  if (mode === 'seed' && result.exit_code === 0) {
    writeTelegramMasterState({
      seeded_at: firedAt,
      workspace_path: TELEGRAM_WORKSPACE_PATH,
      window_title: TELEGRAM_WINDOW_TITLE,
      last_fire_at: firedAt,
    })
  } else if (mode === 'append' && result.exit_code === 0) {
    writeTelegramMasterState({ last_fire_at: firedAt })
  }

  appendFire(log, {
    fired_at: firedAt,
    editor: 'vscode',
    source: source || 'telegram-append',
    idempotency_key: idempotency_key || null,
    auto_submit: true,
    prompt_preview: promptForMode.slice(0, 120),
    prompt_chars: promptForMode.length,
    exit_code: result.exit_code,
    duration_ms: result.duration_ms,
    mode,
  })

  return {
    ok: result.exit_code === 0,
    fired: true,
    fired_at: firedAt,
    mode,
    reason,
    window_title: TELEGRAM_WINDOW_TITLE,
    workspace_path: TELEGRAM_WORKSPACE_PATH,
    exit_code: result.exit_code,
    duration_ms: result.duration_ms,
    error: result.error,
    macro_exit_meaning: telegramMacroExitMeaning(result.exit_code, mode),
  }
}

function telegramMacroExitMeaning(code, mode) {
  if (code === 0) return 'success'
  if (code === 2) return 'could_not_activate_window'
  if (code === 3) return 'clipboard_wait_timed_out'
  if (mode === 'seed' && code === 4) return 'seed_requested_but_exe_path_missing'
  if (mode === 'seed' && code === 5) return 'window_failed_to_appear_after_launch'
  if (code === null) return 'spawn_error_or_timeout'
  return `ahk_exit_${code}`
}

/**
 * Discover all live Claude Code mouths on this laptop by reading the
 * extension's lock-file dir (~/.claude/ide/<port>.lock).
 */
async function list_mouths() {
  if (!fs.existsSync(IDE_LOCK_DIR)) {
    return { mouths: [], lock_dir: IDE_LOCK_DIR, exists: false }
  }
  const files = fs.readdirSync(IDE_LOCK_DIR).filter(f => f.endsWith('.lock'))
  const mouths = []
  for (const f of files) {
    const fullPath = path.join(IDE_LOCK_DIR, f)
    try {
      const raw = fs.readFileSync(fullPath, 'utf8')
      const parsed = JSON.parse(raw)
      const port = parseInt(f.replace('.lock', ''), 10)
      mouths.push({
        port,
        pid: parsed.pid,
        ide_name: parsed.ideName,
        workspace_folders: parsed.workspaceFolders || [],
        transport: parsed.transport,
        has_auth_token: typeof parsed.authToken === 'string' && parsed.authToken.length > 0,
        lock_path: fullPath,
      })
    } catch (err) {
      mouths.push({ lock_path: fullPath, error: err.message })
    }
  }
  return { mouths, lock_dir: IDE_LOCK_DIR, exists: true, count: mouths.length }
}

/**
 * Recent fires from the dedupe log.
 *
 * params: { limit?: number (default 20, max 500) }
 */
async function last_fires({ limit } = {}) {
  const n = Math.min(Math.max(parseInt(limit, 10) || 20, 1), LOG_CAP)
  const log = readLog()
  const fires = log.fires.slice(-n).reverse()
  return { fires, total_logged: log.fires.length, log_path: REFLEX_LOG_PATH }
}

/**
 * Probe the current foreground window (the app Tate is actively focused on).
 * Used by callers to implement focus-no-collision discipline: if Tate is
 * mid-flow in something other than the target editor, defer the fire.
 *
 * Returns: { process_name, window_title, pid }
 * On failure (no foreground, AHK error): { error }
 */
async function foreground_window() {
  // AHK v2 string-literal newlines use backtick-n; backslash-n is literal.
  // Using Chr(10) is unambiguous across PowerShell + Node string escaping.
  const ahkScript = `
    pid := WinGetPID("A")
    title := WinGetTitle("A")
    procName := WinGetProcessName("A")
    FileAppend(procName Chr(10) title Chr(10) pid, "*")
  `
  const tmp = path.join(os.tmpdir(), `reflex-fg-${Date.now()}-${Math.random().toString(36).slice(2)}.ahk`)
  fs.writeFileSync(tmp, '#Requires AutoHotkey v2.0\n' + ahkScript + '\nExitApp(0)', 'utf8')
  try {
    const result = spawnSync(AHK_EXE, [tmp], { timeout: 5000, encoding: 'utf8', windowsHide: true, creationFlags: CREATE_NO_WINDOW })
    if (result.error) return { error: result.error.message }
    const lines = (result.stdout || '').split('\n')
    return {
      process_name: (lines[0] || '').trim(),
      window_title: (lines[1] || '').trim(),
      pid: parseInt((lines[2] || '0').trim(), 10) || null,
    }
  } finally {
    try { fs.unlinkSync(tmp) } catch {}
  }
}

const EDITOR_PROCESS_NAMES = new Set(['Code.exe', 'Code - Insiders.exe', 'Cursor.exe'])

/**
 * Fire-if-clear: probe foreground first. If Tate's active app is NOT in the
 * editor whitelist (he is in another IDE / browser / Teams / etc.), the
 * caller can choose to defer. Use this for low-priority scheduled reflexes
 * (meta-loop, email-triage, etc.) so they don't pull Tate from non-editor
 * flow. High-priority reflexes (inbound SMS) skip this and just fire.
 *
 * Params: same as reflex.fire plus:
 *   editor_whitelist (string[], optional) - process names that are OK to
 *       collide with; defaults to all editor exes from EDITOR_PROFILES
 *   on_busy (string, optional, default 'defer') - 'defer' returns without
 *       firing; 'fire_anyway' ignores the probe and fires; useful for
 *       per-call overrides without needing two functions
 *
 * Returns: { ok, fired, deferred?, foreground? } plus the fire return if fired
 */
async function fire_if_clear(params = {}) {
  const { editor_whitelist, on_busy = 'defer', ...fireParams } = params
  const whitelist = new Set((editor_whitelist || []).concat(Array.from(EDITOR_PROCESS_NAMES)))
  const fg = await foreground_window()
  if (fg.error) {
    return { ok: false, fired: false, error: `foreground probe failed: ${fg.error}` }
  }
  const inWhitelist = whitelist.has(fg.process_name)
  if (!inWhitelist && on_busy === 'defer') {
    return { ok: true, fired: false, deferred: true, foreground: fg, reason: 'foreground_not_in_editor_whitelist' }
  }
  const fireResult = await fire(fireParams)
  return { ...fireResult, foreground_at_fire: fg }
}

// =========================================================================
// one-conductor-many-channels primitives (2026-05-19)
//
// `append_to_conductor` lands an inbound message as the next turn in the
// currently-active Claude Code conductor chat. It uses the cursor-preview
// IDE bridge to focus the right tab without OS focus-stealing, then sends
// one Ctrl+V + Enter keystroke targeted by hwnd/pid.
//
// `seed_conductor` cold-starts a fresh conductor chat when no active
// conductor is registered. Picks the most-recently-started IDE that has a
// workspace open (avoiding empty-workspace fallback instances).
//
// Both primitives ALWAYS queue the message to coord.send_message first
// (chat.conductor.inbox) so the FIFO/safety-net story holds even if the
// keystroke step fails. Doctrine:
// backend/patterns/one-conductor-many-channels-2026-05-19.md
// =========================================================================

const _coord = require('./coord')
const _ide = require('./ide')

const CONDUCTOR_STALE_THRESHOLD_MS = 30 * 60 * 1000

// AHK macro that targets a specific window handle (hwnd) instead of a fragile
// title substring. Reads REFLEX_TARGET_HWND (decimal) + REFLEX_TARGET_PID
// from env. Pastes clipboard (already set via IDE bridge) and submits. The
// in-IDE bridge has already focused chat input via claude-vscode.focus, so
// the keystrokes land in the chat webview input.
const APPEND_BY_HWND_MACRO = `
hwndStr := EnvGet("REFLEX_TARGET_HWND")
pidStr := EnvGet("REFLEX_TARGET_PID")
hwnd := hwndStr + 0
pid := pidStr + 0

activated := false
if (hwnd > 0 && WinExist("ahk_id " hwnd)) {
  WinActivate "ahk_id " hwnd
  if WinWaitActive("ahk_id " hwnd, , 3) {
    activated := true
  }
}
if (!activated && pid > 0 && WinExist("ahk_pid " pid)) {
  WinActivate "ahk_pid " pid
  if WinWaitActive("ahk_pid " pid, , 3) {
    activated := true
  }
}
if (!activated) {
  ExitApp(2)
}

Sleep 350
Send "{Esc}"
Sleep 150

; clipboard was already set via the IDE bridge. paste + enter.
Send "^v"
Sleep 350
Send "{Enter}"
`

// AHK macro for the SEED path. Opens a new Claude Code chat via command
// palette in the target IDE window, then pastes. We send {F1} (= palette
// shortcut, less prone to interception than Ctrl+Shift+P).
const SEED_BY_HWND_MACRO = `
hwndStr := EnvGet("REFLEX_TARGET_HWND")
pidStr := EnvGet("REFLEX_TARGET_PID")
hwnd := hwndStr + 0
pid := pidStr + 0

activated := false
if (hwnd > 0 && WinExist("ahk_id " hwnd)) {
  WinActivate "ahk_id " hwnd
  if WinWaitActive("ahk_id " hwnd, , 3) {
    activated := true
  }
}
if (!activated && pid > 0 && WinExist("ahk_pid " pid)) {
  WinActivate "ahk_pid " pid
  if WinWaitActive("ahk_pid " pid, , 3) {
    activated := true
  }
}
if (!activated) {
  ExitApp(2)
}

Sleep 400
Send "{Esc}"
Sleep 200

; Open command palette + run "Claude Code: Open in New Tab".
Send "{F1}"
Sleep 700
SendText "Claude Code: Open in New Tab"
Sleep 400
Send "{Enter}"
Sleep 2800  ; webview mount

; Clipboard already set via IDE bridge. Paste + submit.
Send "^v"
Sleep 400
Send "{Enter}"
`

// Map conductor.exe -> tools/ide.js IDE filter.
const EXE_TO_IDE_FILTER = {
  'Code': 'stable',
  'Code.exe': 'stable',
  'Code - Insiders': 'insiders',
  'Code - Insiders.exe': 'insiders',
  'Cursor': 'cursor',
  'Cursor.exe': 'cursor',
}

function _ideFilterForConductor(conductor) {
  if (!conductor) return null
  if (conductor.ide_bridge_port) return { port: conductor.ide_bridge_port }  // most precise
  if (conductor.ide_pid) return { pid: conductor.ide_pid }
  if (conductor.exe) return EXE_TO_IDE_FILTER[conductor.exe] ? { ide: EXE_TO_IDE_FILTER[conductor.exe] } : null
  return null
}

function _stripPort(filter) {
  // ide.js doesn't accept {port}; we need to translate by reading the registry
  // ourselves and matching port.
  if (!filter || !filter.port) return filter
  const instances = _listInstancesAlive()
  const match = instances.find(i => i.port === filter.port)
  if (match) return { pid: match.pid }
  return null
}

function _listInstancesAlive() {
  try {
    const path = require('path')
    const fs = require('fs')
    const os = require('os')
    const REG = path.join(os.homedir(), '.ecodia-preview', 'instances.json')
    const reg = JSON.parse(fs.readFileSync(REG, 'utf8')) || {}
    return Object.entries(reg).map(([pid, info]) => ({
      pid: Number(pid),
      port: info.port,
      ide: info.ide,
      workspaceRoots: info.workspaceRoots || [],
      startedAt: info.startedAt,
    })).filter(i => {
      try { process.kill(i.pid, 0); return true } catch { return false }
    })
  } catch {
    return []
  }
}

function _isConductorActive(conductor) {
  if (!conductor) return false
  const lastSeenIso = conductor.last_seen_at || conductor.registered_at
  if (!lastSeenIso) return false
  return (Date.now() - new Date(lastSeenIso).getTime()) <= CONDUCTOR_STALE_THRESHOLD_MS
}

async function _ideCommand(ideFilter, cmd, args) {
  const filter = _stripPort(ideFilter) || ideFilter
  return _ide.command({ ...filter, cmd, args, returnResult: false })
}

async function _ideSetClipboard(ideFilter, text) {
  const filter = _stripPort(ideFilter) || ideFilter
  return _ide.clipboard_write({ ...filter, text })
}

async function _ideHwndAndPid(ideFilter) {
  // The IDE bridge's /ide/info returns pid + appName but not hwnd directly.
  // We have pid from registry; combine with foreground/window probe by pid
  // if needed. For the macro we pass both - the macro tries hwnd first then
  // falls back to pid, so either alone is sufficient.
  const filter = _stripPort(ideFilter) || ideFilter
  const info = await _ide.info(filter).catch(() => null)
  return {
    pid: info?.pid || filter?.pid || null,
    hwnd: null,  // not exposed via /ide/info; PID activation is sufficient
  }
}

function _buildChannelHeader(envelope) {
  const tz = (() => {
    try {
      return new Intl.DateTimeFormat('en-AU', {
        timeZone: 'Australia/Brisbane', hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(new Date(envelope.received_at)) + ' AEST'
    } catch {
      return envelope.received_at
    }
  })()
  const reply = envelope.channel === 'sms'
    ? 'Reply via sms_tate MCP (<=160 GSM unless decision content needs more).'
    : envelope.channel === 'telegram'
    ? `Reply via Telegram bot API: POST https://api.telegram.org/bot<token>/sendMessage with {chat_id: ${envelope.thread_id}, text, parse_mode:"Markdown"}. Bot token at kv_store.creds.telegram_bot.bot_token.`
    : 'Reply via the channel-appropriate MCP.'
  const mediaBits = (envelope.media || []).map((m, i) => `  media[${i}]: ${m.content_type} ${m.bytes || '?'}B at ${m.url} (auth_hint=${m.auth_hint || 'none'})`).join('\n')
  const mediaBlock = mediaBits ? `\nMedia attached (fetch via curl within this turn; URLs may expire):\n${mediaBits}\n` : ''
  const replyToBlock = envelope.reply_to ? `\nIn reply to: ${String(envelope.reply_to.snippet || '').slice(0, 200)}\n` : ''
  return `[inbound from ${envelope.sender_name} via ${envelope.channel} | ${envelope.thread_id} | ${tz} | idempotency_key=${envelope.idempotency_key}]
${reply}${mediaBlock}${replyToBlock}`
}

function _buildAppendPrompt(envelope) {
  const header = _buildChannelHeader(envelope)
  const policy = envelope.from_kind === 'tate'
    ? 'Tate-policy: this is a turn-level directive from the principal. Decide and act; do not request confirmation for routine business. Per sms-segment-economics for SMS replies; Telegram allows longer + markdown.'
    : envelope.from_kind === 'client'
    ? 'Client-policy: per no-client-contact-without-tate-goahead, DRAFT ONLY. Save to kv_store.cowork.inbound-' + envelope.channel + '-draft.' + envelope.idempotency_key + '. status_board.upsert a thread row with status="draft_pending_tate_relay", next_action_by="tate". If urgency=critical, ALSO sms.tate body="Inbound ' + envelope.channel + ' from ' + envelope.sender_name + ': <first 30 chars>. Draft at kv ' + envelope.idempotency_key + '."'
    : 'Unknown-sender policy: do not reply. Log + surface to Tate.'
  return `${header}

${envelope.body || '(no text body; see media block above)'}

---
${policy}

Per cron-fire-must-have-deliverable-not-just-narration: produce a substrate write before exit (reply OR draft kv_store OR status_board row OR Episode).`
}

function _buildSeedPrompt(envelope, threadMirror) {
  const append = _buildAppendPrompt(envelope)
  const priorBlock = (threadMirror && Array.isArray(threadMirror.exchanges) && threadMirror.exchanges.length > 0)
    ? '\n[Prior thread (newest last):\n' + threadMirror.exchanges.map(e => `  ${e.from === 'tate' ? 'Tate' : 'You'}: ${String(e.body || '').slice(0, 240)}`).join('\n') + '\n]\n'
    : '\n[Cold start - no prior thread.]\n'
  return `[CONDUCTOR SEED 2026-05-19]
You are the EcodiaOS conductor in this Claude Code chat tab. From now on, inbound SMS / Telegram / future channels arrive here as new turns. Your native chat history is your memory. Doctrine at backend/patterns/one-conductor-many-channels-2026-05-19.md.
${priorBlock}
${append}`
}

/**
 * Append a new inbound message to the active conductor chat as the next turn.
 *
 * params:
 *   envelope: canonical inbound envelope (see spec §A)
 *   idempotency_key: string (24h dedupe window)
 *   source: string (audit tag, e.g. 'sms-webhook')
 *   force_paste: bool (skip in_turn check; default false)
 *   dry_run: bool (return plan without firing)
 *
 * returns: { ok, fired, mode, reason?, conductor_tab_id?, ide_pid?, ide_bridge_port?, exit_code?, duration_ms? }
 */
async function append_to_conductor({ envelope, idempotency_key, source, force_paste, dry_run } = {}) {
  if (!envelope || typeof envelope !== 'object') {
    return { ok: false, fired: false, reason: 'envelope_required' }
  }
  if (!envelope.channel || !envelope.body && (!envelope.media || envelope.media.length === 0)) {
    return { ok: false, fired: false, reason: 'envelope_missing_channel_or_body' }
  }
  const idemKey = idempotency_key || envelope.idempotency_key || null

  // Step 1: ALWAYS queue to coord inbox first (FIFO + safety net).
  try {
    await _coord.send_message({
      to: 'chat.conductor.inbox',
      body: {
        type: 'inbound_' + envelope.channel,
        envelope,
        idempotency_key: idemKey,
        source: source || envelope.channel,
        queued_at: new Date().toISOString(),
      },
    }, {})
  } catch (err) {
    // Inbox write failing is bad but not fatal; fall through to paste attempt.
  }

  // Step 2: probe conductor state.
  const conductor = _coord._loadConductorRegistration ? _coord._loadConductorRegistration() : null
  if (!_isConductorActive(conductor)) {
    return {
      ok: false, fired: false,
      reason: conductor ? 'conductor_stale' : 'no_conductor',
      queued: true,
    }
  }
  if (conductor.in_turn && !force_paste) {
    // Mid-turn: defer paste. Stop hook will drain on turn end.
    return {
      ok: true, fired: false, mode: 'queued_mid_turn',
      reason: 'conductor_in_turn',
      conductor_tab_id: conductor.tab_id || null,
      queued: true,
    }
  }

  if (dry_run) {
    return {
      ok: true, fired: false, dry_run: true,
      mode: 'append',
      conductor_tab_id: conductor.tab_id || null,
      conductor_exe: conductor.exe || null,
      conductor_hwnd: conductor.hwnd || null,
      conductor_ide_pid: conductor.ide_pid || null,
      conductor_ide_bridge_port: conductor.ide_bridge_port || null,
    }
  }

  // Step 3: dedupe by idempotency_key.
  const log = readLog()
  if (isDuplicate(log, idemKey)) {
    return { ok: true, fired: false, dedupe: 'duplicate', idempotency_key: idemKey, mode: 'append' }
  }

  // Step 4: figure out which IDE to drive. We start with the conductor's
  // recorded IDE filter, but THEN probe foreground - if Tate has switched
  // IDEs since the last heartbeat (race window between switch + next
  // prompt), foreground tells the truth. Use foreground's matching
  // instances.json entry for BOTH the IDE bridge port AND the AHK target,
  // so bridge commands focus the right chat input AND keystrokes land in
  // the right window.
  let ideFilter = _ideFilterForConductor(conductor)
  let foregroundOverride = null
  try {
    const fg = await foreground_window().catch(() => null)
    if (fg && fg.process_name && fg.pid) {
      const isIde = /^(Code|Code - Insiders|Cursor)\.exe$/i.test(fg.process_name)
      if (isIde) {
        // Try to find an instance whose ide matches the foreground exe.
        const ideExeToName = {
          'Code.exe': 'Visual Studio Code',
          'Code - Insiders.exe': 'Visual Studio Code - Insiders',
          'Cursor.exe': 'Cursor',
        }
        const wantIdeName = ideExeToName[fg.process_name]
        const instances = _listInstancesAlive()
        const fgInstance = instances.find(i => (i.ide || '') === wantIdeName) || null
        const conductorIdeBridgePort = conductor.ide_bridge_port || null
        if (fgInstance && fgInstance.port !== conductorIdeBridgePort) {
          foregroundOverride = {
            fg_pid: fg.pid, fg_process: fg.process_name, fg_title: fg.window_title,
            instance_pid: fgInstance.pid, instance_port: fgInstance.port,
          }
          ideFilter = { port: fgInstance.port }
        }
      }
    }
  } catch {}

  if (!ideFilter) {
    return { ok: false, fired: false, reason: 'cannot_resolve_ide_for_conductor', conductor }
  }

  const prompt = _buildAppendPrompt(envelope)

  // Step 5: set clipboard via IDE bridge (focusless).
  let clipboardOk = false
  try {
    await _ideSetClipboard(ideFilter, prompt)
    clipboardOk = true
  } catch (err) {
    // Fall through; AHK macro will use OS clipboard. Worst case we set it
    // via spawnSync echo+clip, but the IDE bridge is the preferred path.
  }

  // Step 6: focus the chat input via IDE bridge.
  // IMPORTANT 2026-05-19 b: drop claude-vscode.editor.openLast - in stable
  // VS Code (and Insiders too in some states) openLast CREATES A NEW CHAT
  // TAB when there's no current "last chat" pointer, which spawns the
  // ghost-chat problem (paste lands in the new tab, not the conductor).
  // Instead trust that the conductor's chat tab is already visible (the
  // heartbeat hook fired from it on the most recent turn, so it WAS active).
  // claude-vscode.focus focuses the chat input of whichever Claude chat is
  // currently displayed in the active editor group, without switching tabs.
  let bridgeFocusOk = false
  try {
    // Raise the IDE's editor group so any open Claude chat tab is visible.
    await _ideCommand(ideFilter, 'workbench.action.focusActiveEditorGroup').catch(() => {})
    // Force focus into chat input (one-way; does not switch chats).
    await _ideCommand(ideFilter, 'claude-vscode.focus').catch(() => {})
    bridgeFocusOk = true
  } catch (err) {
    // Fall through; AHK still tries WinActivate by hwnd/pid.
  }

  // Step 7: resolve hwnd + pid for the AHK keystroke.
  // If foreground override kicked in, use the foreground pid; else use the
  // extension-host pid resolved from ideFilter.
  const { pid: idePid } = await _ideHwndAndPid(ideFilter).catch(() => ({ pid: null }))
  const targetPid = (foregroundOverride && foregroundOverride.fg_pid) || idePid || conductor.ide_pid || null
  const targetHwnd = (foregroundOverride ? 0 : (conductor.hwnd || 0))

  if (!targetPid && !targetHwnd) {
    return { ok: false, fired: false, reason: 'no_target_pid_or_hwnd', queued: true, clipboard_set: clipboardOk, bridge_focus_ok: bridgeFocusOk }
  }

  // Step 8: AHK keystroke - Ctrl+V + Enter.
  const firedAt = new Date().toISOString()
  const macroResult = runAhkMacro({
    script: APPEND_BY_HWND_MACRO,
    env: {
      REFLEX_TARGET_HWND: String(targetHwnd || 0),
      REFLEX_TARGET_PID: String(targetPid || 0),
    },
    timeout_ms: 15000,
  })

  appendFire(log, {
    fired_at: firedAt,
    editor: conductor.exe || 'unknown',
    source: source || 'append_to_conductor',
    idempotency_key: idemKey,
    auto_submit: true,
    prompt_preview: prompt.slice(0, 120),
    prompt_chars: prompt.length,
    exit_code: macroResult.exit_code,
    duration_ms: macroResult.duration_ms,
    mode: 'append_to_conductor',
    channel: envelope.channel,
    conductor_tab_id: conductor.tab_id || null,
    conductor_ide_pid: targetPid,
    conductor_hwnd: targetHwnd,
  })

  return {
    ok: macroResult.exit_code === 0,
    fired: true,
    fired_at: firedAt,
    mode: 'append',
    conductor_tab_id: conductor.tab_id || null,
    ide_pid: targetPid,
    ide_bridge_port: conductor.ide_bridge_port || null,
    clipboard_set: clipboardOk,
    bridge_focus_ok: bridgeFocusOk,
    exit_code: macroResult.exit_code,
    duration_ms: macroResult.duration_ms,
    error: macroResult.error,
    macro_exit_meaning: macroExitMeaning(macroResult.exit_code),
  }
}

/**
 * Cold-start: open a fresh Claude Code chat in the most-recently-started
 * IDE that has a workspace open, paste the seed prompt. The new chat's
 * conductor_heartbeat.py hook will auto-register it as conductor on its
 * first turn (no active conductor exists at the moment seed_conductor
 * runs, so register_conductor succeeds without takeover).
 */
async function seed_conductor({ envelope, idempotency_key, source, thread_mirror, target_ide, dry_run } = {}) {
  if (!envelope || typeof envelope !== 'object') {
    return { ok: false, fired: false, reason: 'envelope_required' }
  }
  const idemKey = idempotency_key || envelope.idempotency_key || null

  // Always queue to inbox first (the seeded chat's heartbeat hook will pick
  // it up as a <inbound_messages_pending> prelude on first turn).
  try {
    await _coord.send_message({
      to: 'chat.conductor.inbox',
      body: {
        type: 'inbound_' + envelope.channel,
        envelope, idempotency_key: idemKey,
        source: source || envelope.channel,
        queued_at: new Date().toISOString(),
        cold_seed: true,
      },
    }, {})
  } catch {}

  const instances = _listInstancesAlive()
  if (instances.length === 0) {
    return { ok: false, fired: false, reason: 'no_ide_instances_alive', queued: true }
  }

  // Prefer: explicit target_ide, then most-recently-started with non-empty
  // workspaceRoots, then most-recently-started any.
  const sorted = instances.slice().sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
  const withWorkspace = sorted.filter(i => (i.workspaceRoots || []).length > 0)
  let target = null
  if (target_ide) {
    const re = target_ide.toLowerCase()
    target = sorted.find(i => (i.ide || '').toLowerCase().includes(re)) || null
  }
  if (!target) target = withWorkspace[0] || sorted[0]
  if (!target) {
    return { ok: false, fired: false, reason: 'no_ide_picked', queued: true }
  }

  if (dry_run) {
    return {
      ok: true, fired: false, dry_run: true, mode: 'seed',
      target_ide: target.ide, target_pid: target.pid, target_port: target.port,
    }
  }

  const log = readLog()
  if (isDuplicate(log, idemKey)) {
    return { ok: true, fired: false, dedupe: 'duplicate', idempotency_key: idemKey, mode: 'seed' }
  }

  const prompt = _buildSeedPrompt(envelope, thread_mirror)

  // Set clipboard via the target IDE's bridge.
  let clipboardOk = false
  try {
    await _ide.clipboard_write({ pid: target.pid, text: prompt })
    clipboardOk = true
  } catch {}

  const firedAt = new Date().toISOString()
  const macroResult = runAhkMacro({
    script: SEED_BY_HWND_MACRO,
    env: {
      REFLEX_TARGET_HWND: '0',
      REFLEX_TARGET_PID: String(target.pid),
    },
    timeout_ms: 25000,
  })

  appendFire(log, {
    fired_at: firedAt,
    editor: target.ide || 'unknown',
    source: source || 'seed_conductor',
    idempotency_key: idemKey,
    auto_submit: true,
    prompt_preview: prompt.slice(0, 120),
    prompt_chars: prompt.length,
    exit_code: macroResult.exit_code,
    duration_ms: macroResult.duration_ms,
    mode: 'seed_conductor',
    channel: envelope.channel,
    target_pid: target.pid,
    target_port: target.port,
  })

  return {
    ok: macroResult.exit_code === 0,
    fired: true,
    fired_at: firedAt,
    mode: 'seed',
    target_ide: target.ide,
    target_pid: target.pid,
    target_port: target.port,
    clipboard_set: clipboardOk,
    exit_code: macroResult.exit_code,
    duration_ms: macroResult.duration_ms,
    error: macroResult.error,
    macro_exit_meaning: macroExitMeaning(macroResult.exit_code),
  }
}

// 2026-05-19 evening: append_to_master + append_to_conductor + seed_conductor
// are DEPRECATED. The keystroke-paste-into-existing-chat architecture they
// implemented was replaced by the headless-conductor-on-VPS architecture
// (see backend/src/services/headlessConductor.js). Function bodies retained
// in this file for ~30 days as reference; do not call them. Will be deleted
// in a follow-up pass after the native iOS channel ships.
module.exports = { fire, fire_if_clear, foreground_window, list_mouths, last_fires }
