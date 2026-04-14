const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { isWindows, isMac, isLinux } = require('../lib/platform')

async function screenshot({ region, format = 'png' }) {
  const tmpFile = path.join(os.tmpdir(), `eos-screenshot-${Date.now()}.${format}`)

  try {
    if (isWindows) {
      const ps = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bitmap = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size)
$bitmap.Save('${tmpFile.replace(/\\/g, '\\\\')}')
$graphics.Dispose()
$bitmap.Dispose()
Write-Output "$($screen.Width)x$($screen.Height)"
`
      const out = execSync(`powershell.exe -Command "${ps.replace(/"/g, '\\"')}"`, { encoding: 'utf-8', timeout: 10000 })
      const [w, h] = out.trim().split('x').map(Number)
      const image = fs.readFileSync(tmpFile, 'base64')
      fs.unlinkSync(tmpFile)
      return { image, width: w, height: h, format }
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
