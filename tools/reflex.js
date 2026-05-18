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
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', `Get-Process | Where-Object { $_.MainWindowTitle -like "*${titleHint.replace(/"/g, '`"')}*" } | Measure-Object | ForEach-Object { $_.Count }`], { encoding: 'utf8', timeout: 5000, windowsHide: true })
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

module.exports = { fire, fire_if_clear, foreground_window, list_mouths, last_fires, append_to_master }
