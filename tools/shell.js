const { spawn } = require('child_process')
const { shellCmd } = require('../lib/platform')

async function shell({ command, cwd, timeout = 30000, env: extraEnv }) {
  return new Promise((resolve) => {
    const proc = spawn(shellCmd.shell, [shellCmd.flag, command], {
      cwd: cwd || process.cwd(),
      env: { ...process.env, ...extraEnv },
      windowsHide: true,
    })

    let stdout = ''
    let stderr = ''
    let killed = false

    const timer = setTimeout(() => {
      killed = true
      proc.kill('SIGKILL')
    }, timeout)

    proc.stdout.on('data', (d) => { stdout += d.toString() })
    proc.stderr.on('data', (d) => { stderr += d.toString() })

    proc.on('close', (exitCode) => {
      clearTimeout(timer)
      resolve({
        stdout: stdout.trimEnd(),
        stderr: stderr.trimEnd(),
        exitCode: killed ? null : exitCode,
        killed,
      })
    })

    proc.on('error', (err) => {
      clearTimeout(timer)
      resolve({ stdout, stderr: err.message, exitCode: 1, killed: false })
    })
  })
}

module.exports = { shell }
