// notification.js - visible desktop notifications + audio beep, per platform.
//
// PLATFORM BRANCHING IS THE POINT OF THIS FILE (darwin port 2026-08-29, lane W1).
// Before this port there was exactly ONE execution path, spawnSync('powershell'),
// and the Mac has been the canonical host since 2026-06-08. powershell and pwsh
// are both absent here, so every wake toast for ~81 days spawned a binary that
// does not exist. It did not throw loudly: spawnSync with a missing binary
// returns status:null and an EMPTY stderr, so the old return value was
// {ok:false, burntErr:'', balloonErr:''} - a failure carrying no reason, which
// is the same thing as no signal at all. Every reason is now captured.
//
// win32 toast order (unchanged):
//   1. BurntToast PowerShell module (if installed) - modern toast
//   2. System.Windows.Forms.NotifyIcon balloon - legacy but ALWAYS visible
//      regardless of appId registration (Win10/11 silently drops toasts
//      from unregistered appIds; the balloon path bypasses that).
//   3. (beep) [console]::beep - audio only, no UI
//
// darwin toast: osascript `display notification`. TWO host conditions can
// suppress the banner while osascript still exits 0, and both are probed and
// REPORTED rather than assumed away, because a toast that returns ok:true and
// shows nothing is the exact failure this port exists to end:
//   - a live Do Not Disturb / Focus assertion (measured active on this host
//     since 2026-08-24T23:01:11Z), which suppresses the banner and routes the
//     notification to Notification Centre silently;
//   - no notification authorisation for the posting bundle (Script Editor has
//     no entry in com.apple.ncprefs on this host, i.e. never registered).
// Under either, toast returns ok:false with a named reason. delivered_to_centre
// says the notification was still filed, so the distinction between "suppressed"
// and "never posted" survives.
//
// darwin flash_window: there is NO honest equivalent of Win32 FlashWindowEx.
// NSApplication.requestUserAttention can only be called by a process for its own
// dock icon, and the agent is a headless node process with no dock presence, so
// nothing here can bounce VS Code's icon. This refuses explicitly instead of
// returning a no-op ok. The real Mac attention tier is a chat-inject turn
// (tools/chat-inject.injectTurn), wired in coord.js wakeConductor, not here.

const { spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const IS_WIN = process.platform === 'win32'
const IS_MAC = process.platform === 'darwin'

// ── win32 execution ──────────────────────────────────────────────────────

function runPs(script, timeoutMs) {
  timeoutMs = timeoutMs || 8000
  const r = spawnSync('powershell', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    creationFlags: 0x08000000,
  })
  // r.error is where a MISSING BINARY lands (code ENOENT). It never reaches
  // stderr, which is why the pre-port failure was reasonless. Surface it.
  return {
    exitCode: r.status,
    stdout: (r.stdout || ''),
    stderr: (r.stderr || ''),
    spawnError: r.error ? (r.error.code || r.error.message) : null,
  }
}

// Escape single quotes for embedding in a PowerShell single-quoted string.
function psQuote(s) { return String(s).replace(/'/g, "''") }

// ── darwin execution ─────────────────────────────────────────────────────

// runOsa(lines, args) - run an AppleScript whose text is FIXED and whose data
// arrives through argv. Nothing user-supplied is ever concatenated into the
// script source, so quote/backslash escaping is not a class of bug that can
// exist here. `on run argv` is the AppleScript entry point osascript passes
// trailing arguments to.
function runOsa(lines, args, timeoutMs) {
  const argv = []
  for (const l of lines) { argv.push('-e', l) }
  for (const a of (args || [])) { argv.push(String(a)) }
  const r = spawnSync('osascript', argv, {
    encoding: 'utf8',
    timeout: timeoutMs || 8000,
  })
  return {
    exitCode: r.status,
    stdout: (r.stdout || ''),
    stderr: (r.stderr || ''),
    spawnError: r.error ? (r.error.code || r.error.message) : null,
  }
}

// focusState() -> {active, mode, since, source}. Reads the Do Not Disturb store
// directly. An assertion is LIVE when its UUID appears in storeAssertionRecords
// and NOT in storeInvalidationRecords; macOS leaves both lists in place, so
// presence in the assert list alone is not enough to call DND on.
// Unreadable store is reported as unknown, never as "off" - guessing "off" here
// would re-create the false green this whole file is fixing.
function focusState() {
  const p = path.join(os.homedir(), 'Library', 'DoNotDisturb', 'DB', 'Assertions.json')
  let raw
  try { raw = fs.readFileSync(p, 'utf8') } catch (e) {
    return { active: null, reason: 'assertions_unreadable', error: e.code || e.message }
  }
  let doc
  try { doc = JSON.parse(raw) } catch (e) {
    return { active: null, reason: 'assertions_unparseable' }
  }
  const invalidated = new Set()
  const live = []
  for (const blk of (doc.data || [])) {
    for (const r of (blk.storeInvalidationRecords || [])) {
      const u = r && r.invalidationAssertion && r.invalidationAssertion.assertionUUID
      if (u) invalidated.add(u)
    }
  }
  for (const blk of (doc.data || [])) {
    for (const r of (blk.storeAssertionRecords || [])) {
      if (!r || !r.assertionUUID) continue
      if (invalidated.has(r.assertionUUID)) continue
      const d = r.assertionDetails || {}
      live.push({
        mode: d.assertionDetailsModeIdentifier || null,
        source: d.assertionDetailsIdentifier || null,
        // Apple absolute time: seconds since 2001-01-01T00:00:00Z.
        since: Number.isFinite(r.assertionStartDateTimestamp)
          ? new Date((r.assertionStartDateTimestamp + 978307200) * 1000).toISOString()
          : null,
      })
    }
  }
  if (!live.length) return { active: false }
  return { active: true, mode: live[0].mode, source: live[0].source, since: live[0].since, count: live.length }
}

// notificationAuthorised(bundleId) -> {registered, reason}. A bundle with NO row
// in com.apple.ncprefs has never been granted (or even asked for) notification
// authorisation, so anything it posts is dropped by the notification daemon
// while the posting process still exits 0. `defaults` is the only stable reader
// of that plist; a read failure is reported as unknown rather than as granted.
function notificationAuthorised(bundleId) {
  const r = spawnSync('defaults', ['read', 'com.apple.ncprefs', 'apps'], { encoding: 'utf8', timeout: 4000 })
  if (r.error || r.status !== 0) {
    return { registered: null, reason: 'ncprefs_unreadable', error: r.error ? (r.error.code || r.error.message) : ('exit ' + r.status) }
  }
  const found = (r.stdout || '').indexOf('"' + bundleId + '"') !== -1
  return { registered: found, reason: found ? null : 'bundle_not_registered', bundle_id: bundleId }
}

// osascript posts under Script Editor's identity. macOS 13+ uses ScriptEditor.id
// for scripts saved as apps and com.apple.ScriptEditor2 for the editor itself;
// a plain `osascript -e` posts as the latter. Both are checked so a host that
// registered either reads as authorised.
const OSA_NOTIFY_BUNDLES = ['com.apple.ScriptEditor2', 'com.apple.ScriptEditor']

let _osaAuthCache = null
function osaNotifyAuth() {
  if (_osaAuthCache) return _osaAuthCache
  let last = null
  for (const b of OSA_NOTIFY_BUNDLES) {
    const r = notificationAuthorised(b)
    if (r.registered === true) { _osaAuthCache = r; return r }
    last = r
  }
  _osaAuthCache = last || { registered: null, reason: 'no_bundle_checked' }
  return _osaAuthCache
}

// ── notification.toast ───────────────────────────────────────────────────

async function toast(params) {
  params = params || {}
  const durationMs = Math.max(1500, Math.min(params.durationMs || 5000, 15000))
  if (IS_MAC) return toastDarwin(params, durationMs)
  if (IS_WIN) return toastWin32(params, durationMs)
  return {
    ok: false,
    unsupported_on_platform: process.platform,
    reason: 'no_toast_path_for_platform',
    title: params.title,
    body: params.body,
  }
}

async function toastDarwin(params, durationMs) {
  const title = String(params.title || 'EcodiaOS')
  const body = String(params.body || '')
  // Fixed script text, data via argv. No escaping surface at all.
  const r = runOsa([
    'on run argv',
    'display notification (item 2 of argv) with title (item 1 of argv)',
    'end run',
  ], [title, body], 6000)

  if (r.spawnError) {
    return { ok: false, mechanism: 'osascript', reason: 'spawn_failed', spawn_error: r.spawnError, title: title, body: body }
  }
  if (r.exitCode !== 0) {
    return { ok: false, mechanism: 'osascript', reason: 'osascript_nonzero', exit_code: r.exitCode, stderr: r.stderr.slice(0, 300), title: title, body: body }
  }

  // osascript exited 0. That means the notification was POSTED. It does NOT
  // mean a human saw a banner, and the two host conditions below are the
  // difference. Reporting ok:true here regardless is precisely the lie the
  // win32-only path told for 81 days, so both are probed every call.
  const focus = focusState()
  const auth = osaNotifyAuth()
  const suppressed = []
  if (focus.active === true) suppressed.push('focus_' + (focus.mode || 'active'))
  if (auth.registered === false) suppressed.push('bundle_not_registered')

  if (suppressed.length) {
    return {
      ok: false,
      mechanism: 'osascript',
      reason: 'posted_but_suppressed',
      suppressed_by: suppressed,
      // The notification is still filed in Notification Centre; it just does not
      // interrupt. A wake that only lands in a list nobody is looking at is not
      // a wake, so ok stays false, but the distinction is preserved.
      delivered_to_centre: true,
      focus: focus,
      notification_auth: auth,
      title: title,
      body: body,
      durationMs: durationMs,
    }
  }

  return {
    ok: true,
    mechanism: 'osascript',
    // Banner visibility is not directly observable from here; what IS observable
    // is that nothing known suppresses it. Say which.
    verified: 'posted_no_known_suppressor',
    focus: focus,
    notification_auth: auth,
    title: title,
    body: body,
    durationMs: durationMs,
  }
}

// notification.toast - show a visible Windows notification.
// Tries BurntToast first, falls back to NotifyIcon system-tray balloon.
async function toastWin32(params, durationMs) {
  const title = psQuote(params.title || 'EcodiaOS')
  const body = psQuote(params.body || '')

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

  return {
    ok: false,
    mechanism_attempts: ['BurntToast', 'NotifyIcon-balloon'],
    // spawn_error is the field that would have named this dead on day one.
    spawn_error: burntR.spawnError || balloonR.spawnError || null,
    reason: (burntR.spawnError || balloonR.spawnError) ? 'spawn_failed' : 'both_paths_failed',
    burntErr: burntR.stderr.slice(0, 200),
    balloonErr: balloonR.stderr.slice(0, 200),
  }
}

// ── notification.beep ────────────────────────────────────────────────────

// Audio, not UI. Unlike a banner this is NOT suppressed by Focus, so on a
// Do-Not-Disturb host it is the only tier in this file that still reaches a
// human in the room.
async function beep(params) {
  params = params || {}
  const freq = Math.max(37, Math.min(params.frequency || 800, 32767))
  const dur = Math.max(50, Math.min(params.durationMs || 200, 5000))
  if (IS_MAC) {
    const sound = params.sound || '/System/Library/Sounds/Ping.aiff'
    const r = spawnSync('afplay', [sound], { encoding: 'utf8', timeout: 6000 })
    if (r.error) return { ok: false, mechanism: 'afplay', reason: 'spawn_failed', spawn_error: r.error.code || r.error.message, sound: sound }
    return { ok: r.status === 0, mechanism: 'afplay', sound: sound, exit_code: r.status }
  }
  if (IS_WIN) {
    const r = runPs('[console]::beep(' + freq + ', ' + dur + ')', dur + 2000)
    if (r.spawnError) return { ok: false, mechanism: 'console-beep', reason: 'spawn_failed', spawn_error: r.spawnError }
    return { ok: r.exitCode === 0, mechanism: 'console-beep', frequency: freq, durationMs: dur }
  }
  return { ok: false, unsupported_on_platform: process.platform, reason: 'no_beep_path_for_platform' }
}

// ── notification.flash_window ────────────────────────────────────────────

// Flash a window's taskbar icon (visible attention grabber) without needing the
// notification system at all. Idempotent + non-intrusive. WIN32 ONLY: see the
// header note on why macOS has no honest equivalent reachable from here.
async function flashWindow(params) {
  params = params || {}
  if (!IS_WIN) {
    return {
      ok: false,
      unsupported_on_platform: process.platform,
      reason: process.platform === 'darwin'
        ? 'no_flashwindowex_equivalent_on_darwin'
        : 'no_flash_path_for_platform',
      // Point the caller at what DOES work here, so this refusal is a routing
      // instruction and not a dead end.
      alternative: process.platform === 'darwin' ? 'tools/chat-inject.injectTurn' : null,
      target: params.titleContains || '(foreground)',
    }
  }
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
  if (r.spawnError) return { ok: false, reason: 'spawn_failed', spawn_error: r.spawnError, target: params.titleContains || '(foreground)' }
  return { ok: r.stdout.indexOf('FLASHED') !== -1, target: params.titleContains || '(foreground)', count: count }
}

// ── capability report ────────────────────────────────────────────────────

// notification.capability() -> what this host can ACTUALLY do, without firing
// anything. This is what the spawn-failure canary reads: a wake path whose
// binary is missing, or whose banner is suppressed, reads as dead here BEFORE
// anyone waits 81 days for a toast that never arrives.
function capability() {
  const out = {
    platform: process.platform,
    checked_at: new Date().toISOString(),
    toast: { ok: false, mechanism: null, reason: 'unknown' },
    beep: { ok: false, mechanism: null, reason: 'unknown' },
    flash_window: { ok: false, mechanism: null, reason: 'unknown' },
  }
  if (IS_WIN) {
    const ps = spawnSync('powershell', ['-NoProfile', '-Command', 'exit 0'], { encoding: 'utf8', timeout: 6000 })
    const psOk = !ps.error && ps.status === 0
    const reason = ps.error ? ('spawn_failed:' + (ps.error.code || ps.error.message)) : (psOk ? null : 'powershell_nonzero')
    out.toast = { ok: psOk, mechanism: 'powershell', reason: reason }
    out.beep = { ok: psOk, mechanism: 'powershell', reason: reason }
    out.flash_window = { ok: psOk, mechanism: 'powershell', reason: reason }
    return out
  }
  if (IS_MAC) {
    const osa = spawnSync('osascript', ['-e', 'return 1'], { encoding: 'utf8', timeout: 6000 })
    const osaOk = !osa.error && osa.status === 0
    const focus = focusState()
    const auth = osaNotifyAuth()
    const suppressed = []
    if (focus.active === true) suppressed.push('focus_' + (focus.mode || 'active'))
    if (auth.registered === false) suppressed.push('bundle_not_registered')
    out.toast = {
      ok: osaOk && suppressed.length === 0,
      mechanism: 'osascript',
      reason: !osaOk
        ? (osa.error ? ('spawn_failed:' + (osa.error.code || osa.error.message)) : 'osascript_nonzero')
        : (suppressed.length ? 'posted_but_suppressed' : null),
      suppressed_by: suppressed.length ? suppressed : null,
      focus: focus,
      notification_auth: auth,
    }
    const af = spawnSync('command', ['-v', 'afplay'], { encoding: 'utf8', timeout: 3000, shell: true })
    out.beep = { ok: !af.error && af.status === 0, mechanism: 'afplay', reason: (af.error || af.status !== 0) ? 'afplay_missing' : null }
    out.flash_window = { ok: false, mechanism: null, reason: 'no_flashwindowex_equivalent_on_darwin', alternative: 'tools/chat-inject.injectTurn' }
    return out
  }
  const r = { ok: false, mechanism: null, reason: 'no_path_for_platform:' + process.platform }
  out.toast = r; out.beep = r; out.flash_window = r
  return out
}

module.exports = {
  toast: toast,
  beep: beep,
  flash_window: flashWindow,
  capability: capability,
  // exported for the canary + tests; not part of the tool surface
  _focusState: focusState,
  _notificationAuthorised: notificationAuthorised,
}
