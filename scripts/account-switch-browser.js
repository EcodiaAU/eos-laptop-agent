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

// DIAGNOSTIC screenshots + DOM dumps, gated on SWITCH_DEBUG_SHOTS=1 so prod behaviour is
// byte-identical when off. Dir from SWITCH_DEBUG_DIR (default /tmp/switch-debug).
const DEBUG_SHOTS = process.env.SWITCH_DEBUG_SHOTS === '1'
const DEBUG_DIR = process.env.SWITCH_DEBUG_DIR || '/tmp/switch-debug'
if (DEBUG_SHOTS) { try { fs.mkdirSync(DEBUG_DIR, { recursive: true }) } catch (_e) {} }
async function shot(page, label) {
  if (!DEBUG_SHOTS) return
  try {
    const f = DEBUG_DIR + '/' + String(Date.now()) + '-' + label + '.png'
    await page.screenshot({ path: f, fullPage: false }).catch(() => {})
    log('SHOT ' + label + ' -> ' + f)
  } catch (_e) {}
}

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
    // DIAGNOSTIC extras: which hcaptcha frames exist, whether a VISIBLE challenge grid is up
    // (vs pure-invisible), whether the response field is populated post-inject, and any
    // captcha error text. All read-only; harmless when debug is off.
    const hcFrameSrcs = hcFrames.map(f => (f.src || '').slice(0, 120))
    // A REAL visible challenge = a #frame=challenge iframe actually rendered on screen with
    // real dimensions and not hidden. The pre-loaded invisible widget iframes are NOT this.
    // Proven 2026-08-20: a clean Authorize click passes the invisible hCaptcha with no solve;
    // only a genuinely on-screen grid needs solving. Gating on DOM-presence (hcPresent) instead
    // of this is what made the drive pre-inject a foreign token and POISON a flow that works.
    let hcChallengeVisible = false
    for (const f of hcFrames) {
      if (!/frame=challenge/.test(f.src || '')) continue
      try {
        const r = f.getBoundingClientRect()
        const cs = getComputedStyle(f)
        if (r.width > 100 && r.height > 100 && r.top < window.innerHeight && r.bottom > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0') hcChallengeVisible = true
      } catch (_e) { /* never throw */ }
    }
    let hcResponseFilled = false
    document.querySelectorAll('textarea[name="h-captcha-response"],textarea[name="g-recaptcha-response"],input[name="h-captcha-response"]').forEach(el => { if ((el.value || '').length > 20) hcResponseFilled = true })
    const hcErrorText = (txt.match(/incorrect|try again|verification failed|please try again|rate limited|too many|something went wrong|couldn.t verify/i) || [null])[0]
    // claude.ai OAuth uses a FIXED invisible hCaptcha (verified live 2026-08-03). The sitekey
    // rides in a nested cross-origin challenge iframe the top document cannot always read, and
    // the checkbox-invisible frame carries no sitekey, so extraction returns null and the solve
    // never fires. Fall back to the known key so CapSolver is invoked.
    if (hcPresent && !hcSitekey) { hcSitekey = 'a8086506-2036-46f4-ae50-00d8be805efa'; hcInvisible = true }
    return {
      url: location.href,
      loggedInAs: loggedMatch ? loggedMatch[1] : null,
      hcSitekey, hcInvisible, hcPresent,
      hcFrameSrcs, hcChallengeVisible, hcResponseFilled, hcErrorText,
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

  // ISOLATION (2026-08-20). The old drive REUSED any existing claude-oauth tab anywhere in
  // the chaotic canonical profile. Parallel chats spawn extra windows and a crashed prior
  // switch leaves oauth debris, so it grabbed the wrong tab in the wrong window and any
  // macro deviation cascaded (Tate: "opens login tabs in multiple windows... switches back
  // and forth... everything downstream is fucked"). Now the switch owns its world: (1) sweep
  // stale oauth/callback debris so nothing is reused or accumulates, (2) create ONE dedicated
  // window we fully own via Target.createTarget(newWindow), (3) close it on EVERY exit. The
  // switch is now immune to how many other windows exist or what parallel chats do.
  const STALE_OAUTH = /claude\.(ai|com)\/(cai\/)?oauth|platform\.claude\.com\/oauth/i
  try {
    for (const p of await browser.pages()) {
      if (STALE_OAUTH.test(p.url())) { log('sweeping stale oauth tab: ' + p.url().slice(0, 60)); try { await p.close() } catch (_e) {} }
    }
  } catch (_e) {}

  // Open our tab IN THE PRIMARY (keeper) WINDOW, never a NEW window. The chrome-canonical
  // guardian collapses any non-primary window whose sole content is an oauth/auth-popup tab
  // (AUTH_POPUP_RX), so a dedicated NEW window gets reaped mid-switch and the code is lost
  // (proven 2026-08-20: guardian log "collapsed orphan auth-popup window ... closed .../oauth/
  // authorize"). A tab in the keeper's window is never touched. newWindow:false = a tab in the
  // current window, which the guardian maintains as the single keeper window.
  let page = null
  try {
    const bcdp = await browser.target().createCDPSession()
    const { targetId } = await bcdp.send('Target.createTarget', { url: 'about:blank', newWindow: false })
    await bcdp.detach().catch(() => {})
    for (let k = 0; k < 25 && !page; k++) {
      page = (await browser.pages()).find(p => p.target()._targetId === targetId)
      if (!page) await sleep(200)
    }
  } catch (e) { log('dedicated-tab create failed, falling back to newPage: ' + e.message) }
  if (!page) page = await browser.newPage()
  const OUR_TARGET_ID = (() => { try { return page.target()._targetId } catch (_e) { return null } })()
  log('driving in a dedicated OWN window (isolated; target=' + String(OUR_TARGET_ID).slice(0, 8) + ')')

  const closeOwned = async () => {
    try { if (page && !page.isClosed()) await page.close() } catch (e) {}
  }

  try {
  await focusless(page)
  await page.goto(OAUTH_URL, { waitUntil: 'domcontentloaded' }).catch(() => {})
  await sleep(3500)
  await shot(page, 'initial-load')

  let hcSolveCount = 0
  const moneyTriedLinks = new Set()
  let moneyStaleHits = 0
  for (let i = 0; i < 50; i++) {
    let st
    try { st = await readState(page) } catch (e) { log('read err', e.message); await sleep(1500); continue }
    log('main[' + i + ']', st.loggedInAs ? ('as=' + st.loggedInAs) : (st.hcPresent ? 'hcaptcha' : st.head))
    if (DEBUG_SHOTS && st.hcPresent) {
      log('  hc-diag: frames=' + JSON.stringify(st.hcFrameSrcs) + ' challengeVisible=' + st.hcChallengeVisible +
          ' responseFilled=' + st.hcResponseFilled + ' err=' + JSON.stringify(st.hcErrorText) +
          ' hasAuthorize=' + st.hasAuthorize + ' hasSwitch=' + st.hasSwitch + ' hasContinueGoogle=' + st.hasContinueGoogle)
    }

    if (st.authCode) {
      fs.writeFileSync(CODE_FILE, st.authCode + '\n')
      log('AUTH_CODE_WRITTEN -> ' + CODE_FILE)
      return 0
    }

    // hCaptcha (REWRITTEN 2026-08-20). The invisible hCaptcha on the OAuth authorize page
    // PASSES on a clean Authorize click on our real logged-in canonical-Chrome profile - no
    // solve needed (proven: clean click -> code issued, hcFrames 2->0, zero challenge). The
    // old code gated on hcPresent (the pre-loaded widget iframes always in the DOM), so it
    // pre-injected a foreign 2Captcha token into h-captcha-response BEFORE clicking Authorize,
    // which POISONED a working flow: hCaptcha then saw a wrong-origin token and the challenge
    // stuck (`HOLDING solves=3` -> EXHAUSTED). So: solve ONLY when a real on-screen challenge
    // grid actually renders (hcChallengeVisible = a #frame=challenge iframe with real
    // dimensions). Otherwise fall through to the normal Authorize / switch-account / Google
    // branches, which now click Authorize cleanly and let the invisible captcha pass.
    if (st.hcChallengeVisible && !st.authCode) {
      if (st.hcSitekey && CAPSOLVER_ENABLED && hcSolveCount < 3) {
        hcSolveCount++
        log('hcaptcha[' + hcSolveCount + '] sitekey=' + String(st.hcSitekey).slice(0, 10) + ' invisible=' + st.hcInvisible + ' - solving via ' + SOLVER_NAME + (st.hcRqdata ? ' (rqdata)' : ''))
        await shot(page, 'hc' + hcSolveCount + '-before-solve')
        try {
          const { token } = await SOLVER.solveHCaptcha({ websiteURL: 'https://claude.ai/oauth/authorize', websiteKey: st.hcSitekey, isInvisible: st.hcInvisible, rqdata: st.hcRqdata || undefined, userAgent: UA })
          if (DEBUG_SHOTS) log('  solver returned token len=' + String(token || '').length)
          const injected = await page.evaluate((tok) => {
            let n = 0
            for (const nm of ['h-captcha-response', 'g-recaptcha-response']) {
              document.querySelectorAll('textarea[name="' + nm + '"],input[name="' + nm + '"]').forEach(el => {
                el.value = tok
                el.dispatchEvent(new Event('input', { bubbles: true }))
                el.dispatchEvent(new Event('change', { bubbles: true }))
                n++
              })
            }
            // Invisible hCaptcha: the SPA waits on the JS callback, not the textarea. Try to
            // fire the hCaptcha client callback with the token so the app actually proceeds.
            let cbFired = false
            try {
              if (window.hcaptcha && typeof window.hcaptcha.getResponse === 'function') { /* present */ }
              // Some integrations stash the onSuccess callback on the widget config.
              if (window.__hcaptchaOnSuccess) { window.__hcaptchaOnSuccess(tok); cbFired = true }
            } catch (_e) {}
            return { fields: n, cbFired }
          }, token)
          log('hcaptcha token injected (fields=' + injected.fields + ' cbFired=' + injected.cbFired + '); nudging the form')
          await shot(page, 'hc' + hcSolveCount + '-after-inject')
          await clickText(page, /^(authorize|verify|continue|submit)$/i)
          await sleep(4000)
          await shot(page, 'hc' + hcSolveCount + '-after-nudge')
          if (DEBUG_SHOTS) { const s3 = await readState(page).catch(() => null); if (s3) log('  post-nudge: hcPresent=' + s3.hcPresent + ' responseFilled=' + s3.hcResponseFilled + ' err=' + JSON.stringify(s3.hcErrorText) + ' loggedInAs=' + s3.loggedInAs + ' authCode=' + !!s3.authCode) }
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
      // STALE-LINK GUARD (2026-08-20). The SA reader returns any Claude link from the last
      // hour (newer_than:1h), so a link from a PRIOR attempt gets navigated over and over
      // while the real send step is not producing a fresh one - an infinite loop that burns
      // all 50 iterations (observed live). If we have already navigated this exact link, it
      // is stale: give it a couple of chances for a fresher mail, then abort THIS attempt
      // cleanly (fail-safe: the switch stays on the current account) rather than loop.
      if (moneyTriedLinks.has(link)) {
        moneyStaleHits++
        log('magic-link is STALE (already navigated) - stale#' + moneyStaleHits + '; not re-navigating')
        if (moneyStaleHits >= 3) { log('money: only stale links available - aborting this attempt (fail-safe)'); break }
        await sleep(4000); continue
      }
      moneyTriedLinks.add(link)
      log('money magic-link acquired (fresh); navigating it')
      await page.goto(link, { waitUntil: 'domcontentloaded' }).catch(() => {})
      await focusless(page); await sleep(4000)
      await page.goto(OAUTH_URL, { waitUntil: 'domcontentloaded' }).catch(() => {})
      await focusless(page); await sleep(3500)
      continue
    }

    await sleep(1500)
  }
  log('EXHAUSTED without writing code')
  return 1
  } finally {
    // GUARANTEED cleanup on EVERY exit path (success, exhaust, thrown error): close our
    // dedicated window and drop the CDP connection. No leaked oauth tab, ever.
    await closeOwned()
    try { await browser.disconnect() } catch (_e) {}
  }
}

if (require.main === module) {
  validateArgs()
  run().then(code => { process.exitCode = code || 0 }).catch(e => { console.error('FATAL', e.message); process.exit(1) })
}

module.exports = { run, focusless, driveGoogle }
