const path = require('path')
const { homeDir } = require('../lib/platform')

const PROFILE_DIR = path.join(homeDir, '.eos-browser')
const CDP_URL = 'http://localhost:9222'
let browser = null
let page = null

async function ensureBrowser() {
  if (browser && browser.connected) return
  const puppeteer = require('puppeteer')

  // Try connecting to existing Chrome with remote debugging first
  try {
    browser = await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null })
    const pages = await browser.pages()
    page = pages[pages.length - 1] || await browser.newPage()
    return
  } catch(e) {}

  // Fall back: launch own browser (also enables remote debugging for next time)
  browser = await puppeteer.launch({
    headless: false,
    userDataDir: PROFILE_DIR,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--remote-debugging-port=9222'],
  })
  const pages = await browser.pages()
  page = pages[0] || await browser.newPage()
}

// Restart Chrome with remote debugging enabled (connects to user's Chrome profile)
async function enableCDP() {
  const { spawnSync, execSync } = require('child_process')
  try { execSync('taskkill /F /IM chrome.exe', { stdio: 'ignore' }) } catch(e) {}
  await new Promise(r => setTimeout(r, 1500))
  // Launch Chrome with CDP and user profile
  const { spawn } = require('child_process')
  spawn('chrome', ['--remote-debugging-port=9222', '--restore-last-session'], {
    detached: true, stdio: 'ignore', shell: true
  }).unref()
  await new Promise(r => setTimeout(r, 2500))
  browser = null
  page = null
  return { cdpEnabled: true, port: 9222, note: 'Chrome restarted with CDP. Call navigate() to use.' }
}

// Switch to a tab matching a URL pattern, or open new tab
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

async function navigate(p) {
  await ensureBrowser()
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
  if (browser) {
    await browser.close().catch(() => {})
    browser = null
    page = null
  }
  return { closed: true }
}

module.exports = { navigate, click, type, pageScreenshot, evaluate, close, enableCDP, switchTab }