const path = require('path')
const { homeDir } = require('../lib/platform')

const PROFILE_DIR = path.join(homeDir, '.eos-browser')
let browser = null
let page = null

async function ensureBrowser() {
  if (browser && browser.connected) return
  const puppeteer = require('puppeteer')
  browser = await puppeteer.launch({
    headless: false,
    userDataDir: PROFILE_DIR,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })
  const pages = await browser.pages()
  page = pages[0] || await browser.newPage()
}

async function navigate({ url, waitUntil = 'networkidle2', timeout = 30000 }) {
  await ensureBrowser()
  await page.goto(url, { waitUntil, timeout })
  return { url: page.url(), title: await page.title() }
}

async function click({ selector, text }) {
  await ensureBrowser()
  if (text) {
    const clicked = await page.evaluate((t) => {
      const els = [...document.querySelectorAll('a, button, [role="button"], input[type="submit"]')]
      const el = els.find(e => e.textContent.trim().includes(t))
      if (el) { el.click(); return true }
      return false
    }, text)
    return { clicked, by: 'text', text }
  }
  await page.click(selector)
  return { clicked: true, by: 'selector', selector }
}

async function type({ selector, text, delay = 0 }) {
  await ensureBrowser()
  await page.type(selector, text, { delay })
  return { typed: true, selector, length: text.length }
}

async function pageScreenshot({ fullPage = false, selector }) {
  await ensureBrowser()
  let target = page
  if (selector) target = await page.$(selector)
  const buffer = await (target || page).screenshot({ fullPage, encoding: 'base64' })
  return { image: buffer, format: 'png', url: page.url() }
}

async function evaluate({ script }) {
  await ensureBrowser()
  const result = await page.evaluate(new Function('return (' + script + ')'))
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

module.exports = { navigate, click, type, pageScreenshot, evaluate, close }
