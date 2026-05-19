// gui.js - batch primitive + semantic helpers for the laptop agent.
//
// LAYER 1 (batch):    gui.sequence collapses N round-trips into 1.
// LAYER 3 (semantic): gui.focus_chrome / gui.open_url / gui.enable_chrome_cdp
//                     compose lower primitives into named, generalisable flows.
//
// Sequence dispatcher accepts: input.*, mouse.*, screenshot.*, cdp.*, gui.*,
// plus pseudo-tool 'wait'. Everything composes - a batched gui.sequence can
// mix a pixel-coord input.click, a semantic gui.open_url, and a DOM-level
// cdp.queryAll in one server-side run, returning structured data + a final
// screenshot in one HTTP response.
//
// Doctrine: gui-batch-primitive-collapses-roundtrips-orthogonal-to-coord-brittleness-2026-05-17
//           drive-chrome-via-input-tools-not-browser-tools
//           chrome-cdp-attach-requires-explicit-user-data-dir-and-singleton-clear

const fs = require('fs')
const path = require('path')
const os = require('os')
const http = require('http')
const { spawnSync, spawn } = require('child_process')

const input = require('./input')
const mouse = require('./mouse')
const screenshot = require('./screenshot')

const AHK = 'C:\\Users\\tjdTa\\AppData\\Local\\Programs\\AutoHotkey\\v2\\AutoHotkey64.exe'

// ----- helpers -----

function runAHK(script, timeoutMs) {
  timeoutMs = timeoutMs || 8000
  const tmp = path.join(os.tmpdir(), 'eos-gui-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.ahk')
  fs.writeFileSync(tmp, '#Requires AutoHotkey v2.0\n' + script + '\nExitApp(0)', 'utf8')
  try {
    const r = spawnSync(AHK, [tmp], { timeout: timeoutMs, encoding: 'utf8', windowsHide: true })
    return { exitCode: r.status, stdout: r.stdout || '', stderr: r.stderr || '' }
  } finally {
    try { fs.unlinkSync(tmp) } catch (e) {}
  }
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function probeChromeCdp(port, timeoutMs) {
  port = port || 9222
  timeoutMs = timeoutMs || 1200
  return new Promise(resolve => {
    const req = http.get({ host: 'localhost', port: port, path: '/json/version', timeout: timeoutMs }, res => {
      let body = ''
      res.on('data', c => body += c)
      res.on('end', () => { try { resolve({ ok: true, version: JSON.parse(body) }) } catch (e) { resolve({ ok: false }) } })
    })
    req.on('error', () => resolve({ ok: false }))
    req.on('timeout', () => { req.destroy(); resolve({ ok: false }) })
  })
}

// ----- pseudo-tool: wait -----

async function pseudoWait(params) {
  const ms = (params && typeof params.ms === 'number') ? params.ms : 1000
  await sleep(Math.max(0, ms))
  return { ok: true, waitedMs: ms }
}

// ----- pseudo-tool: wait_for -----
// Blocks until a condition becomes true, or returns {timed_out:true} after
// timeout_ms. This is the "wait UNTIL X" primitive that turns a flat gui.sequence
// into a real chained flow ("navigate -> wait for ready_state complete -> click").
// Six condition kinds covering the common cases:
//   - cdp_url_contains   {contains: '/dashboard'}
//   - cdp_url_matches    {pattern: '^https://app\\..*'}
//   - cdp_ready_state    {state: 'complete'}                                 (default complete)
//   - cdp_element_visible{selector: 'button.submit'}
//   - cdp_eval_truthy    {script: 'document.querySelector("foo")?.disabled === false'}
//   - file_exists        {path: 'D:/.../done.marker'}
//   - cmd_returns_zero   {cmd: 'curl', args: ['-fsS','http://localhost:7456/api/health'], shell?: false}
//   - foreground_window_matches {exe?: 'Cursor', title_contains?: 'Claude Code', title_matches?: '...'}
//   - coord_inbox_has    {topic: 'chat.conductor.inbox', body_contains?: 'SMOKE_OK'}
// Returns {ok: true, waited_ms, last_value, timed_out: false} on success or
//        {ok: false, waited_ms, last_error, timed_out: true} on timeout
// (unless throw_on_timeout: true, in which case it throws on timeout).
async function pseudoWaitFor(params) {
  params = params || {}
  const until = params.until
  if (!until || typeof until !== 'object') throw new Error('wait_for requires {until: {type, ...}}')
  const timeoutMs = Math.max(50, Math.min(params.timeout_ms || 10000, 600000))
  const pollMs = Math.max(50, Math.min(params.poll_ms || 200, 5000))
  const throwOnTimeout = !!params.throw_on_timeout
  const start = Date.now()
  let lastError = null
  let lastValue = null

  // Multi-condition wait_for: until.any / until.all (audit §3.3)
  // any: returns true when ANY sub-condition is true (race for first wins)
  // all: returns true when ALL sub-conditions are true (gate for ready state)
  // Backward-compat: if until.type is set, single-condition path runs unchanged.
  if (Array.isArray(until.any) || Array.isArray(until.all)) {
    const sub = Array.isArray(until.any) ? until.any : until.all
    const mode = Array.isArray(until.any) ? 'any' : 'all'
    let matched_index = null
    async function multiProbe() {
      const results = []
      for (let i = 0; i < sub.length; i++) {
        const r = await singleProbe(sub[i])
        results.push(r)
        if (mode === 'any' && r) { matched_index = i; return true }
        if (mode === 'all' && !r) return false
      }
      if (mode === 'all') return results.every(Boolean)
      return false
    }
    if (await multiProbe()) {
      return { ok: true, waited_ms: Date.now() - start, condition: mode, matched_index: matched_index, timed_out: false }
    }
    while (Date.now() - start < timeoutMs) {
      await sleep(pollMs)
      if (await multiProbe()) {
        return { ok: true, waited_ms: Date.now() - start, condition: mode, matched_index: matched_index, timed_out: false }
      }
    }
    if (throwOnTimeout) throw new Error('wait_for (' + mode + ') timed out after ' + timeoutMs + 'ms')
    return { ok: false, waited_ms: Date.now() - start, condition: mode, matched_index: matched_index, timed_out: true }
  }

  async function singleProbe(cond) {
    try {
      switch (cond.type) {
        case 'cdp_url_contains':
        case 'cdp_url_matches': {
          const cdp = require('./cdp')
          const r = await cdp.url({})
          const u = (r && (r.url || r.value)) || ''
          lastValue = u
          if (cond.type === 'cdp_url_contains') return u.indexOf(cond.contains || '') !== -1
          return new RegExp(cond.pattern || '.*').test(u)
        }
        case 'cdp_ready_state': {
          const cdp = require('./cdp')
          const r = await cdp.runJs({ script: 'document.readyState' })
          lastValue = r && r.value
          return r && r.value === (cond.state || 'complete')
        }
        case 'cdp_element_visible':
        case 'cdp_element_exists': {
          const cdp = require('./cdp')
          const r = await cdp.queryAll({ selector: cond.selector })
          const count = (r && (r.count || (r.elements && r.elements.length))) || 0
          lastValue = count
          return count > 0
        }
        case 'cdp_eval_truthy': {
          const cdp = require('./cdp')
          const r = await cdp.runJs({ script: cond.script })
          lastValue = r && r.value
          return !!(r && r.value)
        }
        case 'file_exists': {
          lastValue = cond.path
          return fs.existsSync(cond.path)
        }
        case 'cmd_returns_zero': {
          const r = spawnSync(cond.cmd, cond.args || [], { timeout: 5000, encoding: 'utf8', windowsHide: true, shell: !!cond.shell })
          lastValue = r.status
          return r.status === 0
        }
        case 'foreground_window_matches': {
          const win = require('./window')
          const fg = await win.foreground()
          lastValue = fg
          if (cond.exe && fg.exe !== cond.exe) return false
          if (cond.title_contains && (fg.title || '').indexOf(cond.title_contains) === -1) return false
          if (cond.title_matches && !new RegExp(cond.title_matches).test(fg.title || '')) return false
          return true
        }
        case 'coord_inbox_has': {
          const coord = require('./coord')
          // peek_inbox does NOT mark messages seen - safe to poll repeatedly
          // without consuming the message a downstream read_inbox would want.
          const r = await coord.peek_inbox({ topic: cond.topic }, {})
          const msgs = (r && r.messages) || []
          lastValue = msgs.length
          if (msgs.length === 0) return false
          if (!cond.body_contains) return true
          return msgs.some(m => JSON.stringify(m.body || {}).indexOf(cond.body_contains) !== -1)
        }
        default:
          throw new Error('unknown wait_for type: ' + cond.type)
      }
    } catch (e) {
      lastError = e.message
      return false
    }
  }

  // Single-condition path - calls singleProbe with the until object as the condition
  if (await singleProbe(until)) {
    return { ok: true, waited_ms: Date.now() - start, condition: until.type, last_value: lastValue, timed_out: false }
  }
  while (Date.now() - start < timeoutMs) {
    await sleep(pollMs)
    if (await singleProbe(until)) {
      return { ok: true, waited_ms: Date.now() - start, condition: until.type, last_value: lastValue, timed_out: false }
    }
  }
  if (throwOnTimeout) {
    throw new Error('wait_for timed out after ' + timeoutMs + 'ms (last_error: ' + (lastError || 'none') + ')')
  }
  return { ok: false, waited_ms: Date.now() - start, condition: until.type, last_value: lastValue, last_error: lastError, timed_out: true }
}

// ----- pseudo-tool: foreach -----
// Iterate over an array (literal or ${var}-bound), bind each item to a name,
// run a body of actions per item, collect per-iteration results.
// Audit §3.1 - single largest expressive unlock.
//
// Spec: {
//   items: [...] or "${var}",    // literal array OR resolved string from bindings
//   as: "row",                    // bindings[as] = item per iteration
//   index_as?: "i",               // optional: bindings[index_as] = 0,1,2...
//   max_iterations?: 50,          // safety cap (default 100)
//   stopOnError?: false,          // local override of sequence-level
//   body: [<actions>]
// }
//
// Iteration bindings are SCOPED: at iteration end, the as/index_as keys are
// restored to whatever they were before (or deleted if they weren't set).
// This prevents loop variables leaking into outer steps.
async function pseudoForeach(params, parentBindings) {
  params = params || {}
  let items = params.items
  // If items is a string, it's already been substituted by substituteBindings.
  // If it became a JSON-stringified array (object capture), parse it.
  if (typeof items === 'string') {
    try { items = JSON.parse(items) } catch (e) { throw new Error('foreach.items is a string but not JSON-parseable: ' + items.slice(0, 100)) }
  }
  if (!Array.isArray(items)) throw new Error('foreach requires items to be an array (or ${var} that resolves to one)')
  const itemName = params.as || 'item'
  const indexName = params.index_as || null
  const maxIters = Math.min(params.max_iterations || 100, 1000)
  const localStopOnError = params.stopOnError === true  // default false for foreach (different from sequence-level)
  const body = Array.isArray(params.body) ? params.body : []

  const bindings = parentBindings || {}
  const iterations = []
  let completed = 0
  let failed = 0
  const upperLimit = Math.min(items.length, maxIters)

  // Capture pre-iteration values for scoped restore
  const hadItemBinding = Object.prototype.hasOwnProperty.call(bindings, itemName)
  const prevItem = hadItemBinding ? bindings[itemName] : undefined
  const hadIndexBinding = indexName ? Object.prototype.hasOwnProperty.call(bindings, indexName) : false
  const prevIndex = hadIndexBinding ? bindings[indexName] : undefined

  for (let i = 0; i < upperLimit; i++) {
    bindings[itemName] = items[i]
    if (indexName) bindings[indexName] = i
    const iterStart = Date.now()
    const stepResults = []
    let iterFailed = 0
    for (let j = 0; j < body.length; j++) {
      const a = body[j]
      if (!a || typeof a.tool !== 'string') {
        stepResults.push({ j: j, ok: false, error: 'missing tool string' })
        iterFailed++
        if (localStopOnError) break
        continue
      }
      const effParams = substituteBindings(a.params || {}, bindings)
      // Step-level if inside loop body
      if (a.if && typeof a.if === 'object') {
        const probe = await pseudoWaitFor({ until: substituteBindings(a.if, bindings), timeout_ms: a.if_probe_timeout_ms || 1000, poll_ms: 100, throw_on_timeout: false })
        if (!probe.ok) {
          stepResults.push({ j: j, tool: a.tool, ok: true, skipped: true, if_probe: probe })
          continue
        }
      }
      const t0step = Date.now()
      try {
        const result = await runStep(a.tool, effParams)
        const rec = { j: j, tool: a.tool, ok: true, durationMs: Date.now() - t0step }
        if (typeof a.as === 'string' && a.as.length > 0) {
          bindings[a.as] = result
          rec.bound_as = a.as
        }
        stepResults.push(rec)
      } catch (err) {
        stepResults.push({ j: j, tool: a.tool, ok: false, durationMs: Date.now() - t0step, error: err.message })
        iterFailed++
        if (localStopOnError) break
      }
    }
    const iterOk = iterFailed === 0
    if (iterOk) completed++; else failed++
    iterations.push({ i: i, item: items[i], ok: iterOk, durationMs: Date.now() - iterStart, steps: stepResults })
  }

  // Restore iteration bindings to pre-loop state (scoped)
  if (hadItemBinding) bindings[itemName] = prevItem; else delete bindings[itemName]
  if (indexName) {
    if (hadIndexBinding) bindings[indexName] = prevIndex; else delete bindings[indexName]
  }

  return {
    ok: failed === 0,
    iterations: iterations,
    completed: completed,
    failed: failed,
    items_total: items.length,
    items_processed: upperLimit,
  }
}

// ----- pseudo-tool: try (catch / finally) -----
// Body always runs. Catch runs only if body fails. Finally always runs.
// On caught failure, body's error is bound to ${err} inside the catch block.
// Audit §3.2.
async function pseudoTry(params, parentBindings) {
  params = params || {}
  const body = Array.isArray(params.body) ? params.body : []
  const catchSpec = params.catch && typeof params.catch === 'object' ? params.catch : null
  const finallyActions = Array.isArray(params.finally) ? params.finally : []
  const bindings = parentBindings || {}

  async function runBlock(actions, prefix) {
    const results = []
    let blockFailed = false
    let lastError = null
    for (let i = 0; i < actions.length; i++) {
      const a = actions[i]
      if (!a || typeof a.tool !== 'string') {
        results.push({ i: i, ok: false, error: 'missing tool string' })
        blockFailed = true
        break
      }
      const effParams = substituteBindings(a.params || {}, bindings)
      // Step-level if inside try block
      if (a.if && typeof a.if === 'object') {
        const probe = await pseudoWaitFor({ until: substituteBindings(a.if, bindings), timeout_ms: a.if_probe_timeout_ms || 1000, poll_ms: 100, throw_on_timeout: false })
        if (!probe.ok) {
          results.push({ i: i, tool: a.tool, ok: true, skipped: true, if_probe: probe })
          continue
        }
      }
      const t0step = Date.now()
      try {
        const result = await runStep(a.tool, effParams)
        const rec = { i: i, tool: a.tool, ok: true, durationMs: Date.now() - t0step }
        if (typeof a.as === 'string' && a.as.length > 0) {
          bindings[a.as] = result
          rec.bound_as = a.as
        }
        results.push(rec)
      } catch (err) {
        results.push({ i: i, tool: a.tool, ok: false, durationMs: Date.now() - t0step, error: err.message })
        blockFailed = true
        lastError = err.message
        break  // stop on error within a try block (different from foreach default)
      }
    }
    return { results: results, failed: blockFailed, error: lastError }
  }

  const bodyResult = await runBlock(body, 'body')
  let catchResult = null
  let taken = bodyResult.failed ? 'caught' : 'success'
  if (bodyResult.failed && catchSpec && Array.isArray(catchSpec.body)) {
    // Bind error to ${err} (or whatever name catchSpec.as)
    const errBindingName = catchSpec.as || 'err'
    const prevHad = Object.prototype.hasOwnProperty.call(bindings, errBindingName)
    const prevVal = prevHad ? bindings[errBindingName] : undefined
    bindings[errBindingName] = bodyResult.error
    catchResult = await runBlock(catchSpec.body, 'catch')
    if (prevHad) bindings[errBindingName] = prevVal; else delete bindings[errBindingName]
    if (catchResult.failed) taken = 'rethrown'
  } else if (bodyResult.failed) {
    taken = 'rethrown'  // body failed and no catch
  }
  const finallyResult = await runBlock(finallyActions, 'finally')

  return {
    ok: taken !== 'rethrown',
    taken: taken,
    body_steps: bodyResult.results,
    catch_steps: catchResult ? catchResult.results : null,
    finally_steps: finallyResult.results,
    finally_failed: finallyResult.failed,
  }
}

// ----- pseudo-tool: branch -----
// If-then-else inside a sequence. Probes the condition ONCE (with a short
// timeout), then runs `then` actions if true, `else` actions if false.
async function pseudoBranch(params) {
  params = params || {}
  if (!params.condition) throw new Error('branch requires {condition, then, else?}')
  const thenActions = Array.isArray(params.then) ? params.then : []
  const elseActions = Array.isArray(params.else) ? params.else : []
  const probeTimeoutMs = params.probe_timeout_ms || 1000

  const probeResult = await pseudoWaitFor({ until: params.condition, timeout_ms: probeTimeoutMs, poll_ms: 100, throw_on_timeout: false })
  const taken = probeResult.ok ? 'then' : 'else'
  const branchActions = probeResult.ok ? thenActions : elseActions

  const steps = []
  for (let i = 0; i < branchActions.length; i++) {
    const a = branchActions[i]
    if (!a || typeof a.tool !== 'string') {
      steps.push({ i, ok: false, error: 'missing tool string' })
      continue
    }
    const t0 = Date.now()
    try {
      const result = await runStep(a.tool, a.params || {})
      steps.push({ i, tool: a.tool, ok: true, durationMs: Date.now() - t0, result: result })
    } catch (err) {
      steps.push({ i, tool: a.tool, ok: false, durationMs: Date.now() - t0, error: err.message })
    }
  }
  return { ok: true, taken: taken, probe: probeResult, steps: steps }
}

// ----- semantic helpers (callable directly OR via gui.sequence) -----

// Bring Chrome to foreground. Spawn it if not running. Idempotent + safe.
async function focusChrome(_params) {
  const r = runAHK(
    'if WinExist("ahk_exe chrome.exe") {\n' +
    '  WinActivate\n' +
    '  WinWaitActive("ahk_exe chrome.exe", , 2)\n' +
    '} else {\n' +
    '  ExitApp 2\n' +
    '}\n'
  )
  if (r.exitCode === 2) {
    spawn('cmd', ['/c', 'start', '', 'chrome.exe'], { detached: true, stdio: 'ignore' }).unref()
    await sleep(2000)
    runAHK('if WinExist("ahk_exe chrome.exe") { WinActivate }')
    return { ok: true, action: 'launched', chromeFound: false }
  }
  return { ok: true, action: 'focused', chromeFound: true }
}

// Open a URL. Default mode "new_tab" (Ctrl+T) preserves Tate's other tabs.
// "address_bar" mode (Ctrl+L) hijacks the current tab.
async function openUrl(params) {
  params = params || {}
  const url = params.url
  const mode = params.mode || 'new_tab'
  const waitMs = (typeof params.waitMs === 'number') ? params.waitMs : 3500
  if (!url) throw new Error('url required')

  await focusChrome()
  await sleep(250)

  if (mode === 'new_tab') {
    await input.shortcut({ keys: ['ctrl', 't'] })
    await sleep(300)
  } else if (mode === 'address_bar') {
    await input.shortcut({ keys: ['ctrl', 'l'] })
    await sleep(200)
  } else {
    throw new Error('mode must be new_tab or address_bar, got ' + mode)
  }
  await input.type({ text: url })
  await sleep(150)
  await input.key({ key: 'enter' })
  await sleep(waitMs)
  return { ok: true, navigated: url, mode: mode }
}

// Close the current tab (Ctrl+W).
async function closeTab(_params) {
  await focusChrome()
  await sleep(150)
  await input.shortcut({ keys: ['ctrl', 'w'] })
  await sleep(200)
  return { ok: true, closed: 'current_tab' }
}

// Switch to next tab (Ctrl+Tab) or previous (Ctrl+Shift+Tab).
async function switchTab(params) {
  params = params || {}
  const dir = params.direction || 'next'
  await focusChrome()
  await sleep(100)
  if (dir === 'next') await input.shortcut({ keys: ['ctrl', 'tab'] })
  else if (dir === 'previous' || dir === 'prev') await input.shortcut({ keys: ['ctrl', 'shift', 'tab'] })
  else throw new Error('direction must be next or previous')
  await sleep(200)
  return { ok: true, direction: dir }
}

// Modify Chrome's pinned/desktop/start-menu shortcuts to include
// --remote-debugging-port=PORT in their Arguments. After running this once,
// the user's NEXT manual Chrome launch (taskbar click, desktop double-click,
// start-menu open) brings up Chrome with CDP enabled - on their REAL Default
// profile with all cookies/session intact. ZERO session loss vs the relaunch
// approach. Idempotent: skips shortcuts that already have the flag.
async function installCdpToChrome(params) {
  params = params || {}
  const port = params.port || 9222
  // Chrome 136+ silently drops --remote-debugging-port unless --user-data-dir
  // is also explicitly passed. We pin it to Default profile so cookies / tabs
  // carry over. Plus --restore-last-session so the next relaunch is seamless.
  const userData = path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data')
  const flag = '--remote-debugging-port=' + port +
               ' --user-data-dir="' + userData + '"' +
               ' --profile-directory=Default' +
               ' --restore-last-session'

  // Discover all Chrome .lnk files on disk.
  const candidates = [
    path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar', 'Google Chrome.lnk'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Internet Explorer', 'Quick Launch', 'Google Chrome.lnk'),
    path.join(os.homedir(), 'Desktop', 'Google Chrome.lnk'),
    'C:\\Users\\Public\\Desktop\\Google Chrome.lnk',
    path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Google Chrome.lnk'),
    'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Google Chrome.lnk',
  ]

  const found = candidates.filter(p => { try { return fs.statSync(p).isFile() } catch (e) { return false } })
  if (found.length === 0) {
    return { ok: false, error: 'no Chrome .lnk shortcuts found on disk' }
  }

  // PowerShell one-shot script that updates each .lnk via WScript.Shell COM API.
  // Pass paths as a single string arg to avoid quoting headaches.
  const psPaths = found.map(p => "'" + p.replace(/'/g, "''") + "'").join(',')
  const psScript = [
    '$paths = @(' + psPaths + ')',
    '$shell = New-Object -ComObject WScript.Shell',
    '$results = @()',
    'foreach ($p in $paths) {',
    '  try {',
    '    $lnk = $shell.CreateShortcut($p)',
    '    $args = if ($lnk.Arguments) { $lnk.Arguments } else { "" }',
    '    if ($args -match "--remote-debugging-port=") {',
    '      $results += "ALREADY_HAS_FLAG|$p"',
    '    } else {',
    '      $lnk.Arguments = ($args + " ' + flag + '").Trim()',
    '      $lnk.Save()',
    '      $results += "UPDATED|$p"',
    '    }',
    '  } catch {',
    '    $results += "ERROR|$p|" + $_.Exception.Message',
    '  }',
    '}',
    '$results -join "`n"',
  ].join('\n')

  const r = spawnSync('powershell', ['-NoProfile', '-Command', psScript], {
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
    creationFlags: 0x08000000,
  })

  const lines = (r.stdout || '').trim().split(/\r?\n/).filter(Boolean)
  const updated = []
  const already = []
  const errors = []
  for (const ln of lines) {
    const parts = ln.split('|')
    if (parts[0] === 'UPDATED') updated.push(parts[1])
    else if (parts[0] === 'ALREADY_HAS_FLAG') already.push(parts[1])
    else if (parts[0] === 'ERROR') errors.push({ path: parts[1], error: parts.slice(2).join('|') })
  }

  return {
    ok: errors.length === 0,
    port: port,
    flag: flag,
    found: found.length,
    updated: updated,
    already_had_flag: already,
    errors: errors,
    next_step: 'Close + reopen Chrome via the modified shortcut (taskbar/desktop/start). CDP will then be live on :' + port + ' with Tate\'s real Default profile cookies intact.',
  }
}

// LEGACY (kept for explicit force-relaunch): kills Chrome + relaunches with CDP.
// Prefer gui.install_cdp_to_chrome which avoids tab loss.
async function enableChromeCdp(params) {
  params = params || {}
  const port = params.port || 9222

  const pre = await probeChromeCdp(port, 500)
  if (pre.ok) return { ok: true, already_up: true, port: port, version: pre.version.Browser }

  // Kill all chrome.exe instances. spawnSync separates args (no shell interp).
  spawnSync('powershell', [
    '-NoProfile',
    '-Command',
    'Get-Process chrome -ErrorAction SilentlyContinue | Stop-Process -Force'
  ], { stdio: 'ignore', windowsHide: true, creationFlags: 0x08000000 })
  await sleep(2000)

  const userData = path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data')
  for (const lockName of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    const lock = path.join(userData, lockName)
    try { if (fs.existsSync(lock)) fs.unlinkSync(lock) } catch (e) {}
  }

  const args = [
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + userData,
    '--profile-directory=Default',
    '--restore-last-session',
    '--no-first-run',
    '--no-default-browser-check',
  ]
  const child = spawn('chrome.exe', args, { detached: true, stdio: 'ignore', windowsHide: false })
  child.unref()

  const start = Date.now()
  while (Date.now() - start < 12000) {
    await sleep(500)
    const probe = await probeChromeCdp(port, 500)
    if (probe.ok) {
      return { ok: true, already_up: false, port: port, version: probe.version.Browser, ms_to_ready: Date.now() - start }
    }
  }
  throw new Error('CDP did not come up on :' + port + ' within 12s after relaunch')
}

// Launch a CDP-enabled Chrome on the isolated EOS-CDP user-data-dir.
// Idempotent: returns immediately if CDP already up on the port.
// Otherwise spawns chrome.exe detached with the full flag set (Chrome 136+
// requires explicit --user-data-dir for the CDP flag to take effect).
// Does NOT touch the user's regular Chrome (different user-data-dir).
async function launchCdpChrome(params) {
  params = params || {}
  const port = params.port || 9222
  const dataDir = params.userDataDir || 'C:\\eos-chrome-cdp'

  const pre = await probeChromeCdp(port, 600)
  if (pre.ok) return { ok: true, already_up: true, port: port, version: pre.version.Browser }

  const chromeCandidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ]
  let chromeExe = null
  for (const c of chromeCandidates) {
    try { if (fs.statSync(c).isFile()) { chromeExe = c; break } } catch (e) {}
  }
  if (!chromeExe) throw new Error('chrome.exe not found in standard install paths')

  const args = [
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + dataDir,
    '--no-first-run',
    '--no-default-browser-check',
  ]
  const child = spawn(chromeExe, args, { detached: true, stdio: 'ignore', windowsHide: false })
  child.unref()

  const start = Date.now()
  while (Date.now() - start < 15000) {
    await sleep(500)
    const probe = await probeChromeCdp(port, 600)
    if (probe.ok) {
      return { ok: true, already_up: false, port: port, version: probe.version.Browser, ms_to_ready: Date.now() - start, dataDir: dataDir, chromeExe: chromeExe }
    }
  }
  throw new Error('Chrome launched but CDP did not bind on :' + port + ' within 15s')
}

// ----- sequence dispatcher -----

async function runStep(tool, params, bindings) {
  params = params || {}
  if (tool === 'wait') return pseudoWait(params)
  if (tool === 'wait_for') return pseudoWaitFor(params)
  if (tool === 'branch') return pseudoBranch(params)
  if (tool === 'foreach') return pseudoForeach(params, bindings)
  if (tool === 'try') return pseudoTry(params, bindings)
  if (tool === 'screenshot' || tool === 'screenshot.screenshot') return screenshot.screenshot(params)
  if (tool.indexOf('input.') === 0) {
    const fn = input[tool.slice(6)]
    if (!fn) throw new Error('Unknown input tool: ' + tool)
    return fn(params)
  }
  if (tool.indexOf('mouse.') === 0) {
    const fn = mouse[tool.slice(6)]
    if (!fn) throw new Error('Unknown mouse tool: ' + tool)
    return fn(params)
  }
  if (tool.indexOf('cdp.') === 0) {
    const cdp = require('./cdp')
    const fn = cdp[tool.slice(4)]
    if (!fn) throw new Error('Unknown cdp tool: ' + tool)
    return fn(params)
  }
  if (tool.indexOf('vscode.') === 0) {
    const vs = require('./vscode')
    const fn = vs[tool.slice(7)]
    if (!fn) throw new Error('Unknown vscode tool: ' + tool)
    return fn(params)
  }
  if (tool.indexOf('cursor.') === 0) {
    const cur = require('./cursor')
    const fn = cur[tool.slice(7)]
    if (!fn) throw new Error('Unknown cursor tool: ' + tool)
    return fn(params)
  }
  if (tool.indexOf('explorer.') === 0) {
    const exp = require('./explorer')
    const fn = exp[tool.slice(9)]
    if (!fn) throw new Error('Unknown explorer tool: ' + tool)
    return fn(params)
  }
  if (tool.indexOf('window.') === 0) {
    const win = require('./window')
    const fn = win[tool.slice(7)]
    if (!fn) throw new Error('Unknown window tool: ' + tool)
    return fn(params)
  }
  if (tool.indexOf('uia.') === 0) {
    const uia = require('./uia')
    const fn = uia[tool.slice(4)]
    if (!fn) throw new Error('Unknown uia tool: ' + tool)
    return fn(params)
  }
  if (tool.indexOf('clipboard.') === 0) {
    const cb = require('./clipboard')
    const fn = cb[tool.slice(10)]
    if (!fn) throw new Error('Unknown clipboard tool: ' + tool)
    return fn(params)
  }
  if (tool.indexOf('notification.') === 0) {
    const nf = require('./notification')
    const fn = nf[tool.slice(13)]
    if (!fn) throw new Error('Unknown notification tool: ' + tool)
    return fn(params)
  }
  if (tool.indexOf('cowork.') === 0) {
    const cw = require('./cowork')
    const fn = cw[tool.slice(7)]
    if (!fn) throw new Error('Unknown cowork tool: ' + tool)
    return fn(params)
  }
  if (tool === 'gui.focus_chrome') return focusChrome(params)
  if (tool === 'gui.open_url') return openUrl(params)
  if (tool === 'gui.close_tab') return closeTab(params)
  if (tool === 'gui.switch_tab') return switchTab(params)
  if (tool === 'gui.enable_chrome_cdp') return enableChromeCdp(params)
  if (tool === 'gui.install_cdp_to_chrome') return installCdpToChrome(params)
  if (tool === 'gui.launch_cdp_chrome') return launchCdpChrome(params)
  if (tool === 'gui.sequence') throw new Error('gui.sequence cannot dispatch itself; flatten the actions array')
  throw new Error(
    'gui.sequence does not dispatch tool: ' + tool +
    ' (allowed: input.*, mouse.*, screenshot, wait, cdp.*, gui.focus_chrome, gui.open_url, gui.close_tab, gui.switch_tab, gui.enable_chrome_cdp)'
  )
}

// substituteBindings - replace ${varname} tokens in a params object with
// values from the bindings map. Walks the object tree, replaces inside strings.
// Tokens like ${var.field.nested} pluck nested object fields. Unknown vars
// are left as ${...} so callers can spot misnames.
function substituteBindings(params, bindings) {
  if (!params || typeof params !== 'object') return params
  if (!bindings || Object.keys(bindings).length === 0) return params
  const TOKEN_RE = /\$\{([\w.]+)\}/g

  function resolveToken(token) {
    const parts = token.split('.')
    let v = bindings[parts[0]]
    for (let i = 1; i < parts.length; i++) {
      if (v == null) return undefined
      v = v[parts[i]]
    }
    return v
  }

  function walk(node) {
    if (node == null) return node
    if (typeof node === 'string') {
      let out = node
      let m
      TOKEN_RE.lastIndex = 0
      while ((m = TOKEN_RE.exec(node)) !== null) {
        const v = resolveToken(m[1])
        if (v === undefined) continue  // leave token in place
        out = out.replace(m[0], typeof v === 'object' ? JSON.stringify(v) : String(v))
      }
      return out
    }
    if (Array.isArray(node)) return node.map(walk)
    if (typeof node === 'object') {
      const r = {}
      for (const k of Object.keys(node)) r[k] = walk(node[k])
      return r
    }
    return node
  }
  return walk(params)
}

async function sequence(params) {
  params = params || {}
  const actions = params.actions
  const stopOnError = params.stopOnError !== false
  const finalScreenshot = params.finalScreenshot !== false
  const keepIntermediateScreenshots = !!params.keepIntermediateScreenshots
  const includeStepResults = !!params.includeStepResults
  const bindings = (params.bindings && typeof params.bindings === 'object') ? Object.assign({}, params.bindings) : {}
  // Envelope-level whole-sequence timeout (audit §5.1). 0/undefined = unbounded.
  const maxTotalMs = (typeof params.max_total_ms === 'number' && params.max_total_ms > 0) ? params.max_total_ms : 0

  if (!Array.isArray(actions)) throw new Error('actions must be an array')
  if (actions.length === 0) throw new Error('actions must not be empty')

  const t0 = Date.now()
  const steps = []
  let completed = 0
  let failed = 0
  let lastScreenshotResult = null
  let timedOutAtStep = null

  for (let i = 0; i < actions.length; i++) {
    // Whole-sequence deadline check
    if (maxTotalMs > 0 && (Date.now() - t0) > maxTotalMs) {
      timedOutAtStep = i
      break
    }
    const a = actions[i]
    if (!a || typeof a.tool !== 'string') {
      steps.push({ i: i, tool: null, ok: false, durationMs: 0, error: 'missing tool string' })
      failed++
      if (stopOnError) break
      continue
    }
    const start = Date.now()
    // Substitute ${var} tokens in params from the bindings accumulated so far.
    // Any prior step with `as: "name"` set bindings[name] = result.
    const effectiveParams = substituteBindings(a.params || {}, bindings)
    // Step-level `if:` precondition (audit §3.4). Probes condition ONCE with
    // a 1s timeout. If false, step is recorded as skipped and the sequence
    // continues. Eliminates the branch{then:[X]} nesting for single-step skips.
    if (a.if && typeof a.if === 'object') {
      const probe = await pseudoWaitFor({ until: substituteBindings(a.if, bindings), timeout_ms: a.if_probe_timeout_ms || 1000, poll_ms: 100, throw_on_timeout: false })
      if (!probe.ok) {
        steps.push({ i: i, tool: a.tool, ok: true, skipped: true, durationMs: Date.now() - start, if_probe: probe })
        completed++
        continue
      }
    }
    try {
      const result = await runStep(a.tool, effectiveParams, bindings)
      const dur = Date.now() - start
      const isShot = a.tool === 'screenshot' || a.tool === 'screenshot.screenshot' || a.tool === 'cdp.pageScreenshot'
      if (isShot && result && result.image) lastScreenshotResult = result
      const step = { i: i, tool: a.tool, ok: true, durationMs: dur }
      if (isShot && keepIntermediateScreenshots && result.image) {
        step.image = result.image
        step.format = result.format || 'png'
      }
      if (includeStepResults && !isShot) {
        step.result = result
      }
      // Capture result into bindings if action requested it
      if (typeof a.as === 'string' && a.as.length > 0) {
        bindings[a.as] = result
        step.bound_as = a.as
      }
      steps.push(step)
      completed++
    } catch (err) {
      const dur = Date.now() - start
      steps.push({ i: i, tool: a.tool, ok: false, durationMs: dur, error: err.message })
      failed++
      if (stopOnError) break
    }
  }

  const out = { completed: completed, failed: failed, totalMs: Date.now() - t0, steps: steps }
  if (timedOutAtStep !== null) {
    out.timed_out_at_step = timedOutAtStep
    out.max_total_ms = maxTotalMs
  }

  if (finalScreenshot) {
    if (lastScreenshotResult) {
      out.finalImage = lastScreenshotResult.image
      out.finalFormat = lastScreenshotResult.format || 'png'
    } else {
      try {
        const shot = await screenshot.screenshot({})
        out.finalImage = shot.image
        out.finalFormat = shot.format
      } catch (err) {
        out.finalScreenshotError = err.message
      }
    }
  }

  return out
}

module.exports = {
  sequence: sequence,
  focus_chrome: focusChrome,
  open_url: openUrl,
  close_tab: closeTab,
  switch_tab: switchTab,
  enable_chrome_cdp: enableChromeCdp,
  install_cdp_to_chrome: installCdpToChrome,
  launch_cdp_chrome: launchCdpChrome,
}
