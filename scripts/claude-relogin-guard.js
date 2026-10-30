#!/usr/bin/env node
'use strict'
// scripts/claude-relogin-guard.js - keeps the live Claude OAuth session from ever reaching
// its hard expiry, by forcing a fresh login well before it.
//
// WHY THIS EXISTS (2026-10-30). A Claude Code OAuth login is a fixed 30-day session. The
// Keychain entry "Claude Code-credentials" carries it as claudeAiOauth.refreshTokenExpiresAt.
// The 8-hour access-token refreshes rotate the refresh token but never move that expiry
// (measured 2026-10-30: Keychain mdat 11:46Z today, session expiry still 30 days after the
// 2026-10-28 22:22Z login). Nothing warned, nothing relogged. On 2026-10-29/30 the session
// lapsed, every scheduled tab came up logged out and could not run Claude to fix itself, VS
// Code tabs retried until each held ~2GB of history and VS Code crashed. About 2 days dark.
//
// THE RULE. Read the session expiry daily. When fewer than RELOGIN_DAYS_LEFT days remain
// (default 10, i.e. the session is older than ~20 days on a 30-day lifetime), run a real
// fresh login into the target account via the one sanctioned path:
//   bash scripts/account-switch.sh <target> --force-relogin --pin-target
// then re-read the expiry and require it to have moved to more than 25 days out.
// The trigger is expressed as days REMAINING, not age, because the expiry is the only thing
// the vendor stamps; if the lifetime ever changes, this still fires 10 days before the end.
//
// WHEN A CAPTCHA APPEARS (2026-10-30). The unattended attempt runs with NO captcha solver
// (SWITCH_NO_CAPTCHA_SOLVER=1). On the first live test the authorize page showed a visible
// hCaptcha twice. A captcha is a human check and this job does not get past one; instead it
// starts the PHONE HANDSHAKE: switch-run in --external-drive mode holds a live login flow
// open (up to RELOGIN_RELAY_WAIT_MS, default 60 min, via scripts/account-login-relogin.sh),
// Tate is texted the authorize link, he taps Authorize on his phone and texts back the code
// the callback page shows, and the guard writes it for the CLI. The code must carry this
// flow's state, so a stale or foreign code is refused. Off with RELOGIN_RELAY=0.
//
// WHY LAUNCHD AND NOT A SCHEDULER ROW. The failure this prevents is a logged-out machine,
// and a logged-out machine cannot open a Claude tab. This runs as node + security + CDP from
// launchd (au.ecodia.claude-relogin-guard) and spends no Claude budget. Daily calendar fire
// plus RunAtLoad: launchd runs a calendar fire missed during sleep once on wake, and
// RunAtLoad covers a reboot. A missed fire costs one day of a 10-day window.
//
// Modes:
//   (none)            decide and act (what launchd runs)
//   --check           decide only and print the verdict; no side effects
//   --days-left <n>   with --check: simulate a session with n days left (decision dry-run)
//   --force           relogin now whatever the age (the manual verify gate)
//   --relay-dry-run   run the phone-handshake plumbing for real, text nobody, feed no code
//   --selftest        pure-function tests
//
// Exit: 0 skipped or renewed, 1 relogin failed or not proven, 3 another switch in flight.
// Never prints a token. Only timestamps leave the Keychain read.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn, spawnSync } = require('child_process')

const DAY = 86400000
const AGENT_ROOT = path.resolve(__dirname, '..')
const SWITCH_SH = path.join(AGENT_ROOT, 'scripts', 'account-switch.sh')
const RELAY_LOGIN_SH = path.join(AGENT_ROOT, 'scripts', 'account-login-relogin.sh')
const TEXT_TATE = path.join(os.homedir(), '.code', 'ecodiaos', 'backend', 'imessage-agent', 'text-tate.js')
const THREAD_TAIL = path.join(os.homedir(), '.code', 'ecodiaos', 'backend', 'imessage-agent', 'tate-thread-tail.js')
// Phone handshake (2026-10-30): when the unattended login meets a captcha, Tate gets a link,
// taps Authorize on his phone and texts back the code. RELOGIN_RELAY=0 turns it off.
const RELAY_ENABLED = process.env.RELOGIN_RELAY !== '0'
const RELAY_WAIT_MS = Number(process.env.RELOGIN_RELAY_WAIT_MS) || 60 * 60 * 1000
const MAX_TEXT_CHARS = 690 // text-tate's hard ceiling is 700
const COORD_ROOT = process.env.COORD_ROOT || path.join(os.homedir(), '.ecodiaos', 'coordination')
const STATE_FILE = process.env.RELOGIN_STATE_FILE || path.join(COORD_ROOT, 'relogin-guard.json')
const TARGET = process.env.RELOGIN_ACCOUNT || 'tate'
const RELOGIN_DAYS_LEFT = Number(process.env.RELOGIN_DAYS_LEFT) || 10
const MIN_RENEWED_DAYS = 25
const SWITCH_TIMEOUT_MS = Number(process.env.RELOGIN_SWITCH_TIMEOUT_MS) || 40 * 60 * 1000
const ALARM_COOLDOWN_MS = 20 * 3600 * 1000

// ── pure judgement ───────────────────────────────────────────────────────────

// session: { ok, refreshExpiresAt, reason } from readSession(). lastVerifiedAt: ms of our
// own last proven relogin, used only when the Keychain stops carrying the expiry field.
function decide(input) {
  const { session, nowMs, thresholdDays, lastVerifiedAt } = input || {}
  const now = nowMs || Date.now()
  const th = typeof thresholdDays === 'number' ? thresholdDays : RELOGIN_DAYS_LEFT
  if (!session || !session.ok) {
    if (session && session.reason === 'no_refresh_expiry' && typeof lastVerifiedAt === 'number') {
      const ageDays = (now - lastVerifiedAt) / DAY
      if (ageDays < 30 - th) {
        return { act: false, daysLeft: null, reason: 'Keychain carries no session expiry; our last proven relogin was ' + ageDays.toFixed(1) + 'd ago, under the ' + (30 - th) + 'd mark' }
      }
      return { act: true, daysLeft: null, reason: 'Keychain carries no session expiry and our last proven relogin was ' + ageDays.toFixed(1) + 'd ago' }
    }
    return { act: true, daysLeft: null, reason: 'session unreadable (' + ((session && session.reason) || 'unknown') + '): the logged-out shape, relogging' }
  }
  const daysLeft = (session.refreshExpiresAt - now) / DAY
  if (daysLeft <= 0) return { act: true, daysLeft, reason: 'session EXPIRED ' + (-daysLeft).toFixed(2) + 'd ago' }
  if (daysLeft < th) return { act: true, daysLeft, reason: daysLeft.toFixed(2) + 'd left, under the ' + th + 'd threshold' }
  return { act: false, daysLeft, reason: daysLeft.toFixed(2) + 'd left, threshold ' + th + 'd' }
}

// A relogin counts only if the session expiry moved forward and now sits well out.
function sessionRenewed(pre, post, nowMs) {
  const now = nowMs || Date.now()
  if (!post || !post.ok || typeof post.refreshExpiresAt !== 'number') return false
  const before = pre && pre.ok && typeof pre.refreshExpiresAt === 'number' ? pre.refreshExpiresAt : 0
  return post.refreshExpiresAt > before + 60000 && (post.refreshExpiresAt - now) > MIN_RENEWED_DAYS * DAY
}

// The OAuth callback page shows "code#state". Tate may text that, the bare code, or the
// whole callback URL. The state must match the flow we started, so a stale or foreign code
// is never fed to the CLI. Returns "code#state" or null.
function extractAuthCode(text, expectedState) {
  const s = String(text || '').trim()
  if (!s || !expectedState) return null
  let code = null, state = null
  const pair = s.match(/([A-Za-z0-9_-]{20,})#([A-Za-z0-9_-]{8,})/)
  const url = s.match(/[?&]code=([A-Za-z0-9_-]{20,})/)
  if (pair) { code = pair[1]; state = pair[2] } else if (url) {
    code = url[1]
    const st = s.match(/[?&]state=([A-Za-z0-9_-]{8,})/)
    state = st ? st[1] : null
  } else {
    const bare = s.match(/^([A-Za-z0-9_-]{30,})$/)
    if (bare) code = bare[1]
  }
  if (!code) return null
  if (state && state !== expectedState) return null
  return code + '#' + expectedState
}

// Tate's first reply after we texted the link that carries a usable code. Our own rows and
// anything older than the send are ignored, so an earlier code in the thread is never reused.
function pickRelayReply(rows, sentAtMs, expectedState) {
  for (const r of (rows || []).slice().sort((a, b) => (a.ms || 0) - (b.ms || 0))) {
    if (!r || r.from !== 'tate') continue
    if (!(typeof r.ms === 'number' && r.ms >= sentAtMs - 5000)) continue
    const c = extractAuthCode(r.text, expectedState)
    if (c) return { code: c, rowid: r.rowid }
  }
  return null
}

function parseSwitchResult(stdout) {
  const lines = String(stdout || '').split('\n').filter(l => l.startsWith('SWITCH_RESULT='))
  if (!lines.length) return null
  try { return JSON.parse(lines[lines.length - 1].slice('SWITCH_RESULT='.length)) } catch (e) { return null }
}

// ── effects ──────────────────────────────────────────────────────────────────

function readSession() {
  const r = spawnSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-a', os.userInfo().username, '-w'],
    { encoding: 'utf8', timeout: 10000 })
  if (r.status !== 0 || !r.stdout) return { ok: false, reason: 'no_keychain_entry' }
  let o
  try { o = JSON.parse(r.stdout.trim()).claudeAiOauth } catch (e) { return { ok: false, reason: 'unparseable' } }
  if (!o || !o.accessToken) return { ok: false, reason: 'no_oauth_token' }
  if (typeof o.refreshTokenExpiresAt !== 'number') return { ok: false, reason: 'no_refresh_expiry', accessExpiresAt: o.expiresAt }
  return { ok: true, refreshExpiresAt: o.refreshTokenExpiresAt, accessExpiresAt: o.expiresAt }
}

function iso(ms) { return typeof ms === 'number' ? new Date(ms).toISOString() : null }
function log(msg) { process.stdout.write('[' + new Date().toISOString() + ' relogin-guard] ' + msg + '\n') }
function readState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) } catch (e) { return {} } }
function writeState(s) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
    const t = STATE_FILE + '.tmp-' + process.pid
    fs.writeFileSync(t, JSON.stringify(s, null, 2) + '\n')
    fs.renameSync(t, STATE_FILE)
  } catch (e) { log('could not write state: ' + e.message) }
}

// Free iMessage to Tate. --read-thread is the non-interactive ack (a launchd job cannot
// satisfy --ack-thread). Rate-limited so a daily retry loop is one text a day at most,
// unless the session is about to die.
function alarm(state, msg, daysLeft, opts) {
  const critical = daysLeft === null || daysLeft < 3 || !!(opts && opts.bypassCooldown)
  const last = state.last_alarm_at ? Date.parse(state.last_alarm_at) : 0
  if (!critical && Date.now() - last < ALARM_COOLDOWN_MS) { log('alarm suppressed (cooldown): ' + msg); return }
  // process.execPath, never a bare `node`: under launchd only the plist's own (TCC-granted)
  // binary can read chat.db and drive Messages; PATH resolves to the ungranted one.
  const r = spawnSync(process.execPath, [TEXT_TATE, '--from', 'relogin-guard', '--read-thread', '--urgency', critical ? 'critical' : 'decision', msg],
    { encoding: 'utf8', timeout: 60000, cwd: path.join(os.homedir(), '.code', 'ecodiaos', 'backend') })
  log('alarm text exit=' + r.status + ' ' + String((r.stdout || '') + (r.stderr || '')).trim().slice(0, 200))
  state.last_alarm_at = new Date().toISOString()
}

// The unattended attempt. SWITCH_NO_CAPTCHA_SOLVER=1: a visible challenge is never sent to a
// solving service; the leg exhausts and the phone handshake takes over.
function runRelogin() {
  const r = spawnSync('bash', [SWITCH_SH, TARGET, '--force-relogin', '--pin-target'], {
    encoding: 'utf8', timeout: SWITCH_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024,
    env: Object.assign({}, process.env, { SWITCH_REASON: 'relogin-guard', SWITCH_NO_CAPTCHA_SOLVER: '1' }),
  })
  const out = String(r.stdout || '')
  for (const line of out.split('\n').filter(l => /^\[switch-run|^SWITCH_RESULT=|^(DONE|FAILED|TIMEOUT|LOGIN_OK)/.test(l)).slice(-12)) log('  ' + line.slice(0, 300))
  return { status: r.status, signal: r.signal, result: parseSwitchResult(out) }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function readThreadRows() {
  const r = spawnSync(process.execPath, [THREAD_TAIL, '20', '--json', '--no-transcribe'],
    { encoding: 'utf8', timeout: 60000, cwd: path.join(os.homedir(), '.code', 'ecodiaos', 'backend') })
  try { return { ok: true, rows: JSON.parse(r.stdout).messages || [] } } catch (e) { return { ok: false, rows: [], err: String(r.stderr || e.message).slice(0, 200) } }
}

// `claude auth login` opens its authorize link in the Mac's default browser (canonical
// Chrome). In the phone handshake nobody drives that tab, so close any page carrying this
// flow's state once we are done. Only this flow's tabs; never the browser.
function closeFlowTabs(stateParam) {
  const list = spawnSync('curl', ['-s', '-m', '4', 'http://127.0.0.1:9222/json'], { encoding: 'utf8' })
  let n = 0
  try {
    for (const t of JSON.parse(list.stdout || '[]')) {
      if (t.type === 'page' && String(t.url || '').includes(stateParam)) {
        spawnSync('curl', ['-s', '-m', '4', 'http://127.0.0.1:9222/json/close/' + t.id]); n++
      }
    }
  } catch (_e) {}
  return n
}

function killGroup(child) {
  try { process.kill(-child.pid, 'SIGTERM') } catch (_e) { try { child.kill('SIGTERM') } catch (_e2) {} }
}

// The phone handshake. switch-run runs in --external-drive mode (it waits for someone else
// to write the auth code) with no macro takeover and no solver, against a copy of
// account-login.sh whose code wait matches ours. We text Tate the authorize link, watch the
// thread for his reply, and write the code. A human clicking Authorize on his own phone is
// the legitimate answer to a captcha; nothing here tries to get past one.
async function runRelay(state, daysLeft, opts) {
  const dryRun = !!(opts && opts.dryRun)
  const waitMs = dryRun ? 15000 : RELAY_WAIT_MS
  const child = spawn('bash', [SWITCH_SH, TARGET, '--force-relogin', '--pin-target', '--external-drive'], {
    detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, {
      SWITCH_REASON: 'relogin-guard:phone', SWITCH_NO_CAPTCHA_SOLVER: '1', SWITCH_MAX_ATTEMPTS: '1',
      SWITCH_AGENT_FALLBACK_MS: String(365 * DAY), SWITCH_LEG_TIMEOUT_MS: String(waitMs + 5 * 60000),
      ACCOUNT_LOGIN_SH: RELAY_LOGIN_SH, EOS_LOGIN_CODE_WAIT_SECS: String(Math.round(waitMs / 1000) + 60),
    }),
  })
  let out = ''
  child.stdout.on('data', d => { out += d }); child.stderr.on('data', d => { out += d })
  const exited = new Promise(r => child.on('exit', (code, signal) => r({ code, signal })))
  let expectedState = null
  const finish = async (extra) => {
    if (child.exitCode === null) killGroup(child)
    await Promise.race([exited, sleep(30000)])
    const closedTabs = expectedState ? closeFlowTabs(expectedState) : 0
    return Object.assign({ result: parseSwitchResult(out), closedTabs }, extra)
  }

  let url = null, codeFile = null
  for (const t0 = Date.now(); Date.now() - t0 < 120000 && child.exitCode === null;) {
    const u = out.match(/^SWITCH_OAUTH_URL=(\S+)$/m), c = out.match(/^SWITCH_CODE_FILE=(\S+)$/m)
    if (u && c) { url = u[1]; codeFile = c[1]; break }
    await sleep(500)
  }
  if (!url) return finish({ relayed: false, reason: 'switch-run never offered an authorize link: ' + (parseSwitchResult(out) || {}).reason })
  try { expectedState = new URL(url).searchParams.get('state') } catch (_e) {}
  if (!expectedState) return finish({ relayed: false, reason: 'authorize link carried no state parameter' })
  log('phone handshake: link ready (host ' + new URL(url).host + ', ' + url.length + ' chars), code file armed' + (dryRun ? ' [DRY RUN: not texting]' : ''))

  const sentAt = Date.now()
  if (!dryRun) {
    const dl = daysLeft === null ? 'is unreadable' : 'ends in ' + daysLeft.toFixed(1) + ' days'
    // The send gate's HARD ceiling is 700 chars even with --long (measured 2026-10-30: a
    // 708-char version with a 473-char link was refused too_long), and a --follow-up is capped
    // at 300, so the link cannot ride in a second text. Keep the prose short enough that one
    // message fits; a link that still does not fit fails loudly to the ordinary alarm.
    const prose = 'Claude login needs one tap (Mac login ' + dl + '; a captcha blocked auto-renew). ' +
      'Open on your phone, tap Authorize, text me the code. Open ' + Math.round(waitMs / 60000) + ' min:'
    const msg = prose + ' ' + url
    if (msg.length > MAX_TEXT_CHARS) return finish({ relayed: false, reason: 'authorize link too long for one text (' + msg.length + ' chars)' })
    const r = spawnSync(process.execPath, [TEXT_TATE, '--from', 'relogin-guard', '--read-thread', '--urgency',
      (daysLeft !== null && daysLeft < 3) ? 'critical' : 'decision', '--long', 'carries the one-time OAuth authorize link', msg],
    { encoding: 'utf8', timeout: 60000, cwd: path.join(os.homedir(), '.code', 'ecodiaos', 'backend') })
    log('phone handshake text (' + msg.length + ' chars) exit=' + r.status + ' ' + String((r.stdout || '') + (r.stderr || '')).trim().replace(/\s+/g, ' ').slice(0, 200))
    if (r.status !== 0) return finish({ relayed: false, reason: 'could not text the link (exit ' + r.status + ')' })
    state.last_alarm_at = new Date().toISOString()
  }

  let got = null, reads = 0, readFail = null
  while (Date.now() - sentAt < waitMs && child.exitCode === null) {
    const th = readThreadRows(); reads++
    if (!th.ok) readFail = th.err
    got = pickRelayReply(th.rows, sentAt, expectedState)
    if (got) break
    await sleep(dryRun ? 5000 : 15000)
  }
  if (!got) return finish({ relayed: true, reason: 'no usable code from Tate within ' + Math.round(waitMs / 60000) + ' min (' + reads + ' thread reads' + (readFail ? ', last read failed: ' + readFail : '') + ')', reads })

  fs.writeFileSync(codeFile, got.code + '\n')
  log('phone handshake: code from Tate (rowid ' + got.rowid + ') written; waiting for the CLI to exchange it')
  await Promise.race([exited, sleep(10 * 60000)])
  return finish({ relayed: true, codeRowid: got.rowid })
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--selftest')) return selftest()
  if (argv.includes('--relay-dry-run')) {
    // Exercises the phone-handshake plumbing for real (switch-run in external-drive mode, a
    // live authorize link, the thread read, teardown) but texts nobody and writes no code. The
    // Keychain is untouched because no code is ever fed to the CLI.
    const res = await runRelay({}, null, { dryRun: true })
    // The CLI is a grandchild and takes a moment to die after the group SIGTERM.
    let strays = ''
    for (let k = 0; k < 20; k++) { strays = spawnSync('pgrep', ['-f', 'claude auth login'], { encoding: 'utf8' }).stdout.trim(); if (!strays) break; await sleep(500) }
    log('relay dry-run: relayed=' + res.relayed + ' reason=' + (res.reason || '-') + ' reads=' + (res.reads || 0) +
      ' switch_code=' + ((res.result || {}).code) + ' stray_logins=' + (strays ? strays.split('\n').length : 0) + ' closed_tabs=' + (res.closedTabs || 0))
    process.exitCode = (res.relayed && !strays) ? 0 : 1
    return
  }
  if (argv.includes('--alarm-dry-run')) {
    // Proves the failure text would get out FROM THIS PROCESS'S CONTEXT (run it under
    // launchd): the gate reads the thread from chat.db, which needs this binary's Full Disk
    // Access. Sends nothing.
    const r = spawnSync(process.execPath, [TEXT_TATE, '--from', 'relogin-guard', '--read-thread', '--urgency', 'decision', '--dry-run',
      'Claude login renewal alarm path probe (dry run, not sent).'], { encoding: 'utf8', timeout: 60000, cwd: path.join(os.homedir(), '.code', 'ecodiaos', 'backend') })
    log('alarm dry-run via ' + process.execPath + ' exit=' + r.status + ' ' + String((r.stdout || '') + (r.stderr || '')).trim().replace(/\s+/g, ' ').slice(0, 300))
    process.exitCode = r.status === 0 ? 0 : 1
    return
  }
  const CHECK = argv.includes('--check')
  const FORCE = argv.includes('--force')
  const sim = argv.indexOf('--days-left')
  const now = Date.now()
  const state = readState()

  let session = readSession()
  if (CHECK && sim !== -1) session = { ok: true, refreshExpiresAt: now + Number(argv[sim + 1]) * DAY, simulated: true }
  const lastVerifiedAt = state.last_verified_relogin_at ? Date.parse(state.last_verified_relogin_at) : undefined
  const verdict = FORCE
    ? { act: true, daysLeft: session.ok ? (session.refreshExpiresAt - now) / DAY : null, reason: 'forced by hand' }
    : decide({ session, nowMs: now, lastVerifiedAt })

  log((verdict.act ? 'RELOGIN' : 'SKIP') + ' target=' + TARGET + ' session_expires=' + iso(session.refreshExpiresAt) +
    (session.simulated ? ' (SIMULATED)' : '') + ' :: ' + verdict.reason)
  if (CHECK) { process.exitCode = 0; return }

  Object.assign(state, {
    last_check_at: new Date(now).toISOString(), target: TARGET, threshold_days_left: RELOGIN_DAYS_LEFT,
    session_expires_at: iso(session.refreshExpiresAt), days_left: verdict.daysLeft === null ? null : Number(verdict.daysLeft.toFixed(2)),
    last_decision: verdict.act ? 'relogin' : 'skip', last_reason: verdict.reason,
  })
  if (!verdict.act) { writeState(state); process.exitCode = 0; return }

  const before = session
  const run = runRelogin()
  let after = readSession()
  let renewed = sessionRenewed(before, after, Date.now())
  let res = run.result || {}
  let relay = null
  // The unattended attempt failed for a reason other than a held lock: hand Tate the link.
  if (!renewed && res.code !== 3 && RELAY_ENABLED) {
    log('unattended attempt did not renew (' + String(res.reason || 'no result').slice(0, 160) + '); starting the phone handshake')
    relay = await runRelay(state, verdict.daysLeft, {})
    after = readSession()
    renewed = sessionRenewed(before, after, Date.now())
    if (relay.result) res = relay.result
    state.last_relay = { at: new Date().toISOString(), relayed: !!relay.relayed, reason: relay.reason || null, code_rowid: relay.codeRowid || null, renewed }
    log('phone handshake: relayed=' + relay.relayed + (relay.reason ? ' reason=' + relay.reason : '') + ' renewed=' + renewed)
  }
  Object.assign(state, {
    last_attempt_at: new Date().toISOString(), last_attempt_exit: run.status, last_attempt_signal: run.signal || null,
    last_attempt_switch_code: typeof res.code === 'number' ? res.code : null,
    last_attempt_reason: res.reason ? String(res.reason).slice(0, 300) : null,
    expiry_before: iso(before.refreshExpiresAt), expiry_after: iso(after.refreshExpiresAt), renewed,
  })

  if (renewed) {
    state.last_verified_relogin_at = new Date().toISOString()
    state.session_expires_at = iso(after.refreshExpiresAt)
    state.days_left = Number(((after.refreshExpiresAt - Date.now()) / DAY).toFixed(2))
    state.consecutive_failures = 0
    log('RENEWED: session expiry ' + iso(before.refreshExpiresAt) + ' -> ' + iso(after.refreshExpiresAt) +
      (res.ok ? '' : ' (switch-run reported ' + (res.reason || 'not ok') + ', but the session itself is renewed)'))
    writeState(state); process.exitCode = 0; return
  }

  state.consecutive_failures = (state.consecutive_failures || 0) + 1
  if (res.code === 3) {
    log('another switch holds the lock; retrying on the next fire')
    if (verdict.daysLeft !== null && verdict.daysLeft < 3) alarm(state, 'Claude login renewal could not run (another switch was mid-flight) and the session ends in ' + verdict.daysLeft.toFixed(1) + ' days. I will retry tomorrow.', verdict.daysLeft)
    writeState(state); process.exitCode = 3; return
  }
  const dl = verdict.daysLeft
  const when = dl === null ? 'the session is already unreadable or expired' : 'the session ends in ' + dl.toFixed(1) + ' days'
  log('FAILED: switch code=' + res.code + ' reason=' + String(res.reason || run.signal || 'no SWITCH_RESULT').slice(0, 300) + '; expiry after=' + iso(after.refreshExpiresAt))
  // If Tate was already texted the link today, that text was the ask; only a near-dead
  // session earns a second message.
  if (relay && relay.codeRowid) {
    // Tate did his part and the CLI took the code, yet the session did not move out past 25
    // days. That is also the observation that settles whether a re-auth through the same
    // claude.ai web session is capped at that session's expiry. Tell him once, past cooldown.
    alarm(state, 'Your code went through, thanks, but the Mac login did not extend (it still ends ' + (iso(after.refreshExpiresAt) || 'unknown').slice(0, 10) + '). ' +
      'Nothing more from you right now. I have logged it and will retry tomorrow.', dl, { bypassCooldown: true })
  } else if (!(relay && relay.relayed) || (dl !== null && dl < 3)) {
    alarm(state, 'My daily Claude login renewal failed (' + state.consecutive_failures + ' in a row) and ' + when + '. ' +
      (relay && relay.relayed ? 'The one-tap link I sent was not completed. ' : '') +
      'I retry every day and text you a one-tap link each time. Log: ~/Library/Logs/ecodiaos/claude-relogin-guard.log', dl)
  }
  writeState(state); process.exitCode = 1
}

// ── selftest ─────────────────────────────────────────────────────────────────

function selftest() {
  let failed = 0
  const ok = (c, n) => { console.log((c ? '  PASS: ' : '  FAIL: ') + n); if (!c) failed++ }
  const now = Date.parse('2026-10-30T12:00:00Z')
  const s = (d) => ({ ok: true, refreshExpiresAt: now + d * DAY })

  console.log('-- decide: days left against a 10-day threshold --')
  ok(decide({ session: s(28.4), nowMs: now, thresholdDays: 10 }).act === false, 'a 2-day-old session (28.4d left) is skipped')
  ok(decide({ session: s(10.01), nowMs: now, thresholdDays: 10 }).act === false, 'exactly day ~20 (10.01d left) is still skipped')
  ok(decide({ session: s(9.99), nowMs: now, thresholdDays: 10 }).act === true, 'just past day 20 (9.99d left) relogs')
  ok(decide({ session: s(1), nowMs: now, thresholdDays: 10 }).act === true, 'one day left relogs')
  ok(/EXPIRED/.test(decide({ session: s(-0.5), nowMs: now, thresholdDays: 10 }).reason), 'an expired session relogs and says so')

  console.log('-- decide: an unreadable session is the logged-out shape --')
  ok(decide({ session: { ok: false, reason: 'no_keychain_entry' }, nowMs: now }).act === true, 'no Keychain entry relogs')
  ok(decide({ session: { ok: false, reason: 'unparseable' }, nowMs: now }).act === true, 'an unparseable entry relogs')
  ok(decide({ session: { ok: false, reason: 'no_refresh_expiry' }, nowMs: now, thresholdDays: 10, lastVerifiedAt: now - 5 * DAY }).act === false,
    'a missing expiry field falls back to our own last proven relogin (5d ago: skip)')
  ok(decide({ session: { ok: false, reason: 'no_refresh_expiry' }, nowMs: now, thresholdDays: 10, lastVerifiedAt: now - 21 * DAY }).act === true,
    'and relogs once that is past the 20-day mark')
  ok(decide({ session: { ok: false, reason: 'no_refresh_expiry' }, nowMs: now }).act === true, 'with neither, it relogs')

  console.log('-- sessionRenewed: the verify gate --')
  ok(sessionRenewed(s(9), s(30), now), 'expiry moved from 9d to 30d out: renewed')
  ok(!sessionRenewed(s(9), s(9), now), 'expiry unchanged: NOT renewed, whatever switch-run said')
  ok(!sessionRenewed(s(2), s(12), now), 'moved but only 12d out: NOT renewed')
  ok(sessionRenewed({ ok: false, reason: 'no_keychain_entry' }, s(30), now), 'from logged-out to a fresh 30d session: renewed')
  ok(!sessionRenewed(s(9), { ok: false, reason: 'no_keychain_entry' }, now), 'logged out afterwards: NOT renewed')

  console.log('-- parseSwitchResult --')
  ok(parseSwitchResult('noise\nSWITCH_RESULT={"ok":true,"code":0}\n').code === 0, 'reads the result line')
  ok(parseSwitchResult('no result here') === null, 'absent result is null, never success')

  console.log('-- phone handshake: only a code for THIS flow, only from Tate, only after the ask --')
  const ST = 'StAtE_abcdefghijklmnop12345'
  const CODE = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-xyz'
  ok(extractAuthCode(CODE + '#' + ST, ST) === CODE + '#' + ST, 'code#state as the callback page shows it')
  ok(extractAuthCode('  here you go ' + CODE + '#' + ST + ' \n', ST) === CODE + '#' + ST, 'code#state inside a sentence, with whitespace')
  ok(extractAuthCode(CODE, ST) === CODE + '#' + ST, 'the bare code gets our state appended')
  ok(extractAuthCode('https://platform.claude.com/oauth/code/callback?code=' + CODE + '&state=' + ST, ST) === CODE + '#' + ST, 'the whole callback URL')
  ok(extractAuthCode(CODE + '#someOtherState123456', ST) === null, 'a code from a DIFFERENT flow is refused')
  ok(extractAuthCode('ok thanks', ST) === null, 'chat text is not a code')
  ok(extractAuthCode(CODE + '#' + ST, null) === null, 'no expected state, no code')
  const sent = 1000000
  const rows = [
    { from: 'tate', ms: sent - 600000, rowid: 1, text: CODE + '#' + ST },
    { from: 'eos', ms: sent + 1000, rowid: 2, text: 'open this link ' + CODE + '#' + ST },
    { from: 'tate', ms: sent + 30000, rowid: 3, text: 'on it' },
    { from: 'tate', ms: sent + 90000, rowid: 4, text: CODE + '#' + ST },
  ]
  const pick = pickRelayReply(rows, sent, ST)
  ok(pick && pick.rowid === 4, 'picks Tate\'s reply after the ask, skipping his older code and our own message')
  ok(pickRelayReply(rows.slice(0, 3), sent, ST) === null, 'nothing usable yet means keep waiting')

  console.log(failed ? '\nSELFTEST FAILED (' + failed + ')' : '\nSELFTEST PASSED')
  process.exitCode = failed ? 1 : 0
}

module.exports = { decide, sessionRenewed, parseSwitchResult, extractAuthCode, pickRelayReply }
if (require.main === module) main().catch(e => { log('FATAL ' + (e && e.stack || e)); process.exitCode = 1 })
