// vscode.js - semantic helpers for the VS Code family (Stable + Insiders + Cursor).
//
// All three are Electron Code-based editors with identical keyboard maps.
// Helpers are keyboard-driven via input.* primitives (no UIA dependency
// because VS Code's keybindings cover ~all navigation flows reliably).
//
// Usage: { ide: 'stable' | 'insiders' | 'cursor' } selects the target.
// All flows: focus window first, then execute keyboard sequence, then
// settle wait. Returns { ok, ide, action } on success.

const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')
const input = require('./input')

const AHK = 'C:\\Users\\tjdTa\\AppData\\Local\\Programs\\AutoHotkey\\v2\\AutoHotkey64.exe'

const IDE_MAP = {
  stable: { exe: 'Code', friendly: 'VS Code' },
  insiders: { exe: 'Code - Insiders', friendly: 'VS Code Insiders' },
  cursor: { exe: 'Cursor', friendly: 'Cursor' },
}

function resolveIde(ide) {
  ide = (ide || 'cursor').toLowerCase()
  const meta = IDE_MAP[ide]
  if (!meta) throw new Error('ide must be one of ' + Object.keys(IDE_MAP).join(', ') + ', got: ' + ide)
  return meta
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function ahkActivate(exe, timeoutMs) {
  timeoutMs = timeoutMs || 4000
  const tmp = path.join(os.tmpdir(), 'eos-vs-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.ahk')
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
    const r = spawnSync(AHK, [tmp], { timeout: timeoutMs, encoding: 'utf8', windowsHide: true })
    return r.status === 0
  } finally {
    try { fs.unlinkSync(tmp) } catch (e) {}
  }
}

// vscode.focus - bring the target IDE window forward.
async function focus(params) {
  const meta = resolveIde(params && params.ide)
  const found = ahkActivate(meta.exe, 4000)
  if (!found) return { ok: false, ide: params.ide, error: meta.friendly + ' window not found' }
  await sleep(180)
  return { ok: true, ide: params.ide || 'cursor', friendly: meta.friendly, exe: meta.exe + '.exe' }
}

// vscode.open_file - Ctrl+P quick open, type path, Enter.
async function openFile(params) {
  params = params || {}
  const filePath = params.path
  if (!filePath) throw new Error('path required')
  const meta = resolveIde(params.ide)
  if (!ahkActivate(meta.exe)) throw new Error(meta.friendly + ' not running')
  await sleep(180)
  await input.shortcut({ keys: ['ctrl', 'p'] })
  await sleep(250)
  await input.type({ text: filePath })
  await sleep(params.typeSettle || 600)
  await input.key({ key: 'enter' })
  await sleep(params.openSettle || 700)
  return { ok: true, ide: params.ide || 'cursor', action: 'open_file', path: filePath }
}

// vscode.command_palette - opens the palette, types a command, optionally submits.
// Uses Esc + F1 instead of raw Ctrl+Shift+P to dodge the documented bug where
// an active chat input control absorbs Ctrl+Shift+P before the palette opens,
// causing the command text to be typed into the chat (see reflex.js:143-157
// origin). Esc dismisses any focused composer first; F1 is the canonical
// palette-open shortcut that bypasses chat-input capture.
async function commandPalette(params) {
  params = params || {}
  const command = params.command
  if (!command) throw new Error('command required')
  const meta = resolveIde(params.ide)
  if (!ahkActivate(meta.exe)) throw new Error(meta.friendly + ' not running')
  await sleep(180)
  // Dismiss any active overlay / focused composer that could swallow F1
  await input.key({ key: 'escape' })
  await sleep(120)
  // F1 opens the command palette in all three IDEs (Stable, Insiders, Cursor)
  await input.key({ key: 'f1' })
  await sleep(300)
  await input.type({ text: command })
  await sleep(params.typeSettle || 400)
  if (params.submit !== false) {
    await input.key({ key: 'enter' })
    await sleep(params.runSettle || 500)
  }
  return { ok: true, ide: params.ide || 'cursor', action: 'command_palette', command: command, submitted: params.submit !== false, via: 'esc+f1' }
}

// vscode.search_workspace - Ctrl+Shift+F, type query.
async function searchWorkspace(params) {
  params = params || {}
  const query = params.query
  if (!query) throw new Error('query required')
  const meta = resolveIde(params.ide)
  if (!ahkActivate(meta.exe)) throw new Error(meta.friendly + ' not running')
  await sleep(180)
  await input.shortcut({ keys: ['ctrl', 'shift', 'f'] })
  await sleep(300)
  await input.type({ text: query })
  await sleep(params.typeSettle || 400)
  if (params.submit !== false) {
    await input.key({ key: 'enter' })
    await sleep(params.searchSettle || 900)
  }
  return { ok: true, ide: params.ide || 'cursor', action: 'search_workspace', query: query }
}

// vscode.run_task - Ctrl+Shift+P, "task ", task name.
async function runTask(params) {
  params = params || {}
  const task = params.task
  if (!task) throw new Error('task required')
  const meta = resolveIde(params.ide)
  if (!ahkActivate(meta.exe)) throw new Error(meta.friendly + ' not running')
  await sleep(180)
  await input.shortcut({ keys: ['ctrl', 'shift', 'p'] })
  await sleep(300)
  await input.type({ text: 'Tasks: Run Task' })
  await sleep(400)
  await input.key({ key: 'enter' })
  await sleep(500)
  await input.type({ text: task })
  await sleep(400)
  await input.key({ key: 'enter' })
  await sleep(500)
  return { ok: true, ide: params.ide || 'cursor', action: 'run_task', task: task }
}

// vscode.new_terminal - Ctrl+` (backtick)
async function newTerminal(params) {
  params = params || {}
  const meta = resolveIde(params.ide)
  if (!ahkActivate(meta.exe)) throw new Error(meta.friendly + ' not running')
  await sleep(180)
  await input.shortcut({ keys: ['ctrl', '`'] })
  await sleep(700)
  return { ok: true, ide: params.ide || 'cursor', action: 'new_terminal' }
}

// vscode.close_tab - Ctrl+W (closes editor tab; in Cursor / VS Code it also closes the side-panel item if focused there)
async function closeTab(params) {
  params = params || {}
  const meta = resolveIde(params.ide)
  if (!ahkActivate(meta.exe)) throw new Error(meta.friendly + ' not running')
  await sleep(150)
  await input.shortcut({ keys: ['ctrl', 'w'] })
  await sleep(250)
  return { ok: true, ide: params.ide || 'cursor', action: 'close_tab' }
}

// vscode.toggle_sidebar - Ctrl+B
async function toggleSidebar(params) {
  params = params || {}
  const meta = resolveIde(params.ide)
  if (!ahkActivate(meta.exe)) throw new Error(meta.friendly + ' not running')
  await sleep(150)
  await input.shortcut({ keys: ['ctrl', 'b'] })
  await sleep(200)
  return { ok: true, ide: params.ide || 'cursor', action: 'toggle_sidebar' }
}

// vscode.save - Ctrl+S
async function save(params) {
  params = params || {}
  const meta = resolveIde(params.ide)
  if (!ahkActivate(meta.exe)) throw new Error(meta.friendly + ' not running')
  await sleep(120)
  await input.shortcut({ keys: ['ctrl', 's'] })
  await sleep(200)
  return { ok: true, ide: params.ide || 'cursor', action: 'save' }
}

// vscode.format - Shift+Alt+F (format document)
async function format(params) {
  params = params || {}
  const meta = resolveIde(params.ide)
  if (!ahkActivate(meta.exe)) throw new Error(meta.friendly + ' not running')
  await sleep(120)
  await input.shortcut({ keys: ['shift', 'alt', 'f'] })
  await sleep(300)
  return { ok: true, ide: params.ide || 'cursor', action: 'format' }
}

// vscode.go_to_line - Ctrl+G, type line number, Enter
async function goToLine(params) {
  params = params || {}
  const line = params.line
  const col = params.column
  if (typeof line !== 'number') throw new Error('line (number) required')
  const meta = resolveIde(params.ide)
  if (!ahkActivate(meta.exe)) throw new Error(meta.friendly + ' not running')
  await sleep(150)
  await input.shortcut({ keys: ['ctrl', 'g'] })
  await sleep(220)
  const text = col ? (line + ':' + col) : String(line)
  await input.type({ text: text })
  await sleep(200)
  await input.key({ key: 'enter' })
  await sleep(300)
  return { ok: true, ide: params.ide || 'cursor', action: 'go_to_line', line: line, column: col || null }
}

// vscode.tab_through - cycle tabs via Ctrl+Tab N times (next) or with shift (prev).
async function tabThrough(params) {
  params = params || {}
  const count = Math.max(1, Math.min(params.count || 1, 20))
  const dir = params.direction || 'next'
  const meta = resolveIde(params.ide)
  if (!ahkActivate(meta.exe)) throw new Error(meta.friendly + ' not running')
  await sleep(120)
  const keys = dir === 'previous' || dir === 'prev' ? ['ctrl', 'shift', 'tab'] : ['ctrl', 'tab']
  for (let i = 0; i < count; i++) {
    await input.shortcut({ keys: keys })
    await sleep(120)
  }
  return { ok: true, ide: params.ide || 'cursor', action: 'tab_through', count: count, direction: dir }
}

// vscode.read_active_editor - select-all + copy in the active editor,
// then read clipboard. Returns the full text of whatever file is focused.
async function readActiveEditor(params) {
  params = params || {}
  const meta = resolveIde(params.ide)
  if (!ahkActivate(meta.exe)) throw new Error(meta.friendly + ' not running')
  await sleep(150)
  await input.shortcut({ keys: ['ctrl', 'a'] })
  await sleep(120)
  await input.shortcut({ keys: ['ctrl', 'c'] })
  await sleep(180)
  const clipboard = require('./clipboard')
  const r = await clipboard.read()
  return { ok: true, ide: params.ide || 'cursor', length: r.length, text: r.text }
}

// vscode.new_claude_code_chat - open a fresh Claude Code chat as a NEW EDITOR TAB
// (not the side panel). Bound to Ctrl+Alt+Shift+C in Tate's keybindings.json -
// the default "Claude Code: New Chat" command-palette entry opens the SIDE PANEL,
// which only holds one chat at a time and isn't what dispatch_worker wants
// (each worker needs its own tab so the sweeper can manage them as tabs and
// multiple workers can co-exist). If this fails silently in Stable / Insiders,
// the keybinding hasn't been configured there yet - add the same Ctrl+Alt+Shift+C
// -> "Claude Code: New Chat in Editor" (or equivalent) binding in that IDE.
async function newClaudeCodeChat(params) {
  params = params || {}
  const meta = resolveIde(params.ide)
  if (!ahkActivate(meta.exe)) throw new Error(meta.friendly + ' not running')
  await sleep(180)
  await input.shortcut({ keys: ['ctrl', 'alt', 'shift', 'c'] })
  await sleep(params.openSettle || 1200)
  return { ok: true, ide: params.ide || 'cursor', action: 'new_claude_code_chat', via: 'ctrl+alt+shift+c' }
}

// vscode.copy_path - command-palette "Copy Path of Active File" (returns via clipboard)
async function copyPath(params) {
  params = params || {}
  const meta = resolveIde(params.ide)
  if (!ahkActivate(meta.exe)) throw new Error(meta.friendly + ' not running')
  await sleep(150)
  await input.shortcut({ keys: ['ctrl', 'k'] })
  await sleep(180)
  await input.key({ key: 'p' })
  await sleep(300)
  const clipboard = require('./clipboard')
  const r = await clipboard.read()
  return { ok: true, ide: params.ide || 'cursor', path: r.text.trim() }
}

module.exports = {
  focus: focus,
  open_file: openFile,
  command_palette: commandPalette,
  search_workspace: searchWorkspace,
  run_task: runTask,
  new_terminal: newTerminal,
  close_tab: closeTab,
  toggle_sidebar: toggleSidebar,
  save: save,
  format: format,
  go_to_line: goToLine,
  tab_through: tabThrough,
  read_active_editor: readActiveEditor,
  copy_path: copyPath,
  new_claude_code_chat: newClaudeCodeChat,
}
