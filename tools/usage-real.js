'use strict'
// tools/usage-real.js - PER-ACCOUNT GROUND TRUTH for Claude Max usage.
//
// llm-helper-justified: this calls api.anthropic.com/api/oauth/usage and
// /api/oauth/profile, which are quota-metering and whoami endpoints, not inference. They
// return rate-limit utilization percentages and an account email; they never return a
// completion, consume no tokens, and cost nothing. They are also the ONLY way to learn a
// non-live account's remaining quota, which is precisely what a switch decision needs.
//
// WHAT THIS REPLACES
// Until now per-account usage was inferred from ccusage over local transcripts. Those
// transcripts carry NO account identity (grep a 78MB live one for oauthAccount,
// emailAddress or organization_uuid: zero hits), so attribution was a heuristic stack:
// a sticky tag that was never re-evaluated, a worker binding that was dead because
// worker rows carry no session_id, a swap_history reverse-lookup whose file had never
// once been written, and finally "whatever account was live when we first noticed this
// session". Whole session LIFETIMES were then added into 5h windows if the file had been
// touched inside the window, so a 45-day 783M-token session polluted every bucket it
// landed in. A normaliser scaled the aggregate to ccusage's real block totals but applied
// one scalar to all three accounts, preserving the wrong ratio exactly.
//
// The result on 2026-08-02: the system believed money@ had 77% weekly headroom while the
// vendor reported money@ at 100% of its weekly cap, is_active, severity critical. The
// picker would have switched INTO a hard-capped account. It believed code@ was at 0.2%
// of its 5h cap; the vendor said 24%. It believed tate@ was at 16% weekly; the vendor
// said 52%.
//
// So ccusage is demoted to what it can honestly do: measure the LIVE account's spend
// between probes, and carry cost telemetry. Everything decisional comes from here.

const https = require('https')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const cfg = require('./usage-config')
const registry = require('./accounts-registry')

const KEYCHAIN_SERVICE = 'Claude Code-credentials'
const KEYCHAIN_ACCOUNT = 'ecodia'

// ── injectable effects (so the selftest never touches network or Keychain) ────

let _fetchImpl = null          // (url, headers) -> Promise<{status, headers, body}>
let _keychainReader = null     // () -> string|null

function _setFetch(fn) { _fetchImpl = fn }
function _setKeychainReader(fn) { _keychainReader = fn }

function defaultKeychainReader() {
  if (process.platform !== 'darwin') return null
  const res = spawnSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w'],
    { encoding: 'utf8', timeout: 5000 })
  if (res.status !== 0) return null
  return (res.stdout || '').trim()
}

function httpGet(url, headers) {
  return new Promise((resolve) => {
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    let req
    try {
      req = https.request(url, { method: 'GET', headers, timeout: cfg.PROBE.TIMEOUT_MS }, (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', d => { body += d })
        res.on('end', () => finish({ status: res.statusCode, headers: res.headers, body }))
      })
    } catch (e) {
      return finish({ status: 0, headers: {}, body: '', error: 'request-construct' })
    }
    req.on('timeout', () => { try { req.destroy() } catch (e) {} ; finish({ status: 0, headers: {}, body: '', error: 'timeout' }) })
    // Never surface the underlying error message: a TLS/socket error can echo request
    // context, and this module handles bearer tokens.
    req.on('error', () => finish({ status: 0, headers: {}, body: '', error: 'network' }))
    req.end()
  })
}

function doFetch(url, headers) {
  return (_fetchImpl || httpGet)(url, headers)
}

function probeHeaders(token) {
  return {
    'Authorization': 'Bearer ' + token,
    'anthropic-beta': cfg.PROBE.BETA_HEADER,
    'User-Agent': cfg.PROBE.USER_AGENT,
    'Accept': 'application/json',
  }
}

// ── token sourcing ───────────────────────────────────────────────────────────

// The live account reads the Keychain (always the freshest lineage on the machine);
// every other account reads its snapshot. Refresh tokens are NEVER touched: this module
// only ever presents an existing access token, so it can never consume the single-use
// refresh token out from under Claude Code or the cred-refresher.
function tokenForAccount(short, opts) {
  opts = opts || {}
  const liveShort = opts.liveShort !== undefined ? opts.liveShort : currentLiveShort()
  if (short === liveShort) {
    const raw = (_keychainReader || defaultKeychainReader)()
    if (raw) {
      try {
        const o = JSON.parse(raw).claudeAiOauth
        if (o && o.accessToken) return { ok: true, token: o.accessToken, source: 'keychain', expiresAt: o.expiresAt || null }
      } catch (e) { /* fall through to the snapshot */ }
    }
  }
  try {
    const file = path.join(opts.credsDir || cfg.PATHS.CREDS_DIR, short + '.json')
    const o = JSON.parse(fs.readFileSync(file, 'utf8')).claudeAiOauth
    if (!o || !o.accessToken) return { ok: false, status: 'no_token', reason: 'snapshot has no accessToken' }
    // Probing with an access token that is about to expire wastes a request and returns
    // a 401 that looks like a dead snapshot. Two minutes of margin.
    if (o.expiresAt && (o.expiresAt - Date.now()) < 2 * 60 * 1000) {
      return { ok: false, status: 'no_token', reason: 'snapshot access token expires within 2min' }
    }
    return { ok: true, token: o.accessToken, source: 'snapshot', expiresAt: o.expiresAt || null }
  } catch (e) {
    return { ok: false, status: 'no_token', reason: 'no readable snapshot' }
  }
}

function currentLiveShort() {
  try {
    const creds = require('./creds')
    const a = creds.current_account && creds.current_account()
    if (a && a !== 'unknown') return String(a).split('@')[0]
  } catch (e) {}
  return null
}

// ── parsing ──────────────────────────────────────────────────────────────────

// Defensive by design: the vendor owns this shape and can change it without notice.
// Unknown siblings are preserved into raw_extra rather than dropped, so a new window
// (an Opus-scoped cap, say) is visible in the audit trail the day it appears even if no
// code reads it yet.
function parseUsageBody(body) {
  let j
  try { j = JSON.parse(body) } catch (e) { return { ok: false, reason: 'parse_error' } }
  if (!j || typeof j !== 'object') return { ok: false, reason: 'parse_error' }

  const pct = (v) => (typeof v === 'number' && isFinite(v)) ? Math.max(0, Math.min(1, v / 100)) : null
  const five = j.five_hour || {}
  const seven = j.seven_day || {}
  const limits = Array.isArray(j.limits) ? j.limits : []

  // A per-model weekly_scoped cap can strand the fleet while five_hour and seven_day both
  // read healthy, because Fable is the model everything here runs on. Fold the limits
  // rows into the window they belong to by taking the max.
  let u5 = pct(five.utilization)
  let u7 = pct(seven.utilization)
  let capped = false
  const perLimit = []
  for (const l of limits) {
    if (!l || typeof l.percent !== 'number') continue
    const frac = Math.max(0, Math.min(1, l.percent / 100))
    const row = {
      kind: l.kind || null,
      group: l.group || null,
      percent: l.percent,
      severity: l.severity || null,
      is_active: !!l.is_active,
      resets_at: l.resets_at || null,
      model: (l.scope && l.scope.model && l.scope.model.display_name) || null,
    }
    perLimit.push(row)
    if (l.group === 'weekly' || /^weekly/.test(String(l.kind || ''))) {
      u7 = (u7 == null) ? frac : Math.max(u7, frac)
    } else if (l.kind === 'session' || l.group === 'session') {
      u5 = (u5 == null) ? frac : Math.max(u5, frac)
    }
    // The discriminator for "capped" is a limits row at/over the ceiling AND active,
    // not a bare float: is_active is what says the limit is the one currently binding.
    if (frac >= cfg.TRIGGERS.CAPPED_UTIL && l.is_active) capped = true
  }
  if (u5 == null && u7 == null) return { ok: false, reason: 'parse_error' }

  const known = new Set(['five_hour', 'seven_day', 'limits', 'spend', 'extra_usage'])
  const raw_extra = {}
  for (const k of Object.keys(j)) if (!known.has(k) && j[k] != null) raw_extra[k] = j[k]

  return {
    ok: true,
    utilization_5h: u5 == null ? 0 : u5,
    utilization_7d: u7 == null ? 0 : u7,
    // resets_at is recomputed per request with sub-second jitter and is NULL on an idle
    // window (money@ five_hour read 0.0 with a null reset). Never key anything on it;
    // compare at second granularity when detecting a window rollover.
    resets_at_5h: five.resets_at || null,
    resets_at_7d: seven.resets_at || null,
    limits: perLimit,
    capped,
    extra_usage_enabled: !!(j.extra_usage && j.extra_usage.is_enabled),
    raw_extra: Object.keys(raw_extra).length ? raw_extra : undefined,
  }
}

// ── identity ─────────────────────────────────────────────────────────────────

// Which account does this token actually belong to? Without this, a snapshot that has
// been clobbered with another account's lineage reports its usage under the wrong name,
// and the picker confidently switches to an account that is already capped.
//
// Two corroborations: the profile endpoint (authoritative, one call per token lineage)
// and the anthropic-organization-id response header that every usage 200 carries for
// free. If the profile endpoint ever disappears (vendor 404s are live precedent: both
// /api/oauth/claude_cli_profile and /api/oauth/userinfo already 404), header-only
// verification carries on. Losing verification must never escalate into excluding
// everything, because that is the fail-closed stranding shape this rebuild exists to end.
async function verifyTokenIdentity(short, token) {
  const r = await doFetch(cfg.PROBE.PROFILE_URL, probeHeaders(token))
  if (r.status !== 200) return { ok: false, reason: 'profile_http_' + r.status }
  let j
  try { j = JSON.parse(r.body) } catch (e) { return { ok: false, reason: 'profile_parse' } }
  const acct = (j && (j.account || j)) || {}
  const email = acct.email || acct.emailAddress || null
  if (!email) return { ok: false, reason: 'profile_no_email' }
  const got = String(email).split('@')[0].trim().toLowerCase()
  return {
    ok: got === short,
    email,
    got,
    account_uuid: acct.uuid || acct.account_uuid || null,
    org_uuid: (j && j.organization && (j.organization.uuid || j.organization.organization_uuid)) || null,
    reason: got === short ? null : 'identity_mismatch',
  }
}

// ── the probe ────────────────────────────────────────────────────────────────

function backoffMs(consecutiveFailures) {
  const n = Math.max(1, consecutiveFailures)
  return Math.min(cfg.PROBE.BACKOFF_MAX_MS, cfg.PROBE.BACKOFF_BASE_MS * Math.pow(2, n - 1))
}

async function probeAccount(short, opts) {
  opts = opts || {}
  const prior = opts.prior || {}
  const nowMs = opts.nowMs || Date.now()
  const keep = (status, extra) => Object.assign({}, prior, {
    probe_status: status,
    consecutive_failures: (prior.consecutive_failures || 0) + 1,
    last_attempt_at: new Date(nowMs).toISOString(),
  }, extra || {})

  const tok = tokenForAccount(short, opts)
  if (!tok.ok) return keep(tok.status || 'no_token', { probe_reason: tok.reason })

  const r = await doFetch(cfg.PROBE.URL, probeHeaders(tok.token))

  if (r.status === 429) {
    // Honour Retry-After when present. None was observed on any live response in
    // 2026-08-02 testing (200s carry no ratelimit headers at all), so the exponential
    // backoff below is the real mechanism.
    const ra = Number(r.headers && r.headers['retry-after'])
    const wait = isFinite(ra) && ra > 0 ? ra * 1000 : backoffMs((prior.consecutive_failures || 0) + 1)
    return keep('http_429', { backoff_until: new Date(nowMs + wait).toISOString() })
  }
  if (r.status === 401 || r.status === 403) {
    // On a snapshot this means the stored lineage is dead. It does NOT block switching:
    // account-switch.sh performs a full OAuth re-login and needs no snapshot.
    return keep('http_' + r.status, { backoff_until: new Date(nowMs + backoffMs((prior.consecutive_failures || 0) + 1)).toISOString() })
  }
  if (r.status !== 200) {
    const status = r.status === 0 ? (r.error === 'timeout' ? 'timeout' : 'network') : ('http_' + r.status)
    return keep(status, { backoff_until: new Date(nowMs + backoffMs((prior.consecutive_failures || 0) + 1)).toISOString() })
  }

  const parsed = parseUsageBody(r.body)
  if (!parsed.ok) return keep('parse_error')

  // Free corroboration: the org id on the usage response must match the one we recorded
  // for this account. Cheap enough to do on every single probe.
  const orgHeader = (r.headers && (r.headers['anthropic-organization-id'] || r.headers['Anthropic-Organization-Id'])) || null
  let identity_verified_at = prior.identity_verified_at || null
  let identity_mismatch = false
  const known = (opts.registryRow && opts.registryRow.org_uuid) || null
  if (orgHeader && known && orgHeader !== known) identity_mismatch = true

  // The authoritative check runs once per token lineage, not once per probe.
  if (opts.verifyIdentity && (!identity_verified_at || opts.forceVerify)) {
    const v = await verifyTokenIdentity(short, tok.token)
    if (v.ok) {
      identity_verified_at = new Date(nowMs).toISOString()
      if (opts.onIdentity) opts.onIdentity(short, { org_uuid: v.org_uuid || orgHeader, account_uuid: v.account_uuid })
    } else if (v.reason === 'identity_mismatch') {
      identity_mismatch = true
    }
    // Any other failure (endpoint gone, parse trouble) leaves the header check as the
    // only corroboration and is deliberately NOT treated as a mismatch.
  } else if (orgHeader && !known && opts.onIdentity) {
    opts.onIdentity(short, { org_uuid: orgHeader })
  }

  return {
    utilization_5h: parsed.utilization_5h,
    utilization_7d: parsed.utilization_7d,
    resets_at_5h: parsed.resets_at_5h,
    resets_at_7d: parsed.resets_at_7d,
    limits: parsed.limits,
    capped: parsed.capped,
    extra_usage_enabled: parsed.extra_usage_enabled,
    raw_extra: parsed.raw_extra,
    probed_at: new Date(nowMs).toISOString(),
    probe_status: identity_mismatch ? 'identity_mismatch' : 'ok',
    identity_mismatch,
    consecutive_failures: 0,
    identity_verified_at,
    token_source: tok.source,
    backoff_until: null,
  }
}

// ── scheduling ───────────────────────────────────────────────────────────────

// Stagger accounts across the interval so three probes never land together, and probe an
// account more often when it is close to its cap or burning fast.
function probeDue(accountsState, nowMs, opts) {
  opts = opts || {}
  const order = opts.order || Object.keys(accountsState || {})
  const due = []
  order.forEach((short, idx) => {
    const row = (accountsState && accountsState[short]) || {}
    const real = row.real || {}
    if (real.backoff_until && Date.parse(real.backoff_until) > nowMs) return
    const last = real.probed_at ? Date.parse(real.probed_at) : 0
    const hot = (Math.max(real.utilization_5h || 0, real.utilization_7d || 0) >= cfg.PROBE.HOT_UTIL) ||
                ((row.estimate && row.estimate.burn_pp_per_min_5h) || 0) >= cfg.PROBE.HOT_BURN_PP_PER_MIN
    const interval = hot ? cfg.PROBE.HOT_INTERVAL_MS : cfg.PROBE.INTERVAL_MS
    const offset = (idx * cfg.PROBE.STAGGER_MS) % interval
    if (!last) { due.push(short); return }
    if ((nowMs - last) >= interval - offset % interval) due.push(short)
  })
  return due
}

// ── staleness ladder ─────────────────────────────────────────────────────────

// The single question every consumer asks: what do I believe about this account right
// now, how old is that belief, and may I switch to it?
//
// The rule that matters most is the last one: an account we cannot currently SEE is not
// an account we know to be depleted. Treating unknown as depleted is how a fleet ends up
// with an empty target set and texts a human instead of switching.
function computeEffective(row, isLive, nowMs) {
  row = row || {}
  const real = row.real || {}
  const est = row.estimate || {}
  const ageMs = real.probed_at ? (nowMs - Date.parse(real.probed_at)) : Infinity
  const out = { effective_age_s: isFinite(ageMs) ? Math.round(ageMs / 1000) : null }

  if (real.probe_status === 'identity_mismatch') {
    // For a NON-live account this is disqualifying: we cannot tell whose quota we read.
    // For the LIVE slot it is a labelling problem, and the repair is to re-derive who is
    // live from the token itself, never to exclude the account we are already running on.
    if (!isLive) {
      return Object.assign(out, {
        utilization_5h_effective: null, utilization_7d_effective: null,
        effective_source: 'unknown', excluded_as_target: true,
        excluded_reason: 'identity_mismatch: this snapshot does not belong to the account it is filed under',
      })
    }
  }

  const haveReal = typeof real.utilization_5h === 'number' && real.probed_at
  if (haveReal && ageMs <= cfg.PROBE.FRESH_MS) {
    return Object.assign(out, {
      utilization_5h_effective: real.utilization_5h,
      utilization_7d_effective: real.utilization_7d,
      effective_source: 'real', excluded_as_target: false, excluded_reason: null,
    })
  }
  if (haveReal && ageMs <= cfg.PROBE.AGED_MAX_MS) {
    return Object.assign(out, {
      utilization_5h_effective: real.utilization_5h,
      utilization_7d_effective: real.utilization_7d,
      effective_source: 'real_aged', excluded_as_target: false, excluded_reason: null,
    })
  }
  if (isLive && haveReal) {
    // Never exclude the account we are already on: advance the last known reading with
    // locally measured spend instead. The weekly estimate is deliberately NOT advanced -
    // ccusage cannot attribute a week of history to an account, which is the whole
    // failure this rebuild removes.
    const u5 = Math.max(0, Math.min(1, real.utilization_5h + (est.utilization_5h_delta || 0)))
    return Object.assign(out, {
      utilization_5h_effective: u5,
      utilization_7d_effective: real.utilization_7d,
      effective_source: 'estimate', excluded_as_target: false, excluded_reason: null,
    })
  }
  return Object.assign(out, {
    utilization_5h_effective: null, utilization_7d_effective: null,
    effective_source: 'unknown',
    excluded_as_target: !isLive,
    excluded_reason: isLive ? null : 'no usable probe: last reading is ' + (isFinite(ageMs) ? Math.round(ageMs / 60000) + 'min old' : 'absent'),
  })
}

function headroomScore(eff) {
  const a = eff.utilization_5h_effective, b = eff.utilization_7d_effective
  if (typeof a !== 'number' && typeof b !== 'number') return null
  return 1 - Math.max(typeof a === 'number' ? a : 0, typeof b === 'number' ? b : 0)
}

// ── burn rate ────────────────────────────────────────────────────────────────

// Percentage points per minute, from consecutive real readings. Two samples straddling a
// window reset would otherwise produce a large NEGATIVE burn (or, taken absolutely, a
// fake spike), so any pair whose resets_at moved or whose utilization fell is discarded
// rather than smoothed.
function burnRates(samples) {
  const out = { burn_pp_per_min_5h: 0, burn_pp_per_min_7d: 0, samples_used: 0 }
  if (!Array.isArray(samples) || samples.length < 2) return out
  let acc5 = 0, acc7 = 0, n = 0
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i]
    if (!a || !b || !a.probed_at || !b.probed_at) continue
    const dtMin = (Date.parse(b.probed_at) - Date.parse(a.probed_at)) / 60000
    if (!(dtMin > 0)) continue
    // Window rollover: compare at second granularity, because resets_at carries
    // sub-second jitter that differs on every single request.
    const sameWindow5 = secondKey(a.resets_at_5h) === secondKey(b.resets_at_5h)
    const d5 = (b.utilization_5h - a.utilization_5h) * 100
    const d7 = (b.utilization_7d - a.utilization_7d) * 100
    if (!sameWindow5 || d5 < 0) continue
    acc5 += d5 / dtMin
    acc7 += Math.max(0, d7) / dtMin
    n++
  }
  if (!n) return out
  return { burn_pp_per_min_5h: acc5 / n, burn_pp_per_min_7d: acc7 / n, samples_used: n }
}

function secondKey(iso) {
  if (!iso) return 'null'
  const t = Date.parse(iso)
  return isFinite(t) ? String(Math.floor(t / 1000)) : 'null'
}

// ── minutes of headroom ──────────────────────────────────────────────────────

// creds.pick_healthiest_account compares these with `>`, so the degraded values matter as
// much as the real one. Infinity for "no data" preserves fail-open; 0 for capped or
// excluded takes the account out of contention. Returning null or undefined here silently
// evicted the live account in the 2026-06-25/29 regressions.
function headroomMinutesFor(row, nowMs) {
  nowMs = nowMs || Date.now()
  const eff = row && row.utilization_5h_effective !== undefined ? row : computeEffective(row, false, nowMs)
  if (eff.excluded_as_target) return 0
  const u5 = eff.utilization_5h_effective, u7 = eff.utilization_7d_effective
  if (typeof u5 !== 'number' && typeof u7 !== 'number') return Infinity
  if (Math.max(u5 || 0, u7 || 0) >= cfg.TRIGGERS.CAPPED_UTIL) return 0
  const est = (row && row.estimate) || {}
  const b5 = Math.max(est.burn_pp_per_min_5h || 0, 0.01)
  const b7 = Math.max(est.burn_pp_per_min_7d || 0, 0.001)
  const m5 = ((1 - (u5 || 0)) * 100) / b5
  const m7 = ((1 - (u7 || 0)) * 100) / b7
  return Math.min(600, Math.max(0, Math.min(m5, m7)))
}

// ── canonical "how used is this account?" accessors ────────────────────────────
//
// THE ONE PLACE the effective-vs-fallback precedence lives. Prefers the vendor's measured
// utilization (utilization_*_effective, produced by computeEffective over the real probe);
// falls back to the ccusage headroom heuristic ONLY when no measurement exists, so a stale
// accounts.json still decides something rather than nothing. Every picker/alerter reads
// through these so they can never drift from the auto-switch decider again.
//
// The 2026-08-15 bug was exactly this drift: coord.pick_account and the alerts block still
// read the ccusage headroom fields while account-cap-decide already read the measurement,
// so the advisory picker ranked a vendor-measured 78%-weekly account as second-healthiest
// and the alerts block declared "nothing low" while the live account sat at 58% and
// climbing. Doctrine:
// per-account-usage-truth-is-the-vendor-endpoint-not-local-transcripts-2026-08-02.
function used5h(a) {
  a = a || {}
  if (typeof a.utilization_5h_effective === 'number') return a.utilization_5h_effective
  return 1 - (a.headroom_5h_fraction != null ? a.headroom_5h_fraction : (a.remaining_5h / a.cap_5h))
}
function usedWeekly(a) {
  a = a || {}
  if (typeof a.utilization_7d_effective === 'number') return a.utilization_7d_effective
  return 1 - (a.headroom_weekly_fraction != null ? a.headroom_weekly_fraction : (a.remaining_weekly / a.cap_weekly))
}
// Where the number came from, so a decision can say whether it trusted a measurement.
function usedSource(a) {
  a = a || {}
  return (typeof a.utilization_5h_effective === 'number') ? (a.effective_source || 'real') : 'ccusage-fallback'
}
// Effectively capped: the vendor's own capped flag, or a measured window at/over the cap
// ceiling. This is the never-switch-into-a-capped-account guard (the 2026-08-02 failure).
// It reads the measured numbers through used5h/usedWeekly, so a rosy ccusage headroom can
// never hide a real cap.
function isCapped(a) {
  a = a || {}
  if (a.real && a.real.capped) return true
  const ceil = (cfg.TRIGGERS && cfg.TRIGGERS.CAPPED_UTIL) || 0.99
  return Math.max(used5h(a), usedWeekly(a)) >= ceil
}

// ── selftest ─────────────────────────────────────────────────────────────────

function selftest() {
  let failed = 0
  const ok = (cond, name) => { console.log((cond ? '  PASS: ' : '  FAIL: ') + name); if (!cond) failed++ }
  const LIVE_MONEY_BODY = JSON.stringify({
    five_hour: { utilization: 0.0, resets_at: null },
    seven_day: { utilization: 100.0, resets_at: '2026-08-03T11:00:00Z' },
    limits: [
      { kind: 'session', group: 'session', percent: 0, severity: 'normal', resets_at: null, is_active: false },
      { kind: 'weekly_all', group: 'weekly', percent: 100, severity: 'critical', resets_at: '2026-08-03T11:00:00Z', is_active: true },
      { kind: 'weekly_scoped', group: 'weekly', percent: 31, severity: 'normal', is_active: false, scope: { model: { display_name: 'Fable' } } },
    ],
    extra_usage: { is_enabled: false },
  })

  console.log('-- parse: the real money@ body from 2026-08-02 --')
  let p = parseUsageBody(LIVE_MONEY_BODY)
  ok(p.ok, 'parses')
  ok(p.utilization_7d === 1, 'weekly reads 100 percent')
  ok(p.capped === true, 'an active limits row at 100 percent is CAPPED')
  ok(p.resets_at_5h === null, 'a null reset on an idle window survives as null')

  console.log('-- parse: a model-scoped cap must not hide behind healthy top-level windows --')
  p = parseUsageBody(JSON.stringify({
    five_hour: { utilization: 10 }, seven_day: { utilization: 12 },
    limits: [{ kind: 'weekly_scoped', group: 'weekly', percent: 100, severity: 'critical', is_active: true, scope: { model: { display_name: 'Fable' } } }],
  }))
  ok(p.utilization_7d === 1, 'weekly effective lifts to the scoped cap, not the 12 percent headline')
  ok(p.capped === true, 'a Fable-scoped cap counts as capped: it is the model the fleet runs on')

  console.log('-- parse: garbage and drift --')
  ok(parseUsageBody('not json').ok === false, 'non-JSON is a parse_error, not a crash')
  ok(parseUsageBody('{}').ok === false, 'a body with no windows at all is refused')
  p = parseUsageBody(JSON.stringify({ five_hour: { utilization: 5 }, seven_day: { utilization: 5 }, brand_new_window: { utilization: 9 } }))
  ok(p.ok && p.raw_extra && p.raw_extra.brand_new_window, 'an unknown sibling window is preserved into raw_extra')

  console.log('-- staleness ladder --')
  const now = Date.now()
  const mk = (ageMin, extra) => Object.assign({ real: { utilization_5h: 0.3, utilization_7d: 0.4, probed_at: new Date(now - ageMin * 60000).toISOString() } }, extra || {})
  ok(computeEffective(mk(1), false, now).effective_source === 'real', 'a 1min reading is real')
  ok(computeEffective(mk(20), false, now).effective_source === 'real_aged', 'a 20min reading is real_aged and still pickable')
  ok(computeEffective(mk(20), false, now).excluded_as_target === false, 'real_aged is not excluded')
  ok(computeEffective(mk(90), false, now).excluded_as_target === true, 'a 90min-old non-live reading is excluded as a target')
  ok(computeEffective(mk(90), true, now).effective_source === 'estimate', 'the LIVE account falls to the estimator instead of being excluded')
  ok(computeEffective(mk(90), true, now).excluded_as_target === false, 'we never exclude the account we are already running on')
  ok(computeEffective({}, false, now).effective_source === 'unknown', 'no data at all is unknown')

  console.log('-- identity mismatch --')
  const mism = { real: { utilization_5h: 0.1, utilization_7d: 0.1, probed_at: new Date(now).toISOString(), probe_status: 'identity_mismatch' } }
  ok(computeEffective(mism, false, now).excluded_as_target === true, 'a non-live snapshot whose identity does not match is excluded')
  ok(computeEffective(mism, true, now).excluded_as_target === false, 'the LIVE slot is repaired, never excluded, on a mismatch')

  console.log('-- headroom --')
  ok(headroomScore(computeEffective(mk(1), false, now)) === 0.6, 'headroom is 1 - max(util), so the worse window governs')
  ok(headroomMinutesFor({ excluded_as_target: true, utilization_5h_effective: 0.1, utilization_7d_effective: 0.1 }) === 0, 'excluded means zero minutes')
  ok(headroomMinutesFor({ utilization_5h_effective: 0.995, utilization_7d_effective: 0.2 }) === 0, 'capped means zero minutes')
  ok(headroomMinutesFor({ utilization_5h_effective: null, utilization_7d_effective: null }) === Infinity, 'no data means Infinity, so a blind read never evicts an account')

  console.log('-- burn rate --')
  const s = (min, u5, reset) => ({ probed_at: new Date(now - min * 60000).toISOString(), utilization_5h: u5, utilization_7d: u5, resets_at_5h: reset })
  let b = burnRates([s(10, 0.10, 'R1'), s(5, 0.20, 'R1'), s(0, 0.30, 'R1')])
  ok(Math.abs(b.burn_pp_per_min_5h - 2) < 1e-9, '10 points over 5 minutes reads as 2 points per minute')
  b = burnRates([s(10, 0.90, 'R1'), s(5, 0.05, 'R2'), s(0, 0.10, 'R2')])
  ok(b.samples_used === 1, 'the pair that straddles a window reset is discarded, not averaged in')
  ok(b.burn_pp_per_min_5h > 0, 'the surviving pair still yields a positive rate')
  ok(burnRates([s(5, 0.5, 'R1'), s(0, 0.4, 'R1')]).samples_used === 0, 'a negative delta inside one window is rejected as nonsense')

  console.log('-- probe: failure ladder (mocked transport, no network) --')
  const priorGood = { utilization_5h: 0.5, utilization_7d: 0.5, probed_at: new Date(now - 60000).toISOString(), consecutive_failures: 0 }
  const run = async (resp, prior) => {
    _setFetch(async () => resp)
    _setKeychainReader(() => JSON.stringify({ claudeAiOauth: { accessToken: 'x', expiresAt: now + 3600e3 } }))
    return probeAccount('code', { prior: prior || priorGood, nowMs: now, liveShort: 'code' })
  }
  return (async () => {
    let r = await run({ status: 429, headers: { 'retry-after': '30' }, body: '' })
    ok(r.probe_status === 'http_429' && r.utilization_5h === 0.5, 'a 429 keeps the last known reading rather than blanking it')
    ok(Date.parse(r.backoff_until) - now === 30000, 'Retry-After is honoured when the vendor sends one')
    r = await run({ status: 429, headers: {}, body: '' })
    ok(Date.parse(r.backoff_until) - now === cfg.PROBE.BACKOFF_BASE_MS, 'with no Retry-After it falls back to exponential backoff')
    r = await run({ status: 401, headers: {}, body: '' })
    ok(r.probe_status === 'http_401' && r.utilization_5h === 0.5, 'a 401 keeps the last reading; it means a dead snapshot, not zero usage')
    r = await run({ status: 0, headers: {}, body: '', error: 'timeout' })
    ok(r.probe_status === 'timeout', 'a timeout is reported as a timeout')
    r = await run({ status: 200, headers: {}, body: 'garbage' })
    ok(r.probe_status === 'parse_error', 'a 200 with an unparseable body is a parse_error, not silent zeroes')
    r = await run({ status: 200, headers: { 'anthropic-organization-id': 'org-A' }, body: LIVE_MONEY_BODY })
    ok(r.probe_status === 'ok' && r.utilization_7d === 1, 'a good 200 parses through to the real numbers')
    ok(r.consecutive_failures === 0, 'success resets the failure counter')
    _setFetch(async () => ({ status: 200, headers: { 'anthropic-organization-id': 'org-WRONG' }, body: LIVE_MONEY_BODY }))
    r = await probeAccount('code', { prior: priorGood, nowMs: now, liveShort: 'code', registryRow: { org_uuid: 'org-A' } })
    ok(r.probe_status === 'identity_mismatch', 'an org-id that does not match the registry is caught for free on every probe')

    console.log('-- probe: an expiring snapshot is not spent on a doomed request --')
    _setKeychainReader(() => null)
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'usage-real-'))
    fs.writeFileSync(path.join(dir, 'money.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'y', expiresAt: now + 30 * 1000 } }))
    let hit = false
    _setFetch(async () => { hit = true; return { status: 200, headers: {}, body: LIVE_MONEY_BODY } })
    r = await probeAccount('money', { prior: {}, nowMs: now, liveShort: 'code', credsDir: dir })
    ok(r.probe_status === 'no_token' && hit === false, 'a token expiring inside 2 minutes is refused without a request')

    _setFetch(null); _setKeychainReader(null)
    console.log(failed ? '\nSELFTEST FAILED (' + failed + ')' : '\nSELFTEST PASSED')
    process.exitCode = failed ? 1 : 0
  })()
}

module.exports = {
  probeAccount, probeDue, computeEffective, headroomScore, headroomMinutesFor,
  used5h, usedWeekly, usedSource, isCapped,
  burnRates, verifyTokenIdentity, tokenForAccount,
  _parseUsageBody: parseUsageBody, _setFetch, _setKeychainReader, _secondKey: secondKey,
  _backoffMs: backoffMs, _currentLiveShort: currentLiveShort,
}

if (require.main === module) {
  if (process.argv.includes('--selftest')) selftest()
  else {
    // One-shot live read, for a human at a terminal. Prints percentages only.
    ;(async () => {
      const live = currentLiveShort()
      for (const short of registry.enabled()) {
        const row = registry.get(short) || {}
        const r = await probeAccount(short, { prior: {}, liveShort: live, registryRow: row })
        const fmt = (v) => (typeof v === 'number' ? (v * 100).toFixed(0) + '%' : 'n/a')
        console.log([short.padEnd(6), (short === live ? 'LIVE ' : '     '),
          '5h=' + fmt(r.utilization_5h).padStart(4),
          '7d=' + fmt(r.utilization_7d).padStart(4),
          r.probe_status, r.capped ? 'CAPPED' : ''].join(' '))
      }
    })()
  }
}
