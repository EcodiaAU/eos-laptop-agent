# eos-laptop-agent PS daemon host
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
    [Console]::Out.WriteLine('{"id":null,"ok":false,"error":"bad json: ' + $_.Exception.Message.Replace('"','\"') + '"}')
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
        $stderr = ($errMsgs -join "` + 'n')
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
