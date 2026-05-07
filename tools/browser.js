// browser.js - eos-laptop-agent Puppeteer wrapper
//
// 29 Apr 2026 14:24 AEST surgical-no-spawn-no-kill patch.
//
// THIS MODULE ONLY ATTACHES TO EXISTING CHROME WITH CDP ON :9222.
// IT DOES NOT LAUNCH CHROME. IT DOES NOT KILL CHROME.
//
// Why: launching Chrome from PM2 (Windows Session 0, the service session) cannot
// reliably bind --remote-debugging-port=9222 with Tate logged-in profile. Past
// failure modes included: spawning an isolated profile that silently shipped a
// logged-out browser to callers; killing Tate live Chrome window when a CDP-attach
// caller exited; PM2-spawned chrome.exe binding 9222 in Session 0 with no Tate
// authenticated state. The only safe contract is: agent never touches Chrome
// process lifecycle. Chrome must be launched in Tate interactive session (Session 1)
// by Tate himself, or by the conductor via input.* / shell.shell calls that target
// the user session.
//
// If port 9222 is not bound when a browser.* tool is called, return a clean error
// and let the caller bring Chrome up. See pattern:
//   ~/ecodiaos/patterns/chrome-cdp-attach-requires-explicit-user-data-dir-and-singleton-clear.md

const CDP_URL = 'http://localhost:9222'
let browser = null
let page = null

const VIEWPORTS = {
  iphone: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
  pixel: { width: 412, height: 915, deviceScaleFactor: 3, isMobile: true, hasTouch: true, ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36' },
  ipad: { width: 820, height: 1180, deviceScaleFactor: 2, isMobile: true, hasTouch: true, ua: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false, ua: null },
  tablet: { width: 768, height: 1024, deviceScaleFactor: 2, isMobile: true, hasTouch: true, ua: null },
}

// ensureBrowser - attach to existing CDP only. Never launch, never kill.
async function ensureBrowser() {
  if (browser && browser.connected) return
  const puppeteer = require('puppeteer')
  try {
    browser = await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null })
    const pages = await browser.pages()
    page = pages[pages.length - 1] || await browser.newPage()
    return
  } catch (e) {
    browser = null
    page = null
    throw new Error(
      'Chrome with CDP not available on :9222. Run enableCDP first OR launch Chrome manually with --remote-debugging-port=9222 in Tate interactive session. ' +
      'Underlying connect error: ' + (e && e.message ? e.message : String(e))
    )
  }
}

// enableCDP - probe-only. Returns true if Chrome already exposes CDP on :9222,
// false with a clear error otherwise. Does not kill chrome.exe. Does not spawn
// chrome.exe. Does not touch SingletonLock files.
async function enableCDP() {
  const puppeteer = require('puppeteer')
  try {
    const test = await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null })
    await test.disconnect()
    return {
      cdpEnabled: true,
      port: 9222,
      alreadyRunning: true,
      note: 'CDP already available at :9222, existing Chrome session preserved (idempotent).',
    }
  } catch (e) {
    return {
      cdpEnabled: false,
      port: 9222,
      error: 'CDP not bound on :9222. Tate must launch Chrome interactively with --remote-debugging-port=9222 in HIS user session. Agent is in Session 0 and cannot bind from here. See ~/ecodiaos/patterns/chrome-cdp-attach-requires-explicit-user-data-dir-and-singleton-clear.md for manual launch command.',
      probeError: e && e.message ? e.message : String(e),
    }
  }
}

async function switchTab(p) {
  await ensureBrowser()
  const pages = await browser.pages()
  if (p.url) {
    for (const pg of pages) {
      if (pg.url().includes(p.url)) { page = pg; await page.bringToFront(); return { switched: true, url: pg.url() } }
    }
    page = await browser.newPage()
  }
  return { switched: false, opened: true }
}

async function setViewport(p) {
  await ensureBrowser()
  p = p || {}
  let v
  if (p.preset && VIEWPORTS[p.preset]) v = { ...VIEWPORTS[p.preset] }
  else v = { width: p.width || 1440, height: p.height || 900, deviceScaleFactor: p.deviceScaleFactor || 1, isMobile: !!p.isMobile, hasTouch: !!p.hasTouch, ua: p.ua || null }
  if (typeof p.width === 'number') v.width = p.width
  if (typeof p.height === 'number') v.height = p.height
  if (typeof p.deviceScaleFactor === 'number') v.deviceScaleFactor = p.deviceScaleFactor
  if (typeof p.isMobile === 'boolean') v.isMobile = p.isMobile
  if (typeof p.hasTouch === 'boolean') v.hasTouch = p.hasTouch
  if (typeof p.ua === 'string') v.ua = p.ua
  await page.setViewport({ width: v.width, height: v.height, deviceScaleFactor: v.deviceScaleFactor, isMobile: v.isMobile, hasTouch: v.hasTouch })
  if (v.ua) await page.setUserAgent(v.ua)
  return { applied: { width: v.width, height: v.height, isMobile: v.isMobile, hasTouch: v.hasTouch, ua: v.ua ? v.ua.slice(0,60)+'...' : null }, preset: p.preset || null }
}

async function navigate(p) {
  await ensureBrowser()
  if (p.viewport || p.preset) {
    await setViewport(p.viewport ? p.viewport : { preset: p.preset })
  }
  const waitUntil = p.waitUntil || 'networkidle2'
  const timeout = p.timeout || 30000
  await page.goto(p.url, { waitUntil, timeout })
  return { url: page.url(), title: await page.title() }
}

async function click(p) {
  await ensureBrowser()
  if (p.text) {
    const clicked = await page.evaluate((t) => {
      const els = [...document.querySelectorAll('a, button, [role="button"], input[type="submit"]')]
      const el = els.find(e => e.textContent.trim().includes(t))
      if (el) { el.click(); return true }
      return false
    }, p.text)
    return { clicked, by: 'text', text: p.text }
  }
  await page.click(p.selector)
  return { clicked: true, by: 'selector', selector: p.selector }
}

async function type(p) {
  await ensureBrowser()
  await page.type(p.selector, p.text, { delay: p.delay || 0 })
  return { typed: true, selector: p.selector, length: p.text.length }
}

async function waitFor(p) {
  await ensureBrowser()
  const timeout = p.timeout || 10000
  if (p.selector) {
    await page.waitForSelector(p.selector, { timeout, visible: p.state === 'visible', hidden: p.state === 'hidden' })
    return { waited: true, by: 'selector', selector: p.selector }
  }
  if (p.function) {
    await page.waitForFunction(new Function('return (' + p.function + ')'), { timeout })
    return { waited: true, by: 'function' }
  }
  await new Promise(r => setTimeout(r, p.ms || 500))
  return { waited: true, by: 'ms', ms: p.ms || 500 }
}

async function pageScreenshot(p) {
  await ensureBrowser()
  p = p || {}
  let target = page
  if (p.selector) target = await page.$(p.selector)
  const buffer = await (target || page).screenshot({ fullPage: p.fullPage || false, encoding: 'base64' })
  return { image: buffer, format: 'png', url: page.url() }
}

async function evaluate(p) {
  await ensureBrowser()
  const result = await page.evaluate(new Function('return (' + p.script + ')'))
  return { result }
}

// close - severs the puppeteer<->CDP link only. NEVER calls browser.close()
// because that would kill Tate live Chrome window. The agent does not own
// the Chrome process; it is always attached via CDP. The owned-subprocess
// branch from earlier versions is removed because no code path in this module
// spawns Chrome anymore.
async function close() {
  if (browser) {
    try { await browser.disconnect() } catch (e) { /* swallow */ }
    browser = null
    page = null
  }
  return { closed: true, kept_chrome_open: true }
}

module.exports = { navigate, click, type, pageScreenshot, evaluate, close, enableCDP, switchTab, setViewport, waitFor }
