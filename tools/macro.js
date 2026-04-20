const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

const AHK = 'C:\\Users\\tjdTa\\AppData\\Local\\Programs\\AutoHotkey\\v2\\AutoHotkey64.exe'
const MACRO_DIR = path.join(__dirname, '..', 'macros')

function runAHKScript(script, timeout) {
  timeout = timeout || 30000
  const tmp = path.join(os.tmpdir(), 'macro_' + Date.now() + '.ahk')
  fs.writeFileSync(tmp, '#Requires AutoHotkey v2.0\n' + script + '\nExitApp(0)', 'utf8')
  try {
    const r = spawnSync(AHK, [tmp], { timeout: timeout, encoding: 'utf8', windowsHide: true })
    if (r.error) throw r.error
    return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr }
  } finally {
    try { fs.unlinkSync(tmp) } catch(e) {}
  }
}

// Run a named macro from macros/ with optional {{param}} substitution
async function run(p) {
  const name = p.name, params = p.params || {}, timeout = p.timeout || 30000
  if (!fs.existsSync(MACRO_DIR)) fs.mkdirSync(MACRO_DIR, { recursive: true })
  const scriptPath = path.join(MACRO_DIR, name + '.ahk')
  if (!fs.existsSync(scriptPath)) {
    const available = fs.readdirSync(MACRO_DIR).filter(f => f.endsWith('.ahk')).map(f => f.replace('.ahk', ''))
    throw new Error('Macro not found: ' + name + '. Available: ' + available.join(', '))
  }
  let script = fs.readFileSync(scriptPath, 'utf8').replace(/^#Requires AutoHotkey v2\.0\s*/m, '')
  for (const [k, v] of Object.entries(params)) {
    script = script.replace(new RegExp('{{' + k + '}}', 'g'), v)
  }
  return Object.assign({ macro: name, params: params }, runAHKScript(script, timeout))
}

// Run an inline AHK v2 script directly (no #Requires needed)
async function inline(p) {
  return runAHKScript(p.script || '', p.timeout || 30000)
}

// List all macros in the library
async function list() {
  if (!fs.existsSync(MACRO_DIR)) return { macros: [] }
  const macros = fs.readdirSync(MACRO_DIR).filter(f => f.endsWith('.ahk')).map(f => {
    const content = fs.readFileSync(path.join(MACRO_DIR, f), 'utf8')
    const desc = (content.match(/; Description: (.+)/) || [])[1] || ''
    const params = [...content.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1])
    return { name: f.replace('.ahk', ''), description: desc, params: [...new Set(params)] }
  })
  return { macros: macros }
}

// Save a new macro to the library
async function save(p) {
  if (!fs.existsSync(MACRO_DIR)) fs.mkdirSync(MACRO_DIR, { recursive: true })
  const header = p.description ? '; Description: ' + p.description + '\n' : ''
  const full = '#Requires AutoHotkey v2.0\n' + header + (p.script || '')
  fs.writeFileSync(path.join(MACRO_DIR, p.name + '.ahk'), full, 'utf8')
  return { saved: true, name: p.name }
}

module.exports = { run, inline, list, save }