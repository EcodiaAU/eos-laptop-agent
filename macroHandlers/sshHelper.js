// macroHandlers/sshHelper.js
// Tiny ssh2 wrapper for password-auth SSH from Node. Replaces sshpass dependency
// for Mac-side macros (macincloud-login, xcode-organizer-upload, transporter-upload).
//
// Why ssh2: Corazon (Windows) does not ship sshpass, Git Bash, or WSL bash. The
// existing Mac-side macros assumed sshpass would be on PATH. ssh2 npm package
// gives us native Node SSH with password auth, no shell dependencies.
//
// Surface:
//   runRemote({host, user, pass, command, timeoutMs}) -> {stdout, stderr, exitCode}
//   writeRemote({host, user, pass, remotePath, body}) -> {ok, error?}
//
// Authored by fork_mojpge0a_3c7dcd, 29 Apr 2026.

const { Client } = require('ssh2')

function runRemote({ host, user, pass, command, timeoutMs, port }) {
  const tm = timeoutMs || 60000
  return new Promise((resolve) => {
    const conn = new Client()
    let stdout = ''
    let stderr = ''
    let resolved = false
    const finalize = (out) => {
      if (resolved) return
      resolved = true
      try { conn.end() } catch (_) {}
      resolve(out)
    }
    const watchdog = setTimeout(() => {
      finalize({ stdout, stderr: stderr + `\n[ssh2 watchdog timeout after ${tm}ms]`, exitCode: 124, killed: true })
    }, tm)
    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(watchdog)
          return finalize({ stdout: '', stderr: `exec error: ${err.message}`, exitCode: 1, killed: false })
        }
        stream
          .on('close', (code, signal) => {
            clearTimeout(watchdog)
            finalize({ stdout, stderr, exitCode: typeof code === 'number' ? code : (signal ? 130 : 0), killed: false })
          })
          .on('data', (d) => { stdout += d.toString('utf8') })
          .stderr.on('data', (d) => { stderr += d.toString('utf8') })
      })
    }).on('error', (err) => {
      clearTimeout(watchdog)
      finalize({ stdout: '', stderr: `ssh2 connect error: ${err.message}`, exitCode: 255, killed: false })
    }).connect({
      host,
      port: port || 22,
      username: user,
      password: pass,
      readyTimeout: Math.min(tm, 30000),
      tryKeyboard: true,
    })
    // Some servers require keyboard-interactive for password auth.
    conn.on('keyboard-interactive', (_name, _instr, _lang, _prompts, finish) => {
      finish([pass])
    })
  })
}

async function writeRemote({ host, user, pass, remotePath, body, port }) {
  const b64 = Buffer.from(body, 'utf8').toString('base64')
  const cmd = `printf '%s' '${b64}' | base64 -d > ${shellQuote(remotePath)} && chmod 644 ${shellQuote(remotePath)}`
  const r = await runRemote({ host, user, pass, command: cmd, timeoutMs: 30000, port })
  if (r.exitCode !== 0) {
    return { ok: false, error: `writeRemote failed: exit=${r.exitCode} stderr=${truncate(r.stderr, 500)}` }
  }
  return { ok: true }
}

function shellQuote(s) {
  if (!s) return "''"
  return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

function truncate(s, n) {
  if (!s) return s
  if (s.length <= n) return s
  return s.slice(0, n) + '...[trunc]'
}

module.exports = { runRemote, writeRemote }
