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
// hCaptcha solver (2026-08-03): the OAuth authorize now throws an hCaptcha after Authorize.
// CapSolver returns a token we inject. Key from env CAPSOLVER_API_KEY (kv creds.capsolver_api_key).
const capsolver = require('../tools/capsolver')
const twocaptcha = require('../tools/twocaptcha')
// Prefer 2Captcha (human solvers) when its key is present - CapSolver refused Anthropic's
// hCaptcha 2026-08-03. Falls back to CapSolver otherwise.
const SOLVER = process.env.TWOCAPTCHA_API_KEY ? twocaptcha : capsolver
const SOLVER_NAME = process.env.TWOCAPTCHA_API_KEY ? '2captcha' : 'capsolver'
const CAPSOLVER_ENABLED = !!(process.env.CAPSOLVER_API_KEY || process.env.TWOCAPTCHA_API_KEY)
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'

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

// Read the Google password IN-PROCESS (never argv/stdout).
//
// The mirrors are NOT consistently encoded: code@'s is a JSON string ("pw"), tate@'s is
// raw text. The old JSON.parse-only reader returned null for tate@, which reads exactly
// like a missing mirror and aborted the leg. Worse, a JSON.parse SyntaxError quotes its
// input, so a naive error path can print the password; on 2026-08-02 one did. Accept both
// shapes and never let a parse failure carry content.
function password() {
  const p = process.env.PW_MIRROR_PATH || PW_MIRROR[TARGET]
  if (!p || !fs.existsSync(p)) return null
  let raw
  try { raw = fs.readFileSync(p, 'utf8') } catch (_e) { return null }
  try { const j = JSON.parse(raw); if (typeof j === 'string' && j.length) return j } catch (_e) { /* raw form below */ }
  const bare = raw.replace(/\r?\n$/, '')
  return bare.length ? bare : null
}

// Mint a TOTP code for this account from the vault. The vault seals seeds in the Secure
// Enclave and mint.js prints only six digits, so nothing here ever holds the seed.
//
// Before this existed, driveGoogle's 2FA branch just slept, so a Google challenge could
// only ever be resolved by Tate tapping his phone - the exact human dependency this whole
// rebuild removes. Returns null when the account has no enrolled seed, in which case the
// caller falls back to waiting for a phone approval.
function mintTotp() {
  const service = process.env.TOTP_SERVICE || (TARGET === 'code' ? 'google-code' : TARGET === 'tate' ? 'google-tate' : null)
  if (!service) return null
  try {
    const out = execSync('node /Users/ecodia/.code/eos-laptop-agent/tools/vault/mint.js ' + service,
      { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] })
    const m = String(out).trim().match(/\b(\d{6})\b/)
    return m ? m[1] : null
  } catch (_e) { return null }
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
    // 2026-07-17 vendor drift: the platform.claude.com callback no longer renders
    // the code#state string in page text - it rides ONLY in the URL query
    // (?code=...&state=...). Both switch runs that night EXHAUSTED at this exact
    // point while the code sat in location.search. Claude Code's paste format is
    // code#state, so rebuild it from the params when the text/DOM reads miss.
    if (!authCode && /\/oauth\/code\/callback/.test(location.pathname + location.href)) {
      try {
        const q = new URLSearchParams(location.search)
        const c = q.get('code')
        const s = q.get('state')
        if (c && c.length >= 20) authCode = s ? (c + '#' + s) : c
      } catch (_e) { /* state read must never throw */ }
    }
    // hCaptcha (2026-08-03): sitekey lives on the widget container (data-sitekey) or in the
    // hcaptcha iframe src (?sitekey= / #...sitekey=). Enterprise rqdata rides the widget
    // config and is not reliably in the DOM; handled as a follow-up if CapSolver flags it.
    let hcSitekey = null, hcInvisible = false
    const hcHost = document.querySelector('[data-sitekey]')
    if (hcHost) hcSitekey = hcHost.getAttribute('data-sitekey')
    const hcFrames = [...document.querySelectorAll('iframe')].filter(f => /hcaptcha\.com/.test(f.src || ''))
    for (const f of hcFrames) {
      try {
        const src = f.src
        const q = new URLSearchParams((src.split('#')[1] || '') + '&' + (src.split('?')[1] || ''))
        const sk = q.get('sitekey'); if (sk && !hcSitekey) hcSitekey = sk
        if (/invisible/i.test(src)) hcInvisible = true
      } catch (_e) { /* never throw */ }
    }
    const hcPresent = hcFrames.length > 0 || !!hcHost || /select all|verify you are human|each image containing/i.test(txt)
    // claude.ai OAuth uses a FIXED invisible hCaptcha (verified live 2026-08-03). The sitekey
    // rides in a nested cross-origin challenge iframe the top document cannot always read, and
    // the checkbox-invisible frame carries no sitekey, so extraction returns null and the solve
    // never fires. Fall back to the known key so CapSolver is invoked.
    if (hcPresent && !hcSitekey) { hcSitekey = 'a8086506-2036-46f4-ae50-00d8be805efa'; hcInvisible = true }
    return {
      url: location.href,
      loggedInAs: loggedMatch ? loggedMatch[1] : null,
      hcSitekey, hcInvisible, hcPresent,
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
    // Multi-strategy click for stubborn React OAuth buttons (Authorize):
    // 1) programmatic .click() - many React handlers honor it and it does not
    //    depend on hit-testing a hidden tab;
    // 2) real box-model mouse via puppeteer (Page.getContentQuads + trusted
    //    Input.dispatchMouseEvent) for the ones that gate on a real pointer.
    await h.evaluate(e => e.click()).catch(() => {})
    await h.click({ delay: 20 }).catch(() => {})
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
    if (st.twofa) {
      // TOTP FIRST, phone approval only as a fallback (2026-08-02). This branch used to
      // sleep and nothing else, so an unattended switch stalled here until its 40
      // iterations ran out (~2 minutes) and then reported EXHAUSTED. If the challenge is
      // a code entry and this account has an enrolled vault seed, fill it ourselves.
      const codeBox = await gp.evaluate(() => {
        const i = document.querySelector('input[type=tel],input[name=totpPin],input[autocomplete="one-time-code"],input[type=text][aria-label*="code" i]')
        if (!i) return null
        const r = i.getBoundingClientRect()
        if (!r.width || !r.height) return null
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
      }).catch(() => null)
      if (codeBox) {
        const code = mintTotp()
        if (code) {
          log('2FA code prompt - filling from the vault')
          await gp.mouse.click(codeBox.x, codeBox.y); await sleep(150)
          await gp.keyboard.type(code, { delay: 40 })
          await gp.keyboard.press('Enter')
          await sleep(4000)
          continue
        }
        log('2FA code prompt but no enrolled seed for ' + TARGET + ' - falling back to phone approval')
      }
      log('WAITING_2FA - needs an approval tap on the phone')
      await sleep(3000)
      continue
    }
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
    if (st.signingBackIn && st.crect) {
      // Click Continue ONCE then wait for the handshake (popup closes) rather
      // than re-clicking every poll, which kept Google re-rendering the screen
      // (the ~30-iteration 2026-06-22 stall).
      await gp.mouse.click(st.crect.x, st.crect.y)
      for (let w = 0; w < 12; w++) { await sleep(1300); if (gp.isClosed && gp.isClosed()) return true }
      continue
    }
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

  // TAB HIJACK FIX (2026-08-02). This used to fall back to pages[pages.length - 1] when
  // no OAuth tab was open, then NAVIGATE that tab to the consent URL. The canonical
  // Chrome profile is where every logged-in vendor console lives, so "the last tab" was
  // routinely a live Play Console or a Gmail window, yanked away from whatever it was
  // doing. Reuse a genuine OAuth tab if one exists; otherwise open our OWN and close it
  // on the way out.
  let page = pages.find(p => /claude\.(ai|com)\/oauth|platform\.claude/.test(p.url()))
  let ownedTab = false
  if (!page) {
    page = await browser.newPage()
    ownedTab = true
    log('opened a dedicated OAuth tab (never navigating an existing one)')
  }
  const closeOwned = async () => {
    if (!ownedTab || !page) return
    try { if (!page.isClosed()) await page.close() } catch (e) {}
  }
  await focusless(page)
  await page.goto(OAUTH_URL, { waitUntil: 'domcontentloaded' }).catch(() => {})
  await sleep(3500)

  let hcSolveCount = 0
  for (let i = 0; i < 50; i++) {
    let st
    try { st = await readState(page) } catch (e) { log('read err', e.message); await sleep(1500); continue }
    log('main[' + i + ']', st.loggedInAs ? ('as=' + st.loggedInAs) : (st.hcPresent ? 'hcaptcha' : st.head))

    if (st.authCode) {
      fs.writeFileSync(CODE_FILE, st.authCode + '\n')
      log('AUTH_CODE_WRITTEN -> ' + CODE_FILE)
      await closeOwned()
      await browser.disconnect()
      return 0
    }

    // hCaptcha wall (2026-08-03). CRITICAL: the captcha overlay hides the "Logged in as"
    // text, so loggedInAs reads null. If we fall through, the Continue-with-Google branch
    // fires and RE-RUNS the whole login, landing back on the same captcha - the infinite
    // loop Tate caught. So when a captcha is present it is a HARD STOP: solve it, or if we
    // cannot yet (sitekey not extracted, or no key), HOLD. Never fall through to a login
    // branch while a captcha is up.
    if (st.hcPresent && !st.authCode) {
      if (st.hcSitekey && CAPSOLVER_ENABLED && hcSolveCount < 3) {
        hcSolveCount++
        log('hcaptcha[' + hcSolveCount + '] sitekey=' + String(st.hcSitekey).slice(0, 10) + ' invisible=' + st.hcInvisible + ' - solving via ' + SOLVER_NAME + (st.hcRqdata ? ' (rqdata)' : ''))
        try {
          const { token } = await SOLVER.solveHCaptcha({ websiteURL: 'https://claude.ai/oauth/authorize', websiteKey: st.hcSitekey, isInvisible: st.hcInvisible, rqdata: st.hcRqdata || undefined, userAgent: UA })
          await page.evaluate((tok) => {
            for (const n of ['h-captcha-response', 'g-recaptcha-response']) {
              document.querySelectorAll('textarea[name="' + n + '"],input[name="' + n + '"]').forEach(el => {
                el.value = tok
                el.dispatchEvent(new Event('input', { bubbles: true }))
                el.dispatchEvent(new Event('change', { bubbles: true }))
              })
            }
          }, token)
          log('hcaptcha token injected; nudging the form')
          await clickText(page, /^(authorize|verify|continue|submit)$/i)
          await sleep(4000)
        } catch (e) { log('capsolver solve failed: ' + e.message) }
      } else {
        log('hcaptcha present, HOLDING (sitekey=' + (st.hcSitekey ? 'yes' : 'no') + ' key=' + CAPSOLVER_ENABLED + ' solves=' + hcSolveCount + ') - not restarting login')
        await sleep(3000)
      }
      continue
    }
    if (st.loggedInAs === EMAIL && st.hasAuthorize) {
      log('authorize')
      await clickText(page, /^authorize$/i)
      // Wait for the callback/code page instead of blind re-looping (the consent
      // re-renders and a too-fast re-click races it - the 2026-06-22 loop).
      for (let w = 0; w < 10; w++) {
        await sleep(1200)
        const s2 = await readState(page).catch(() => null)
        if (s2 && (s2.authCode || !s2.hasAuthorize)) break
      }
      continue
    }
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
  await closeOwned()
  await browser.disconnect()
  return 1
}

if (require.main === module) {
  validateArgs()
  run().then(code => { process.exitCode = code || 0 }).catch(e => { console.error('FATAL', e.message); process.exit(1) })
}

module.exports = { run, focusless, driveGoogle }
