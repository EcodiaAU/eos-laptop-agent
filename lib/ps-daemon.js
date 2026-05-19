// ps-daemon.js - long-lived PowerShell child process for the GUI substrate.
//
// PROBLEM: every PS-shelling tool (clipboard, window, uia, notification, etc)
// pays a ~500ms cold-start cost AND loads .NET / System.Web each call. Under
// memory pressure these fresh PS spawns fail outright (System.Web init throws,
// Set-Clipboard hangs, ConvertTo-Json blows up). Two clipboard.write failures
// + a window.foreground failure in one dispatch session on 2026-05-17 night.
//
// SOLUTION: one long-lived powershell.exe child process spawned at laptop-agent
// startup. Commands are piped in via stdin as line-delimited JSON envelopes;
// responses come out the same way on stdout. .NET + System.Web load ONCE.
// Inline C# `Add-Type @"..."@` compiles ONCE per session and is cached.
//
// API:
//   psd.run(script, {timeout_ms?}) -> Promise<{ok, stdout, stderr, exit_code, elapsed_ms}>
//   psd.runOrFallback(script, opts) -> psd.run if alive, else fallback to spawnSync
//   psd.ensureAlive() -> kicks the daemon back to life if dead
//   psd.shutdown() -> graceful close
//   psd.stats() -> {alive, pid, requests_served, requests_failed, last_error}
//
// Protocol (line-delimited JSON):
//   Request:  {"id":"<uuid>","script":"<ps body>","timeout_ms":5000}
//   Response: {"id":"<uuid>","ok":true,"stdout":"...","stderr":"...","exit_code":0,"elapsed_ms":42}
//   Error:    {"id":"<uuid>","ok":false,"error":"<message>"}
//
// SAFETY:
//   - Each request runs in its own try/catch inside the daemon, so a bad script
//     doesn't kill the daemon.
//   - Per-request timeout cancels long-running scripts (using a runspace).
//   - Daemon liveness check every 30s; auto-respawn on death.
//   - Requests serialise via internal queue - PS daemon processes one at a time
//     so stdout doesn't interleave across calls.

const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const { spawn, spawnSync } = require('child_process')

const DAEMON_PS_PATH = path.join(__dirname, 'ps-daemon-host.ps1')
const POWERSHELL_EXE = process.env.POWERSHELL_EXE || 'powershell.exe'
const DEFAULT_TIMEOUT_MS = 8000
const RESPAWN_BACKOFF_MS = 2000
const HEARTBEAT_INTERVAL_MS = 30 * 1000

let daemonProc = null
let daemonAlive = false
let respawnTimer = null
let heartbeatTimer = null
let lastError = null
let requestsServed = 0
let requestsFailed = 0
let stdoutBuffer = ''
const pending = new Map()        // id -> {resolve, reject, timer, startedAt}
const queue = []                  // [{id, payload, resolve, reject}]
let inflight = false              // single-request-in-flight gate

function uuid() { return crypto.randomUUID() }

function writeHostScript() {
  // Write the daemon-side PS host script. Reads JSON envelopes line-by-line
  // from stdin, runs the script in a child runspace with timeout, writes
  // JSON response to stdout.
  const ps = `# eos-laptop-agent PS daemon host
# Reads line-delimited JSON request envelopes from stdin, runs each script,
# writes line-delimited JSON response envelopes to stdout.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# Pre-load assemblies the tools commonly use (one-time cost, amortised forever)
try { Add-Type -AssemblyName System.Windows.Forms } catch {}
try { Add-Type -AssemblyName UIAutomationClient } catch {}
try { Add-Type -AssemblyName UIAutomationTypes } catch {}
try { Add-Type -AssemblyName System.Web } catch {}

# Signal ready
[Console]::Out.WriteLine('{"_daemon_ready":true,"pid":' + $PID + ',"ts":"' + (Get-Date -Format 'o') + '"}')
[Console]::Out.Flush()

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }  # stdin closed
  if ($line.Length -eq 0) { continue }

  $req = $null
  try { $req = $line | ConvertFrom-Json } catch {
    [Console]::Out.WriteLine('{"id":null,"ok":false,"error":"bad json: ' + $_.Exception.Message.Replace('"','\\"') + '"}')
    [Console]::Out.Flush()
    continue
  }

  $id = $req.id
  $script = $req.script
  $timeoutMs = if ($req.timeout_ms) { [int]$req.timeout_ms } else { 8000 }

  $start = Get-Date
  $stdout = ''
  $stderr = ''
  $ok = $true
  $errorMsg = $null

  try {
    # Run in a child runspace so we can timeout
    $rs = [runspacefactory]::CreateRunspace()
    $rs.Open()
    $ps = [powershell]::Create()
    $ps.Runspace = $rs
    [void]$ps.AddScript($script)
    $async = $ps.BeginInvoke()
    if (-not $async.AsyncWaitHandle.WaitOne($timeoutMs)) {
      $ps.Stop()
      $ok = $false
      $errorMsg = 'timeout after ' + $timeoutMs + 'ms'
    } else {
      $output = $ps.EndInvoke($async)
      $stdout = if ($output) { ($output | Out-String).TrimEnd() } else { '' }
      if ($ps.HadErrors) {
        $errMsgs = @()
        foreach ($e in $ps.Streams.Error) { $errMsgs += $e.ToString() }
        $stderr = ($errMsgs -join [Environment]::NewLine)
      }
    }
    $rs.Close()
  } catch {
    $ok = $false
    $errorMsg = $_.Exception.Message
  }

  $elapsed = ((Get-Date) - $start).TotalMilliseconds
  $resp = @{
    id = $id
    ok = $ok
    stdout = $stdout
    stderr = $stderr
    exit_code = if ($ok) { 0 } else { 1 }
    elapsed_ms = [int]$elapsed
  }
  if ($errorMsg) { $resp.error = $errorMsg }
  $json = $resp | ConvertTo-Json -Compress -Depth 8
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}
`
  try { fs.writeFileSync(DAEMON_PS_PATH, ps, 'utf8') } catch (e) {
    lastError = 'failed to write daemon host script: ' + e.message
  }
}

function spawnDaemon() {
  if (daemonProc) return
  writeHostScript()
  try {
    daemonProc = spawn(POWERSHELL_EXE, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', DAEMON_PS_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
  } catch (e) {
    lastError = 'spawn failed: ' + e.message
    daemonAlive = false
    scheduleRespawn()
    return
  }

  daemonProc.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString('utf8')
    // Process complete lines
    let nl
    while ((nl = stdoutBuffer.indexOf('\n')) !== -1) {
      const line = stdoutBuffer.slice(0, nl).replace(/\r$/, '')
      stdoutBuffer = stdoutBuffer.slice(nl + 1)
      if (!line) continue
      handleLine(line)
    }
  })

  daemonProc.stderr.on('data', (chunk) => {
    // Stderr from the daemon host itself (not from individual scripts).
    // Log but don't fail; per-script stderr is captured inside the protocol.
    const s = chunk.toString('utf8').trim()
    if (s) lastError = 'daemon-host stderr: ' + s.slice(0, 500)
  })

  daemonProc.on('exit', (code, signal) => {
    daemonAlive = false
    daemonProc = null
    lastError = 'daemon exited code=' + code + ' signal=' + signal
    // Reject all pending
    for (const [id, p] of pending.entries()) {
      try { p.reject(new Error('daemon died mid-request')) } catch (e) {}
      if (p.timer) clearTimeout(p.timer)
    }
    pending.clear()
    inflight = false
    // Reject queued too
    while (queue.length) {
      const q = queue.shift()
      try { q.reject(new Error('daemon died, queued request dropped')) } catch (e) {}
    }
    scheduleRespawn()
  })

  daemonProc.on('error', (e) => {
    lastError = 'daemon error: ' + e.message
  })
}

function handleLine(line) {
  let parsed
  try { parsed = JSON.parse(line) } catch (e) {
    lastError = 'malformed daemon response: ' + line.slice(0, 200)
    return
  }
  if (parsed._daemon_ready) {
    daemonAlive = true
    return
  }
  const id = parsed.id
  if (id && pending.has(id)) {
    const p = pending.get(id)
    pending.delete(id)
    if (p.timer) clearTimeout(p.timer)
    if (parsed.ok) {
      requestsServed++
      p.resolve(parsed)
    } else {
      requestsFailed++
      p.resolve(parsed)  // resolve with ok:false rather than reject - lets callers see the structured error
    }
    inflight = false
    processQueue()
  }
}

function processQueue() {
  if (inflight) return
  if (!daemonAlive || !daemonProc) return
  const next = queue.shift()
  if (!next) return
  inflight = true
  pending.set(next.id, next)
  try {
    daemonProc.stdin.write(JSON.stringify(next.payload) + '\n', 'utf8')
  } catch (e) {
    pending.delete(next.id)
    inflight = false
    if (next.timer) clearTimeout(next.timer)
    next.reject(new Error('stdin write failed: ' + e.message))
    processQueue()
  }
}

function scheduleRespawn() {
  if (respawnTimer) return
  respawnTimer = setTimeout(() => {
    respawnTimer = null
    spawnDaemon()
  }, RESPAWN_BACKOFF_MS)
}

function heartbeat() {
  if (!daemonAlive || !daemonProc) {
    scheduleRespawn()
    return
  }
  // Cheap probe; reject if it doesn't return in 5s
  run('1', { timeout_ms: 5000 })
    .then((r) => { if (!r.ok) { try { daemonProc.kill() } catch (e) {} } })
    .catch(() => { try { daemonProc.kill() } catch (e) {} })
}

function run(script, opts) {
  opts = opts || {}
  const timeout_ms = opts.timeout_ms || DEFAULT_TIMEOUT_MS
  return new Promise((resolve, reject) => {
    if (!daemonProc) spawnDaemon()
    const id = uuid()
    const payload = { id: id, script: script, timeout_ms: timeout_ms }
    const entry = {
      id: id,
      payload: payload,
      resolve: resolve,
      reject: reject,
      startedAt: Date.now(),
      timer: setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id)
          requestsFailed++
          inflight = false
          resolve({ id: id, ok: false, error: 'client-side timeout after ' + timeout_ms + 'ms', stdout: '', stderr: '', exit_code: 1, elapsed_ms: timeout_ms })
          processQueue()
        }
      }, timeout_ms + 1000),  // +1s grace over daemon-side timeout
    }
    queue.push(entry)
    processQueue()
  })
}

// Fallback to spawnSync when the daemon is unavailable. Same input contract,
// same return shape, so callers can compose without conditionals.
function runFallback(script, opts) {
  opts = opts || {}
  const timeout_ms = opts.timeout_ms || DEFAULT_TIMEOUT_MS
  const start = Date.now()
  try {
    const r = spawnSync(POWERSHELL_EXE, ['-NoProfile', '-NonInteractive', '-Command', script], {
      timeout: timeout_ms,
      encoding: 'utf8',
      windowsHide: true,
      creationFlags: 0x08000000,
    })
    return {
      ok: r.status === 0,
      stdout: (r.stdout || '').trim(),
      stderr: (r.stderr || '').trim(),
      exit_code: r.status,
      elapsed_ms: Date.now() - start,
      via: 'fallback-spawnSync',
    }
  } catch (e) {
    return {
      ok: false,
      stdout: '',
      stderr: '',
      error: e.message,
      exit_code: 1,
      elapsed_ms: Date.now() - start,
      via: 'fallback-spawnSync',
    }
  }
}

async function runOrFallback(script, opts) {
  if (daemonAlive) {
    try {
      const r = await run(script, opts)
      if (r.ok) return r
      // Daemon returned an error - try the fallback once before bubbling up
      const fb = runFallback(script, opts)
      if (fb.ok) return fb
      return r  // both failed, return daemon's error for better signal
    } catch (e) {
      return runFallback(script, opts)
    }
  }
  return runFallback(script, opts)
}

function ensureAlive() {
  if (!daemonProc || !daemonAlive) spawnDaemon()
}

function shutdown() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }
  if (respawnTimer) { clearTimeout(respawnTimer); respawnTimer = null }
  if (daemonProc) {
    try { daemonProc.stdin.end() } catch (e) {}
    try { daemonProc.kill() } catch (e) {}
    daemonProc = null
    daemonAlive = false
  }
}

function stats() {
  return {
    alive: daemonAlive,
    pid: daemonProc ? daemonProc.pid : null,
    requests_served: requestsServed,
    requests_failed: requestsFailed,
    pending: pending.size,
    queued: queue.length,
    last_error: lastError,
  }
}

// Auto-start on require; restart loop self-heals.
spawnDaemon()
heartbeatTimer = setInterval(heartbeat, HEARTBEAT_INTERVAL_MS)

// Graceful shutdown on parent exit
process.on('exit', shutdown)
process.on('SIGINT', () => { shutdown(); process.exit(0) })
process.on('SIGTERM', () => { shutdown(); process.exit(0) })

module.exports = {
  run: run,
  runFallback: runFallback,
  runOrFallback: runOrFallback,
  ensureAlive: ensureAlive,
  shutdown: shutdown,
  stats: stats,
}
