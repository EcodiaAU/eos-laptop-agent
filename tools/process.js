const { execSync, spawn } = require('child_process')
const { isWindows } = require('../lib/platform')

async function listProcesses({ filter } = {}) {
  try {
    if (isWindows) {
      const cmd = filter
        ? `tasklist /FI "IMAGENAME eq ${filter}" /FO CSV`
        : 'tasklist /FO CSV'
      const out = execSync(cmd, { encoding: 'utf-8', timeout: 10000 })
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
      execSync(`taskkill ${force ? '/F' : ''} /PID ${pid}`, { encoding: 'utf-8', timeout: 10000 })
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
    })
    if (detached) child.unref()
    return { launched: true, pid: child.pid, command }
  } catch (err) {
    return { error: err.message, command }
  }
}

module.exports = { listProcesses, killProcess, launchApp }
