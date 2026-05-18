// explorer.js - Windows File Explorer helpers.
//
// File Explorer is a native Win32 app (CabinetWClass) - keyboard shortcuts +
// UIA both work cleanly. Most flows use keyboard shortcuts via input.*.
//
// Address bar:    Alt+D (or Ctrl+L)  -> focus + select path text
// Search box:     Ctrl+E             -> focus search
// Refresh:        F5
// New folder:     Ctrl+Shift+N
// Delete:         Delete (to Recycle Bin) or Shift+Delete (permanent)
// Cut / copy:     Ctrl+X / Ctrl+C
// Paste:          Ctrl+V
// Select all:     Ctrl+A
// Properties:     Alt+Enter

const path = require('path')
const fs = require('fs')
const os = require('os')
const { spawnSync, spawn } = require('child_process')
const input = require('./input')

const AHK = 'C:\\Users\\tjdTa\\AppData\\Local\\Programs\\AutoHotkey\\v2\\AutoHotkey64.exe'

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function ahkActivate(titleContains) {
  const tmp = path.join(os.tmpdir(), 'eos-exp-' + Date.now() + '.ahk')
  const script = '#Requires AutoHotkey v2.0\n' +
    'SetTitleMatchMode 2\n' +
    'if WinExist("' + (titleContains || '').replace(/"/g, '`"') + '" "ahk_class CabinetWClass") {\n' +
    '  WinActivate\n' +
    '  WinWaitActive("ahk_class CabinetWClass", , 2)\n' +
    '  ExitApp 0\n' +
    '} else if WinExist("ahk_class CabinetWClass") {\n' +
    '  WinActivate\n' +
    '  WinWaitActive("ahk_class CabinetWClass", , 2)\n' +
    '  ExitApp 0\n' +
    '} else { ExitApp 1 }\n'
  fs.writeFileSync(tmp, script, 'utf8')
  try {
    const r = spawnSync(AHK, [tmp], { timeout: 4000, encoding: 'utf8', windowsHide: true })
    return r.status === 0
  } finally {
    try { fs.unlinkSync(tmp) } catch (e) {}
  }
}

// explorer.open - spawn a new File Explorer window at a path.
async function open(params) {
  params = params || {}
  const targetPath = params.path || (require('os').homedir())
  const child = spawn('explorer.exe', [targetPath], { detached: true, stdio: 'ignore' })
  child.unref()
  await sleep(900)
  return { ok: true, action: 'open', path: targetPath }
}

// explorer.focus - bring a File Explorer window forward (latest if multiple).
async function focus(params) {
  params = params || {}
  const ok = ahkActivate(params.titleContains || '')
  if (!ok) return { ok: false, error: 'No File Explorer window found' }
  await sleep(180)
  return { ok: true, action: 'focused' }
}

// explorer.navigate - Alt+D focus address bar, type path, Enter.
async function navigate(params) {
  params = params || {}
  const targetPath = params.path
  if (!targetPath) throw new Error('path required')
  if (!ahkActivate(params.titleContains || '')) {
    // No explorer open; spawn one at that path directly.
    await open({ path: targetPath })
    return { ok: true, action: 'navigate', method: 'spawn_new', path: targetPath }
  }
  await sleep(180)
  await input.shortcut({ keys: ['alt', 'd'] })
  await sleep(220)
  await input.type({ text: targetPath })
  await sleep(180)
  await input.key({ key: 'enter' })
  await sleep(700)
  return { ok: true, action: 'navigate', method: 'address_bar', path: targetPath }
}

// explorer.search - Ctrl+E focus search, type query, Enter.
async function search(params) {
  params = params || {}
  const query = params.query
  if (!query) throw new Error('query required')
  if (!ahkActivate()) throw new Error('No File Explorer window')
  await sleep(180)
  await input.shortcut({ keys: ['ctrl', 'e'] })
  await sleep(250)
  await input.type({ text: query })
  await sleep(180)
  if (params.submit !== false) {
    await input.key({ key: 'enter' })
    await sleep(1200)
  }
  return { ok: true, action: 'search', query: query }
}

// explorer.refresh - F5
async function refresh() {
  if (!ahkActivate()) throw new Error('No File Explorer window')
  await sleep(120)
  await input.key({ key: 'f5' })
  await sleep(400)
  return { ok: true, action: 'refresh' }
}

// explorer.list_dir - filesystem-level read (NOT UI - just fs.readdirSync).
// Faster and more reliable than driving the UI for read-only listings.
async function listDir(params) {
  params = params || {}
  const targetPath = params.path
  if (!targetPath) throw new Error('path required')
  if (!fs.existsSync(targetPath)) throw new Error('path does not exist: ' + targetPath)
  const entries = fs.readdirSync(targetPath, { withFileTypes: true })
  const items = entries.map(e => {
    const full = path.join(targetPath, e.name)
    let stat = null
    try { stat = fs.statSync(full) } catch (err) {}
    return {
      name: e.name,
      type: e.isDirectory() ? 'dir' : (e.isSymbolicLink() ? 'symlink' : 'file'),
      sizeBytes: stat ? stat.size : null,
      modifiedAt: stat ? stat.mtime.toISOString() : null,
    }
  })
  return { path: targetPath, count: items.length, items: items.slice(0, params.limit || 200) }
}

module.exports = {
  open: open,
  focus: focus,
  navigate: navigate,
  search: search,
  refresh: refresh,
  list_dir: listDir,
}
