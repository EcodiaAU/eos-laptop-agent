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
let connection = null  // { browser, page }
let connectedPort = null

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
  const c = await ensureConnected({ port: port })
  return {
    ok: true,
    port: port,
    chromeVersion: probe.version.Browser,
    protocolVersion: probe.version['Protocol-Version'],
    currentUrl: await c.page.url(),
    currentTitle: await c.page.title(),
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
    const c = await ensureConnected()
    const value = await Promise.race([
      c.page.evaluate(js),
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
  const c = await ensureConnected()
  await c.page.waitForSelector(selector, { timeout: timeout, visible: true })
  await c.page.click(selector)
  return { ok: true, clicked: selector }
}

async function wait(opts) {
  opts = opts || {}
  const selector = opts.selector
  const timeout = opts.timeout || 10000
  if (!selector) throw new Error('selector required')
  const c = await ensureConnected()
  const w = { timeout: timeout }
  if (opts.visible) w.visible = true
  if (opts.hidden) w.hidden = true
  await c.page.waitForSelector(selector, w)
  return { ok: true, found: selector }
}

async function url_() {
  const c = await ensureConnected()
  return { url: await c.page.url(), title: await c.page.title() }
}

async function navigate(opts) {
  opts = opts || {}
  const url = opts.url
  const waitUntil = opts.waitUntil || 'domcontentloaded'
  const timeout = opts.timeout || 30000
  if (!url) throw new Error('url required')
  const c = await ensureConnected()
  await c.page.goto(url, { waitUntil: waitUntil, timeout: timeout })
  return { ok: true, url: await c.page.url(), title: await c.page.title() }
}

async function text(opts) {
  opts = opts || {}
  const selector = opts.selector
  if (!selector) throw new Error('selector required')
  const c = await ensureConnected()
  await c.page.waitForSelector(selector, { timeout: 5000 })
  const txt = await c.page.$eval(selector, el => (el.textContent || '').trim())
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
  const c = await ensureConnected()
  const rows = await c.page.evaluate((sel, fld, lim) => {
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
  const c = await ensureConnected()
  const buf = await c.page.screenshot({ fullPage: fullPage, type: 'png' })
  return { image: buf.toString('base64'), format: 'png', fullPage: fullPage }
}

// List all tabs/pages, with index + url + title.
async function listTabs() {
  const c = await ensureConnected()
  const pages = await c.browser.pages()
  const tabs = []
  for (let i = 0; i < pages.length; i++) {
    try {
      tabs.push({ index: i, url: await pages[i].url(), title: await pages[i].title() })
    } catch (e) {
      tabs.push({ index: i, error: e.message })
    }
  }
  return { count: tabs.length, tabs: tabs }
}

// Switch the cached "current page" to a specific tab by index or url-substring.
async function selectTab(opts) {
  opts = opts || {}
  const c = await ensureConnected()
  const pages = await c.browser.pages()
  let target = null
  if (typeof opts.index === 'number') target = pages[opts.index]
  else if (opts.urlContains) {
    for (const p of pages) {
      if ((await p.url()).indexOf(opts.urlContains) !== -1) { target = p; break }
    }
  }
  if (!target) throw new Error('no matching tab')
  await target.bringToFront()
  connection.page = target
  return { ok: true, url: await target.url(), title: await target.title() }
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
  const c = await ensureConnected()
  const start = Date.now()
  let lastErr = ''
  while (Date.now() - start < timeout) {
    try {
      const result = await c.page.evaluate(function(args){
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
  const c = await ensureConnected()
  const result = await c.page.evaluate(function(args){
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
  const c = await ensureConnected()
  const all = await c.page.cookies()
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
  const c = await ensureConnected()
  if (!opts.name || typeof opts.value === 'undefined') throw new Error('name + value required')
  const cookie = { name: opts.name, value: String(opts.value) }
  if (opts.domain) cookie.domain = opts.domain
  if (opts.path) cookie.path = opts.path
  if (opts.url) cookie.url = opts.url
  if (typeof opts.expires === 'number') cookie.expires = opts.expires
  if (opts.httpOnly) cookie.httpOnly = true
  if (opts.secure) cookie.secure = true
  if (opts.sameSite) cookie.sameSite = opts.sameSite
  await c.page.setCookie(cookie)
  return { ok: true, set: opts.name }
}

// cdp.viewport - resize the page viewport (mobile emulation etc.)
async function viewport(opts) {
  opts = opts || {}
  const c = await ensureConnected()
  const width = opts.width || 1366
  const height = opts.height || 768
  const deviceScaleFactor = opts.deviceScaleFactor || 1
  const isMobile = !!opts.isMobile
  const hasTouch = !!opts.hasTouch
  await c.page.setViewport({ width: width, height: height, deviceScaleFactor: deviceScaleFactor, isMobile: isMobile, hasTouch: hasTouch })
  if (opts.userAgent) await c.page.setUserAgent(opts.userAgent)
  return { ok: true, viewport: { width: width, height: height, deviceScaleFactor: deviceScaleFactor, isMobile: isMobile, hasTouch: hasTouch } }
}

// cdp.scrollTo - scroll to selector or absolute y or bottom.
async function scrollTo(opts) {
  opts = opts || {}
  const c = await ensureConnected()
  if (opts.selector) {
    const found = await c.page.$(opts.selector)
    if (!found) return { ok: false, error: 'selector not found: ' + opts.selector }
    await c.page.evaluate(function(s){
      var el = document.querySelector(s)
      if (el) el.scrollIntoView({behavior:'instant', block:'center'})
    }, opts.selector)
    return { ok: true, scrolledTo: opts.selector }
  }
  if (typeof opts.y === 'number') {
    await c.page.evaluate(function(y){ window.scrollTo({top:y, behavior:'instant'}) }, opts.y)
    return { ok: true, scrolledTo: opts.y }
  }
  if (opts.bottom) {
    await c.page.evaluate(function(){ window.scrollTo({top: document.body.scrollHeight, behavior:'instant'}) })
    return { ok: true, scrolledTo: 'bottom' }
  }
  throw new Error('scrollTo requires selector, y, or bottom: true')
}

// cdp.networkLog - capture request/response summaries for a duration window.
async function networkLog(opts) {
  opts = opts || {}
  const captureMs = Math.min(opts.captureMs || 5000, 30000)
  const filter = opts.urlContains || null
  const c = await ensureConnected()
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
  c.page.on('request', onReq)
  c.page.on('response', onRes)
  await new Promise(r => setTimeout(r, captureMs))
  c.page.off('request', onReq)
  c.page.off('response', onRes)
  return { ok: true, captureMs: captureMs, eventCount: events.length, events: events.slice(0, 200) }
}

// cdp.pdf - export current page as PDF bytes (base64).
async function pdf(opts) {
  opts = opts || {}
  const c = await ensureConnected()
  try {
    const buf = await c.page.pdf({ format: opts.format || 'A4', printBackground: !!opts.printBackground })
    return { ok: true, pdfBase64: buf.toString('base64'), bytes: buf.length }
  } catch (e) {
    return { ok: false, error: 'pdf failed (often requires headless): ' + e.message }
  }
}

// cdp.send - raw DevTools Protocol passthrough. Power user surface.
async function sendCdp(opts) {
  opts = opts || {}
  const method = opts.method
  const params = opts.params || {}
  if (!method) throw new Error('method required')
  const c = await ensureConnected()
  const client = await c.page.target().createCDPSession()
  try {
    const result = await client.send(method, params)
    return { ok: true, method: method, result: result }
  } finally {
    try { await client.detach() } catch (e) {}
  }
}

module.exports = {
  attach: attach,
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
  detach: detach,
  clickText: clickText,
  fillByLabel: fillByLabel,
  cookies: cookies,
  setCookie: setCookie,
  viewport: viewport,
  scrollTo: scrollTo,
  networkLog: networkLog,
  pdf: pdf,
  send: sendCdp,
}
