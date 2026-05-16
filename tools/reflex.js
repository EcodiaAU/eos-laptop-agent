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
const DEDUPE_WINDOW_HOURS = 24
const LOG_CAP = 500
const MAX_PROMPT_CHARS = 64 * 1024
const AHK_EXE = 'C:\\Users\\tjdTa\\AppData\\Local\\Programs\\AutoHotkey\\v2\\AutoHotkey64.exe'

const EDITOR_PROFILES = {
  vscode: {
    window_title_hint: 'Visual Studio Code',
    exe_basename: 'Code.exe',
    exe_path: 'C:\\Users\\tjdTa\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe',
  },
  'vscode-insiders': {
    window_title_hint: 'Visual Studio Code - Insiders',
    exe_basename: 'Code - Insiders.exe',
    exe_path: 'C:\\Users\\tjdTa\\AppData\\Local\\Programs\\Microsoft VS Code Insiders\\Code - Insiders.exe',
  },
  cursor: {
    window_title_hint: 'Cursor',
    exe_basename: 'Cursor.exe',
    exe_path: 'C:\\Users\\tjdTa\\AppData\\Local\\Programs\\cursor\\Cursor.exe',
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
 * The macro itself. Reads REFLEX_PROMPT, REFLEX_WINDOW_TITLE, REFLEX_AUTO_SUBMIT
 * from env. Exit codes:
 *   0 success
 *   2 could not activate VS Code window (title hint mismatch or no window)
 *   3 clipboard wait timed out
 *   4 panel did not open in time (currently best-effort, we don't probe)
 */
const MACRO_SCRIPT = `
promptText := EnvGet("REFLEX_PROMPT")
titleHint := EnvGet("REFLEX_WINDOW_TITLE")
autoSubmit := EnvGet("REFLEX_AUTO_SUBMIT")
if (titleHint = "") {
  titleHint := "Visual Studio Code"
}

; Activate the target editor window.
WinActivate titleHint
if !WinWaitActive(titleHint, , 3) {
  ExitApp(2)
}
Sleep 200

; Open VS Code command palette.
Send "^+p"
Sleep 400

; Type the command name. The leading > is implicit when palette opens via
; Ctrl+Shift+P; not needed. Just the command text.
SendText "Claude Code: Open in New Tab"
Sleep 250

; Execute - opens a new Claude Code chat in a new editor tab.
Send "{Enter}"

; Wait for the new chat panel to mount + take focus. Conservative wait.
Sleep 1500

; Set clipboard to the prompt body, paste via Ctrl+V.
A_Clipboard := promptText
if !ClipWait(2) {
  ExitApp(3)
}
Send "^v"
Sleep 250

; Optional auto-submit.
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
      REFLEX_AUTO_SUBMIT: auto_submit ? 'true' : 'false',
    },
    timeout_ms: 15000,
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

module.exports = { fire, fire_if_clear, foreground_window, list_mouths, last_fires }
