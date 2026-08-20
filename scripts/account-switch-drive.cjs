#!/usr/bin/env node
'use strict'
// account-switch-drive.cjs - the plumbing half of the AGENT-PRIMARY account switch.
//
// AGENT-PRIMARY (Tate 2026-08-20): the live-account switch is driven by an AGENT (a
// dispatched Claude Code worker, or the conductor) reading the consent page with its OWN
// vision and driving CDP - not by a blind fixed macro. The macro (account-switch-browser.js)
// stays only as the fallback switch-run spawns if the agent stalls (Guarantee A).
//
// This script is the plumbing so the AGENT's job stays pure vision + decision. It:
//   - spawns switch-run.js <target> --external-drive in the background,
//   - reads SWITCH_OAUTH_URL + SWITCH_CODE_FILE from its stdout,
//   - opens the oauth URL as a TAB IN THE PRIMARY (keeper) WINDOW (newWindow:false), which
//     MECHANICALLY enforces the hard rule that a switch never spawns a new window (the
//     chrome-canonical guardian collapses a lone-oauth window mid-switch and loses the code),
//   - keeps a `.driving` heartbeat fresh so switch-run's macro fallback only fires if the
//     agent genuinely stalls,
//   - screenshots the owned tab for the agent to Read,
//   - writes the agent's auth code (code#state) to CODE_FILE in the exact format the CLI wants,
//   - reports the final SWITCH_RESULT.
//
// It NEVER looks at a screenshot itself and NEVER calls an LLM: the agent IS the vision model.
//
// Contract (single key = the code_file returned by `begin`):
//   node account-switch-drive.cjs begin  <tate|code|money>   -> JSON {ok, oauth_url, code_file, log, switch_pid}
//   node account-switch-drive.cjs shot   <code_file>         -> JSON {ok, png, url, title, head, buttons[], popups[]}
//   node account-switch-drive.cjs submit <code_file> <code#state>
//   node account-switch-drive.cjs await  <code_file>         -> JSON SWITCH_RESULT (exit 0 if ok)
//   node account-switch-drive.cjs status <code_file>         -> JSON {stage, result?, tail}

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const puppeteer = require('puppeteer-core')

const AGENT_ROOT = path.resolve(__dirname, '..')
const SWITCH_RUN = path.join(AGENT_ROOT, 'scripts', 'switch-run.js')
const PORT = process.env.CDP_PORT || '9222'
const DRIVE_DIR = path.join(os.homedir(), '.ecodiaos', 'coordination', 'usage', 'drive')
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function readJson(p, fb) { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch (_e) { return fb } }
function out(o) { process.stdout.write(JSON.stringify(o) + '\n') }
function fail(msg, extra) { out(Object.assign({ ok: false, error: msg }, extra || {})); process.exit(1) }
function sidecarPath(codeFile) { return codeFile + '.drive.json' }
function touchDriving(codeFile) { try { fs.writeFileSync(codeFile + '.driving', new Date().toISOString()) } catch (_e) {} }

async function connect() {
  return puppeteer.connect({ browserURL: 'http://127.0.0.1:' + PORT, defaultViewport: null })
}
async function focusless(page) {
  try { const c = await page.target().createCDPSession(); await c.send('Emulation.setFocusEmulationEnabled', { enabled: true }); await c.detach().catch(() => {}) } catch (_e) {}
}
async function findOwnedPage(browser, targetId) {
  for (const p of await browser.pages()) { try { if (p.target()._targetId === targetId) return p } catch (_e) {} }
  return null
}

// ── begin ──────────────────────────────────────────────────────────────────────
async function begin(target) {
  if (!['tate', 'code', 'money'].includes(target)) fail('usage: begin <tate|code|money>')
  fs.mkdirSync(DRIVE_DIR, { recursive: true })
  const stamp = 'drive_' + Date.now().toString(36)
  const log = path.join(DRIVE_DIR, stamp + '.log')
  fs.writeFileSync(log, '')

  // Spawn switch-run --external-drive detached, teeing its stdout to the run log. Detached +
  // unref so it outlives this short-lived `begin` process and keeps orchestrating (lock,
  // seed, verify, reawaken) while the agent drives.
  const fd = fs.openSync(log, 'a')
  const child = spawn('node', [SWITCH_RUN, target, '--external-drive'], {
    detached: true, stdio: ['ignore', fd, fd],
    env: Object.assign({}, process.env, { SWITCH_REASON: process.env.SWITCH_REASON || 'agent-drive' }),
  })
  child.unref()

  // Poll the log for the handoff (or an early terminal result).
  let oauthUrl = null, codeFile = null
  const deadline = Date.now() + 100000
  while (Date.now() < deadline) {
    const text = fs.readFileSync(log, 'utf8')
    const u = text.match(/^SWITCH_OAUTH_URL=(.+)$/m)
    const c = text.match(/^SWITCH_CODE_FILE=(.+)$/m)
    if (u && c) { oauthUrl = u[1].trim(); codeFile = c[1].trim(); break }
    const res = text.match(/^SWITCH_RESULT=(.+)$/m)
    if (res) { const j = readJson(res[1], null); fail('switch-run exited before handoff', { switch_result: j, log }); }
    await sleep(500)
  }
  if (!oauthUrl || !codeFile) fail('no SWITCH_OAUTH_URL from switch-run within 100s', { log, tail: tail(log) })

  // Open the oauth tab IN THE PRIMARY WINDOW (newWindow:false). This is the mechanically
  // enforced hard rule: never a new window (the guardian reaps a lone-oauth window mid-switch).
  let targetId = null
  try {
    const browser = await connect()
    const bcdp = await browser.target().createCDPSession()
    const created = await bcdp.send('Target.createTarget', { url: 'about:blank', newWindow: false })
    targetId = created.targetId
    await bcdp.detach().catch(() => {})
    let page = null
    for (let k = 0; k < 25 && !page; k++) { page = await findOwnedPage(browser, targetId); if (!page) await sleep(200) }
    if (page) {
      await focusless(page)
      await page.goto(oauthUrl, { waitUntil: 'domcontentloaded' }).catch(() => {})
    }
    await browser.disconnect().catch(() => {})
  } catch (e) { /* the agent can still open/drive via the cdp plane; report the miss */ }

  fs.writeFileSync(sidecarPath(codeFile), JSON.stringify({ target, oauth_url: oauthUrl, log, target_id: targetId, switch_pid: child.pid, opened_at: new Date().toISOString() }, null, 2))
  touchDriving(codeFile)
  out({ ok: true, target, oauth_url: oauthUrl, code_file: codeFile, log, switch_pid: child.pid, tab_opened: !!targetId })
}

// ── shot ───────────────────────────────────────────────────────────────────────
// Screenshot the owned oauth tab for the agent to Read, refresh the .driving heartbeat, and
// return a lightweight text read (DATA the agent reasons over - url, title, body head, the
// visible buttons, and any Google popups). Everything here is read-only page state.
async function shot(codeFile) {
  const sc = readJson(sidecarPath(codeFile), null)
  if (!sc) fail('no drive sidecar for ' + codeFile + ' (run begin first)')
  touchDriving(codeFile)
  const browser = await connect()
  try {
    let page = sc.target_id ? await findOwnedPage(browser, sc.target_id) : null
    if (!page) {
      // The owned tab is gone; fall back to any live oauth/consent/callback tab.
      for (const p of await browser.pages()) { const u = p.url(); if (/oauth|callback|accounts\.google|magic-link|claude\.(ai|com)/i.test(u)) { page = p; break } }
    }
    if (!page) fail('no owned oauth tab and no oauth-like tab found')
    await focusless(page)
    const pngDir = path.join(DRIVE_DIR, 'shots'); fs.mkdirSync(pngDir, { recursive: true })
    const png = path.join(pngDir, 'shot_' + Date.now().toString(36) + '.png')
    await page.screenshot({ path: png, fullPage: false }).catch(() => {})
    const state = await page.evaluate(() => {
      const txt = (document.body ? document.body.innerText : '') || ''
      const btns = [].slice.call(document.querySelectorAll('button,[role=button],a'))
        .map(b => (b.innerText || '').trim()).filter(t => t && t.length < 40).slice(0, 20)
      return { url: location.href, title: document.title, head: txt.slice(0, 500).replace(/\s+/g, ' '), buttons: btns }
    }).catch(() => ({ url: page.url(), title: '', head: '', buttons: [] }))
    const popups = []
    for (const p of await browser.pages()) { try { const u = p.url(); if (/accounts\.google\.com/i.test(u)) popups.push(u.slice(0, 80)) } catch (_e) {} }
    out({ ok: true, png, url: state.url, title: state.title, head: state.head, buttons: state.buttons, popups })
  } finally { await browser.disconnect().catch(() => {}) }
}

// ── submit ───────────────────────────────────────────────────────────────────────
function submit(codeFile, code) {
  if (!codeFile || !code) fail('usage: submit <code_file> <code#state>')
  code = String(code).trim()
  if (code.length < 20) fail('auth code looks too short (expected code#state); got length ' + code.length)
  // account-login.sh re-adds exactly one trailing newline via printf, so write the raw value.
  fs.writeFileSync(codeFile, code + '\n')
  touchDriving(codeFile)
  out({ ok: true, wrote: codeFile, len: code.length, has_state: code.includes('#') })
}

// ── await ──────────────────────────────────────────────────────────────────────
async function awaitResult(codeFile) {
  const sc = readJson(sidecarPath(codeFile), null)
  const log = (sc && sc.log) || (fs.existsSync(codeFile) ? null : null)
  if (!log) fail('no drive sidecar/log for ' + codeFile)
  const deadline = Date.now() + 14 * 60 * 1000
  while (Date.now() < deadline) {
    const text = fs.readFileSync(log, 'utf8')
    const res = text.match(/^SWITCH_RESULT=(.+)$/m)
    if (res) { const j = readJson(res[1], { ok: false, error: 'unparseable SWITCH_RESULT' }); out(j); process.exit(j && j.ok ? 0 : 1) }
    await sleep(2000)
  }
  fail('no SWITCH_RESULT within 14min', { log, tail: tail(log) })
}

function status(codeFile) {
  const sc = readJson(sidecarPath(codeFile), null)
  if (!sc || !sc.log) fail('no drive sidecar for ' + codeFile)
  const text = fs.readFileSync(sc.log, 'utf8')
  const res = text.match(/^SWITCH_RESULT=(.+)$/m)
  const stage = (text.match(/state=(\w+)/g) || []).slice(-1)[0] || null
  out({ ok: true, stage, result: res ? readJson(res[1], null) : null, tail: tail(sc.log) })
}

function tail(p, n) { try { return fs.readFileSync(p, 'utf8').split('\n').slice(-(n || 8)).join('\n') } catch (_e) { return '' } }

// ── main ───────────────────────────────────────────────────────────────────────
const [cmd, a1, a2] = process.argv.slice(2)
;(async () => {
  try {
    if (cmd === 'begin') await begin((a1 || '').trim().toLowerCase())
    else if (cmd === 'shot') await shot(a1)
    else if (cmd === 'submit') submit(a1, a2)
    else if (cmd === 'await') await awaitResult(a1)
    else if (cmd === 'status') status(a1)
    else fail('usage: account-switch-drive.cjs <begin|shot|submit|await|status> ...')
  } catch (e) { fail(String(e && e.message || e)) }
})()
