'use strict'
// tools/pace-governor.js - LEASE-TIME WEEKLY PACE GOVERNOR (lane G7, 2026-09-29).
//
// WHY THIS EXISTS
// From 2026-09-29 the fleet runs on ONE Claude plan. code@ and money@ lapsed on failed
// payment and are disabled in the accounts registry until 2026-12-28, so tate@ is the
// only enabled account, with no failover behind it. A weekly cap on that account stops
// every worker and cron (inbound triage and security included) until the 7d reset, and
// Tate's own phone app shares the same window. Tate is laptop-free ~2026-10-04 to
// ~2026-12-23, so nobody is at the Mac to notice a stall.
//
// The cron freeze does not protect the week: migration 196 lets every one-off
// (delayed/chained) row lease under a freeze, and on 2026-09-16 money@ went 0.35 to 0.74
// weekly entirely underneath the freeze. Before this module nothing on the lease path read
// weekly headroom at all: the only related guard was pick_healthiest_account's
// defer-on-all-capped, which fires once the account is ALREADY capped.
//
// WHAT IT DOES
// ACTIVE only while the registry has exactly one enabled account, so it retires itself
// the moment a second plan is re-enabled. While active it reads the live account's
// vendor-measured 7d utilisation (usage-real.js, never ccusage) at most once per
// CACHE_TTL_MS and, when the week is running hot, tells leaseDueRows to lease CORE rows
// only. Non-core rows are not cancelled and their next_run_at is not touched: they stay
// due, carry a visible last_error signature, and lease on the first pass after pace
// recovers. The thresholds mirror gradeSingleAccount() in the backend's
// scripts/account-failover-depth-canary.cjs so the alarm and the brake agree on what
// "hot" means:
//   defer non-core when 7d >= 0.80, or when 7d >= 0.30 AND 7d > elapsed_share + 0.20
//
// CORE (never deferred) is read from the sources that already define it, never retyped:
//   - a cron whose cronAusterity group still fires under a FROZEN posture
//     (decidePosture(name, {frozen:true}).suppressed === false: inbound comms, security,
//     breakage, compliance)
//   - the Continuity Engine's own rows (continuity/arm-chain.cjs CHAIN_NAME and the
//     cowork.away-ship-verify-<key> rows continuity/dispatch-verify-successor.cjs arms)
//   - any row whose prompt DECLARES FREEZE-EXEMPT on its own line, with the same anchored
//     regex migration 196 uses: (^|\n)[[:space:]]*FREEZE-EXEMPT
//
// FAILURE POSTURE
// Fail-OPEN, loudly: an unreadable probe, a missing band table or any internal throw
// leaves leasing exactly as it was before this module existed. leaseDueRows' catch pages
// Tate over iMessage, so evaluate() must never throw into it. The failover-depth canary
// already alarms on an unreadable single account, so the brake does not need to.
//
// Doctrine: patterns/one-plan-means-the-week-is-the-budget-2026-09-29.md (backend),
// patterns/a-suppression-gate-that-leaves-no-signature-makes-every-caller-believe-it-succeeded-2026-09-13.md.

const WARN_7D = 0.80
const PACE_MARGIN = 0.20
const PACE_FLOOR = 0.30
const WEEK_MS = 7 * 24 * 3600e3
const CACHE_TTL_MS = 5 * 60 * 1000
// A reading older than this is not a reading. probeAccount keeps the prior numbers on a
// 429/401/timeout, so without an age bound a probe that stayed broken for a day would
// keep braking (or not braking) on yesterday's figure.
const MAX_READING_AGE_MS = 30 * 60 * 1000
const SIG_PREFIX = 'pace-governor:'

const CONTINUITY_NAMES = ['continuity-advance-chain']
const CONTINUITY_PREFIXES = ['cowork.away-ship-verify-']
// Postgres receives the two characters backslash + n, which its ARE reads as a newline;
// identical to the literal in migration 196_freeze_is_a_roster_lever_not_a_worker_lever.
const FREEZE_EXEMPT_PG = '(^|\\n)[[:space:]]*FREEZE-EXEMPT'
// JS twin. [[:space:]] in Postgres is space, tab, newline, CR, FF, VT; \s would be wider.
const FREEZE_EXEMPT_RE = /(^|\n)[ \t\n\r\f\v]*FREEZE-EXEMPT/

const FROZEN = { frozen: true }

// ── injectable effects (tests never touch the network, Keychain or registry file) ──
let _deps = {}
function _setDeps(d) { _deps = d || {}; _reset() }
function dep(name) {
  if (_deps[name]) return _deps[name]
  if (name === 'registry') return require('./accounts-registry')
  if (name === 'probe') return require('./usage-real').probeAccount
  if (name === 'now') return Date.now
  if (name === 'log') return (s) => process.stderr.write(s + '\n')
  return null
}

// ── pure ─────────────────────────────────────────────────────────────────────

function austerityUsable(cfg) {
  return !!(cfg && typeof cfg.decidePosture === 'function' && Array.isArray(cfg.GROUP_OF_SETS))
}

// Every cron name that survives a frozen posture, computed from the band table itself.
// Unknown names are not listed: decidePosture defaults them to always_on, which a freeze
// suppresses, so they are non-core on both the SQL and the JS side.
function coreCronNames(cfg) {
  if (!austerityUsable(cfg)) return null
  const names = new Set()
  for (const [, set] of cfg.GROUP_OF_SETS) for (const n of set) names.add(n)
  if (cfg.FROZEN_SURVIVORS) for (const n of cfg.FROZEN_SURVIVORS) names.add(n)
  return [...names].filter(n => cfg.decidePosture(n, FROZEN).suppressed === false).sort()
}

function isContinuityName(name) {
  const n = String(name || '')
  return CONTINUITY_NAMES.includes(n) || CONTINUITY_PREFIXES.some(p => n.startsWith(p))
}

function declaresFreezeExempt(prompt) {
  return FREEZE_EXEMPT_RE.test(String(prompt || ''))
}

// JS twin of sqlCorePredicate, used at dispatch time on the leased row.
function isCoreRow(row, cfg) {
  if (!row) return false
  if (row.type === 'cron' && austerityUsable(cfg) &&
      cfg.decidePosture(row.name, FROZEN).suppressed === false) return true
  if (isContinuityName(row.name)) return true
  return declaresFreezeExempt(row.prompt)
}

function likePrefix(p) { return String(p).replace(/[\\%_]/g, c => '\\' + c) + '%' }

// SQL twin. Consumes four parameters starting at $base, supplied by sqlCoreParams().
function sqlCorePredicate(alias, base) {
  const a = alias ? alias + '.' : ''
  return `((${a}type = 'cron' AND ${a}name = ANY($${base}::text[]))
          OR ${a}name = ANY($${base + 1}::text[])
          OR ${a}name LIKE ANY($${base + 2}::text[])
          OR COALESCE(${a}prompt, '') ~ $${base + 3})`
}

function sqlCoreParams(coreCrons) {
  return [Array.isArray(coreCrons) ? coreCrons : [], CONTINUITY_NAMES.slice(),
    CONTINUITY_PREFIXES.map(likePrefix), FREEZE_EXEMPT_PG]
}

const r2 = (x) => Math.round(x * 100) / 100
const f2 = (x) => (Number.isFinite(x) ? r2(x).toFixed(2) : 'n/a')

// reading = a probeAccount() result. Returns the brake decision for that reading.
function decidePace(reading, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now()
  const r = reading || {}
  const u7 = r.utilization_7d
  const probedAt = r.probed_at ? Date.parse(r.probed_at) : NaN
  const age = Number.isFinite(probedAt) ? now - probedAt : Infinity
  if (!Number.isFinite(u7) || r.probe_status === 'identity_mismatch' || !(age <= MAX_READING_AGE_MS)) {
    const why = !Number.isFinite(u7) ? 'no 7d reading'
      : r.probe_status === 'identity_mismatch' ? 'identity mismatch'
      : 'reading ' + (Number.isFinite(age) ? Math.round(age / 60000) + 'min' : 'of unknown age') + ' old'
    return { readable: false, defer: false, rule: null, used: null, elapsed: null,
      reason: why + ' (probe ' + (r.probe_status || 'absent') + ')' }
  }
  const reset = r.resets_at_7d ? Date.parse(r.resets_at_7d) : NaN
  const elapsed = Number.isFinite(reset) ? Math.min(1, Math.max(0, 1 - (reset - now) / WEEK_MS)) : null
  let rule = null
  if (u7 >= WARN_7D) rule = 'weekly-line'
  else if (elapsed !== null && u7 >= PACE_FLOOR && u7 > elapsed + PACE_MARGIN) rule = 'ahead-of-pace'
  return { readable: true, defer: rule !== null, rule, used: r2(u7),
    elapsed: elapsed === null ? null : r2(elapsed),
    reason: rule === 'weekly-line' ? '7d at or over the ' + f2(WARN_7D) + ' weekly line'
      : rule === 'ahead-of-pace' ? '7d >= ' + f2(PACE_FLOOR) + ' and more than ' + f2(PACE_MARGIN) + ' ahead of the elapsed share'
      : 'within pace' }
}

// The row-visible trace. Stable to 2dp so the guarded write fires only when it changes.
function signature(decision, account) {
  const d = decision || {}
  return SIG_PREFIX + ' deferred, ' + (account || '?') + ' 7d ' + f2(d.used) + ' vs ' +
    f2(d.elapsed) + ' elapsed (' + (d.rule || 'no rule') + ': non-core rows wait for pace to recover, core still leases)'
}

// ── stateful ─────────────────────────────────────────────────────────────────

let _cache = null        // { at, short, reading }
let _lastLogKey = null

function _reset() { _cache = null; _lastLogKey = null }

function logOnce(key, line) {
  if (key === _lastLogKey) return
  _lastLogKey = key
  try { dep('log')(line) } catch (_) {}
}

function inert(reason, extra) {
  return Object.assign({ active: false, defer: false, failOpen: false, reason,
    account: null, used: null, elapsed: null, rule: null, signature: null, coreCrons: null }, extra || {})
}

// evaluate({ austerityCfg }) -> the governor state for this lease pass. NEVER throws.
async function evaluate(opts) {
  try {
    return await evaluateInner(opts || {})
  } catch (e) {
    const msg = (e && e.message) || String(e)
    logOnce('throw:' + msg, '[scheduler] pace-governor: INTERNAL ERROR (' + msg + ') -> FAIL-OPEN, leasing normally')
    return inert('internal error: ' + msg, { failOpen: true })
  }
}

async function evaluateInner(opts) {
  const now = dep('now')()
  const registry = dep('registry')
  const enabled = registry.enabled({ bootstrap: false }) || []
  if (enabled.length !== 1) {
    logOnce('inert:' + enabled.length, '[scheduler] pace-governor: inert (' + enabled.length +
      ' enabled accounts; the brake is for single-account operation only)')
    return inert(enabled.length + ' enabled accounts')
  }
  const short = enabled[0]
  const account = short + '@'
  const coreCrons = coreCronNames(opts.austerityCfg)
  if (!coreCrons) {
    logOnce('nocfg', '[scheduler] pace-governor: austerity band table UNAVAILABLE, core crons cannot be ' +
      'identified -> FAIL-OPEN, leasing normally (a brake that cannot tell gmail-inbox-poll from a ' +
      'growth cron must not brake at all)')
    return inert('band table unavailable', { failOpen: true, account })
  }

  let refreshed = false
  if (!_cache || _cache.short !== short || now - _cache.at >= CACHE_TTL_MS) {
    const prior = _cache && _cache.short === short ? _cache.reading : {}
    let row = null
    try { row = registry.get ? registry.get(short, { bootstrap: false }) : null } catch (_) {}
    let reading
    try {
      reading = await dep('probe')(short, { prior: prior || {}, nowMs: now, registryRow: row || undefined })
    } catch (e) {
      reading = Object.assign({}, prior || {}, { probe_status: 'probe_threw' })
    }
    _cache = { at: now, short, reading }
    refreshed = true
  }

  const d = decidePace(_cache.reading, now)
  if (!d.readable) {
    const line = '[scheduler] pace-governor: active (1 enabled: ' + account + ') but the usage probe is ' +
      'UNREADABLE: ' + d.reason + ' -> FAIL-OPEN, leasing normally'
    if (refreshed) { _lastLogKey = null }
    logOnce('unreadable:' + d.reason, line)
    return inert('unreadable: ' + d.reason, { active: true, failOpen: true, account, coreCrons })
  }
  const state = {
    active: true, defer: d.defer, failOpen: false, reason: d.reason, rule: d.rule,
    account, used: d.used, elapsed: d.elapsed, coreCrons,
    signature: d.defer ? signature(d, account) : null,
  }
  if (refreshed) {
    _lastLogKey = null
    logOnce('eval', '[scheduler] pace-governor: active (1 enabled: ' + account + ') 7d ' + f2(d.used) +
      ' vs ' + f2(d.elapsed) + ' elapsed -> ' + (d.defer
        ? 'DEFER non-core (' + d.rule + ': ' + d.reason + '); ' + coreCrons.length + ' core crons + continuity + FREEZE-EXEMPT still lease'
        : 'lease all (' + d.reason + ')'))
  }
  return state
}

module.exports = {
  WARN_7D, PACE_MARGIN, PACE_FLOOR, WEEK_MS, CACHE_TTL_MS, MAX_READING_AGE_MS, SIG_PREFIX,
  CONTINUITY_NAMES, CONTINUITY_PREFIXES, FREEZE_EXEMPT_PG, FREEZE_EXEMPT_RE,
  coreCronNames, isContinuityName, declaresFreezeExempt, isCoreRow,
  sqlCorePredicate, sqlCoreParams, decidePace, signature, evaluate,
  _setDeps, _reset,
}
