'use strict'
// tools/switch-core.js - the DECIDING half of an account switch. Pure functions only:
// no network, no filesystem, no child processes, nothing that happens at require time.
// scripts/switch-run.js performs the effects and calls in here for every judgement.
//
// The split exists because the switch is the one operation that, when it goes wrong,
// takes the whole fleet down with it: it rewrites a machine-wide Keychain that every
// Claude Code process on the host reads. Every decision it makes should be testable
// without touching that Keychain, so all of them live here behind injected inputs.
//
// WHAT THIS ENCODES, and why each rule exists:
//
//   VERIFY IS FIVE INDEPENDENT CHECKS, not a narration. "Login successful" scrolled past
//   is not evidence. The five are: the refresh-stable label, the Keychain token actually
//   changing, the coord marker, the CLI's own view, and a fresh vendor probe with the new
//   token. Four of them agreed for weeks in 2026-07 while the fifth would have caught
//   that the label had been stripped and current_account() was naming the account we had
//   just switched away from.
//
//   THE FAIL LADDER IS FLIP-AWARE. Once the Keychain token has changed, the machine is
//   already on the new account: falling through to "try the next-ranked target" would
//   then full-login a THIRD account nobody chose, while the intended one is live and
//   adopted. After the flip, failure means repair-and-verify, never re-target.
//
//   A LOCK IS RECLAIMED ON EVIDENCE, NOT AGE. The money@ magic-link leg alone waits up
//   to 12 minutes for mail. An age-based reclaim would kill a leg that is working
//   perfectly and hand the Keychain to a second concurrent login. Reclaim requires a
//   dead pid or a heartbeat that has stopped moving.

const cfg = require('./usage-config')

const STATES = [
  'IDLE', 'RECONCILE', 'PREFLIGHT', 'SEED_OUTGOING', 'LOGIN_CLI',
  'BROWSER_DRIVE', 'VERIFY', 'RECORD', 'DONE', 'FAILED',
]

// Exit codes are a caller contract: the poller and real-limit-watch read them, and
// "launched" must never be reportable as success anywhere.
const EXIT = {
  VERIFIED: 0,
  USAGE: 2,
  IN_PROGRESS: 3,   // another switch holds the lock; success-pending, not a failure
  NOOP: 4,          // pinned, disabled, or already on the target
  FAILED: 5,
}

// ── lock ─────────────────────────────────────────────────────────────────────

// Heartbeat-based, never age-based. Returns what the caller should DO, with a reason a
// human can act on.
function lockVerdict(lock, opts) {
  opts = opts || {}
  const nowMs = opts.nowMs || Date.now()
  const staleMs = opts.staleMs || 5 * 60 * 1000
  const pidAlive = opts.pidAlive || (() => false)

  if (!lock || !lock.pid) return { action: 'claim', reason: 'no lock held' }
  if (!pidAlive(lock.pid)) {
    return { action: 'reclaim', reason: 'holder pid ' + lock.pid + ' is gone', deadHolder: true }
  }
  const beat = lock.heartbeat_at ? Date.parse(lock.heartbeat_at) : NaN
  if (!isFinite(beat)) return { action: 'wait', reason: 'holder ' + lock.pid + ' is alive but has not beaten yet' }
  const ageMs = nowMs - beat
  if (ageMs > staleMs) {
    return {
      action: 'reclaim',
      reason: 'holder ' + lock.pid + ' is alive but wedged: no heartbeat for ' + Math.round(ageMs / 1000) + 's at stage ' + (lock.stage || '?'),
      wedged: true,
    }
  }
  return { action: 'wait', reason: 'a switch to ' + (lock.target || '?') + ' is in flight at stage ' + (lock.stage || '?'), ageMs }
}

// ── preflight ────────────────────────────────────────────────────────────────

// Everything that can be known BEFORE any side effect. A refusal here costs nothing; the
// same refusal after `claude auth login` has rewritten the Keychain is a half-switch.
function preflightVerdict(input) {
  const { target, registry, pinRaw, currentShort, cdpAlive, prereq } = input || {}
  if (!target) return { ok: false, code: EXIT.USAGE, reason: 'no target given' }

  const pin = cfg.parsePin(pinRaw)
  if (pin.valid && pin.account !== target) {
    return { ok: false, code: EXIT.NOOP, reason: 'REFUSED: the live account is pinned to ' + pin.account + (pin.reason ? ' (' + pin.reason + ')' : '') + '; not switching to ' + target }
  }

  const row = registry && registry.accounts && registry.accounts[target]
  if (!row) return { ok: false, code: EXIT.USAGE, reason: 'unknown account: ' + target }
  if (row.enabled === false) {
    return { ok: false, code: EXIT.NOOP, reason: target + ' is disabled in the registry' + (row.disabled_reason ? ' (' + row.disabled_reason + ')' : '') }
  }
  if (currentShort && currentShort === target) {
    return { ok: false, code: EXIT.NOOP, reason: 'already live on ' + target, alreadyOnTarget: true }
  }
  if (cdpAlive === false) {
    return { ok: false, code: EXIT.FAILED, reason: 'cdp_dead: canonical Chrome is not answering on 9222, so the consent page cannot be driven' }
  }
  if (prereq && prereq.ok === false) {
    return { ok: false, code: EXIT.FAILED, reason: 'prereq:' + (prereq.which || 'unknown') + ' - ' + (prereq.detail || '') }
  }
  return { ok: true, pin, row }
}

// ── verify ───────────────────────────────────────────────────────────────────

// All inputs injected, so every branch is fixture-testable.
function verifyIdentity(input) {
  const { targetEmail, preTokenSha, keychainTokenSha, claudeJsonEmail, activeAccountEmail, authStatusText, probe } = input || {}
  const eq = (a, b) => !!a && !!b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase()

  const checks = {
    // The refresh-stable label. This is the one that was silently wrong for weeks.
    label: eq(claudeJsonEmail, targetEmail),
    // The Keychain actually changed. Guards against a login that no-oped.
    token_changed: !!keychainTokenSha && keychainTokenSha !== preTokenSha,
    // The coord marker used for usage attribution and dispatch.
    active_account: eq(activeAccountEmail, targetEmail),
    // The CLI's own answer, independent of our files.
    auth_status: !!authStatusText && String(authStatusText).toLowerCase().includes(String(targetEmail).toLowerCase()),
    // The vendor agrees, using the NEW token. Nothing else proves the token works.
    usage_probe: !!(probe && probe.ok),
  }
  const failed = Object.keys(checks).filter(k => !checks[k])
  return {
    ok: failed.length === 0,
    checks,
    failed,
    reason: failed.length ? 'verify:' + failed.join(',') : null,
  }
}

// ── fail ladder ──────────────────────────────────────────────────────────────

// The single most important rule in this file. `flipped` means the Keychain token has
// already changed, i.e. the machine IS on some new account. After that point a
// next-target fallback would log into a third account nobody asked for.
function failLadder(input) {
  const { flipped, attempt, maxAttempts, remainingTargets, pinnedTarget } = input || {}
  const attempts = attempt || 1
  const max = maxAttempts || 2

  if (flipped) {
    if (attempts < max) return { action: 'repair', reason: 'the Keychain already flipped; re-verifying and reconciling rather than logging into a third account' }
    return { action: 'give_up', reason: 'the Keychain flipped but verification kept failing; leaving RECONCILE to name the true live account' }
  }
  if (attempts < max) return { action: 'retry_same', reason: 'pre-flip failure, retrying the same target once' }
  if (pinnedTarget) return { action: 'give_up', reason: 'matrix mode pins one target; not falling through to another account' }
  if (remainingTargets && remainingTargets.length) {
    return { action: 'next_target', target: remainingTargets[0], reason: 'pre-flip failure on every attempt; trying the next ranked target' }
  }
  return { action: 'give_up', reason: 'no targets left' }
}

// ── reconcile ────────────────────────────────────────────────────────────────

// Every mid-login crash leaves the machine half-switched: the Keychain holds the new
// account, ~/.claude.json and active_account.json still name the old one, and no history
// row exists. Nothing in the old design ever noticed. The token is the only thing that
// cannot lie, so the token decides and the labels are rewritten to match.
function reconcileVerdict(input) {
  const { switchState, tokenEmail, claudeJsonEmail, activeAccountEmail } = input || {}
  const nonTerminal = switchState && switchState.state &&
    !['DONE', 'FAILED', 'IDLE'].includes(switchState.state)

  if (!tokenEmail) {
    return { needed: !!nonTerminal, ok: false, reason: 'cannot identify the live token; leaving labels untouched rather than guessing' }
  }
  const mismatched = []
  const eq = (a, b) => !!a && !!b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase()
  if (!eq(claudeJsonEmail, tokenEmail)) mismatched.push('claude_json')
  if (!eq(activeAccountEmail, tokenEmail)) mismatched.push('active_account')

  if (!nonTerminal && mismatched.length === 0) return { needed: false, ok: true }
  return {
    needed: true,
    ok: true,
    tokenEmail,
    repair: mismatched,
    reason: nonTerminal
      ? 'a previous switch stopped at ' + switchState.state + '; the live token belongs to ' + tokenEmail
      : 'labels disagree with the live token (' + mismatched.join(',') + '); the token wins',
  }
}

// ── target ranking ───────────────────────────────────────────────────────────

// Ranks by measured headroom, and only ever offers accounts with real budget on BOTH
// windows. Snapshot freshness is deliberately NOT a criterion: a full OAuth re-login
// needs no snapshot, and the old rotatable gate is exactly what emptied the target set
// and left the fleet texting a human instead of switching.
function rankTargets(input) {
  const { accounts, liveEmail, disabled, flaky, maxUsed } = input || {}
  const ceiling = typeof maxUsed === 'number' ? maxUsed : cfg.TRIGGERS.TARGET_MAX_USED
  const dis = new Set((disabled || []).map(s => String(s).toLowerCase()))
  const fl = new Set((flaky || []).map(s => String(s).toLowerCase()))
  const out = []
  const rejected = []

  for (const [email, row] of Object.entries(accounts || {})) {
    const short = email.split('@')[0]
    const why = (r) => rejected.push({ email, reason: r })
    if (email === liveEmail) { why('is the live account'); continue }
    if (dis.has(email.toLowerCase()) || dis.has(short.toLowerCase())) { why('disabled in the registry'); continue }
    if (fl.has(email.toLowerCase()) || fl.has(short.toLowerCase())) { why('marked flaky'); continue }
    if (row.excluded_as_target) { why(row.excluded_reason || 'excluded'); continue }
    const u5 = row.utilization_5h_effective, u7 = row.utilization_7d_effective
    if (typeof u5 !== 'number' || typeof u7 !== 'number') { why('no usable utilization reading'); continue }
    if (Math.max(u5, u7) >= cfg.TRIGGERS.CAPPED_UTIL) { why('CAPPED (' + Math.round(Math.max(u5, u7) * 100) + '%)'); continue }
    if (u5 > ceiling || u7 > ceiling) {
      why('too little headroom (5h ' + Math.round(u5 * 100) + '%, weekly ' + Math.round(u7 * 100) + '%)')
      continue
    }
    out.push({ email, short, worst: Math.max(u5, u7), utilization_5h: u5, utilization_7d: u7 })
  }
  out.sort((a, b) => a.worst - b.worst)
  return { targets: out, rejected }
}

// ── selftest ─────────────────────────────────────────────────────────────────

function selftest() {
  let failed = 0
  const ok = (c, n) => { console.log((c ? '  PASS: ' : '  FAIL: ') + n); if (!c) failed++ }
  const now = Date.now()
  const alive = () => true, dead = () => false

  console.log('-- lock: reclaim on evidence, never on age --')
  ok(lockVerdict(null, { nowMs: now }).action === 'claim', 'no lock means claim it')
  ok(lockVerdict({ pid: 1, heartbeat_at: new Date(now - 1000).toISOString() }, { nowMs: now, pidAlive: alive }).action === 'wait',
    'a live holder beating one second ago is left alone')
  ok(lockVerdict({ pid: 1, stage: 'BROWSER_DRIVE', heartbeat_at: new Date(now - 11 * 60000).toISOString() }, { nowMs: now, pidAlive: alive }).action === 'wait' === false,
    'a holder silent for 11 minutes is wedged')
  ok(lockVerdict({ pid: 1, heartbeat_at: new Date(now - 4 * 60000).toISOString() }, { nowMs: now, pidAlive: alive }).action === 'wait',
    'a 4-minute-old heartbeat is still within tolerance: the money@ magic-link leg legitimately waits up to 12 minutes')
  ok(lockVerdict({ pid: 999999, heartbeat_at: new Date(now).toISOString() }, { nowMs: now, pidAlive: dead }).action === 'reclaim',
    'a dead holder is reclaimed however fresh its heartbeat looks')

  console.log('-- preflight: refuse before any side effect --')
  const reg = { accounts: { tate: { enabled: true }, code: { enabled: true }, money: { enabled: false, disabled_reason: 'paused' } } }
  ok(preflightVerdict({ target: 'code', registry: reg, cdpAlive: true }).ok, 'a healthy target passes')
  ok(preflightVerdict({ target: 'money', registry: reg, cdpAlive: true }).code === EXIT.NOOP, 'a disabled target is a no-op, not a failure')
  ok(preflightVerdict({ target: 'code', registry: reg, currentShort: 'code', cdpAlive: true }).alreadyOnTarget === true, 'already-on-target is recognised')
  ok(preflightVerdict({ target: 'code', registry: reg, cdpAlive: false }).reason.startsWith('cdp_dead'), 'dead CDP is caught in preflight')
  ok(preflightVerdict({ target: 'code', registry: reg, cdpAlive: true, prereq: { ok: false, which: 'pw_mirror', detail: 'missing' } }).reason.startsWith('prereq:pw_mirror'),
    'a missing password mirror fails BEFORE the Keychain is touched')

  console.log('-- preflight: the pin is force-proof and understands both formats --')
  ok(preflightVerdict({ target: 'code', registry: reg, cdpAlive: true, pinRaw: 'tate' }).code === EXIT.NOOP, 'a legacy bare-string pin still blocks')
  ok(preflightVerdict({ target: 'code', registry: reg, cdpAlive: true, pinRaw: JSON.stringify({ account: 'tate', reason: 'debugging' }) }).code === EXIT.NOOP,
    'a JSON pin blocks and carries its reason')
  ok(preflightVerdict({ target: 'code', registry: reg, cdpAlive: true, pinRaw: JSON.stringify({ account: 'code' }) }).ok, 'a pin naming the target does not block it')
  ok(preflightVerdict({ target: 'code', registry: reg, cdpAlive: true, pinRaw: JSON.stringify({ account: 'tate', expires_at: new Date(now - 1000).toISOString() }) }).ok,
    'an EXPIRED pin is ignored, so a forgotten pin cannot strand the fleet forever')

  console.log('-- verify: five independent checks --')
  const good = {
    targetEmail: 'code@ecodia.au', preTokenSha: 'aaa', keychainTokenSha: 'bbb',
    claudeJsonEmail: 'code@ecodia.au', activeAccountEmail: 'code@ecodia.au',
    authStatusText: 'Logged in as code@ecodia.au', probe: { ok: true },
  }
  ok(verifyIdentity(good).ok, 'all five green verifies')
  ok(verifyIdentity(Object.assign({}, good, { claudeJsonEmail: 'tate@ecodia.au' })).failed[0] === 'label',
    'a stale label alone fails verification: this is the defect that read as "the switch did not stick"')
  ok(verifyIdentity(Object.assign({}, good, { keychainTokenSha: 'aaa' })).failed[0] === 'token_changed', 'an unchanged Keychain token fails')
  ok(verifyIdentity(Object.assign({}, good, { probe: { ok: false } })).failed[0] === 'usage_probe', 'a token the vendor rejects fails')
  ok(verifyIdentity(Object.assign({}, good, { authStatusText: '' })).failed[0] === 'auth_status', 'no CLI confirmation fails')
  ok(verifyIdentity(Object.assign({}, good, { activeAccountEmail: null })).failed[0] === 'active_account', 'a missing coord marker fails')

  console.log('-- fail ladder: never log into a third account after the flip --')
  ok(failLadder({ flipped: false, attempt: 1, remainingTargets: ['money'] }).action === 'retry_same', 'pre-flip retries the same target once')
  ok(failLadder({ flipped: false, attempt: 2, remainingTargets: ['money'] }).action === 'next_target', 'pre-flip then falls through to the next target')
  ok(failLadder({ flipped: true, attempt: 1, remainingTargets: ['money'] }).action === 'repair', 'post-flip repairs instead of re-targeting')
  ok(failLadder({ flipped: true, attempt: 2, remainingTargets: ['money'] }).action === 'give_up', 'post-flip never falls through to a third account')
  ok(failLadder({ flipped: false, attempt: 2, remainingTargets: ['money'], pinnedTarget: true }).action === 'give_up', 'matrix mode pins one target')
  ok(failLadder({ flipped: false, attempt: 2, remainingTargets: [] }).action === 'give_up', 'no targets left means give up')

  console.log('-- reconcile: the token wins over every label --')
  let r = reconcileVerdict({ switchState: { state: 'LOGIN_CLI' }, tokenEmail: 'code@ecodia.au', claudeJsonEmail: 'tate@ecodia.au', activeAccountEmail: 'tate@ecodia.au' })
  ok(r.needed && r.repair.length === 2, 'a crash mid-login is detected and both labels are queued for repair')
  ok(reconcileVerdict({ switchState: { state: 'DONE' }, tokenEmail: 'code@ecodia.au', claudeJsonEmail: 'code@ecodia.au', activeAccountEmail: 'code@ecodia.au' }).needed === false,
    'a clean finish needs no reconcile')
  ok(reconcileVerdict({ switchState: { state: 'DONE' }, tokenEmail: 'code@ecodia.au', claudeJsonEmail: 'tate@ecodia.au', activeAccountEmail: 'code@ecodia.au' }).repair[0] === 'claude_json',
    'label drift is caught even when the last switch finished cleanly')
  ok(reconcileVerdict({ switchState: { state: 'VERIFY' }, tokenEmail: null }).ok === false, 'with no identifiable token we repair nothing rather than guess')

  console.log('-- ranking: only accounts with real budget, snapshot state irrelevant --')
  const accounts = {
    'tate@ecodia.au': { utilization_5h_effective: 0.39, utilization_7d_effective: 0.53 },
    'code@ecodia.au': { utilization_5h_effective: 1.0, utilization_7d_effective: 0.20 },
    'money@ecodia.au': { utilization_5h_effective: 0.0, utilization_7d_effective: 1.0 },
  }
  let rk = rankTargets({ accounts, liveEmail: 'tate@ecodia.au' })
  ok(rk.targets.length === 0, 'the live 2026-08-02 state offers NO target: both alternates are capped')
  ok(rk.rejected.some(x => /CAPPED/.test(x.reason)), 'and it says CAPPED rather than silently dropping them')

  rk = rankTargets({
    accounts: {
      'tate@ecodia.au': { utilization_5h_effective: 0.9, utilization_7d_effective: 0.9 },
      'code@ecodia.au': { utilization_5h_effective: 0.4, utilization_7d_effective: 0.1 },
      'money@ecodia.au': { utilization_5h_effective: 0.1, utilization_7d_effective: 0.1 },
    },
    liveEmail: 'tate@ecodia.au',
  })
  ok(rk.targets[0].short === 'money', 'the emptiest account ranks first')
  ok(rk.targets.length === 2, 'both healthy alternates are offered')

  rk = rankTargets({
    accounts: { 'code@ecodia.au': { utilization_5h_effective: 0.1, utilization_7d_effective: 0.1, snapshot_state: 'dead' } },
    liveEmail: 'tate@ecodia.au',
  })
  ok(rk.targets.length === 1, 'a DEAD snapshot is still a valid target: a full re-login needs no snapshot (this is the gate that stranded auto-switch)')

  rk = rankTargets({ accounts: { 'code@ecodia.au': { excluded_as_target: true, excluded_reason: 'probe stale' } }, liveEmail: 'tate@ecodia.au' })
  ok(rk.targets.length === 0 && /stale/.test(rk.rejected[0].reason), 'an unmeasurable account is not offered, and the reason survives')

  console.log(failed ? '\nSELFTEST FAILED (' + failed + ')' : '\nSELFTEST PASSED')
  process.exitCode = failed ? 1 : 0
}

module.exports = {
  STATES, EXIT,
  lockVerdict, preflightVerdict, verifyIdentity, failLadder, reconcileVerdict, rankTargets,
  _selftest: selftest,
}

if (require.main === module && process.argv.includes('--selftest')) selftest()
