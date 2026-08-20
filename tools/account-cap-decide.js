'use strict'
/**
 * account-cap-decide - deterministic decision for the account-cap-autoswitch
 * watcher. Pure function + CLI so the trigger is TESTABLE (mockable), instead
 * of free-text interpretation inside a cron prompt.
 *
 * Thresholds (Tate 2026-06-19): switch the live account OFF its window when
 *   5h USED      >= 80%  (headroom_5h_fraction     <= 0.20), OR
 *   weekly USED  >= 90%  (headroom_weekly_fraction <= 0.10).
 * A target must be clear of BOTH its own walls (5h used < TARGET_MAX_USED_5H, weekly used
 * < TARGET_MAX_USED_WEEKLY - a PER-WINDOW ceiling, not a flat half) and not be
 * live/flaky/disabled. Pick the highest min-headroom target.
 *
 * Usage:
 *   node account-cap-decide.js                 # live: read coord usage + Keychain
 *   node account-cap-decide.js --selftest      # run mock scenarios, assert, exit
 *   node account-cap-decide.js --mock '<json>' # decide against an injected state
 */

// Tate 2026-08-02: predict and drain at 90 percent, on BOTH windows.
//
// The 90 is only safe alongside the projection term below. Measured busy-period burn is
// p95 4.13 percentage points per 5-minute probe interval and p99 7.2, so a bare 90 with a
// 5-minute blind spot is overshot about a fifth of the time. Without projection the floor
// drops to 0.80. Both numbers live in usage-config.
const _cfg = (() => { try { return require('./usage-config') } catch (e) { return null } })()
const T = (_cfg && _cfg.TRIGGERS) || {}
// SESSION (5h) fires at 90%, WEEKLY (7d) fires at 95% (Tate 2026-08-20: "90% session OR
// 95% weekly"). These used to both read T.SWITCH_USER (0.90); the weekly window now has
// its own, later trigger so a proactive switch keeps more of the scarce weekly allowance.
const SESSION_USED_TRIGGER = T.SWITCH_USED || 0.90
const WEEKLY_USED_TRIGGER = T.SWITCH_USED_WEEKLY || 0.95
// Target eligibility ceiling is PER WINDOW (2026-08-20). A flat 0.50 on BOTH windows stranded
// auto-switch across the back half of every week: the weekly window accumulates, so once an
// account passes 50% weekly (mid-week, always) it was permanently ineligible as a target even
// on a fresh 5h window. tate@ hit the 5h wall at 0.97 while money@ sat at 5h=0.00 / weekly=0.67
// and got excluded, so the fleet texted Tate instead of switching. The weekly ceiling now sits
// just under the weekly trigger; an account is only a bad target if it is near its OWN wall.
const TARGET_MAX_USED_5H = T.TARGET_MAX_USED_5H || T.TARGET_MAX_USED || 0.50
const TARGET_MAX_USED_WEEKLY = T.TARGET_MAX_USED_WEEKLY || 0.90
const PROJECTION_HORIZON_MIN = T.PROJECTION_HORIZON_MIN || 20
const PROJECTION_CEILING = T.PROJECTION_CEILING || 0.98
const CAPPED_UTIL = T.CAPPED_UTIL || 0.99

// PREFER THE MEASURED NUMBER (2026-08-02). utilization_*_effective comes from the vendor's
// own quota endpoint; the headroom fractions underneath are the ccusage heuristic, which
// on the day this changed reported code@ at 8.9% of its 5h cap while the vendor reported
// 100% and capped. The fallback stays for one release so a stale accounts.json still
// decides something rather than nothing.
//
// These delegate to the ONE canonical implementation in usage-real (2026-08-15) so this
// decider and coord.pick_account / the alerts block share the exact same effective-vs-
// fallback precedence and can never drift again - the drift that made the advisory picker
// rank a vendor-measured 78%-weekly account as second-healthiest. Semantics unchanged.
const _usageReal = require('./usage-real')
const used5h = _usageReal.used5h
const usedWeekly = _usageReal.usedWeekly
const usedSource = _usageReal.usedSource
// Projection: at the current burn, will this account cross the ceiling before the next
// few probes? Switching at 90 with no lookahead means switching after the overshoot.
function projectedOver(a) {
  const est = a.estimate || {}
  const b5 = est.burn_pp_per_min_5h || 0
  const b7 = est.burn_pp_per_min_7d || 0
  const p5 = used5h(a) + (b5 * PROJECTION_HORIZON_MIN) / 100
  const p7 = usedWeekly(a) + (b7 * PROJECTION_HORIZON_MIN) / 100
  return (p5 >= PROJECTION_CEILING || p7 >= PROJECTION_CEILING)
    ? { over: true, p5, p7 } : { over: false, p5, p7 }
}

/**
 * pickTarget(state, liveAccount, opts) -> { usable, staleButHealthy }
 * The healthiest eligible switch targets, ranked, INDEPENDENT of whether the live
 * account has crossed a predictive threshold. decide() gates this behind the
 * usage trigger; the real-limit watch (daemons/usage-poller.js) calls it directly
 * because an actual "You've hit your ... limit" event from Claude Code IS the
 * trigger - it is ground truth, not a token estimate, so it does not consult %.
 *   usable          = ranked targets with a FRESH (rotatable) snapshot
 *   staleButHealthy = targets with budget but a stale snapshot (need re-auth)
 */
function pickTarget(state, liveAccount, opts) {
  opts = opts || {}
  const flaky = new Set(opts.flaky || [])
  const disabled = new Set(opts.disabled || [])
  const accounts = (state && state.accounts) || {}
  const headroomTargets = Object.keys(accounts)
    .filter(e => e !== liveAccount && !flaky.has(e) && !disabled.has(e))
    // An account whose usage we cannot currently measure is not a safe target: we would
    // be switching blind. It is NOT counted as depleted either - see the caller's
    // no-target reasoning.
    .filter(e => !accounts[e].excluded_as_target)
    .map(e => ({ email: e, u5: used5h(accounts[e]), uw: usedWeekly(accounts[e]) }))
    // Per-window ceiling: a target must be clear of BOTH its own walls. The weekly ceiling
    // sits just under the weekly trigger (0.90 vs 0.95) so an account mid-week - fresh 5h,
    // 0.67 weekly - is still a valid target instead of stranding the switch.
    .filter(c => c.u5 < TARGET_MAX_USED_5H && c.uw < TARGET_MAX_USED_WEEKLY)
    // highest min-headroom = lowest max-used
    .sort((a, b) => Math.max(a.u5, a.uw) - Math.max(b.u5, b.uw))

  // THE ROTATABLE GATE IS GONE (2026-08-02), and its removal is the single change that
  // un-strands auto-switching. It required a target's SNAPSHOT to be fresh, because the
  // old switch path wrote that snapshot into the Keychain. But the Keychain holds one
  // identity and Anthropic refresh tokens are single-use, so every non-live snapshot
  // rots by design: code@ sat on 484 consecutive invalid_grant failures. usable[] was
  // therefore empty almost always, and instead of switching, the fleet texted Tate to
  // re-auth by hand - 43 times in a fortnight. A full OAuth re-login needs no snapshot,
  // so snapshot freshness is now irrelevant to whether an account can be switched to.
  // opts.rotatable is accepted and ignored so an old caller cannot resurrect the gate.
  return { usable: headroomTargets, staleButHealthy: [] }
}

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
  const atThreshold = liveU5 >= sTrig || liveUW >= wTrig

  // PROJECTION (2026-08-02). Waiting for the threshold means switching AFTER the
  // overshoot: measured busy-period burn is 4.13 percentage points per 5-minute probe
  // interval at p95 and 7.2 at p99, so a 90 trigger with a 5-minute blind spot lands
  // past the cap about a fifth of the time. If the current burn would carry this account
  // over the ceiling within the horizon, switch now and let the old account drain.
  const proj = projectedOver(live)
  const triggered = atThreshold || proj.over

  if (!triggered) {
    return { shouldSwitch: false, reason: `live_comfortable (5h_used=${liveU5.toFixed(2)} weekly_used=${liveUW.toFixed(2)} source=${usedSource(live)})`, target: null, live: liveAccount, slots }
  }

  // Never decide on blind data. If the live account has no usable measurement, the
  // ground-truth cap detector (real-limit-watch, which reads Claude Code's own synthetic
  // cap message) remains the backstop; guessing here would switch on noise.
  if (live.effective_source === 'unknown') {
    return { shouldSwitch: false, reason: 'stale_measurement_hold: no usable usage reading for ' + liveAccount, target: null, live: liveAccount, slots }
  }

  // Eligible targets: not live, not flaky/disabled, both windows comfortable.
  // A headroom-comfortable target whose SNAPSHOT is stale CANNOT be rotated to
  // without a browser re-login (rotate_to refuses an expired blob), so it is not
  // a usable auto-switch target - but it IS exactly what to tell Tate to re-auth.
  // opts.rotatable, when provided, is the set of emails whose snapshot is fresh
  // enough for creds.rotate_to (expiresAt > now + 5min, the creds.js stale gate).
  const { usable, staleButHealthy } = pickTarget(state, liveAccount, opts)

  const trigReason = atThreshold
    ? `live ${liveAccount} hit cap (5h_used=${liveU5.toFixed(2)}>=${sTrig} or weekly_used=${liveUW.toFixed(2)}>=${wTrig}, source=${usedSource(live)})`
    : `live ${liveAccount} is projected over ${PROJECTION_CEILING} within ${PROJECTION_HORIZON_MIN}min at the current burn (5h ${liveU5.toFixed(2)} -> ${proj.p5.toFixed(2)}, weekly ${liveUW.toFixed(2)} -> ${proj.p7.toFixed(2)}, source=${usedSource(live)})`
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

  // 1. live at 92% 5h used -> switch to healthiest. (The trigger moved 0.80 -> 0.90 on
  //    2026-08-02, Tate's predict-and-drain call, which is only safe because the
  //    projection term below fires earlier when the burn rate warrants it.)
  let r = decide({ accounts: { 'money@ecodia.au': A(0.08, 0.5), 'code@ecodia.au': A(1.0, 1.0), 'tate@ecodia.au': A(0.6, 0.0) } }, 'money@ecodia.au')
  assert(r.shouldSwitch && r.target === 'code@ecodia.au', '92% 5h used -> switch to code@ (healthiest)')

  // 1b. 82% no longer triggers on its own: that is the drain window Tate asked for.
  r = decide({ accounts: { 'money@ecodia.au': A(0.18, 0.5), 'code@ecodia.au': A(1.0, 1.0) } }, 'money@ecodia.au')
  assert(!r.shouldSwitch, '82% 5h used -> hold (the trigger is 90 now, not 80)')

  // 2. live at 96% weekly used -> switch (weekly trigger moved 0.90 -> 0.95 on 2026-08-20)
  r = decide({ accounts: { 'money@ecodia.au': A(0.7, 0.04), 'code@ecodia.au': A(1.0, 1.0) } }, 'money@ecodia.au')
  assert(r.shouldSwitch && r.target === 'code@ecodia.au', '96% weekly used -> switch')

  // 2b. 91% weekly used no longer triggers on its own: the weekly drain window now runs
  //     to 95% (Tate 2026-08-20 "90% session OR 95% weekly"). 5h must also be comfortable.
  r = decide({ accounts: { 'money@ecodia.au': A(0.5, 0.09), 'code@ecodia.au': A(1.0, 1.0) } }, 'money@ecodia.au')
  assert(!r.shouldSwitch, '91% weekly used, 50% 5h -> hold (weekly trigger is 95 now)')

  // 2c. weekly boundary: exactly 95% weekly used -> switch (>= inclusive)
  r = decide({ accounts: { 'money@ecodia.au': A(0.5, 0.05), 'code@ecodia.au': A(1.0, 1.0) } }, 'money@ecodia.au')
  assert(r.shouldSwitch, '95.00% weekly used -> switch (boundary inclusive)')

  // 3. live comfortable -> hold
  r = decide({ accounts: { 'money@ecodia.au': A(0.9, 0.9), 'code@ecodia.au': A(1.0, 1.0) } }, 'money@ecodia.au')
  assert(!r.shouldSwitch, 'live comfortable (10% used) -> hold')

  // 4. exactly 90% 5h used -> switch (>= boundary)
  r = decide({ accounts: { 'money@ecodia.au': A(0.10, 0.5), 'code@ecodia.au': A(1.0, 1.0) } }, 'money@ecodia.au')
  assert(r.shouldSwitch, '90.00% 5h used -> switch (boundary inclusive)')

  // 5. triggered but no healthy target (all others near cap) -> hold + alert
  r = decide({ accounts: { 'money@ecodia.au': A(0.1, 0.05), 'code@ecodia.au': A(0.3, 0.4), 'tate@ecodia.au': A(0.4, 0.45) } }, 'money@ecodia.au')
  assert(!r.shouldSwitch && r.alert && /no USABLE target/.test(r.reason), 'triggered + no healthy target -> hold + alert')

  // 6. flaky target excluded
  r = decide({ accounts: { 'money@ecodia.au': A(0.1, 0.05), 'code@ecodia.au': A(1.0, 1.0) } }, 'money@ecodia.au', { flaky: ['code@ecodia.au'] })
  assert(!r.shouldSwitch, 'flaky target excluded -> hold')

  // 7. INVERTED 2026-08-02. This case used to assert that a healthy target with a stale
  //    snapshot was NOT usable, and it held while texting Tate to re-auth by hand. That
  //    gate is deleted: switching is a full OAuth re-login, which needs no snapshot at
  //    all. A snapshot rots on every non-live account by design (one Keychain,
  //    single-use refresh tokens), so the gate emptied the target set almost always -
  //    code@ sat on 484 consecutive invalid_grant failures and the fleet sent 43 texts
  //    in a fortnight instead of switching. The healthy account must now be switched to.
  r = decide({ accounts: { 'money@ecodia.au': A(0.1, 0.05), 'code@ecodia.au': A(0.9, 0.9) } }, 'money@ecodia.au', { rotatable: ['money@ecodia.au'] })
  assert(r.shouldSwitch && r.target === 'code@ecodia.au' && !r.alert,
    'a healthy target with a STALE snapshot is switched to (the rotatable gate is gone)')

  // 8. the same thing with every snapshot fresh: unchanged behaviour, and proof that
  //    passing opts.rotatable at all no longer alters the outcome either way.
  r = decide({ accounts: { 'money@ecodia.au': A(0.1, 0.05), 'code@ecodia.au': A(0.9, 0.9) } }, 'money@ecodia.au', { rotatable: ['money@ecodia.au', 'code@ecodia.au'] })
  assert(r.shouldSwitch && r.target === 'code@ecodia.au' && !r.alert, 'healthy target -> switch')

  // 9. triggered, NO account has budget -> hold + alert (no stale note)
  r = decide({ accounts: { 'money@ecodia.au': A(0.1, 0.05), 'code@ecodia.au': A(0.3, 0.4) } }, 'money@ecodia.au', { rotatable: ['money@ecodia.au', 'code@ecodia.au'] })
  assert(!r.shouldSwitch && r.alert && /NO account has budget/.test(r.reason), 'no budget anywhere -> hold + alert')

  // 10. THE MEASURED NUMBER WINS. This is the live 2026-08-02 state: the vendor says
  //     code@ is at 100% of its 5h window and capped, while the ccusage heuristic
  //     underneath still reports it as the healthiest account in the fleet. If the
  //     fallback ever wins here, the picker switches into a capped account.
  const REAL = (u5, u7, legacyH5, legacyH7) => ({
    utilization_5h_effective: u5, utilization_7d_effective: u7, effective_source: 'real',
    headroom_5h_fraction: legacyH5, headroom_weekly_fraction: legacyH7,
    cap_5h: 1, cap_weekly: 1, remaining_5h: legacyH5, remaining_weekly: legacyH7,
  })
  r = decide({
    accounts: {
      'tate@ecodia.au': REAL(0.95, 0.53, 0.58, 0.84),
      'code@ecodia.au': REAL(1.00, 0.20, 0.84, 0.84),   // legacy says healthiest, vendor says CAPPED
      'money@ecodia.au': REAL(0.00, 1.00, 0.56, 0.73),  // legacy says fine, vendor says CAPPED
    },
  }, 'tate@ecodia.au')
  assert(r.shouldSwitch === false && r.alert,
    'both alternates measured capped -> hold and alert, never switch into one (the live 2026-08-02 state)')
  assert(!/code@/.test(String(r.target)), 'the capped account is never offered as a target however good its legacy number looks')

  // 11. Projection: comfortably under the trigger, but burning fast enough to blow
  //     through the ceiling before the next few probes. Switching at 90 with no
  //     lookahead means switching after the overshoot, and measured p95 burn is 4.13
  //     points per 5-minute interval.
  const burning = Object.assign(REAL(0.80, 0.30, 0.20, 0.70), { estimate: { burn_pp_per_min_5h: 1.5, burn_pp_per_min_7d: 0 } })
  r = decide({ accounts: { 'money@ecodia.au': burning, 'code@ecodia.au': REAL(0.05, 0.05, 0.95, 0.95) } }, 'money@ecodia.au')
  assert(r.shouldSwitch && /projected/i.test(r.reason), 'a fast burn triggers early via the projection term, before the ceiling is hit')

  // 12. The same account NOT burning stays put: projection must not fire on a quiet one.
  const quiet = Object.assign(REAL(0.80, 0.30, 0.20, 0.70), { estimate: { burn_pp_per_min_5h: 0.01, burn_pp_per_min_7d: 0 } })
  r = decide({ accounts: { 'money@ecodia.au': quiet, 'code@ecodia.au': REAL(0.05, 0.05, 0.95, 0.95) } }, 'money@ecodia.au')
  assert(!r.shouldSwitch, '80% used but barely burning -> hold, the drain window is the point')

  // 13. THE 2026-08-20 STRAND (regression guard). tate@ hit the 5h SESSION wall (0.97).
  //     code@ was weekly-capped (0.98). money@ had a FRESH 5h window (0.00) and 0.67 weekly -
  //     well under its 0.95 weekly trigger. The old flat TARGET_MAX_USED=0.50 excluded money@
  //     for weekly>0.50 and the fleet TEXTED Tate "no usable target" instead of switching.
  //     With the per-window ceiling money@ MUST be the target. If this ever alerts again, the
  //     weekly ceiling has regressed toward the accumulator trap.
  r = decide({ accounts: {
    'tate@ecodia.au': REAL(0.97, 0.25, 0.03, 0.75),
    'code@ecodia.au': REAL(0.00, 0.98, 1.00, 0.02),
    'money@ecodia.au': REAL(0.00, 0.67, 1.00, 0.33),
  } }, 'tate@ecodia.au')
  assert(r.shouldSwitch && r.target === 'money@ecodia.au' && !r.alert,
    'session wall + only alternate at 0.67 weekly (fresh 5h) -> switch to it, never alert (2026-08-20 strand)')

  // 13b. Boundary: an alternate at exactly the weekly ceiling (0.90) is NOT a target; just under is.
  r = decide({ accounts: {
    'tate@ecodia.au': REAL(0.97, 0.25, 0.03, 0.75),
    'money@ecodia.au': REAL(0.00, 0.90, 1.00, 0.10),
  } }, 'tate@ecodia.au')
  assert(!r.shouldSwitch && r.alert, '0.90 weekly target is at the ceiling -> excluded (alert)')
  r = decide({ accounts: {
    'tate@ecodia.au': REAL(0.97, 0.25, 0.03, 0.75),
    'money@ecodia.au': REAL(0.00, 0.89, 1.00, 0.11),
  } }, 'tate@ecodia.au')
  assert(r.shouldSwitch && r.target === 'money@ecodia.au', '0.89 weekly target is just under the ceiling -> switch')

  console.log(process.exitCode ? '\nSELFTEST FAILED' : '\nSELFTEST PASSED')
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
  // Exclude disabled and currently-flaky accounts from targets. Roster comes from the
  // registry as of 2026-08-02, not process.env.ACCOUNTS_DISABLED: the env var lived in
  // four places that drifted apart, and a disable with no expiry kept a re-subscribed
  // tate@ out of the target set for six weeks while this very function texted Tate that
  // it had nowhere to switch.
  const disabled = (() => {
    try { return require('./accounts-registry').disabledEmails() } catch (e) { return [] }
  })().map(s => s.includes('@') ? s : s + '@ecodia.au')

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

module.exports = { decide, pickTarget, used5h, usedWeekly, SESSION_USED_TRIGGER, WEEKLY_USED_TRIGGER, TARGET_MAX_USED_5H, TARGET_MAX_USED_WEEKLY }
