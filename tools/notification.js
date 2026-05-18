// notification.js - Windows visible notifications + audio beep.
//
// Toast attempted in this order:
//   1. BurntToast PowerShell module (if installed) - modern toast
//   2. System.Windows.Forms.NotifyIcon balloon - legacy but ALWAYS visible
//      regardless of appId registration (Win10/11 silently drops toasts
//      from unregistered appIds; the balloon path bypasses that).
//   3. msg.exe - last resort modal popup (works even in locked sessions)
//
// Beep uses [console]::beep (audio only, no UI).

const { spawnSync } = require('child_process')

function runPs(script, timeoutMs) {
  timeoutMs = timeoutMs || 8000
  const r = spawnSync('powershell', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
  })
  return { exitCode: r.status, stdout: (r.stdout || ''), stderr: (r.stderr || '') }
}

// Escape single quotes for embedding in a PowerShell single-quoted string.
function psQuote(s) { return String(s).replace(/'/g, "''") }

// notification.toast - show a visible Windows notification.
// Tries BurntToast first, falls back to NotifyIcon system-tray balloon.
async function toast(params) {
  params = params || {}
  const title = psQuote(params.title || 'EcodiaOS')
  const body = psQuote(params.body || '')
  const durationMs = Math.max(1500, Math.min(params.durationMs || 5000, 15000))

  // Path 1: BurntToast module
  const burntScript =
    "if (Get-Module -ListAvailable -Name BurntToast) {\n" +
    "  Import-Module BurntToast -ErrorAction SilentlyContinue\n" +
    "  New-BurntToastNotification -Text '" + title + "', '" + body + "' -ErrorAction Stop\n" +
    "  Write-Output 'TOAST_BURNT'\n" +
    "} else { Write-Output 'NO_BURNT' }"
  const burntR = runPs(burntScript, 5000)
  if (burntR.exitCode === 0 && burntR.stdout.indexOf('TOAST_BURNT') !== -1) {
    return { ok: true, mechanism: 'BurntToast', title: params.title, body: params.body }
  }

  // Path 2: NotifyIcon balloon (always visible regardless of appId)
  const balloonScript =
    "Add-Type -AssemblyName System.Windows.Forms\n" +
    "Add-Type -AssemblyName System.Drawing\n" +
    "$notify = New-Object System.Windows.Forms.NotifyIcon\n" +
    "$notify.Icon = [System.Drawing.SystemIcons]::Information\n" +
    "$notify.BalloonTipTitle = '" + title + "'\n" +
    "$notify.BalloonTipText = '" + body + "'\n" +
    "$notify.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Info\n" +
    "$notify.Visible = $true\n" +
    "$notify.ShowBalloonTip(" + durationMs + ")\n" +
    "Start-Sleep -Milliseconds " + (durationMs + 200) + "\n" +
    "$notify.Dispose()\n" +
    "Write-Output 'BALLOON_SHOWN'"
  // Note: timeout must exceed durationMs + buffer for the Start-Sleep above
  const balloonR = runPs(balloonScript, durationMs + 4000)
  if (balloonR.exitCode === 0 && balloonR.stdout.indexOf('BALLOON_SHOWN') !== -1) {
    return { ok: true, mechanism: 'NotifyIcon-balloon', title: params.title, body: params.body, durationMs: durationMs }
  }

  return { ok: false, mechanism_attempts: ['BurntToast', 'NotifyIcon-balloon'], burntErr: burntR.stderr.slice(0, 200), balloonErr: balloonR.stderr.slice(0, 200) }
}

// notification.beep - simple system beep.
async function beep(params) {
  params = params || {}
  const freq = Math.max(37, Math.min(params.frequency || 800, 32767))
  const dur = Math.max(50, Math.min(params.durationMs || 200, 5000))
  const r = runPs('[console]::beep(' + freq + ', ' + dur + ')', dur + 2000)
  return { ok: r.exitCode === 0, frequency: freq, durationMs: dur }
}

// notification.flash_window - flash a window's taskbar icon (visible attention grabber)
// without needing notification system at all. Idempotent + non-intrusive.
async function flashWindow(params) {
  params = params || {}
  const title = psQuote(params.titleContains || '')
  const count = Math.max(1, Math.min(params.count || 3, 10))
  const script =
    "Add-Type @'\n" +
    "using System;\n" +
    "using System.Runtime.InteropServices;\n" +
    "public class FW {\n" +
    "  [StructLayout(LayoutKind.Sequential)]\n" +
    "  public struct FLASHWINFO {\n" +
    "    public uint cbSize; public IntPtr hwnd; public uint dwFlags; public uint uCount; public uint dwTimeout;\n" +
    "  }\n" +
    "  [DllImport(\"user32.dll\")] public static extern bool FlashWindowEx(ref FLASHWINFO p);\n" +
    "  [DllImport(\"user32.dll\")] public static extern IntPtr FindWindow(string c, string n);\n" +
    "  [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow();\n" +
    "}\n" +
    "'@\n" +
    "$h = if ('" + title + "') { [FW]::FindWindow($null, '" + title + "') } else { [FW]::GetForegroundWindow() }\n" +
    "if ($h -eq [IntPtr]::Zero) { Write-Output 'NO_HWND'; exit 1 }\n" +
    "$fi = New-Object FW+FLASHWINFO\n" +
    "$fi.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($fi)\n" +
    "$fi.hwnd = $h\n" +
    "$fi.dwFlags = 3\n" +  // FLASHW_ALL = TRAY | CAPTION
    "$fi.uCount = " + count + "\n" +
    "$fi.dwTimeout = 0\n" +
    "[void][FW]::FlashWindowEx([ref]$fi)\n" +
    "Write-Output 'FLASHED'"
  const r = runPs(script, 4000)
  return { ok: r.stdout.indexOf('FLASHED') !== -1, target: params.titleContains || '(foreground)', count: count }
}

module.exports = {
  toast: toast,
  beep: beep,
  flash_window: flashWindow,
}
