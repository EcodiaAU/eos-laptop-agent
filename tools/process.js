const { execSync, spawn, spawnSync } = require('child_process')

// Windows CREATE_NO_WINDOW: prevent cmd flash on every list/kill call.
// 29 Apr 2026 12:43 AEST patch.
const CREATE_NO_WINDOW = 0x08000000

function execHidden(file, args, timeoutMs = 10000) {
  if (process.platform === 'win32') {
    const r = spawnSync(file, args, {
      encoding: 'utf-8',
      timeout: timeoutMs,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsVerbatimArguments: false,
      detached: false,
      creationFlags: CREATE_NO_WINDOW,
    })
    if (r.error) throw r.error
    if (r.status !== 0) {
      const e = new Error('Command failed: ' + file + ' status=' + r.status + ' stderr=' + (r.stderr || ''))
      e.status = r.status; e.stdout = r.stdout; e.stderr = r.stderr
      throw e
    }
    return r.stdout || ''
  }
  return execSync(file + ' ' + args.map(a => '"' + a.replace(/"/g, '\\"') + '"').join(' '), { encoding: 'utf-8', timeout: timeoutMs })
}
const { isWindows } = require('../lib/platform')

async function listProcesses({ filter } = {}) {
  try {
    if (isWindows) {
      const args = filter
        ? ['/FI', 'IMAGENAME eq ' + filter, '/FO', 'CSV']
        : ['/FO', 'CSV']
      const out = execHidden('tasklist', args, 10000)
      const lines = out.trim().split('\n')
      const headers = lines[0].replace(/"/g, '').split(',')
      const procs = lines.slice(1).map(line => {
        const vals = line.match(/"([^"]*)"/g)?.map(v => v.replace(/"/g, '')) || []
        const obj = {}
        headers.forEach((h, i) => { obj[h.trim()] = vals[i] || '' })
        return obj
      })
      return { processes: procs, count: procs.length }
    }

    const cmd = filter
      ? `ps aux | head -1; ps aux | grep -i "${filter}" | grep -v grep`
      : 'ps aux --sort=-%mem | head -50'
    const out = execSync(cmd, { encoding: 'utf-8', timeout: 10000 })
    const lines = out.trim().split('\n')
    const procs = lines.slice(1).map(line => {
      const parts = line.split(/\s+/)
      return {
        user: parts[0], pid: parts[1], cpu: parts[2], mem: parts[3],
        command: parts.slice(10).join(' '),
      }
    })
    return { processes: procs, count: procs.length }
  } catch (err) {
    return { error: err.message }
  }
}

async function killProcess({ pid, force = false }) {
  try {
    if (isWindows) {
      execHidden('taskkill', force ? ['/F', '/PID', String(pid)] : ['/PID', String(pid)], 10000)
    } else {
      process.kill(parseInt(pid), force ? 'SIGKILL' : 'SIGTERM')
    }
    return { killed: true, pid }
  } catch (err) {
    return { error: err.message, pid }
  }
}

async function launchApp({ command, args = [], detached = true }) {
  try {
    const child = spawn(command, args, {
      detached,
      stdio: 'ignore',
      windowsHide: false,
      ...(process.platform === 'win32' ? { creationFlags: 0x00000008 } : {}), // DETACHED_PROCESS
    })
    if (detached) child.unref()
    return { launched: true, pid: child.pid, command }
  } catch (err) {
    return { error: err.message, command }
  }
}

module.exports = { listProcesses, killProcess, launchApp }
