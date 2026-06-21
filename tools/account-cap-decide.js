'use strict'
/**
 * account-cap-decide - deterministic decision for the account-cap-autoswitch
 * watcher. Pure function + CLI so the trigger is TESTABLE (mockable), instead
 * of free-text interpretation inside a cron prompt.
 *
 * Thresholds (Tate 2026-06-19): switch the live account OFF its window when
 *   5h USED      >= 80%  (headroom_5h_fraction     <= 0.20), OR
 *   weekly USED  >= 90%  (headroom_weekly_fraction <= 0.10).
 * A target must have BOTH windows comfortable (used < TARGET_MAX_USED on each)
 * and not be live/flaky/disabled. Pick the highest min-headroom target.
 *
 * Usage:
 *   node account-cap-decide.js                 # live: read coord usage + Keychain
 *   node account-cap-decide.js --selftest      # run mock scenarios, assert, exit
 *   node account-cap-decide.js --mock '<json>' # decide against an injected state
 */

const SESSION_USED_TRIGGER = 0.80   // 5h cap
const WEEKLY_USED_TRIGGER = 0.90    // weekly cap
const TARGET_MAX_USED = 0.50        // a switch target must be under 50% used on both windows

function used5h(a) { return 1 - (a.headroom_5h_fraction != null ? a.headroom_5h_fraction : (a.remaining_5h / a.cap_5h)) }
function usedWeekly(a) { return 1 - (a.headroom_weekly_fraction != null ? a.headroom_weekly_fraction : (a.remaining_weekly / a.cap_weekly)) }

/**
 * decide(state, liveAccount, opts) -> { shouldSwitch, reason, target, live, slots }
 *   state.accounts: { "<email>": {headroom_5h_fraction, headroom_weekly_fraction, ...} }
 *   opts.flaky / opts.disabled: arrays of emails to exclude as targets
 */
function decide(state, liveAccount, opts) {
  opts = opts || {}
  const flaky = new Set(opts.flaky || [])
  const disabled = new Set(opts.disabled || [])
  const sTrig = opts.sessionUsedTrigger != null ? opts.sessionUsedTrigger : SESSION_USED_TRIGGER
  const wTrig = opts.weeklyUsedTrigger != null ? opts.weeklyUsedTrigger : WEEKLY_USED_TRIGGER
  const accounts = (state && state.accounts) || {}

  const slots = Object.keys(accounts).map(email => ({
    email,
    used_5h: +used5h(accounts[email]).toFixed(4),
    used_weekly: +usedWeekly(accounts[email]).toFixed(4),
  }))

  const live = accounts[liveAccount]
  if (!live) {
    return { shouldSwitch: false, reason: 'live_account_not_in_usage_state', target: null, live: liveAccount, slots }
  }

  const liveU5 = used5h(live)
  const liveUW = usedWeekly(live)
  const triggered = liveU5 >= sTrig || liveUW >= wTrig
  if (!triggered) {
    return { shouldSwitch: false, reason: `live_comfortable (5h_used=${liveU5.toFixed(2)} weekly_used=${liveUW.toFixed(2)})`, target: null, live: liveAccount, slots }
  }

  // Eligible targets: not live, not flaky/disabled, both windows comfortable.
  // A headroom-comfortable target whose SNAPSHOT is stale CANNOT be rotated to
  // without a browser re-login (rotate_to refuses an expired blob), so it is not
  // a usable auto-switch target - but it IS exactly what to tell Tate to re-auth.
  // opts.rotatable, when provided, is the set of emails whose snapshot is fresh
  // enough for creds.rotate_to (expiresAt > now + 5min, the creds.js stale gate).
  const rotatable = opts.rotatable ? new Set(opts.rotatable) : null
  const headroomTargets = Object.keys(accounts)
    .filter(e => e !== liveAccount && !flaky.has(e) && !disabled.has(e))
    .map(e => ({ email: e, u5: used5h(accounts[e]), uw: usedWeekly(accounts[e]) }))
    .filter(c => c.u5 < TARGET_MAX_USED && c.uw < TARGET_MAX_USED)
    // highest min-headroom = lowest max-used
    .sort((a, b) => Math.max(a.u5, a.uw) - Math.max(b.u5, b.uw))
  const usable = rotatable ? headroomTargets.filter(c => rotatable.has(c.email)) : headroomTargets
  const staleButHealthy = rotatable ? headroomTargets.filter(c => !rotatable.has(c.email)).map(c => c.email) : []

  const trigReason = `live ${liveAccount} hit cap (5h_used=${liveU5.toFixed(2)}>=${sTrig} or weekly_used=${liveUW.toFixed(2)}>=${wTrig})`
  if (!usable.length) {
    // Triggered but cannot switch -> ALERT (the away-safety net). Distinguish
    // "a healthy account exists but its snapshot is stale (re-auth fixes it)"
    // from "no account has any budget" so the SMS tells Tate the right action.
    const staleNote = staleButHealthy.length
      ? ` - ${staleButHealthy.join(',')} HAS budget but snapshot is STALE (re-auth needed; cannot rotate to an expired token)`
      : ' - NO account has budget'
    return {
      shouldSwitch: false,
      alert: true,
      reason: `${trigReason} but no USABLE target${staleNote}`,
      target: null,
      staleButHealthy,
      live: liveAccount,
      slots,
    }
  }
  return { shouldSwitch: true, alert: false, reason: trigReason, target: usable[0].email, live: liveAccount, slots }
}

function selftest() {
  const A = (h5, hw) => ({ headroom_5h_fraction: h5, headroom_weekly_fraction: hw, cap_5h: 1, cap_weekly: 1, remaining_5h: h5, remaining_weekly: hw })
  const assert = (cond, msg) => { if (!cond) { console.error('FAIL: ' + msg); process.exitCode = 1 } else console.log('ok: ' + msg) }

  // 1. live at 82% 5h used -> switch to healthiest
  let r = decide({ accounts: { 'money@ecodia.au': A(0.18, 0.5), 'code@ecodia.au': A(1.0, 1.0), 'tate@ecodia.au': A(0.6, 0.0) } }, 'money@ecodia.au')
  assert(r.shouldSwitch && r.target === 'code@ecodia.au', '82% 5h used -> switch to code@ (healthiest)')

  // 2. live at 91% weekly used -> switch
  r = decide({ accounts: { 'money@ecodia.au': A(0.7, 0.09), 'code@ecodia.au': A(1.0, 1.0) } }, 'money@ecodia.au')
  assert(r.shouldSwitch && r.target === 'code@ecodia.au', '91% weekly used -> switch')

  // 3. live comfortable -> hold
  r = decide({ accounts: { 'money@ecodia.au': A(0.9, 0.9), 'code@ecodia.au': A(1.0, 1.0) } }, 'money@ecodia.au')
  assert(!r.shouldSwitch, 'live comfortable (10% used) -> hold')

  // 4. exactly 80% 5h used -> switch (>= boundary)
  r = decide({ accounts: { 'money@ecodia.au': A(0.20, 0.5), 'code@ecodia.au': A(1.0, 1.0) } }, 'money@ecodia.au')
  assert(r.shouldSwitch, '80.00% 5h used -> switch (boundary inclusive)')

  // 5. triggered but no healthy target (all others near cap) -> hold + alert
  r = decide({ accounts: { 'money@ecodia.au': A(0.1, 0.05), 'code@ecodia.au': A(0.3, 0.4), 'tate@ecodia.au': A(0.4, 0.45) } }, 'money@ecodia.au')
  assert(!r.shouldSwitch && r.alert && /no USABLE target/.test(r.reason), 'triggered + no healthy target -> hold + alert')

  // 6. flaky target excluded
  r = decide({ accounts: { 'money@ecodia.au': A(0.1, 0.05), 'code@ecodia.au': A(1.0, 1.0) } }, 'money@ecodia.au', { flaky: ['code@ecodia.au'] })
  assert(!r.shouldSwitch, 'flaky target excluded -> hold')

  // 7. triggered, target HAS budget but snapshot STALE (not rotatable) -> hold + alert(re-auth)
  //    money@ live & near-cap; code@ comfortable but only money@ is rotatable.
  r = decide({ accounts: { 'money@ecodia.au': A(0.1, 0.05), 'code@ecodia.au': A(0.9, 0.9) } }, 'money@ecodia.au', { rotatable: ['money@ecodia.au'] })
  assert(!r.shouldSwitch && r.alert && /STALE/.test(r.reason) && r.staleButHealthy.includes('code@ecodia.au'),
    'healthy-but-stale target -> hold + alert (this is the 2026-06-21 failure)')

  // 8. triggered, target healthy AND rotatable -> switch (the fixed happy path)
  r = decide({ accounts: { 'money@ecodia.au': A(0.1, 0.05), 'code@ecodia.au': A(0.9, 0.9) } }, 'money@ecodia.au', { rotatable: ['money@ecodia.au', 'code@ecodia.au'] })
  assert(r.shouldSwitch && r.target === 'code@ecodia.au' && !r.alert, 'healthy + rotatable target -> switch')

  // 9. triggered, NO account has budget -> hold + alert (no stale note)
  r = decide({ accounts: { 'money@ecodia.au': A(0.1, 0.05), 'code@ecodia.au': A(0.3, 0.4) } }, 'money@ecodia.au', { rotatable: ['money@ecodia.au', 'code@ecodia.au'] })
  assert(!r.shouldSwitch && r.alert && /NO account has budget/.test(r.reason), 'no budget anywhere -> hold + alert')

  console.log(process.exitCode ? '\nSELFTEST FAILED' : '\nSELFTEST PASSED (9/9)')
}

async function liveDecide() {
  const fs = require('fs'), path = require('path'), os = require('os')
  // Read the poller's persisted snapshot (same source coord.get_usage_state serves).
  const COORD_ROOT = process.env.COORD_ROOT || path.join(os.homedir(), '.ecodiaos', 'coordination')
  const SNAP = path.join(COORD_ROOT, 'usage', 'accounts.json')
  let state = null
  try { state = JSON.parse(fs.readFileSync(SNAP, 'utf8')) } catch (e) {}
  if (!state || !state.accounts) {
    console.log(JSON.stringify({ error: 'no usage snapshot at ' + SNAP + '; run coord.poll_now first' })); return
  }
  // Live account: prefer the live Keychain identity, fall back to the snapshot's active_account marker.
  let live = null
  try { const creds = require('./creds'); live = creds.current_account && creds.current_account() } catch (e) {}
  if (!live || live === 'unknown') live = state.active_account || null
  const liveEmail = live && live.includes('@') ? live : (live ? live + '@ecodia.au' : null)
  // Exclude disabled accounts (env) and currently-flaky accounts from targets.
  const disabled = (process.env.ACCOUNTS_DISABLED || '').split(',').map(s => s.trim()).filter(Boolean)
    .map(s => s.includes('@') ? s : s + '@ecodia.au')

  // rotatable = snapshots fresh enough for creds.rotate_to (expiresAt > now+5min,
  // matching STALE_THRESHOLD_MS in creds.js). A target with budget but a stale
  // snapshot is NOT switchable headlessly: it needs a re-auth. Reads expiry only,
  // never logs the token. THIS is the gate that was missing on 2026-06-21 - the
  // decision happily named a dead-snapshot target and the switch silently failed.
  const CREDS_DIR = process.env.CREDS_DIR || path.join(os.homedir(), 'PRIVATE', 'ecodia-creds')
  const STALE_MS = 5 * 60 * 1000
  const rotatable = []
  for (const email of Object.keys(state.accounts)) {
    const short = email.split('@')[0]
    try {
      const exp = JSON.parse(fs.readFileSync(path.join(CREDS_DIR, short + '.json'), 'utf8')).claudeAiOauth.expiresAt
      if (exp && (exp - Date.now()) > STALE_MS) rotatable.push(email)
    } catch (e) { /* missing/unreadable snapshot = not rotatable */ }
  }

  const result = decide(state, liveEmail, { disabled, rotatable })
  console.log(JSON.stringify(result, null, 1))

  // Loud, rate-limited away-safety net: a switch is needed but no usable target
  // exists. Ping Tate to re-auth while a healthy account is still live, instead
  // of him discovering a stall days later. Rate-limited via a marker file so the
  // 25-min cron does not spam. (text-tate.js = free iMessage, zero Claude budget.)
  if (result.alert) {
    const marker = path.join(COORD_ROOT, 'usage', 'autoswitch-alert.last')
    const COOLDOWN_MS = Number(process.env.AUTOSWITCH_ALERT_COOLDOWN_MS) || 3 * 60 * 60 * 1000
    let last = 0
    try { last = Number(fs.readFileSync(marker, 'utf8')) || 0 } catch (e) {}
    if (Date.now() - last >= COOLDOWN_MS) {
      const { spawnSync } = require('child_process')
      const TEXT_TATE = process.env.TEXT_TATE_PATH ||
        path.join(os.homedir(), '.code', 'ecodiaos', 'backend', 'imessage-agent', 'text-tate.js')
      const msg = `Auto-switch needed but BLOCKED. ${result.reason}. Re-auth the stale account (account-login) so I can switch off a capped one without you. Live=${liveEmail}.`
      try {
        const out = spawnSync('node', [TEXT_TATE, '--from', 'account-cap-watch', msg], { timeout: 20000, encoding: 'utf8' })
        if (out.status === 0) { try { fs.writeFileSync(marker, String(Date.now())) } catch (e) {}; console.error('[account-cap-decide] SMS-alerted Tate: no usable switch target') }
        else console.error('[account-cap-decide] text-tate alert failed: ' + ((out.stderr || out.stdout || '').trim().slice(0, 200)))
      } catch (e) { console.error('[account-cap-decide] text-tate threw: ' + e.message) }
    }
  }
}

if (require.main === module) {
  const arg = process.argv[2]
  if (arg === '--selftest') { selftest() }
  else if (arg === '--mock') { console.log(JSON.stringify(decide(JSON.parse(process.argv[3]), process.argv[4], {}), null, 1)) }
  else { liveDecide() }
}

module.exports = { decide, used5h, usedWeekly, SESSION_USED_TRIGGER, WEEKLY_USED_TRIGGER, TARGET_MAX_USED }
