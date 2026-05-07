const { spawn } = require('child_process')
const { shellCmd, isWindows } = require('../lib/platform')

// Windows CREATE_NO_WINDOW flag - definitively prevents the console window
// from appearing for the spawned process. windowsHide:true alone is unreliable
// when the parent (PM2 daemon) has a console attached.
const CREATE_NO_WINDOW = 0x08000000

async function shell({ command, cwd, timeout = 30000, env: extraEnv }) {
  return new Promise((resolve) => {
    const spawnOptions = {
      cwd: cwd || process.cwd(),
      env: { ...process.env, ...extraEnv },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
    if (isWindows) {
      spawnOptions.windowsVerbatimArguments = false
      // CREATE_NO_WINDOW prevents the cmd/powershell window from appearing
      // even when the parent process has a console. This is the definitive fix
      // for the "cmd window pops on every shell call" issue Tate flagged 2026-04-29.
      spawnOptions.detached = false
      spawnOptions.shell = false
      spawnOptions.creationFlags = CREATE_NO_WINDOW
    }
    const proc = spawn(shellCmd.shell, [shellCmd.flag, command], spawnOptions)

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
