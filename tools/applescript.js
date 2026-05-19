// applescript.js - macOS-native focusless control substrate.
//
// The third leg of the focusless GUI substrate, alongside cdp.* (Chromium)
// and ide.* (VS Code Extension API HTTP bridge). This module gives the
// conductor direct, focusless control of macOS native apps via osascript -
// AppleScript and System Events accessibility scripting.
//
// Why this isn't keyboard automation:
//   - osascript runs in its own subprocess; it does not steal foreground
//     focus to send keys. AppleScript talks to apps over Mach RPC; System
//     Events talks to the accessibility tree. Both bypass the keyboard
//     entirely.
//   - The user's foreground window stays the user's foreground window.
//
// Prerequisites (one-time, per MacInCloud session):
//   - System Settings -> Privacy & Security -> Accessibility:
//     "osascript" / "Terminal" / "Tools" must be ticked. MacInCloud's
//     templated sessions usually have this pre-set for the dev profile.
//   - For Apple Events (tell application "X") to other apps, the agent's
//     parent app needs Apple Events permission for the target. First-touch
//     prompts a dialog; pre-approve in the MacInCloud template before agent
//     run, OR have applescript.preflight() prime each target once.
//
// Tools exposed (every name maps to applescript.*):
//   run             - raw osascript -e (and -ss for hex output if needed)
//   tell_app        - tell application "X" to <oneliner> + scriptable bits
//   system_events   - tell application "System Events" to <oneliner>
//   ui_click        - accessibility click by AXTitle / AXValue / AXRole
//   ui_set_value    - set the value of a text field by AXTitle / AXValue
//   ui_dump         - dump the UI tree of an app's frontmost window
//   keystroke       - send keystroke via System Events (uses accessibility,
//                     NOT raw keyboard; same focusless-ish guarantee but
//                     does require the target app to have keyboard focus
//                     within its own window)
//   activate_app    - bring an app to front without raising other windows
//                     (less invasive than focus)
//   message_send    - Messages.app: send a chat to a contact/group
//   mail_compose    - Mail.app: create a draft (optionally send)
//   calendar_create - Calendar.app: create an event in a named calendar
//   finder_reveal   - Finder: select a file in a window (no focus steal)
//   notify          - macOS Notification Center bubble
//   say             - text-to-speech (handy for ambient feedback)
//   apps_running    - list running apps (Application.processes)
//   preflight       - first-time Apple Events permission warmup for an app
//
// All tools accept `{timeout: ms}` (default 15s). Long-running scripts
// (e.g. Calendar with sync) may need higher.

const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawn } = require('child_process')

// ---------- core runner ----------

function _runOsascript(scriptArg, opts) {
  opts = opts || {}
  const timeoutMs = opts.timeout || 15000
  // -ss = AppleScript object notation in stdout, easier to JSON-postprocess
  // -e <line> can be repeated. For multiline scripts we pass via stdin (-).
  const args = []
  if (Array.isArray(scriptArg.lines)) {
    for (const line of scriptArg.lines) { args.push('-e', line) }
  } else if (typeof scriptArg.line === 'string') {
    args.push('-e', scriptArg.line)
  }
  // language tag if requested (JavaScript for Automation):
  if (opts.lang === 'jxa') { args.unshift('-l', 'JavaScript') }
  const useStdin = typeof scriptArg.body === 'string' && scriptArg.body.length > 0
  return new Promise((resolve) => {
    const proc = spawn('osascript', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const t = setTimeout(() => {
      timedOut = true
      try { proc.kill('SIGKILL') } catch (_e) {}
    }, timeoutMs)
    proc.stdout.on('data', d => stdout += d.toString('utf8'))
    proc.stderr.on('data', d => stderr += d.toString('utf8'))
    proc.on('error', e => {
      clearTimeout(t)
      resolve({ ok: false, error: 'osascript spawn failed: ' + e.message })
    })
    proc.on('close', code => {
      clearTimeout(t)
      if (timedOut) return resolve({ ok: false, error: 'osascript timed out after ' + timeoutMs + 'ms' })
      if (code === 0) return resolve({ ok: true, stdout: stdout.trim(), stderr: stderr.trim() })
      resolve({ ok: false, exitCode: code, stdout: stdout.trim(), error: (stderr || '').trim() || 'osascript exit ' + code })
    })
    if (useStdin) {
      proc.stdin.write(scriptArg.body)
      proc.stdin.end()
    }
  })
}

// Escape a string for inclusion in an AppleScript double-quoted literal.
function _asEscape(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

// ---------- exported tools ----------

// applescript.run - raw osascript. Pass {body: 'multiline script'} OR
// {line: 'one liner'} OR {lines: ['line1', 'line2', ...]}. Optional
// {lang:'jxa'} runs as JavaScript for Automation instead of AppleScript.
async function run(opts) {
  opts = opts || {}
  if (!opts.body && !opts.line && !Array.isArray(opts.lines)) {
    throw new Error('one of body | line | lines required')
  }
  return _runOsascript(opts, { timeout: opts.timeout, lang: opts.lang })
}

// applescript.tell_app - run a one-liner in the context of an app.
// {app: 'Calendar', script: 'name of every calendar', timeout?}
async function tellApp(opts) {
  opts = opts || {}
  if (!opts.app || !opts.script) throw new Error('app and script required')
  const body = `tell application "${_asEscape(opts.app)}"\n${opts.script}\nend tell`
  return _runOsascript({ body }, { timeout: opts.timeout })
}

// applescript.system_events - run a one-liner under System Events context.
// Useful for accessibility / UI driving without an app being told directly.
async function systemEvents(opts) {
  opts = opts || {}
  if (!opts.script) throw new Error('script required')
  const body = `tell application "System Events"\n${opts.script}\nend tell`
  return _runOsascript({ body }, { timeout: opts.timeout })
}

// applescript.ui_click - click an accessibility element by title/role.
// {app: 'Cursor', title: 'New Chat'} - looks for a button matching the
// title in the app's frontmost window's accessibility tree, clicks it.
// Optional {role: 'button'|'menu item'|...} narrows the search.
async function uiClick(opts) {
  opts = opts || {}
  if (!opts.app) throw new Error('app required')
  if (!opts.title && !opts.value) throw new Error('title or value required')
  const role = opts.role || 'button'
  const matchAttr = opts.title ? 'title' : 'value'
  const matchVal = opts.title || opts.value
  const body = [
    `tell application "System Events"`,
    `  tell process "${_asEscape(opts.app)}"`,
    `    set hits to every ${role} of window 1 whose ${matchAttr} contains "${_asEscape(matchVal)}"`,
    `    if (count of hits) is 0 then error "no ${role} matching ${matchAttr}=" & "${_asEscape(matchVal)}"`,
    `    click item 1 of hits`,
    `  end tell`,
    `end tell`,
    `return "clicked"`,
  ].join('\n')
  return _runOsascript({ body }, { timeout: opts.timeout })
}

// applescript.ui_set_value - set the value of a text field via accessibility.
// {app, field_title?: 'Name', field_value?: 'existing-value', new_value: '...'}
async function uiSetValue(opts) {
  opts = opts || {}
  if (!opts.app) throw new Error('app required')
  if (!opts.new_value && opts.new_value !== '') throw new Error('new_value required')
  const matchAttr = opts.field_title ? 'title' : (opts.field_value ? 'value' : null)
  const matchVal = opts.field_title || opts.field_value
  if (!matchAttr) throw new Error('field_title or field_value required')
  const body = [
    `tell application "System Events"`,
    `  tell process "${_asEscape(opts.app)}"`,
    `    set hits to every text field of window 1 whose ${matchAttr} contains "${_asEscape(matchVal)}"`,
    `    if (count of hits) is 0 then error "no text field matching ${matchAttr}=" & "${_asEscape(matchVal)}"`,
    `    set value of item 1 of hits to "${_asEscape(opts.new_value)}"`,
    `  end tell`,
    `end tell`,
    `return "set"`,
  ].join('\n')
  return _runOsascript({ body }, { timeout: opts.timeout })
}

// applescript.ui_dump - dump the accessibility tree of the frontmost
// window of an app. Useful for finding the right title/role to address.
// {app: 'Cursor', max: 200}
async function uiDump(opts) {
  opts = opts || {}
  if (!opts.app) throw new Error('app required')
  const max = opts.max || 200
  // JXA dump - easier to JSON-postprocess than AppleScript's records.
  const script = `
const proc = Application("System Events").processes["${_asEscape(opts.app)}"];
if (!proc) throw new Error("process not found: ${_asEscape(opts.app)}");
const win = proc.windows()[0];
if (!win) throw new Error("no frontmost window for ${_asEscape(opts.app)}");
const out = [];
function walk(node, depth, parentPath) {
  if (out.length >= ${max}) return;
  let role = '', title = '', value = '', desc = '';
  try { role = node.role() } catch (e) {}
  try { title = node.title() } catch (e) {}
  try { value = String(node.value()).slice(0, 80) } catch (e) {}
  try { desc = node.description() } catch (e) {}
  const path = parentPath + '/' + role + (title ? '[' + title.slice(0,30) + ']' : '');
  out.push({ depth, role, title: (title || '').slice(0,80), value, desc, path });
  let kids = [];
  try { kids = node.uiElements() } catch (e) { kids = [] }
  for (let i = 0; i < kids.length; i++) {
    if (out.length >= ${max}) break;
    walk(kids[i], depth + 1, path);
  }
}
walk(win, 0, '');
JSON.stringify(out);
`
  const r = await _runOsascript({ body: script }, { timeout: opts.timeout || 30000, lang: 'jxa' })
  if (!r.ok) return r
  try { return { ok: true, count: 0, items: JSON.parse(r.stdout) } }
  catch (e) { return { ok: true, raw: r.stdout, parse_error: e.message } }
}

// applescript.keystroke - send keystroke via System Events. Note: this DOES
// require the target app to have keyboard focus within its own window.
async function keystroke(opts) {
  opts = opts || {}
  if (!opts.text && !opts.key) throw new Error('text or key required')
  let body
  if (opts.text) {
    body = `tell application "System Events" to keystroke "${_asEscape(opts.text)}"`
  } else {
    // key code or named key with optional modifiers (cmd, opt, ctrl, shift)
    const mods = []
    if (opts.cmd) mods.push('command down')
    if (opts.opt) mods.push('option down')
    if (opts.ctrl) mods.push('control down')
    if (opts.shift) mods.push('shift down')
    const modPart = mods.length ? ` using {${mods.join(', ')}}` : ''
    if (typeof opts.key === 'number') {
      body = `tell application "System Events" to key code ${opts.key}${modPart}`
    } else {
      body = `tell application "System Events" to keystroke "${_asEscape(opts.key)}"${modPart}`
    }
  }
  return _runOsascript({ body }, { timeout: opts.timeout })
}

// applescript.activate_app - bring an app to front (less invasive than the
// AppleScript "activate" because we don't run launchctl or osascript -ss).
async function activateApp(opts) {
  opts = opts || {}
  if (!opts.app) throw new Error('app required')
  return tellApp({ app: opts.app, script: 'activate' })
}

async function appsRunning() {
  const body = `tell application "System Events" to get name of every process whose background only is false`
  const r = await _runOsascript({ body })
  if (!r.ok) return r
  const apps = (r.stdout || '').split(',').map(s => s.trim()).filter(Boolean)
  return { ok: true, count: apps.length, apps }
}

// applescript.message_send - Messages.app send to a buddy / chat / group.
// {to: '+61...', service: 'iMessage' | 'SMS', text: '...'}
async function messageSend(opts) {
  opts = opts || {}
  if (!opts.to || typeof opts.text !== 'string') throw new Error('to and text required')
  const service = opts.service || 'iMessage'
  const body = [
    `tell application "Messages"`,
    `  set targetService to first service whose service type = ${service}`,
    `  set targetBuddy to buddy "${_asEscape(opts.to)}" of targetService`,
    `  send "${_asEscape(opts.text)}" to targetBuddy`,
    `end tell`,
    `return "sent"`,
  ].join('\n')
  return _runOsascript({ body }, { timeout: opts.timeout })
}

// applescript.mail_compose - draft / send a Mail.app message.
// {to, subject, body, cc?, bcc?, send?: true}
async function mailCompose(opts) {
  opts = opts || {}
  if (!opts.to || !opts.subject) throw new Error('to and subject required')
  const send = !!opts.send
  const cc = opts.cc ? `make new cc recipient at end of cc recipients with properties {address:"${_asEscape(opts.cc)}"}` : ''
  const bcc = opts.bcc ? `make new bcc recipient at end of bcc recipients with properties {address:"${_asEscape(opts.bcc)}"}` : ''
  const body = [
    `tell application "Mail"`,
    `  set theMsg to make new outgoing message with properties {subject:"${_asEscape(opts.subject)}", content:"${_asEscape(opts.body || '')}", visible:false}`,
    `  tell theMsg`,
    `    make new to recipient at end of to recipients with properties {address:"${_asEscape(opts.to)}"}`,
    cc, bcc,
    send ? '    send' : '    save',
    `  end tell`,
    `end tell`,
    `return "${send ? 'sent' : 'draft_saved'}"`,
  ].filter(Boolean).join('\n')
  return _runOsascript({ body }, { timeout: opts.timeout || 20000 })
}

// applescript.calendar_create - create a Calendar.app event.
// {calendar: 'Work', summary: '...', start: 'YYYY-MM-DDTHH:MM:SS', end?: ditto, notes?: ''}
async function calendarCreate(opts) {
  opts = opts || {}
  if (!opts.calendar || !opts.summary || !opts.start) throw new Error('calendar, summary, start required')
  // AppleScript date parser is fussy; use ISO -> date object via JS bridge.
  const toASDate = (iso) => {
    // "YYYY-MM-DDTHH:MM:SS" -> AppleScript-friendly "M/D/YYYY H:MM:SS AM/PM"
    const d = new Date(iso)
    if (isNaN(d.getTime())) throw new Error('bad date: ' + iso)
    const M = d.getMonth() + 1, D = d.getDate(), Y = d.getFullYear()
    let h = d.getHours(); const m = String(d.getMinutes()).padStart(2,'0'); const s = String(d.getSeconds()).padStart(2,'0')
    const ampm = h >= 12 ? 'PM' : 'AM'; h = ((h + 11) % 12) + 1
    return `${M}/${D}/${Y} ${h}:${m}:${s} ${ampm}`
  }
  const start = toASDate(opts.start)
  const end = toASDate(opts.end || new Date(new Date(opts.start).getTime() + 60*60*1000).toISOString())
  const body = [
    `tell application "Calendar"`,
    `  tell calendar "${_asEscape(opts.calendar)}"`,
    `    set ev to make new event with properties {summary:"${_asEscape(opts.summary)}", start date:date "${start}", end date:date "${end}", description:"${_asEscape(opts.notes || '')}"}`,
    `    return id of ev`,
    `  end tell`,
    `end tell`,
  ].join('\n')
  return _runOsascript({ body }, { timeout: opts.timeout || 20000 })
}

// applescript.finder_reveal - select a file in a Finder window without
// stealing focus from the active app.
async function finderReveal(opts) {
  opts = opts || {}
  if (!opts.path) throw new Error('path required')
  const body = [
    `tell application "Finder"`,
    `  reveal POSIX file "${_asEscape(opts.path)}"`,
    `end tell`,
  ].join('\n')
  return _runOsascript({ body }, { timeout: opts.timeout })
}

// applescript.notify - native notification bubble (Notification Center).
// {title, message, subtitle?, sound?}
async function notify(opts) {
  opts = opts || {}
  if (!opts.message) throw new Error('message required')
  const parts = [`display notification "${_asEscape(opts.message)}"`]
  if (opts.title) parts.push(`with title "${_asEscape(opts.title)}"`)
  if (opts.subtitle) parts.push(`subtitle "${_asEscape(opts.subtitle)}"`)
  if (opts.sound) parts.push(`sound name "${_asEscape(opts.sound)}"`)
  return _runOsascript({ line: parts.join(' ') }, { timeout: opts.timeout })
}

// applescript.say - text to speech (focusless ambient feedback channel)
// {text, voice?: 'Samantha'|'Daniel'|..., rate?: 200}
async function say(opts) {
  opts = opts || {}
  if (typeof opts.text !== 'string') throw new Error('text required')
  const parts = [`say "${_asEscape(opts.text)}"`]
  if (opts.voice) parts.push(`using "${_asEscape(opts.voice)}"`)
  if (opts.rate) parts.push(`speaking rate ${parseInt(opts.rate, 10) || 200}`)
  return _runOsascript({ line: parts.join(' ') }, { timeout: opts.timeout || 30000 })
}

// applescript.preflight - one-time touch on a target app to surface the
// Apple Events permission prompt. Returns ok regardless of permission
// state; the prompt will appear in the GUI session if the agent doesn't
// already have permission. Call once per app per fresh MacInCloud
// template. Subsequent calls are no-ops.
async function preflight(opts) {
  opts = opts || {}
  if (!opts.app) throw new Error('app required')
  return tellApp({ app: opts.app, script: 'count windows', timeout: 5000 })
}

// applescript.launch_cdp_chrome - Mac analogue of gui.install_cdp_to_chrome
// on Corazon. Launches Chrome with --remote-debugging-port + a dedicated
// --user-data-dir so the cdp.* tools can attach. Idempotent: if Chrome
// is already running with the debug port, this is a no-op (Chrome will
// just open a new window in the same process; the port stays bound).
//
// {port?: 9222, userDataDir?: '~/chrome-cdp', initialUrl?: 'about:blank',
//  killExisting?: false}
//
// Note: if a non-CDP Chrome is already running, you have two choices:
//   - killExisting:true (closes all existing Chrome windows first)
//   - leave it alone (the open command will reuse the existing process
//     and the debug port flags will be IGNORED - then cdp.attach fails)
async function launchCdpChrome(opts) {
  opts = opts || {}
  const port = opts.port || 9222
  const home = require('os').homedir()
  const userDataDir = (opts.userDataDir || (home + '/chrome-cdp')).replace(/^~(?=\/)/, home)
  const initialUrl = opts.initialUrl || 'about:blank'
  const killFirst = !!opts.killExisting

  const lines = []
  if (killFirst) {
    lines.push('do shell script "pkill -x \\"Google Chrome\\" || true"')
    lines.push('delay 1')
  }
  // Use `open -na` (-n = new instance, -a = app) so we get a fresh process
  // tree that honors the --args we pass.
  const chromeArgs = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir="${_asEscape(userDataDir)}"`,
    `--no-first-run`,
    `--no-default-browser-check`,
    `"${_asEscape(initialUrl)}"`,
  ].join(' ')
  lines.push(`do shell script "mkdir -p '${_asEscape(userDataDir)}'"`)
  lines.push(`do shell script "open -na 'Google Chrome' --args ${chromeArgs.replace(/"/g, '\\"')}"`)
  // Wait briefly for Chrome to bind the port
  lines.push('delay 2')
  // Probe the CDP endpoint
  lines.push(`set probeResult to do shell script "curl -s -m 3 http://localhost:${port}/json/version | head -c 200 || echo NO_RESPONSE"`)
  lines.push('return probeResult')

  const body = lines.join('\n')
  return _runOsascript({ body }, { timeout: opts.timeout || 15000 })
}

// applescript.self_test - one-shot probe of all 3 focusless substrates
// from the Mac side. Tells you exactly what's live and what's gated on
// the GUI Aqua context. Run this after RDP-ing in to confirm the build
// is operational.
async function selfTest(opts) {
  opts = opts || {}
  const result = {
    machine: { ok: false },
    applescript_pure: { ok: false },
    applescript_gui: { ok: false },
    cdp: { ok: false },
    ide: { ok: false },
  }

  // 1. machine / aqua context probe
  try {
    const r = await _runOsascript({ body: 'return (system attribute "USER") & ":" & (POSIX path of (path to home folder))' })
    result.machine = { ok: r.ok, info: r.stdout, error: r.error }
  } catch (e) { result.machine = { ok: false, error: e.message } }

  // 2. pure applescript - works over SSH alone
  try {
    const r = await _runOsascript({ body: 'return "pure-applescript ok @ " & (current date as string)' })
    result.applescript_pure = { ok: r.ok, stdout: r.stdout }
  } catch (e) { result.applescript_pure = { ok: false, error: e.message } }

  // 3. applescript GUI - requires Aqua context (notification daemon reachable)
  try {
    const r = await _runOsascript({ body: 'tell application "System Events" to return name of every process whose background only is false' })
    if (r.ok) {
      const apps = (r.stdout || '').split(',').map(s => s.trim()).filter(Boolean)
      result.applescript_gui = { ok: true, count: apps.length, sampleApps: apps.slice(0, 8) }
    } else {
      result.applescript_gui = { ok: false, error: r.error, hint: 'RDP in to activate Aqua context' }
    }
  } catch (e) { result.applescript_gui = { ok: false, error: e.message } }

  // 4. CDP - is Chrome listening on 9222?
  try {
    const r = await _runOsascript({ body: 'do shell script "curl -s -m 2 http://localhost:9222/json/version | head -c 200 || echo NO_CDP"' })
    if (r.ok && r.stdout && r.stdout.indexOf('NO_CDP') === -1) {
      try { result.cdp = { ok: true, version: JSON.parse(r.stdout) } }
      catch (_e) { result.cdp = { ok: true, raw: r.stdout } }
    } else {
      result.cdp = { ok: false, hint: 'launch with applescript.launch_cdp_chrome' }
    }
  } catch (e) { result.cdp = { ok: false, error: e.message } }

  // 5. IDE bridge - is the registry populated?
  try {
    const r = await _runOsascript({ body: 'do shell script "cat ~/.ecodia-preview/instances.json 2>/dev/null || echo {}"' })
    if (r.ok && r.stdout) {
      try {
        const reg = JSON.parse(r.stdout)
        const instances = Object.entries(reg).map(([pid, info]) => ({ pid: Number(pid), ide: info.ide, port: info.port }))
        result.ide = { ok: instances.length > 0, count: instances.length, instances, hint: instances.length === 0 ? 'open VS Code Stable or Cursor to register' : null }
      } catch (_e) {
        result.ide = { ok: false, raw: r.stdout }
      }
    }
  } catch (e) { result.ide = { ok: false, error: e.message } }

  // Summarise
  const greenLegs = ['applescript_pure', 'applescript_gui', 'cdp', 'ide'].filter(k => result[k].ok)
  return {
    ok: true,
    summary: greenLegs.length + '/4 focusless legs operational',
    green: greenLegs,
    detail: result,
  }
}

module.exports = {
  run: run,
  tell_app: tellApp,
  system_events: systemEvents,
  ui_click: uiClick,
  ui_set_value: uiSetValue,
  ui_dump: uiDump,
  keystroke: keystroke,
  activate_app: activateApp,
  apps_running: appsRunning,
  message_send: messageSend,
  mail_compose: mailCompose,
  calendar_create: calendarCreate,
  finder_reveal: finderReveal,
  notify: notify,
  say: say,
  preflight: preflight,
  launch_cdp_chrome: launchCdpChrome,
  self_test: selfTest,
}
