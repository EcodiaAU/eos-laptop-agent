// cdp.js - Chrome DevTools Protocol bridge for the laptop agent.
//
// Attaches to a CDP-enabled Chrome (Tate's real session if launched via
// gui.enable_chrome_cdp, otherwise whatever's listening on :9222). Lets the
// conductor express GUI tasks at the DOM level instead of the pixel level:
// `cdp.click({selector: 'a[href*=deployments]'})` instead of
// `input.click({x: 80, y: 259})`. No screenshot OCR, no stale taskbar coords,
// no flaky waits. Pure DOM addressing on real logged-in sessions.
//
// Connection is cached at module scope. Attach once per agent boot, then call
// freely. If the cached connection goes stale (Chrome restart, network drop),
// the next call probes + reconnects automatically.
//
// Doctrine: chrome-cdp-attach-requires-explicit-user-data-dir-and-singleton-clear
//           (the relaunch side is handled by gui.enable_chrome_cdp).

const http = require('http')

const DEFAULT_PORT = 9222
let connection = null  // { browser, page } - legacy, kept for compat with selectTab
let connectedPort = null
// Map<alias, targetId>. Per-call page resolution (no singleton). Aliases let
// concurrent callers address different tabs in parallel.
const aliasToTargetId = new Map()
let lastTouchedTargetId = null

function _extractTargetId(page) {
  try { return page.target()._targetId || (page.target()._targetInfo && page.target()._targetInfo.targetId) || null }
  catch (_e) { return null }
}

// Per-call page resolver. Picks the lookup strategy from `opts.target`:
//   {targetId}      stable CDP id
//   {alias}         pre-registered name -> targetId
//   {urlContains}   substring match on page URL
//   {titleContains} substring match on page title
//   {index}         browser.pages()[index]
// Falls back to last-touched, then last page. Existing callers without
// `target` keep the legacy behaviour via the lastTouched fallback.
async function resolveTarget(opts) {
  const c = await ensureConnected(opts)
  const target = (opts && opts.target) || {}
  const pages = await c.browser.pages()
  const byId = async (tid) => {
    for (const p of pages) if (_extractTargetId(p) === tid) return p
    return null
  }
  if (target.targetId) {
    const p = await byId(target.targetId)
    if (p) { lastTouchedTargetId = target.targetId; return p }
    throw new Error('no page matches targetId ' + target.targetId + ' (tab closed)')
  }
  if (target.alias) {
    const tid = aliasToTargetId.get(target.alias)
    if (!tid) throw new Error('alias not registered: ' + target.alias + '. Use cdp.attach_tab first.')
    const p = await byId(tid)
    if (p) { lastTouchedTargetId = tid; return p }
    aliasToTargetId.delete(target.alias)
    throw new Error('alias ' + target.alias + ' pointed at a closed tab; alias dropped')
  }
  if (target.urlContains) {
    const needle = String(target.urlContains).toLowerCase()
    for (const p of pages) {
      try {
        if (String(await p.url()).toLowerCase().indexOf(needle) !== -1) {
          lastTouchedTargetId = _extractTargetId(p)
          return p
        }
      } catch (_e) {}
    }
    throw new Error('no tab url contains: ' + target.urlContains)
  }
  if (target.titleContains) {
    const needle = String(target.titleContains).toLowerCase()
    for (const p of pages) {
      try {
        if (String(await p.title()).toLowerCase().indexOf(needle) !== -1) {
          lastTouchedTargetId = _extractTargetId(p)
          return p
        }
      } catch (_e) {}
    }
    throw new Error('no tab title contains: ' + target.titleContains)
  }
  if (typeof target.index === 'number') {
    if (target.index < 0 || target.index >= pages.length) throw new Error('index out of range')
    const p = pages[target.index]
    lastTouchedTargetId = _extractTargetId(p)
    return p
  }
  // fallback: last-touched, then last
  if (lastTouchedTargetId) {
    const p = await byId(lastTouchedTargetId)
    if (p) return p
    lastTouchedTargetId = null
  }
  if (pages.length === 0) throw new Error('no pages in browser')
  return pages[pages.length - 1]
}

function probePort(port, timeoutMs) {
  port = port || DEFAULT_PORT
  timeoutMs = timeoutMs || 1500
  return new Promise(resolve => {
    const req = http.get({ host: 'localhost', port: port, path: '/json/version', timeout: timeoutMs }, res => {
      let body = ''
      res.on('data', c => body += c)
      res.on('end', () => {
        try { resolve({ ok: true, version: JSON.parse(body) }) }
        catch (e) { resolve({ ok: false, error: 'version json parse failed' }) }
      })
    })
    req.on('error', e => resolve({ ok: false, error: e.message }))
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }) })
  })
}

async function ensureConnected(opts) {
  const port = (opts && opts.port) || DEFAULT_PORT
  if (connection && connection.browser && connection.browser.connected && connectedPort === port) {
    return connection
  }
  const puppeteer = require('puppeteer')
  try {
    const browser = await puppeteer.connect({
      browserURL: `http://localhost:${port}`,
      defaultViewport: null,
    })
    const pages = await browser.pages()
    const page = pages[pages.length - 1] || await browser.newPage()
    connection = { browser: browser, page: page }
    connectedPort = port
    return connection
  } catch (err) {
    connection = null
    connectedPort = null
    throw new Error(
      'cdp.attach failed on :' + port + ': ' + err.message + '. ' +
      'Chrome must be running with --remote-debugging-port=' + port + ' + explicit --user-data-dir. ' +
      'Run gui.enable_chrome_cdp once to bootstrap (will relaunch Chrome).'
    )
  }
}

async function attach(opts) {
  opts = opts || {}
  const port = opts.port || DEFAULT_PORT
  const probe = await probePort(port)
  if (!probe.ok) throw new Error('CDP not listening on :' + port + ': ' + probe.error)
  await ensureConnected({ port: port })
  const page = await resolveTarget(opts)
  return {
    ok: true,
    port: port,
    chromeVersion: probe.version.Browser,
    protocolVersion: probe.version['Protocol-Version'],
    currentUrl: await page.url(),
    currentTitle: await page.title(),
    parallelism: 'per-call target resolution (alias / urlContains / titleContains / index / targetId)',
  }
}

// Run a JS expression in the attached page. Pass a string; Puppeteer evaluates
// it in the page context. For multi-statement, wrap in an IIFE.
async function runJs(opts) {
  opts = opts || {}
  const js = opts.js
  const timeout = opts.timeout || 5000
  if (typeof js !== 'string' || !js.trim()) throw new Error('js (string) required')
  try {
    const page = await resolveTarget(opts)
    const value = await Promise.race([
      page.evaluate(js),
      new Promise((_, rej) => setTimeout(() => rej(new Error('cdp.runJs timed out after ' + timeout + 'ms')), timeout)),
    ])
    return { ok: true, value: value }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

async function click(opts) {
  opts = opts || {}
  const selector = opts.selector
  const timeout = opts.timeout || 5000
  if (!selector) throw new Error('selector required')
  const page = await resolveTarget(opts)
  await page.waitForSelector(selector, { timeout: timeout, visible: true })
  await page.click(selector)
  return { ok: true, clicked: selector }
}

async function wait(opts) {
  opts = opts || {}
  const selector = opts.selector
  const timeout = opts.timeout || 10000
  if (!selector) throw new Error('selector required')
  const page = await resolveTarget(opts)
  const w = { timeout: timeout }
  if (opts.visible) w.visible = true
  if (opts.hidden) w.hidden = true
  await page.waitForSelector(selector, w)
  return { ok: true, found: selector }
}

async function url_(opts) {
  const page = await resolveTarget(opts)
  return { url: await page.url(), title: await page.title() }
}

async function navigate(opts) {
  opts = opts || {}
  const url = opts.url
  const waitUntil = opts.waitUntil || 'domcontentloaded'
  const timeout = opts.timeout || 30000
  if (!url) throw new Error('url required')
  const page = await resolveTarget(opts)
  await page.goto(url, { waitUntil: waitUntil, timeout: timeout })
  return { ok: true, url: await page.url(), title: await page.title() }
}

async function text(opts) {
  opts = opts || {}
  const selector = opts.selector
  if (!selector) throw new Error('selector required')
  const page = await resolveTarget(opts)
  await page.waitForSelector(selector, { timeout: 5000 })
  const txt = await page.$eval(selector, el => (el.textContent || '').trim())
  return { selector: selector, text: txt }
}

// Query many elements, project named fields.
// fields format per key:
//   "@text"            -> el.textContent
//   "@html"            -> el.innerHTML
//   "@href"            -> el.getAttribute('href')
//   "@data-id"         -> any attribute by name
//   ".sub@text"        -> sub-selector + extractor
//   ".sub@href"        -> sub-selector + named attribute
async function queryAll(opts) {
  opts = opts || {}
  const selector = opts.selector
  const fields = opts.fields || {}
  const limit = opts.limit || 100
  if (!selector) throw new Error('selector required')
  const page = await resolveTarget(opts)
  const rows = await page.evaluate((sel, fld, lim) => {
    const extract = (target, what) => {
      if (!target) return null
      if (what === '' || what === 'text' || what === 'textContent') return (target.textContent || '').trim()
      if (what === 'html' || what === 'innerHTML') return target.innerHTML
      if (what === 'href') return target.getAttribute('href')
      return target.getAttribute(what)
    }
    const els = Array.from(document.querySelectorAll(sel)).slice(0, lim)
    return els.map(el => {
      const row = {}
      for (const [key, expr] of Object.entries(fld)) {
        const m = String(expr).match(/^(.*?)@(.*)$/)
        const sub = m ? m[1] : ''
        const what = m ? m[2] : 'textContent'
        const target = sub ? el.querySelector(sub) : el
        row[key] = extract(target, what)
      }
      return row
    })
  }, selector, fields, limit)
  return { count: rows.length, rows: rows }
}

// Page-level screenshot via CDP (different from screenshot.screenshot which
// captures the OS screen). Useful for off-screen / non-foreground captures.
async function pageScreenshot(opts) {
  opts = opts || {}
  const fullPage = !!opts.fullPage
  const page = await resolveTarget(opts)
  const buf = await page.screenshot({ fullPage: fullPage, type: 'png' })
  return { image: buf.toString('base64'), format: 'png', fullPage: fullPage }
}

// List all tabs/pages with index + url + title + targetId (for pinning aliases).
async function listTabs(opts) {
  const c = await ensureConnected(opts)
  const pages = await c.browser.pages()
  const tabs = []
  for (let i = 0; i < pages.length; i++) {
    try {
      tabs.push({ index: i, url: await pages[i].url(), title: await pages[i].title(), targetId: _extractTargetId(pages[i]) })
    } catch (e) {
      tabs.push({ index: i, error: e.message })
    }
  }
  return { count: tabs.length, tabs: tabs }
}

// LEGACY: bring tab to front + set implicit-fallback target. Use cdp.attach_tab
// for stable named aliasing in new code - that's what unlocks true parallelism.
async function selectTab(opts) {
  opts = opts || {}
  const target = opts.target || { index: opts.index, urlContains: opts.urlContains, titleContains: opts.titleContains }
  const page = await resolveTarget({ target })
  await page.bringToFront()
  lastTouchedTargetId = _extractTargetId(page)
  return { ok: true, url: await page.url(), title: await page.title(), brought_to_front: true }
}

// === alias management - per-tab named pins for parallel addressing ======

async function attachTab(opts) {
  opts = opts || {}
  if (!opts.alias) throw new Error('alias required')
  if (!opts.urlContains && !opts.titleContains && typeof opts.index !== 'number' && !opts.targetId) {
    throw new Error('one of urlContains | titleContains | index | targetId required')
  }
  const page = await resolveTarget({ target: { urlContains: opts.urlContains, titleContains: opts.titleContains, index: opts.index, targetId: opts.targetId } })
  const tid = _extractTargetId(page)
  if (!tid) throw new Error('could not extract targetId from page')
  aliasToTargetId.set(opts.alias, tid)
  return { ok: true, alias: opts.alias, targetId: tid, url: await page.url(), title: await page.title() }
}

async function detachTab(opts) {
  opts = opts || {}
  if (!opts.alias) throw new Error('alias required')
  const dropped = aliasToTargetId.delete(opts.alias)
  return { ok: true, alias: opts.alias, dropped: dropped }
}

async function listAliases(opts) {
  const c = await ensureConnected(opts)
  const pages = await c.browser.pages()
  const out = []
  for (const [alias, tid] of aliasToTargetId.entries()) {
    let live = null
    for (const p of pages) if (_extractTargetId(p) === tid) { live = p; break }
    if (!live) { out.push({ alias, targetId: tid, alive: false }); continue }
    out.push({ alias, targetId: tid, alive: true, url: await live.url(), title: await live.title() })
  }
  return { count: out.length, aliases: out }
}

async function detach() {
  if (connection && connection.browser) {
    try { connection.browser.disconnect() } catch (e) {}
  }
  connection = null
  connectedPort = null
  return { ok: true }
}

// cdp.clickText - find an element by visible text (case-insensitive substring) and click it.
async function clickText(opts) {
  opts = opts || {}
  const text = opts.text
  const tag = opts.tag || 'a, button, [role=button], [role=link], [role=tab], li, span, div'
  const isExact = !!opts.exact
  const timeout = opts.timeout || 5000
  if (!text) throw new Error('text required')
  const page = await resolveTarget(opts)
  const start = Date.now()
  let lastErr = ''
  while (Date.now() - start < timeout) {
    try {
      const result = await page.evaluate(function(args){
        var t = args.text, isExact = args.isExact, sel = args.sel
        var lower = t.toLowerCase()
        var nodes = Array.from(document.querySelectorAll(sel))
        for (var i = 0; i < nodes.length; i++) {
          var el = nodes[i]
          var tc = (el.textContent || '').trim()
          var tcl = tc.toLowerCase()
          var match = isExact ? (tcl === lower) : (tcl.indexOf(lower) !== -1)
          if (!match) continue
          var r = el.getBoundingClientRect()
          if (r.width === 0 || r.height === 0) continue
          el.scrollIntoView({block:'center'})
          el.click()
          return { ok: true, tag: el.tagName, text: tc.slice(0, 120) }
        }
        return { ok: false }
      }, { text: text, isExact: isExact, sel: tag })
      if (result && result.ok) return { ok: true, clickedText: result.text, tag: result.tag }
    } catch (e) { lastErr = e.message }
    await new Promise(r => setTimeout(r, 250))
  }
  return { ok: false, error: 'no clickable element with text within ' + timeout + 'ms', lastErr: lastErr }
}

// cdp.fillByLabel - find form field by label/aria/placeholder/name + fill it.
async function fillByLabel(opts) {
  opts = opts || {}
  const label = opts.label
  const value = opts.value
  if (!label) throw new Error('label required')
  if (typeof value !== 'string') throw new Error('value (string) required')
  const page = await resolveTarget(opts)
  const result = await page.evaluate(function(args){
    var lower = args.label.toLowerCase()
    var candidates = Array.from(document.querySelectorAll('input, textarea, select, [contenteditable=true]'))
    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i]
      var aria = (el.getAttribute('aria-label') || '').toLowerCase()
      var placeholder = (el.getAttribute('placeholder') || '').toLowerCase()
      var name = (el.getAttribute('name') || '').toLowerCase()
      var id = el.id || ''
      var labelEl = id ? document.querySelector('label[for="' + id + '"]') : null
      var labelText = labelEl ? (labelEl.textContent || '').toLowerCase() : ''
      var hit = (aria.indexOf(lower) !== -1) || (placeholder.indexOf(lower) !== -1) || (name.indexOf(lower) !== -1) || (labelText.indexOf(lower) !== -1)
      if (!hit) continue
      el.focus()
      if (el.tagName === 'SELECT') {
        for (var j = 0; j < el.options.length; j++) {
          if ((el.options[j].text || '').toLowerCase().indexOf(args.value.toLowerCase()) !== -1) {
            el.selectedIndex = j
            el.dispatchEvent(new Event('change', {bubbles:true}))
            return { ok: true, tag: 'SELECT', selected: el.options[j].text }
          }
        }
        return { ok: false, error: 'no matching option in select' }
      }
      if (el.isContentEditable) {
        el.innerText = args.value
        el.dispatchEvent(new Event('input', {bubbles:true}))
      } else {
        el.value = args.value
        el.dispatchEvent(new Event('input', {bubbles:true}))
        el.dispatchEvent(new Event('change', {bubbles:true}))
      }
      return { ok: true, tag: el.tagName, name: name, id: id }
    }
    return { ok: false, error: 'no field matching label/placeholder/aria/name' }
  }, { label: label, value: value })
  return result
}

// cdp.cookies - list cookies (filterable by domain substring).
async function cookies(opts) {
  opts = opts || {}
  const page = await resolveTarget(opts)
  const all = await page.cookies()
  let filtered = all
  if (opts.domain) {
    var d = opts.domain.toLowerCase()
    filtered = all.filter(function(c){ return (c.domain || '').toLowerCase().indexOf(d) !== -1 })
  }
  return { count: filtered.length, cookies: filtered }
}

// cdp.setCookie - set a cookie on the current page or named url.
async function setCookie(opts) {
  opts = opts || {}
  const page = await resolveTarget(opts)
  if (!opts.name || typeof opts.value === 'undefined') throw new Error('name + value required')
  const cookie = { name: opts.name, value: String(opts.value) }
  if (opts.domain) cookie.domain = opts.domain
  if (opts.path) cookie.path = opts.path
  if (opts.url) cookie.url = opts.url
  if (typeof opts.expires === 'number') cookie.expires = opts.expires
  if (opts.httpOnly) cookie.httpOnly = true
  if (opts.secure) cookie.secure = true
  if (opts.sameSite) cookie.sameSite = opts.sameSite
  await page.setCookie(cookie)
  return { ok: true, set: opts.name }
}

// cdp.viewport - resize the page viewport (mobile emulation etc.)
async function viewport(opts) {
  opts = opts || {}
  const page = await resolveTarget(opts)
  const width = opts.width || 1366
  const height = opts.height || 768
  const deviceScaleFactor = opts.deviceScaleFactor || 1
  const isMobile = !!opts.isMobile
  const hasTouch = !!opts.hasTouch
  await page.setViewport({ width: width, height: height, deviceScaleFactor: deviceScaleFactor, isMobile: isMobile, hasTouch: hasTouch })
  if (opts.userAgent) await page.setUserAgent(opts.userAgent)
  return { ok: true, viewport: { width: width, height: height, deviceScaleFactor: deviceScaleFactor, isMobile: isMobile, hasTouch: hasTouch } }
}

// cdp.scrollTo - scroll to selector or absolute y or bottom.
async function scrollTo(opts) {
  opts = opts || {}
  const page = await resolveTarget(opts)
  if (opts.selector) {
    const found = await page.$(opts.selector)
    if (!found) return { ok: false, error: 'selector not found: ' + opts.selector }
    await page.evaluate(function(s){
      var el = document.querySelector(s)
      if (el) el.scrollIntoView({behavior:'instant', block:'center'})
    }, opts.selector)
    return { ok: true, scrolledTo: opts.selector }
  }
  if (typeof opts.y === 'number') {
    await page.evaluate(function(y){ window.scrollTo({top:y, behavior:'instant'}) }, opts.y)
    return { ok: true, scrolledTo: opts.y }
  }
  if (opts.bottom) {
    await page.evaluate(function(){ window.scrollTo({top: document.body.scrollHeight, behavior:'instant'}) })
    return { ok: true, scrolledTo: 'bottom' }
  }
  throw new Error('scrollTo requires selector, y, or bottom: true')
}

// cdp.networkLog - capture request/response summaries for a duration window.
async function networkLog(opts) {
  opts = opts || {}
  const captureMs = Math.min(opts.captureMs || 5000, 30000)
  const filter = opts.urlContains || null
  const page = await resolveTarget(opts)
  const events = []
  const onReq = function(req){
    var u = req.url()
    if (filter && u.indexOf(filter) === -1) return
    events.push({ type: 'request', method: req.method(), url: u, resourceType: req.resourceType(), at: Date.now() })
  }
  const onRes = async function(res){
    var u = res.url()
    if (filter && u.indexOf(filter) === -1) return
    events.push({ type: 'response', status: res.status(), url: u, at: Date.now() })
  }
  page.on('request', onReq)
  page.on('response', onRes)
  await new Promise(r => setTimeout(r, captureMs))
  page.off('request', onReq)
  page.off('response', onRes)
  return { ok: true, captureMs: captureMs, eventCount: events.length, events: events.slice(0, 200) }
}

// cdp.pdf - export current page as PDF bytes (base64).
async function pdf(opts) {
  opts = opts || {}
  const page = await resolveTarget(opts)
  try {
    const buf = await page.pdf({ format: opts.format || 'A4', printBackground: !!opts.printBackground })
    return { ok: true, pdfBase64: buf.toString('base64'), bytes: buf.length }
  } catch (e) {
    return { ok: false, error: 'pdf failed (often requires headless): ' + e.message }
  }
}

// cdp.realClick - real synthetic mouse click via Input.dispatchMouseEvent at
// (x,y). The fix for "JS .click() does nothing on Material/MUI/custom-element
// buttons" - those listen for the full pointerdown/mousedown/pointerup/mouseup/
// click sequence, not the dispatch-event shortcut.
//
// Pass either {x,y} or {selector} (deep-walked, computes center). Optional
// {tag} narrows the selector to that tag (e.g. 'BUTTON') so a parent P/SPAN
// wrapping the same label text isn't grabbed instead of the real button.
async function realClick(opts) {
  opts = opts || {}
  const page = await resolveTarget(opts)
  const client = await page.target().createCDPSession()
  try {
    let x = opts.x, y = opts.y
    if (typeof x !== 'number' || typeof y !== 'number') {
      const rect = await deepFindRect.call(null, opts)
      if (!rect || !rect.ok) return { ok: false, error: 'no element matched for click', detail: rect && rect.error }
      x = rect.x + rect.w / 2
      y = rect.y + rect.h / 2
    }
    for (const t of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await client.send('Input.dispatchMouseEvent', { type: t, x: x, y: y, button: 'left', clickCount: 1 })
    }
    return { ok: true, x: x, y: y }
  } finally {
    try { await client.detach() } catch (e) {}
  }
}

// cdp.deepFindRect - shadow-DOM aware element finder that returns the bounding
// rect of the FIRST visible matching element. Filters by tag (default BUTTON),
// by text substring, by aria-label substring, or by selector.
//
// Why this exists: cdp.clickText returns the first matching element which can
// be a P or SPAN wrapping the same label text outside the modal. When you want
// "the BUTTON inside the popover", filter by tag === 'BUTTON' AND only enumerate
// visible nodes.
async function deepFindRect(opts) {
  opts = opts || {}
  const page = await resolveTarget(opts)
  const result = await page.evaluate(function(args){
    const wantTag = (args.tag || '').toUpperCase()
    const wantText = (args.text || '').toLowerCase()
    const wantAria = (args.aria || '').toLowerCase()
    const wantSelector = args.selector || ''
    const exact = !!args.exact
    const matches = []
    const walk = function(root){
      let elems
      try { elems = root.querySelectorAll ? root.querySelectorAll('*') : [] }
      catch (e) { return }
      for (const el of elems) {
        const r = el.getBoundingClientRect()
        if (r.width === 0 || r.height === 0) continue
        const style = (el.ownerDocument && el.ownerDocument.defaultView)
          ? el.ownerDocument.defaultView.getComputedStyle(el)
          : null
        if (style && (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0')) continue
        if (wantSelector && !el.matches(wantSelector)) {
          if (el.shadowRoot) walk(el.shadowRoot)
          continue
        }
        if (wantTag && el.tagName !== wantTag) {
          if (el.shadowRoot) walk(el.shadowRoot)
          continue
        }
        const tc = (el.textContent || '').trim().toLowerCase()
        if (wantText) {
          const ok = exact ? (tc === wantText) : (tc.indexOf(wantText) !== -1)
          if (!ok) { if (el.shadowRoot) walk(el.shadowRoot); continue }
        }
        if (wantAria) {
          const a = (el.getAttribute('aria-label') || '').toLowerCase()
          if (a.indexOf(wantAria) === -1) { if (el.shadowRoot) walk(el.shadowRoot); continue }
        }
        matches.push({
          tag: el.tagName,
          text: (el.textContent || '').trim().slice(0, 80),
          aria: el.getAttribute('aria-label') || '',
          x: Math.round(r.x), y: Math.round(r.y),
          w: Math.round(r.width), h: Math.round(r.height),
        })
        if (el.shadowRoot) walk(el.shadowRoot)
      }
    }
    walk(document)
    if (matches.length === 0) return { ok: false, error: 'no match' }
    return { ok: true, count: matches.length, ...matches[0], allMatches: matches.slice(0, 10) }
  }, { tag: opts.tag, text: opts.text, aria: opts.aria, selector: opts.selector, exact: !!opts.exact })
  return result
}

// cdp.nativeFill - fill a controlled input via the native HTMLInputElement
// prototype setter, then dispatch input + change events. The fix for React/MUI/
// SPA inputs where `el.value = 'x'` is silently overwritten on the next render
// because the framework doesn't see a "real" user input.
//
// Selector strategies (try in order until one matches):
//   - {selector}     CSS selector against light + shadow DOM
//   - {placeholder}  input.placeholder === value
//   - {currentValue} input.value === value (e.g. find the input currently
//                    showing the default cron expression and replace it)
//   - {ariaLabel}    aria-label substring match
async function nativeFill(opts) {
  opts = opts || {}
  if (typeof opts.value !== 'string') throw new Error('value (string) required')
  const page = await resolveTarget(opts)
  const result = await page.evaluate(function(args){
    const collect = function(){
      const out = []
      const walk = function(root){
        let elems
        try { elems = root.querySelectorAll ? root.querySelectorAll('input,textarea') : [] }
        catch (e) { return }
        for (const el of elems) {
          const r = el.getBoundingClientRect()
          if (r.width === 0 || r.height === 0) continue
          out.push(el)
        }
        try {
          const sr = root.querySelectorAll ? root.querySelectorAll('*') : []
          for (const el of sr) if (el.shadowRoot) walk(el.shadowRoot)
        } catch (e) {}
        // Descend into same-origin iframes (cross-origin throws; swallowed).
        // Origin: 2026-05-19 CarPlay-entitlement flow on idmsa.apple.com
        // signin widget, which serves the email/password fields inside an
        // iframe; flat nativeFill scope missed them. Recursive-improvement
        // doctrine: extend the helper SAME-TURN.
        try {
          const ifs = root.querySelectorAll ? root.querySelectorAll('iframe') : []
          for (const ifr of ifs) {
            try {
              if (ifr.contentDocument) walk(ifr.contentDocument)
            } catch (e) { /* cross-origin */ }
          }
        } catch (e) {}
      }
      walk(document)
      return out
    }
    const inputs = collect()
    let target = null
    if (args.selector) target = inputs.find(function(el){ try { return el.matches(args.selector) } catch (e) { return false } })
    if (!target && args.placeholder) target = inputs.find(function(el){ return (el.placeholder || '') === args.placeholder })
    if (!target && args.currentValue) target = inputs.find(function(el){ return (el.value || '') === args.currentValue })
    if (!target && args.ariaLabel) {
      const lc = args.ariaLabel.toLowerCase()
      target = inputs.find(function(el){ return ((el.getAttribute('aria-label') || '').toLowerCase()).indexOf(lc) !== -1 })
    }
    if (!target) return { ok: false, error: 'no input matched any strategy', candidates: inputs.slice(0, 5).map(function(el){ return { tag: el.tagName, type: el.type, value: (el.value||'').slice(0,40), placeholder: el.placeholder || '', aria: el.getAttribute('aria-label') || '' } }) }
    const proto = target.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
    target.focus()
    setter.call(target, args.value)
    target.dispatchEvent(new Event('input', { bubbles: true }))
    target.dispatchEvent(new Event('change', { bubbles: true }))
    return { ok: true, tag: target.tagName, finalValue: target.value, placeholder: target.placeholder || '', aria: target.getAttribute('aria-label') || '' }
  }, { value: opts.value, selector: opts.selector, placeholder: opts.placeholder, currentValue: opts.currentValue, ariaLabel: opts.ariaLabel })
  return result
}

// cdp.findVisible - shadow-DOM aware enumeration of visible elements with
// rect + text + tag + class. The eyes-of-the-blind-agent reflex for
// "what is actually clickable in this modal right now?" without taking a
// screenshot and OCRing it.
async function findVisible(opts) {
  opts = opts || {}
  const page = await resolveTarget(opts)
  const result = await page.evaluate(function(args){
    const tagFilter = (args.tag || '').toUpperCase()
    const textFilter = (args.text || '').toLowerCase()
    const minW = args.minW || 0
    const minH = args.minH || 0
    const limit = args.limit || 60
    const out = []
    const walk = function(root){
      let elems
      try { elems = root.querySelectorAll ? root.querySelectorAll('*') : [] }
      catch (e) { return }
      for (const el of elems) {
        if (tagFilter && el.tagName !== tagFilter) {
          if (el.shadowRoot) walk(el.shadowRoot)
          continue
        }
        const r = el.getBoundingClientRect()
        if (r.width < minW || r.height < minH) {
          if (el.shadowRoot) walk(el.shadowRoot)
          continue
        }
        if (r.width === 0 || r.height === 0) {
          if (el.shadowRoot) walk(el.shadowRoot)
          continue
        }
        const txt = (el.textContent || '').trim()
        if (textFilter && txt.toLowerCase().indexOf(textFilter) === -1) {
          if (el.shadowRoot) walk(el.shadowRoot)
          continue
        }
        out.push({
          tag: el.tagName,
          text: txt.slice(0, 80),
          aria: el.getAttribute('aria-label') || '',
          role: el.getAttribute('role') || '',
          cls: ((el.className || '') + '').slice(0, 50),
          x: Math.round(r.x), y: Math.round(r.y),
          w: Math.round(r.width), h: Math.round(r.height),
        })
        if (out.length >= limit) return
        if (el.shadowRoot) walk(el.shadowRoot)
      }
    }
    walk(document)
    return { ok: true, count: out.length, items: out }
  }, { tag: opts.tag, text: opts.text, minW: opts.minW, minH: opts.minH, limit: opts.limit })
  return result
}

// cdp.clickByTag - cdp.clickText but with mandatory tag filter AND falls back
// to a real CDP mouse-event sequence if JS .click() didn't change DOM. Use
// this when clicking buttons in modals/popovers built with MUI/Material/
// custom-element libraries that ignore synthetic .click().
async function clickByTag(opts) {
  opts = opts || {}
  const tag = (opts.tag || 'BUTTON').toUpperCase()
  if (!opts.text && !opts.aria) throw new Error('text or aria required')
  const rect = await deepFindRect({ tag: tag, text: opts.text, aria: opts.aria, exact: !!opts.exact, target: opts.target })
  if (!rect || !rect.ok) return { ok: false, error: 'no ' + tag + ' matched', detail: rect && rect.error }
  // Try JS click first - cheaper, succeeds on plain DOM buttons.
  const page = await resolveTarget(opts)
  const jsResult = await page.evaluate(function(args){
    const candidates = []
    const walk = function(root){
      let elems
      try { elems = root.querySelectorAll ? root.querySelectorAll(args.tag.toLowerCase()) : [] }
      catch (e) { return }
      for (const el of elems) {
        const r = el.getBoundingClientRect()
        if (r.width === 0 || r.height === 0) continue
        if (args.text) {
          const tc = (el.textContent || '').trim().toLowerCase()
          const ok = args.exact ? (tc === args.text.toLowerCase()) : (tc.indexOf(args.text.toLowerCase()) !== -1)
          if (!ok) { if (el.shadowRoot) walk(el.shadowRoot); continue }
        }
        if (args.aria && (el.getAttribute('aria-label') || '').toLowerCase().indexOf(args.aria.toLowerCase()) === -1) {
          if (el.shadowRoot) walk(el.shadowRoot); continue
        }
        candidates.push(el)
        if (el.shadowRoot) walk(el.shadowRoot)
      }
    }
    walk(document)
    if (candidates.length === 0) return { ok: false, error: 'no candidate after walk' }
    const before = document.activeElement
    candidates[0].click()
    return { ok: true, count: candidates.length, focusChanged: document.activeElement !== before }
  }, { tag: tag, text: opts.text, aria: opts.aria, exact: !!opts.exact })
  // If JS click reported a focus change, trust it. Otherwise escalate to real mouse.
  if (jsResult && jsResult.ok && jsResult.focusChanged) {
    return { ok: true, via: 'js', tag: tag, x: rect.x, y: rect.y, w: rect.w, h: rect.h }
  }
  // Escalate to real CDP mouse click (same tab).
  const real = await realClick({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2, target: opts.target })
  return { ok: !!real.ok, via: 'cdp-mouse', tag: tag, x: real.x, y: real.y, w: rect.w, h: rect.h, jsAttempted: jsResult }
}

// cdp.helpers - self-describing inventory of high-leverage helpers.
// Call this mid-session when you forget what's available. Each entry names
// the helper, when to reach for it, and a minimal example.
//
// Recursive-improvement rule: when a new helper lands in this file, also add
// its entry below. The hook at C:/Users/tjdTa/.claude/hooks/ecodia/
// cdp_helper_nudge.py also needs a matching anti-pattern detector. The
// doctrine pattern is at
// backend/patterns/cdp-helper-library-and-recursive-improvement-2026-05-18.md
async function helpers() {
  return {
    ok: true,
    doctrine: 'backend/patterns/cdp-helper-library-and-recursive-improvement-2026-05-18.md',
    helpers: [
      {
        name: 'cdp.realClick',
        whenToUse: 'Material/MUI/custom-element buttons that ignore JS .click(). Sends full Input.dispatchMouseEvent sequence.',
        example: "cdp.realClick({x: 946, y: 874}) OR cdp.realClick({tag: 'BUTTON', text: 'Save'})",
      },
      {
        name: 'cdp.deepFindRect',
        whenToUse: 'Lock onto the real BUTTON when a P/SPAN wraps the same label outside the modal. Shadow-DOM aware, visible-rect filtered.',
        example: "cdp.deepFindRect({tag: 'BUTTON', text: 'Save', exact: true})",
      },
      {
        name: 'cdp.nativeFill',
        whenToUse: "React/MUI controlled inputs where el.value = 'x' reverts on next render. Uses native HTMLInputElement.prototype setter.",
        example: "cdp.nativeFill({placeholder: '0 9 * * *', value: '0 */6 * * *'})",
      },
      {
        name: 'cdp.findVisible',
        whenToUse: '"What is on screen right now?" - shadow-DOM aware enumeration with rect + text + aria + role. Eyes-of-the-blind reflex.',
        example: "cdp.findVisible({tag: 'BUTTON', text: 'save', limit: 10})",
      },
      {
        name: 'cdp.clickByTag',
        whenToUse: 'Default reach-for click helper. Cheap JS click first, auto-escalates to real CDP mouse if focus did not move.',
        example: "cdp.clickByTag({tag: 'BUTTON', text: 'Save'})",
      },
    ],
    hardRules: [
      'Never send Escape (closes parent panels in GCP / Material UIs)',
      'Filter by tag:BUTTON when clicking by text (P/SPAN can wrap the same label)',
      'Use cdp.nativeFill for any controlled input, not el.value =',
      'Wait 6-10s post-navigate, 1500-2500ms after autocomplete fill',
      "Tate's Chrome cookies authenticate every API call - no token replay needed",
    ],
    recursiveImprovement: 'Every new CDP failure mode lands a new helper + doctrine line SAME-TURN, not "next time."',
    nudgeHook: 'C:/Users/tjdTa/.claude/hooks/ecodia/cdp_helper_nudge.py (PreToolUse on Bash, fires [CDP-HELPER NUDGE] when anti-patterns appear in cdp.runJs JS)',
  }
}

// cdp.send - raw DevTools Protocol passthrough. Power user surface.
async function sendCdp(opts) {
  opts = opts || {}
  const method = opts.method
  const params = opts.params || {}
  if (!method) throw new Error('method required')
  const page = await resolveTarget(opts)
  const client = await page.target().createCDPSession()
  try {
    const result = await client.send(method, params)
    return { ok: true, method: method, result: result }
  } finally {
    try { await client.detach() } catch (e) {}
  }
}

module.exports = {
  attach: attach,
  detach: detach,
  attach_tab: attachTab,
  detach_tab: detachTab,
  list_aliases: listAliases,
  runJs: runJs,
  click: click,
  wait: wait,
  url: url_,
  navigate: navigate,
  text: text,
  queryAll: queryAll,
  pageScreenshot: pageScreenshot,
  listTabs: listTabs,
  selectTab: selectTab,
  clickText: clickText,
  fillByLabel: fillByLabel,
  cookies: cookies,
  setCookie: setCookie,
  viewport: viewport,
  scrollTo: scrollTo,
  networkLog: networkLog,
  pdf: pdf,
  send: sendCdp,
  realClick: realClick,
  deepFindRect: deepFindRect,
  nativeFill: nativeFill,
  findVisible: findVisible,
  clickByTag: clickByTag,
  helpers: helpers,
}
