const { runSilent } = require('./_lib/silentExec')
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
        const out = runSilent(`powershell.exe -ExecutionPolicy Bypass -File "${scriptFile}"`, { encoding: 'utf-8', timeout: 15000 })
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
      runSilent(`screencapture -x "${tmpFile}"`, { timeout: 10000 })
    } else if (isLinux) {
      try {
        runSilent(`scrot "${tmpFile}"`, { timeout: 10000 })
      } catch {
        runSilent(`import -window root "${tmpFile}"`, { timeout: 10000 })
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
