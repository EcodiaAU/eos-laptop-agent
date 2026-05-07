const path = require('path')
const fs = require('fs')
const { homeDir } = require('../lib/platform')

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

// 29 Apr 2026 hard guard: NEVER launch Chrome with an isolated profile.
// Past failure mode (PID 27804 audit, 12:50 AEST today): a stale build / external code
// path launched chrome.exe with --user-data-dir=C:\Users\tjdTa\.eos-cdp-profile, an
// isolated profile with no Tate logins, no Google password manager. browser.* tools then
// silently delivered a useless logged-out browser. Refuse-to-launch is the only safe
// behaviour: if userDataDir resolves to anything that is NOT Tate's real Default profile,
// throw loudly so the failure is visible instead of producing wrong results.
const FORBIDDEN_PROFILE_FRAGMENTS = [
  'eos-cdp-profile',
  'eos-browser',
  '.cache\\puppeteer',
  '.cache/puppeteer',
  'puppeteer_dev_chrome_profile',
]
function assertProfileIsTates(userDataDir) {
  const lower = String(userDataDir || '').toLowerCase()
  if (!lower) {
    throw new Error('Refusing to launch Chrome: userDataDir is empty. Must be Tate Default Chrome profile path.')
  }
  for (const frag of FORBIDDEN_PROFILE_FRAGMENTS) {
    if (lower.includes(frag.toLowerCase())) {
      throw new Error(
        'Refusing to launch Chrome with isolated/forbidden profile path: ' + userDataDir + '. ' +
        'browser.* tools must always attach to Tate Default Chrome profile at LOCALAPPDATA/Google/Chrome/User Data. ' +
        'Forbidden fragment matched: ' + frag + '. ' +
        'Set CHROME_USER_DATA_DIR to the real Chrome path or unset it to use the default.'
      )
    }
  }
}

async function ensureBrowser() {
  if (browser && browser.connected) return
  const puppeteer = require('puppeteer')

  // Try connect to existing CDP endpoint (Tate real Chrome). Fast-path idempotent return.
  try {
    browser = await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null })
    const pages = await browser.pages()
    page = pages[pages.length - 1] || await browser.newPage()
    return
  } catch(e) {}

  // No CDP available - bootstrap Tate Chrome via enableCDP, then retry connect.
  // 29 Apr 2026 patch: removed puppeteer.launch fallback to isolated profile (~/.eos-browser).
  // The isolated-profile fallback meant any caller invoking browser.navigate without prior
  // enableCDP would silently get a fresh isolated Chromium with no Tate logins. Now we
  // ALWAYS bootstrap Tate real Chrome instead. If chrome is not in PATH or port 9222
  // can not bind, throw rather than silently fall back.
  await enableCDP()
  await new Promise(r => setTimeout(r, 1500))
  try {
    browser = await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null })
    const pages = await browser.pages()
    page = pages[pages.length - 1] || await browser.newPage()
    return
  } catch(e) {
    throw new Error('Failed to attach to Chrome via CDP after enableCDP bootstrap. Chrome may not be in PATH, or port 9222 can not bind. Diagnostic: ' + e.message)
  }
}

// enableCDP - 29 Apr 2026 12:40 patch + hard-profile-guard.
// Idempotent: if CDP already up at :9222, return immediately preserving existing Chrome.
// Otherwise: kill all chrome.exe, clear singleton locks, launch with EXPLICIT
// LOCALAPPDATA/Google/Chrome/User Data + Default profile, poll /json/version for up to 10s.
// Hard guard: refuses to launch if userDataDir resolves to any forbidden isolated-profile
// fragment (eos-cdp-profile, eos-browser, .cache/puppeteer, etc.).
async function enableCDP() {
  const puppeteer = require('puppeteer')

  // Step 1: probe - is CDP already up?
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
    // not available, proceed to launch
  }

  const { spawn } = require('child_process')

  // Step 2: kill all chrome + clear singleton locks
  try { require('child_process').spawnSync('taskkill', ['/F', '/IM', 'chrome.exe'], { stdio: 'ignore', windowsHide: true, shell: false, creationFlags: 0x08000000 }) } catch(e) {}
  await new Promise(r => setTimeout(r, 2000))

  const localAppData = process.env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local')
  const userDataDir = process.env.CHROME_USER_DATA_DIR || path.join(localAppData, 'Google', 'Chrome', 'User Data')

  // HARD GUARD: refuse isolated-profile paths. Failing loudly is correct behaviour.
  assertProfileIsTates(userDataDir)

  for (const lockFile of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { fs.unlinkSync(path.join(userDataDir, lockFile)) } catch(e) {}
  }

  // Step 3: launch chrome with full arg list
  const profileDir = process.env.CHROME_PROFILE_DIR || 'Default'
  const chromeArgs = [
    '--remote-debugging-port=9222',
    '--remote-allow-origins=*',
    '--user-data-dir=' + userDataDir,
    '--profile-directory=' + profileDir,
    '--no-first-run',
    '--no-default-browser-check',
    '--restore-last-session',
  ]
  // Find chrome.exe explicitly - relying on PATH is fragile
  let chromeExe = 'chrome'
  const candidatePaths = [
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ]
  for (const cp of candidatePaths) {
    try { fs.accessSync(cp, fs.constants.X_OK); chromeExe = cp; break } catch(e) {}
  }
  spawn(chromeExe, chromeArgs, {
    detached: true,
    stdio: 'ignore',
    shell: false,
    windowsHide: false,
    creationFlags: 0x00000008, // DETACHED_PROCESS - chrome runs separate from agent console tree
  }).unref()

  // Step 4: poll /json/version for up to 10s
  const start = Date.now()
  const probeUrl = 'http://127.0.0.1:9222/json/version'
  let lastErr = null
  while (Date.now() - start < 10000) {
    try {
      let body
      if (typeof fetch === 'function') {
        const res = await fetch(probeUrl, { signal: AbortSignal.timeout(2000) })
        body = await res.text()
      } else {
        body = await new Promise((resolve, reject) => {
          const http = require('http')
          const req = http.get(probeUrl, (res) => {
            let data = ''
            res.on('data', (chunk) => { data += chunk })
            res.on('end', () => resolve(data))
          })
          req.on('error', reject)
          req.setTimeout(2000, () => req.destroy(new Error('timeout')))
        })
      }
      if (body && body.includes('webSocketDebuggerUrl')) {
        browser = null
        page = null
        return {
          cdpEnabled: true,
          port: 9222,
          killedAndRespawned: true,
          profileDir,
          userDataDir,
          chromeExe,
          probeMs: Date.now() - start,
          note: 'Chrome killed and restarted, CDP verified bound to :9222.',
        }
      }
    } catch (e) {
      lastErr = e
    }
    await new Promise(r => setTimeout(r, 500))
  }

  // Step 5: probe failed - return false with diagnostic
  return {
    cdpEnabled: false,
    port: 9222,
    error: 'Chrome launched but CDP probe at /json/version did not respond within 10s.',
    lastProbeError: lastErr ? lastErr.message : null,
    chromeExe,
    userDataDir,
    profileDir,
    note: 'Manual debugging needed. Check: chrome.exe in candidatePaths, SingletonLock files, port 9222 conflict.',
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

async function close() {
  // CRITICAL: when browser was attached via puppeteer.connect (CDP-attach), browser.close()
  // sends the close command to the underlying Chrome - which kills Tate actual Chrome window.
  // Use disconnect() instead to sever the puppeteer<->CDP link without closing Chrome.
  // When browser was launched via puppeteer.launch (we own the process), close() is correct.
  // browser.process() returns null for connect-attached, the child process for launch-spawned.
  if (browser) {
    try {
      if (browser.process() === null) {
        // CDP-attached - disconnect only, do NOT close Tate Chrome
        await browser.disconnect()
      } else {
        // Owned subprocess - close is correct
        await browser.close()
      }
    } catch (e) { /* swallow */ }
    browser = null
    page = null
  }
  return { closed: true, kept_chrome_open: true }
}

module.exports = { navigate, click, type, pageScreenshot, evaluate, close, enableCDP, switchTab, setViewport, waitFor }
