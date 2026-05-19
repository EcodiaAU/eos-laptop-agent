// clipboard.js - read + write the Windows clipboard.
//
// The bridge for moving data between Chrome / IDE / filesystem / network.
// Used by vscode.read_active_editor (Ctrl+A + Ctrl+C + clipboard.read)
// and by any flow that needs to grab text content from any UI.
//
// IMPORTANT: clipboard ops do NOT use the PS daemon. The long-lived daemon
// process runs MTA by default (powershell.exe -File) and Windows clipboard
// COM operations need STA to actually mutate the system clipboard. Daemon
// Set-Clipboard CLAIMS success but the clipboard never updates - the
// "silent stale-clipboard" failure mode the brittleness audit predicted.
// Use direct per-call spawnSync (fresh PS, defaults to STA) for correctness.
//
// Daemon-skip is acceptable here because clipboard is rare (~1 call per
// dispatch). For input.* (30+ calls per dispatch), the daemon win is large
// and SendKeys doesn't care about STA so it's safe.

const { spawnSync } = require('child_process')

function runPs(script, timeoutMs) {
  // -Sta forces STA apartment for clipboard COM correctness
  const r = spawnSync('powershell', ['-NoProfile', '-Sta', '-Command', script], {
    encoding: 'utf8',
    timeout: timeoutMs || 4000,
    windowsHide: true,
    creationFlags: 0x08000000,
  })
  return { exitCode: r.status, stdout: (r.stdout || ''), stderr: (r.stderr || '') }
}

// clipboard.read - return current clipboard text (preserves trailing newlines)
async function read() {
  const r = runPs('Get-Clipboard -Raw')
  if (r.exitCode !== 0) throw new Error('clipboard read failed: ' + r.stderr)
  return { ok: true, text: r.stdout, length: r.stdout.length }
}

// clipboard.write - set clipboard to given text + VERIFY by read-back.
// The verify step catches the "Set-Clipboard claimed success but the value
// didn't land" silent failure mode (clipboard ownership contention, STA/MTA
// mismatch, etc). Two attempts with a 200ms settle between, then throws.
async function write(params) {
  params = params || {}
  const text = params.text
  if (typeof text !== 'string') throw new Error('text (string) required')
  const b64 = Buffer.from(text, 'utf8').toString('base64')
  // Combined write+verify in one PS invocation so we don't pay two spawn costs
  // AND so the verify happens in the same clipboard-COM context as the write.
  const script =
    '$bytes = [Convert]::FromBase64String("' + b64 + '")\n' +
    '$txt = [System.Text.Encoding]::UTF8.GetString($bytes)\n' +
    'Set-Clipboard -Value $txt\n' +
    'Start-Sleep -Milliseconds 50\n' +
    '$readback = Get-Clipboard -Raw\n' +
    'if ($readback -ne $txt) { Write-Error ("clipboard verify failed: wrote " + $txt.Length + " chars, read " + $readback.Length + " chars"); exit 2 }\n' +
    'Write-Output "ok"'
  let lastError = null
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = runPs(script, 5000)
    if (r.exitCode === 0) {
      return { ok: true, written: text.length, verified: true, attempt: attempt }
    }
    lastError = r.stderr || ('exit ' + r.exitCode)
    if (attempt === 1) {
      // Pause briefly before retry to let clipboard ownership settle
      const waitMs = 250
      const start = Date.now()
      while (Date.now() - start < waitMs) { /* spin */ }
    }
  }
  throw new Error('clipboard write failed after 2 attempts: ' + lastError)
}

// clipboard.clear
async function clear() {
  const r = runPs('Set-Clipboard -Value $null')
  if (r.exitCode !== 0) throw new Error('clipboard clear failed: ' + r.stderr)
  return { ok: true }
}

module.exports = {
  read: read,
  write: write,
  clear: clear,
}
