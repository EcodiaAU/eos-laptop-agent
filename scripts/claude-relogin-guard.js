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
//   --selftest        pure-function tests
//
// Exit: 0 skipped or renewed, 1 relogin failed or not proven, 3 another switch in flight.
// Never prints a token. Only timestamps leave the Keychain read.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const DAY = 86400000
const AGENT_ROOT = path.resolve(__dirname, '..')
const SWITCH_SH = path.join(AGENT_ROOT, 'scripts', 'account-switch.sh')
const TEXT_TATE = path.join(os.homedir(), '.code', 'ecodiaos', 'backend', 'imessage-agent', 'text-tate.js')
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
function alarm(state, msg, daysLeft) {
  const critical = daysLeft === null || daysLeft < 3
  const last = state.last_alarm_at ? Date.parse(state.last_alarm_at) : 0
  if (!critical && Date.now() - last < ALARM_COOLDOWN_MS) { log('alarm suppressed (cooldown): ' + msg); return }
  const r = spawnSync('node', [TEXT_TATE, '--from', 'relogin-guard', '--read-thread', '--urgency', critical ? 'critical' : 'decision', msg],
    { encoding: 'utf8', timeout: 60000, cwd: path.join(os.homedir(), '.code', 'ecodiaos', 'backend') })
  log('alarm text exit=' + r.status + ' ' + String((r.stdout || '') + (r.stderr || '')).trim().slice(0, 200))
  state.last_alarm_at = new Date().toISOString()
}

function runRelogin() {
  const r = spawnSync('bash', [SWITCH_SH, TARGET, '--force-relogin', '--pin-target'], {
    encoding: 'utf8', timeout: SWITCH_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024,
    env: Object.assign({}, process.env, { SWITCH_REASON: 'relogin-guard' }),
  })
  const out = String(r.stdout || '')
  for (const line of out.split('\n').filter(l => /^\[switch-run|^SWITCH_RESULT=|^(DONE|FAILED|TIMEOUT|LOGIN_OK)/.test(l)).slice(-12)) log('  ' + line.slice(0, 300))
  return { status: r.status, signal: r.signal, result: parseSwitchResult(out) }
}

function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--selftest')) return selftest()
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
  const after = readSession()
  const renewed = sessionRenewed(before, after, Date.now())
  const res = run.result || {}
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
  alarm(state, 'My daily Claude login renewal failed (' + state.consecutive_failures + ' in a row) and ' + when + '. I retry every day. If it keeps failing, the fix is one fresh login at the Mac: claude auth login. Log: ~/Library/Logs/ecodiaos/claude-relogin-guard.log', dl)
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

  console.log(failed ? '\nSELFTEST FAILED (' + failed + ')' : '\nSELFTEST PASSED')
  process.exitCode = failed ? 1 : 0
}

module.exports = { decide, sessionRenewed, parseSwitchResult }
if (require.main === module) main()
