$src = @"
using System;
using System.Runtime.InteropServices;
public class Win {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int n);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
}
"@
Add-Type -TypeDefinition $src -ErrorAction SilentlyContinue
$HWND_TOPMOST = New-Object IntPtr(-1)
$HWND_NOTOPMOST = New-Object IntPtr(-2)
$p = Get-Process -Id 6324
$h = $p.MainWindowHandle
[Win]::SetWindowPos($h, $HWND_TOPMOST, 0, 0, 1366, 768, 0x0040) | Out-Null
Start-Sleep -Milliseconds 300
[Win]::SetWindowPos($h, $HWND_NOTOPMOST, 0, 0, 1366, 768, 0x0040) | Out-Null
[Win]::ShowWindow($h, 3) | Out-Null
[Win]::BringWindowToTop($h) | Out-Null
[Win]::SetForegroundWindow($h) | Out-Null
Write-Output "done"
