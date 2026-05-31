// cursor.js - Cursor-specific helpers (Claude Code chat panel + Cursor-only shortcuts).
//
// Cursor's chat panel keybindings:
//   Ctrl+L   - open chat in side panel
//   Ctrl+I   - inline edit composer
//   Ctrl+K   - quick edit (selection-focused)
//   Ctrl+;   - history of chats
//   Ctrl+/   - terminal chat
//   Ctrl+Enter - submit chat message (or Enter, depending on settings)
//   Esc      - dismiss
//
// For the Claude Code extension (the chat panel itself), the panel works
// like a regular editor panel; activating it requires focusing the chat
// tab via Ctrl+0..9 or by clicking, then typing in the input field at the
// bottom and pressing Enter (or Ctrl+Enter on multi-line).

const path = require('path')
const fs = require('fs')
const os = require('os')
const { spawnSync } = require('child_process')
const input = require('./input')

const AHK = 'C:\\Users\\tjdTa\\AppData\\Local\\Programs\\AutoHotkey\\v2\\AutoHotkey64.exe'
const CURSOR_EXE = 'Cursor'

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function ahkActivate() {
  const tmp = path.join(os.tmpdir(), 'eos-curs-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.ahk')
  // Verbatim clone of vscode.js's working pattern. The "ahk_exe " "Cursor.exe"
  // concat form + SetTitleMatchMode 2 + WinWaitActive (no explicit hwnd) is
  // the empirically-working combo on this machine for finding the visible
  // Electron main window among Cursor's many helper processes.
  const exe = 'Cursor'
  const script = '#Requires AutoHotkey v2.0\n' +
    'SetTitleMatchMode 2\n' +
    'if WinExist("ahk_exe " "' + exe + '.exe") {\n' +
    '  WinActivate\n' +
    '  WinWaitActive("ahk_exe " "' + exe + '.exe", , 2)\n' +
    '  ExitApp 0\n' +
    '} else {\n' +
    '  ExitApp 1\n' +
    '}\n'
  fs.writeFileSync(tmp, script, 'utf8')
  try {
    const r = spawnSync(AHK, [tmp], { timeout: 4000, encoding: 'utf8', windowsHide: true, creationFlags: 0x08000000 /* CREATE_NO_WINDOW */ })
    return r.status === 0
  } finally {
    try { fs.unlinkSync(tmp) } catch (e) {}
  }
}

// cursor.focus - bring Cursor forward.
async function focus() {
  const ok = ahkActivate()
  if (!ok) return { ok: false, error: 'Cursor window not found' }
  await sleep(180)
  return { ok: true, action: 'focused' }
}

// cursor.open_chat_panel - open the Claude Code chat side panel via Ctrl+L.
async function openChatPanel() {
  if (!ahkActivate()) throw new Error('Cursor not running')
  await sleep(160)
  await input.shortcut({ keys: ['ctrl', 'l'] })
  await sleep(400)
  return { ok: true, action: 'open_chat_panel' }
}

// cursor.new_chat_tab - open the chat panel + start a NEW chat (Ctrl+L, then Ctrl+N if needed).
// Cursor sometimes does this with Ctrl+Shift+L, depends on version.
async function newChatTab() {
  if (!ahkActivate()) throw new Error('Cursor not running')
  await sleep(160)
  await input.shortcut({ keys: ['ctrl', 'shift', 'l'] })
  await sleep(500)
  return { ok: true, action: 'new_chat_tab' }
}

// cursor.send_chat - type a message into the focused chat input and submit.
// Assumes chat panel is already open AND focused (call open_chat_panel first
// if you aren't sure). Submits with Enter by default; pass { submit: false }
// to compose without sending.
async function sendChat(params) {
  params = params || {}
  const message = params.message
  if (typeof message !== 'string' || !message.trim()) throw new Error('message (non-empty string) required')
  if (!ahkActivate()) throw new Error('Cursor not running')
  await sleep(150)
  // If the chat input isn't already focused, the user may need to call open_chat_panel first.
  // We just type + submit, assuming the focus is already in the chat input box.
  await input.type({ text: message })
  await sleep(params.typeSettle || 300)
  if (params.submit !== false) {
    await input.key({ key: 'enter' })
    await sleep(params.submitSettle || 400)
  }
  return { ok: true, action: 'send_chat', chars: message.length, submitted: params.submit !== false }
}

// cursor.inline_edit - open the inline edit composer (Ctrl+I) with a prompt.
async function inlineEdit(params) {
  params = params || {}
  const prompt = params.prompt || ''
  if (!ahkActivate()) throw new Error('Cursor not running')
  await sleep(150)
  await input.shortcut({ keys: ['ctrl', 'i'] })
  await sleep(400)
  if (prompt) {
    await input.type({ text: prompt })
    await sleep(300)
    if (params.submit !== false) {
      await input.key({ key: 'enter' })
      await sleep(400)
    }
  }
  return { ok: true, action: 'inline_edit', prompted: !!prompt }
}

// cursor.quick_edit - Ctrl+K with optional prompt (selection-focused edit).
async function quickEdit(params) {
  params = params || {}
  const prompt = params.prompt || ''
  if (!ahkActivate()) throw new Error('Cursor not running')
  await sleep(150)
  await input.shortcut({ keys: ['ctrl', 'k'] })
  await sleep(400)
  if (prompt) {
    await input.type({ text: prompt })
    await sleep(300)
    if (params.submit !== false) {
      await input.key({ key: 'enter' })
      await sleep(400)
    }
  }
  return { ok: true, action: 'quick_edit', prompted: !!prompt }
}

// cursor.dismiss - Escape (close any composer / dropdown / panel overlay)
async function dismiss() {
  if (!ahkActivate()) throw new Error('Cursor not running')
  await sleep(120)
  await input.key({ key: 'escape' })
  await sleep(200)
  return { ok: true, action: 'dismiss' }
}

module.exports = {
  focus: focus,
  open_chat_panel: openChatPanel,
  new_chat_tab: newChatTab,
  send_chat: sendChat,
  inline_edit: inlineEdit,
  quick_edit: quickEdit,
  dismiss: dismiss,
}
