#!/usr/bin/env node
// account-switch-browser.js - deterministic browser half of the Claude account switch.
//
// The CLI half (backend/scripts/account-login.sh) prints OAUTH_URL + CODE_FILE and
// waits. This script drives the claude.ai OAuth consent to completion and writes the
// auth code to CODE_FILE. It is DETERMINISTIC (no LLM clicking at fire time) so the
// account-cap-autoswitch cron can run it headless.
//
// Per-account login method (Tate 2026-06-22): code@ + tate@ = Google SSO, money@ =
// email magic-link (delivered to tate@'s mailbox via the SA; read with
// backend/scripts/eos-read-maglink-sa.js).
//
// FOCUSLESS (Tate 2026-06-22): every page is driven with
// Emulation.setFocusEmulationEnabled, NOT page.bringToFront(). bringToFront raises the
// OS window and steals focus from whatever the user is doing. setFocusEmulationEnabled
// makes the renderer behave as focused+active (React click handlers fire, layout is
// fresh) without ever raising the window. Google "Continue with Google" is a POPUP
// (ux_mode=popup) that postMessages the credential back to the opener, so we do NOT
// override window.open (that breaks the handshake); we poll for the popup page target
// and drive it focuslessly, then the opener completes.
//
// This file lives in scripts/ NOT tools/ - the laptop-agent auto-requires every file
// in tools/, and a CLI that process.exit()s at require time crash-loops the agent.
// Execution is also guarded by require.main === module as defence-in-depth.
//
// Usage:  OAUTH_URL=... CODE_FILE=... node account-switch-browser.js <tate|code|money>
'use strict'
const fs = require('fs')
const { execSync } = require('child_process')
const puppeteer = require('puppeteer-core')

const MAGLINK_HELPER = '/Users/ecodia/.code/ecodiaos/backend/scripts/eos-read-maglink-sa.js'

const TARGET = (process.argv[2] || '').trim()
const EMAILS = { tate: 'tate@ecodia.au', code: 'code@ecodia.au', money: 'money@ecodia.au' }
const PW_MIRROR = {
  tate: '/Users/ecodia/PRIVATE/ecodia-creds/kv-mirror/google_workspace_tate_password.json',
  code: '/Users/ecodia/PRIVATE/ecodia-creds/kv-mirror/google_workspace_code_password.json',
}
const EMAIL = EMAILS[TARGET]
const OAUTH_URL = process.env.OAUTH_URL
const CODE_FILE = process.env.CODE_FILE
const PORT = process.env.CDP_PORT || '9222'

const log = (...a) => console.log('[switch:' + TARGET + ']', ...a)
const sleep = ms => new Promise(r => setTimeout(r, ms))

function validateArgs() {
  if (!EMAIL) { console.error('usage: node account-switch-browser.js <tate|code|money>'); process.exit(2) }
  if (!OAUTH_URL || !CODE_FILE) { console.error('OAUTH_URL and CODE_FILE env required'); process.exit(2) }
}

// FOCUSLESS: make a page behave as focused+active without raising its window.
async function focusless(page) {
  try {
    const c = await page.target().createCDPSession()
    await c.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await c.detach().catch(() => {})
  } catch (_e) {}
}

// Read the Google password IN-PROCESS (never argv/stdout). Bare JSON string.
function password() {
  const p = PW_MIRROR[TARGET]
  if (!p || !fs.existsSync(p)) return null
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch (_e) { return null }
}

// State read against any claude.ai / Google page.
async function readState(page) {
  return page.evaluate(() => {
    const txt = (document.body ? document.body.innerText : '') || ''
    const btns = [].slice.call(document.querySelectorAll('button,[role=button],a'))
    const find = re => btns.find(b => re.test((b.innerText || '').trim()))
    const loggedMatch = txt.match(/Logged in as\s+([^\s]+@[^\s]+)/i)
    const switchA = btns.find(b => /switch account/i.test(b.innerText || '') && b.href)
    let authCode = null
    const codeEl = document.querySelector('textarea,input[readonly],code,div[jsname]')
    const m = txt.match(/[A-Za-z0-9/_-]{20,}#[A-Za-z0-9/_-]{20,}/)
    if (m) authCode = m[0]
    else if (codeEl && /^[A-Za-z0-9/_#-]{20,}$/.test((codeEl.value || codeEl.textContent || '').trim())) {
      authCode = (codeEl.value || codeEl.textContent || '').trim()
    }
    return {
      url: location.href,
      loggedInAs: loggedMatch ? loggedMatch[1] : null,
      hasAuthorize: !!find(/^authorize$/i),
      hasSwitch: !!switchA,
      switchHref: switchA ? switchA.href : null,
      hasContinueGoogle: !!find(/continue with google/i),
      hasContinueEmail: !!find(/continue with email/i),
      signingBackIn: /signing back in/i.test(txt),
      hasContinue: !!find(/^continue$/i),
      authCode,
      head: txt.slice(0, 80).replace(/\n/g, ' '),
    }
  })
}

// Click a button/link by visible text. Tags the element then uses puppeteer's
// native ElementHandle.click, which scrolls into view and computes the clickable
// point from the live box model (CDP) at click time - robust against the stale
// getBoundingClientRect coords a non-visible tab reports. Focusless throughout.
async function clickText(page, re) {
  await focusless(page)
  const ok = await page.evaluate((pattern) => {
    const r = new RegExp(pattern, 'i')
    const els = [].slice.call(document.querySelectorAll('button,[role=button],a'))
    const el = els.find(e => r.test((e.innerText || '').trim()))
    if (!el) return false
    document.querySelectorAll('[data-eos-click]').forEach(e => e.removeAttribute('data-eos-click'))
    el.setAttribute('data-eos-click', '1')
    return true
  }, re.source)
  if (!ok) return false
  try {
    const h = await page.$('[data-eos-click="1"]')
    if (!h) return false
    await h.evaluate(e => e.scrollIntoView({ block: 'center', inline: 'center' })).catch(() => {})
    await h.click({ delay: 20 })
    await page.evaluate(() => { const e = document.querySelector('[data-eos-click]'); if (e) e.removeAttribute('data-eos-click') }).catch(() => {})
    return true
  } catch (_e) {
    await page.evaluate(() => { const e = document.querySelector('[data-eos-click]'); if (e) e.removeAttribute('data-eos-click') }).catch(() => {})
    return false
  }
}

// Drive a Google GSI page (popup or same-tab) to select EMAIL + pass pw/2FA. Focusless.
async function driveGoogle(gp) {
  await focusless(gp)
  for (let i = 0; i < 40; i++) {
    if (gp.isClosed && gp.isClosed()) { log('google page closed (handshake done)'); return true }
    let st
    try {
      st = await gp.evaluate((email) => {
        const txt = (document.body ? document.body.innerText : '') || ''
        // Only an ACTUAL chooser row (carries the data-identifier attr). The loose
        // email text also shows on the "signing back in" confirm screen; matching it
        // there re-clicks the row and bounces back to the chooser (2026-06-22 loop).
        const row = [].slice.call(document.querySelectorAll('[data-identifier]'))
          .find(e => e.getAttribute('data-identifier') === email)
        let rrect = null
        if (row) { const b = row.getBoundingClientRect(); if (b.width > 40 && b.height > 20) rrect = { x: b.x + b.width / 2, y: b.y + b.height / 2 } }
        const pw = document.querySelector('input[type=password]')
        let pwrect = null
        if (pw) { const b = pw.getBoundingClientRect(); if (b.width > 20) pwrect = { x: b.x + b.width / 2, y: b.y + b.height / 2 } }
        const cont = [].slice.call(document.querySelectorAll('button,[role=button]')).find(b => /^(continue|next|yes|allow)$/i.test((b.innerText || '').trim()))
        let crect = null
        if (cont) { const b = cont.getBoundingClientRect(); if (b.width > 4) crect = { x: b.x + b.width / 2, y: b.y + b.height / 2 } }
        return {
          rrect, pwHere: !!pw, pwrect, contHere: !!cont, crect,
          signingBackIn: /signing back in/i.test(txt),
          twofa: /2-step|verification code|authenticator|check your phone|tap yes|approve this|security key|passkey/i.test(txt),
          head: txt.slice(0, 70).replace(/\n/g, ' '),
        }
      }, EMAIL)
    } catch (e) { if (gp.isClosed && gp.isClosed()) return true; log('google read err', e.message); await sleep(800); continue }

    log('google[' + i + ']', st.head)
    if (st.twofa) { log('WAITING_2FA - approve on iPhone (tate@)'); await sleep(3000); continue }
    if (st.pwHere && st.pwrect) {
      const pw = password()
      if (!pw) { log('NO_PASSWORD_MIRROR for ' + TARGET); return false }
      await gp.mouse.click(st.pwrect.x, st.pwrect.y); await sleep(200)
      await gp.keyboard.type(pw, { delay: 25 }); await sleep(200)
      if (st.crect) await gp.mouse.click(st.crect.x, st.crect.y)
      else await gp.keyboard.press('Enter')
      await sleep(3500); continue
    }
    // Confirm/Continue BEFORE row-click: on the "signing back in" screen a row
    // click would bounce us back to the chooser.
    if (st.signingBackIn && st.crect) { await gp.mouse.click(st.crect.x, st.crect.y); await sleep(2500); continue }
    if (st.rrect) { await gp.mouse.click(st.rrect.x, st.rrect.y); await sleep(2500); continue }
    if (st.contHere && st.crect) { await gp.mouse.click(st.crect.x, st.crect.y); await sleep(2500); continue }
    await sleep(1200)
  }
  return false
}

// After clicking Continue with Google, find the NEW accounts.google page target.
async function waitForGooglePopup(browser, knownIds) {
  for (let k = 0; k < 16; k++) {
    await sleep(600)
    const pages = await browser.pages()
    const fresh = pages.find(p => /accounts\.google\.com\/(v3\/signin|signin|o\/oauth)/.test(p.url()) && !knownIds.has(p.target()._targetId))
    if (fresh) return fresh
  }
  return null
}

async function run() {
  const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:' + PORT, defaultViewport: null })
  const pages = await browser.pages()
  let page = pages.find(p => /claude\.(ai|com)\/oauth|platform\.claude/.test(p.url())) || pages[pages.length - 1]
  await focusless(page)
  await page.goto(OAUTH_URL, { waitUntil: 'domcontentloaded' }).catch(() => {})
  await sleep(3500)

  for (let i = 0; i < 50; i++) {
    let st
    try { st = await readState(page) } catch (e) { log('read err', e.message); await sleep(1500); continue }
    log('main[' + i + ']', st.loggedInAs ? ('as=' + st.loggedInAs) : st.head)

    if (st.authCode) {
      fs.writeFileSync(CODE_FILE, st.authCode + '\n')
      log('AUTH_CODE_WRITTEN -> ' + CODE_FILE)
      await browser.disconnect()
      return 0
    }
    if (st.loggedInAs === EMAIL && st.hasAuthorize) { log('authorize'); await clickText(page, /^authorize$/i); await sleep(3500); continue }
    if (st.loggedInAs && st.loggedInAs !== EMAIL && st.switchHref) { log('switch-account (logout) ->'); await page.goto(st.switchHref, { waitUntil: 'domcontentloaded' }).catch(() => {}); await focusless(page); await sleep(3000); continue }
    if (st.hasContinue && st.signingBackIn) { await clickText(page, /^continue$/i); await sleep(3000); continue }

    if (st.hasContinueGoogle && (TARGET === 'tate' || TARGET === 'code')) {
      const before = await browser.pages()
      const knownIds = new Set(before.map(p => p.target()._targetId))
      await clickText(page, /continue with google/i)
      let gp = await waitForGooglePopup(browser, knownIds)
      if (!gp && /accounts\.google/.test(page.url())) gp = page // same-tab fallback
      if (gp) { log('GSI google page acquired'); await driveGoogle(gp) }
      else { log('NO_GOOGLE_TARGET after Continue with Google') }
      await sleep(3500)
      await page.goto(OAUTH_URL, { waitUntil: 'domcontentloaded' }).catch(() => {})
      await focusless(page)
      await sleep(3500)
      continue
    }

    if (st.hasContinueEmail && TARGET === 'money') {
      // money@ is a tate@ alias: EMAIL magic-link only. Link lands in tate@'s
      // mailbox, read via the Workspace SA (eos-read-maglink-sa.js).
      log('money: Continue with email')
      await clickText(page, /continue with email/i)
      await sleep(3000)
      await focusless(page)
      const es = await page.evaluate((email) => {
        const inp = document.querySelector('input[type=email],input[name=email],input[autocomplete=email]')
        const sent = /check your (email|inbox)|magic link|we (just )?(sent|emailed)|verify your email/i.test((document.body && document.body.innerText) || '')
        if (inp && !inp.value) inp.setAttribute('data-eos-email', '1')
        return { hasInput: !!inp, filled: inp ? !!inp.value : false, sent }
      }, EMAIL)
      log('money email-step: ' + JSON.stringify(es))
      if (es.hasInput && !es.filled) {
        try { const h = await page.$('[data-eos-email="1"]'); if (h) { await h.click(); await page.keyboard.type(EMAIL, { delay: 20 }) } } catch (_e) {}
        await sleep(500)
      }
      if (!es.sent) { await clickText(page, /^(continue|next|send magic link|log in|sign in|continue with email)$/i); await sleep(4500) }
      // Poll the SA mailbox for the fresh magic link.
      let link = null
      for (let k = 0; k < 14; k++) {
        try {
          const out = execSync('node ' + MAGLINK_HELPER + ' 2>/dev/null', { timeout: 25000 }).toString()
          const m = out.match(/MAGIC_LINK=(\S+)/)
          if (m) { link = m[1]; break }
        } catch (_e) {}
        await sleep(4000)
      }
      if (!link) { log('NO_MAGIC_LINK from SA mailbox after polling'); await sleep(2000); continue }
      log('money magic-link acquired; navigating it')
      await page.goto(link, { waitUntil: 'domcontentloaded' }).catch(() => {})
      await focusless(page); await sleep(4000)
      await page.goto(OAUTH_URL, { waitUntil: 'domcontentloaded' }).catch(() => {})
      await focusless(page); await sleep(3500)
      continue
    }

    await sleep(1500)
  }
  log('EXHAUSTED without writing code')
  await browser.disconnect()
  return 1
}

if (require.main === module) {
  validateArgs()
  run().then(code => { process.exitCode = code || 0 }).catch(e => { console.error('FATAL', e.message); process.exit(1) })
}

module.exports = { run, focusless, driveGoogle }
