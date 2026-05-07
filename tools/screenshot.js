const { execSync, spawnSync } = require('child_process')

// Windows CREATE_NO_WINDOW: prevents powershell console flash on every screenshot.
// 29 Apr 2026 12:42 AEST patch.
const CREATE_NO_WINDOW = 0x08000000

function runPsHidden(file, args, timeoutMs = 15000) {
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
    const err = new Error('Command failed: ' + file + ' status=' + r.status + ' stderr=' + (r.stderr || ''))
    err.status = r.status
    err.stdout = r.stdout
    err.stderr = r.stderr
    throw err
  }
  return r.stdout || ''
}
const fs = require('fs')
const path = require('path')
const os = require('os')
const { isWindows, isMac, isLinux } = require('../lib/platform')

async function screenshot({ region, format = 'png' }) {
  const tmpFile = path.join(os.tmpdir(), `eos-screenshot-${Date.now()}.${format}`)

  try {
    if (isWindows) {
      const scriptFile = path.join(os.tmpdir(), `eos-screenshot-${Date.now()}.ps1`)
      const psScript = [
        'Add-Type -AssemblyName System.Windows.Forms',
        'Add-Type -AssemblyName System.Drawing',
        '$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
        '$bitmap = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)',
        '$graphics = [System.Drawing.Graphics]::FromImage($bitmap)',
        '$graphics.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size)',
        `$bitmap.Save("${tmpFile.replace(/\\/g, '\\\\')}")`,
        '$graphics.Dispose()',
        '$bitmap.Dispose()',
        'Write-Output "$($screen.Width)x$($screen.Height)"',
      ].join('\n')
      fs.writeFileSync(scriptFile, psScript, 'utf-8')
      try {
        const out = runPsHidden('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-File', scriptFile], 15000)
        const [w, h] = out.trim().split('x').map(Number)
        const image = fs.readFileSync(tmpFile, 'base64')
        fs.unlinkSync(tmpFile)
        fs.unlinkSync(scriptFile)
        return { image, width: w, height: h, format }
      } finally {
        try { fs.unlinkSync(scriptFile) } catch {}
      }
    }

    if (isMac) {
      execSync(`screencapture -x "${tmpFile}"`, { timeout: 10000 })
    } else if (isLinux) {
      try {
        execSync(`scrot "${tmpFile}"`, { timeout: 10000 })
      } catch {
        execSync(`import -window root "${tmpFile}"`, { timeout: 10000 })
      }
    }

    if (!fs.existsSync(tmpFile)) {
      return { error: 'Screenshot capture failed - no display available or tool not installed' }
    }

    const image = fs.readFileSync(tmpFile, 'base64')
    fs.unlinkSync(tmpFile)

    return { image, format }
  } catch (err) {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
    return { error: err.message }
  }
}

module.exports = { screenshot }
