$src = @"
using System;
using System.Runtime.InteropServices;
public class Win {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int n);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
}
"@
Add-Type -TypeDefinition $src -ErrorAction SilentlyContinue
$h = (Get-Process -Id 6324).MainWindowHandle
$TOPMOST = New-Object IntPtr(-1)
$NOTOPMOST = New-Object IntPtr(-2)
[Win]::SetWindowPos($h, $TOPMOST, 0, 0, 1366, 768, 0x0040) | Out-Null
Start-Sleep -Milliseconds 300
[Win]::SetWindowPos($h, $NOTOPMOST, 0, 0, 1366, 768, 0x0040) | Out-Null
[Win]::ShowWindow($h, 3) | Out-Null
[Win]::SetForegroundWindow($h) | Out-Null
Write-Output "done"
