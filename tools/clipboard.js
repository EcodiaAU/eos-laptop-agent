// clipboard.js - read + write the Windows clipboard.
//
// The bridge for moving data between Chrome / IDE / filesystem / network.
// Used by vscode.read_active_editor (Ctrl+A + Ctrl+C + clipboard.read)
// and by any flow that needs to grab text content from any UI.
//
// Routes through the long-lived PowerShell daemon (lib/ps-daemon) so we
// don't pay per-call powershell.exe spawn cost AND don't OOM under memory
// pressure when Set-Clipboard wants to load .NET assemblies. Falls back to
// per-call spawnSync if the daemon is unavailable.

const psd = require('../lib/ps-daemon')

// clipboard.read - return current clipboard text (preserves trailing newlines)
async function read() {
  const r = await psd.runOrFallback('Get-Clipboard -Raw', { timeout_ms: 4000 })
  if (!r.ok) throw new Error('clipboard read failed: ' + (r.error || r.stderr))
  return { ok: true, text: r.stdout, length: r.stdout.length }
}

// clipboard.write - set clipboard to given text. Base64-via-PS-decode to fully
// sidestep any quoting concerns for arbitrary content.
async function write(params) {
  params = params || {}
  const text = params.text
  if (typeof text !== 'string') throw new Error('text (string) required')
  const b64 = Buffer.from(text, 'utf8').toString('base64')
  const script =
    '$bytes = [Convert]::FromBase64String("' + b64 + '")\n' +
    '$txt = [System.Text.Encoding]::UTF8.GetString($bytes)\n' +
    'Set-Clipboard -Value $txt'
  const r = await psd.runOrFallback(script, { timeout_ms: 4000 })
  if (!r.ok) throw new Error('clipboard write failed: ' + (r.error || r.stderr))
  return { ok: true, written: text.length, via: r.via || 'daemon' }
}

// clipboard.clear
async function clear() {
  const r = await psd.runOrFallback('Set-Clipboard -Value $null', { timeout_ms: 4000 })
  if (!r.ok) throw new Error('clipboard clear failed: ' + (r.error || r.stderr))
  return { ok: true, via: r.via || 'daemon' }
}

module.exports = {
  read: read,
  write: write,
  clear: clear,
}
