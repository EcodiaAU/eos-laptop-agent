'use strict'
// tools/usage-config.js - the ONE place usage/switch constants and paths are defined.
//
// llm-helper-justified: the api.anthropic.com URLs below are NOT an inference wrapper.
// /api/oauth/usage and /api/oauth/profile are the quota-metering and whoami endpoints
// Claude Code's own /usage screen reads: they return rate-limit utilization percentages
// and an account email, never a completion, and they consume no tokens and no budget.
// This is the only route to PER-ACCOUNT quota truth for accounts that are not currently
// live, which is exactly what the switch decision needs and what nothing else on this
// machine can supply (transcripts carry no account identity at all).
//
// WHY: on 2026-08-02 the 5h and weekly cap constants existed at six sites with five
// different values (plists 41.5M/497M, .env 185M/2.2B, usage.js defaults 220M/6.6B, a
// dead usage-poller.js constant of 735M, and a stale comment claiming 220M/1B). Which
// one applied depended on whether a process was started by launchd or by hand, and a
// decision made against a 4.5x-looser cap silently under-triggers. Separately,
// COORD_ROOT had a different default in usage-poller.js than in every other module, and
// the account-pin path was hardcoded in usage.js while three other readers derived it.
//
// The deeper fix is that caps stop being decision inputs at all: the vendor reports
// utilization directly (see usage-real.js), so DISPLAY_CAPS exist only to render
// human-readable token figures in legacy fields. Nothing may switch on them.

const path = require('path')
const os = require('os')

const COORD_ROOT = process.env.COORD_ROOT || path.join(os.homedir(), '.ecodiaos', 'coordination')
const USAGE_DIR = path.join(COORD_ROOT, 'usage')
const CREDS_DIR = process.env.CREDS_DIR || path.join(os.homedir(), 'PRIVATE', 'ecodia-creds')

const PATHS = {
  COORD_ROOT,
  USAGE_DIR,
  CREDS_DIR,
  ACCOUNTS_FILE: path.join(USAGE_DIR, 'accounts.json'),
  SESSIONS_FILE: path.join(USAGE_DIR, 'sessions.json'),
  FLAKY_FILE: path.join(USAGE_DIR, 'flaky.json'),
  PIN_FILE: path.join(USAGE_DIR, 'account-pin'),
  HEARTBEAT_FILE: path.join(USAGE_DIR, 'poller.heartbeat'),
  SWITCH_REQUEST_FILE: path.join(USAGE_DIR, 'switch-request.json'),
  SWITCH_STATE_FILE: path.join(USAGE_DIR, 'switch-state.json'),
  SWITCH_LOCK_FILE: process.env.SWITCH_LOCK_FILE || path.join(USAGE_DIR, 'switch.lock'),
  SWITCH_LOG_FILE: path.join(USAGE_DIR, 'last-switch.log'),
  SWAP_HISTORY_FILE: path.join(COORD_ROOT, 'swap_history.json'),
  ACTIVE_ACCOUNT_FILE: path.join(COORD_ROOT, 'active_account.json'),
  AUDIT_DIR: path.join(USAGE_DIR, 'audit'),
  REGISTRY_FILE: path.join(COORD_ROOT, 'accounts-registry.json'),
}

// The vendor's own usage surface: the numbers the claude.ai UI shows, per account.
// Proven live 2026-08-02 with both a live Keychain token and a non-live snapshot token,
// consuming no refresh token in either case.
const PROBE = {
  URL: 'https://api.anthropic.com/api/oauth/usage',
  PROFILE_URL: 'https://api.anthropic.com/api/oauth/profile',
  BETA_HEADER: 'oauth-2025-04-20',
  // Pinned deliberately. claude-code issues #31021/#31637 report that a non-claude-code
  // User-Agent lands in an aggressively rate-limited bucket. A single default-UA probe
  // did NOT reproduce that here on 2026-08-02, and sustained-poll behaviour is untested,
  // so this stays as hygiene rather than as a proven necessity.
  USER_AGENT: process.env.PROBE_USER_AGENT || 'claude-code/2.1.220',
  TIMEOUT_MS: 15000,

  // Cadence. Three accounts staggered inside a 5-minute period is 36 requests/hour.
  INTERVAL_MS: Number(process.env.PROBE_INTERVAL_MS) || 5 * 60 * 1000,
  STAGGER_MS: 100 * 1000,
  // Escalated cadence: when an account is close to its cap or burning fast, a 5-minute
  // blind spot is too long (observed p95 burn is 4.13 percentage points per 5 min, so a
  // fixed 90% trigger can be overshot by ~20% inside one interval).
  HOT_INTERVAL_MS: 2 * 60 * 1000,
  HOT_UTIL: 0.75,
  HOT_BURN_PP_PER_MIN: 0.5,

  // Staleness ladder. See computeEffective in usage-real.js.
  FRESH_MS: 12 * 60 * 1000,
  AGED_MAX_MS: 45 * 60 * 1000,
  ALERT_STALE_MS: 2 * 60 * 60 * 1000,

  // Backoff is PER ACCOUNT, never global. A global circuit composes with the freshness
  // gate and real-limit-watch's corroboration floor into "no switching at all" during
  // exactly the high-burn moment a switch is needed.
  BACKOFF_BASE_MS: 60 * 1000,
  BACKOFF_MAX_MS: 30 * 60 * 1000,
  CIRCUIT_429_TRIPS: 3,
}

const TRIGGERS = {
  // Tate 2026-08-02: predict and drain at 90 percent.
  //
  // SAFE ONLY WITH THE PROJECTION TERM ACTIVE. Measured busy-period burn is p95 1.72M
  // limit-relevant tokens per 5 min = 4.13 percentage points, p99 2.97M = 7.2pp. A bare
  // 90 with a 5-minute blind spot is overshot 20.7% of the time at p95. Any phase that
  // ships the threshold without the projection must use SWITCH_USED_NO_PROJECTION.
  SWITCH_USED: 0.90,
  // Weekly window fires LATER than the 5h window (Tate 2026-08-20: "90% session OR 95%
  // weekly"). The weekly allowance is the scarcer resource and recovers slowly, so we
  // squeeze more of it before switching; 5% of a weekly window is still a large absolute
  // headroom, plenty for an agent to drive the switch. The 5h window is small and resets
  // fast, so 90 there is the right drain point. SWITCH_USED remains the 5h/session trigger;
  // callers read SWITCH_USED_WEEKLY for the 7d/weekly window.
  SWITCH_USED_WEEKLY: 0.95,
  SWITCH_USED_NO_PROJECTION: 0.80,
  PROJECTION_HORIZON_MIN: 20,
  PROJECTION_CEILING: 0.98,

  // A switch target must be comfortably below half on BOTH windows, so we do not switch
  // into an account that caps ten minutes later.
  TARGET_MAX_USED: 0.50,
  WARN_HEADROOM: 0.20,
  CORROBORATION_FLOOR: 0.10,

  // Capped classification. Prefer the limits[] rows: a per-model weekly_scoped cap (Fable
  // is what the whole fleet runs on) can strand the conductor while five_hour and
  // seven_day both read healthy.
  CAPPED_UTIL: 0.99,

  // How long running sessions keep working on the account they started on. Corpus
  // forensics over 14+ real switches (2026-08-02): sessions ADOPT the new Keychain
  // identity within 1.5-26 minutes and do not 401. The old assumption - that they run
  // until the old access token expires, up to 8 hours - was wrong, so a drain deadline
  // derived from expiresAt was wrong too.
  POST_SWITCH_GRACE_MS: 45 * 60 * 1000,
}

// DISPLAY ONLY. These render token figures in the legacy accounts.json fields for human
// readability. No decision may be taken against them.
//   cap_5h    41.5M  CONFIRMED empirically 2026-08-02 (implied 41.1M central, 34.0-47.4M
//                    band, from code@ reading 24% against 9.87M limit-relevant tokens).
//   cap_weekly 497M  UNVERIFIED and probably wrong: the whole machine's 7-day
//                    limit-relevant total is ~54% of it, yet money@ alone read 100% of
//                    its weekly cap. Weekly decisions come only from probed utilization.
const DISPLAY_CAPS = {
  cap_5h: Number(process.env.CAPS_5H_TOKENS) || 41_500_000,
  cap_weekly: Number(process.env.CAPS_WEEKLY_TOKENS) || 497_000_000,
}

// Never spend metered overage autonomously. An account at or past its cap is capped for
// our purposes even when extra_usage credits could carry it: unattended dollar spend
// walks into the >$50 tripwire with nothing watching the meter.
const EXTRA_USAGE_POLICY = { autonomous_overage: false }

const BUFFER_FACTOR = 0.85
const FLAKY_TTL_MS = 10 * 60 * 1000
const CACHE_READ_WEIGHT = process.env.CACHE_READ_WEIGHT != null ? Number(process.env.CACHE_READ_WEIGHT) : 0

// parsePin - ONE parser for the account pin, shared by all four readers.
//
// The pin is being upgraded from a bare short name to JSON carrying a reason and an
// expiry. Four places read it independently (switch preflight, real-limit-watch's gate,
// usage.js computeAlerts, creds.readAccountPin) and each parsed it differently. Ship a
// JSON pin while any of them still does trim/split('@') and that reader either blocks
// forever on garbage or stops seeing the pin at all. Accepts both forms.
function parsePin(raw) {
  if (raw == null) return { account: null, expires_at: null, reason: null, valid: false, legacy: false }
  const text = String(raw).trim()
  if (!text) return { account: null, expires_at: null, reason: null, valid: false, legacy: false }
  if (text[0] === '{') {
    try {
      const o = JSON.parse(text)
      const account = o && o.account ? String(o.account).trim().toLowerCase().split('@')[0] : null
      const expMs = o && o.expires_at ? Date.parse(o.expires_at) : NaN
      const expired = isFinite(expMs) && expMs <= Date.now()
      return {
        account: expired ? null : account,
        expires_at: o && o.expires_at ? o.expires_at : null,
        reason: o && o.reason ? String(o.reason) : null,
        valid: !!account && !expired,
        expired,
        legacy: false,
      }
    } catch (e) {
      return { account: null, expires_at: null, reason: null, valid: false, legacy: false, malformed: true }
    }
  }
  // Legacy bare-string pin: honored, but it carries no expiry, which is the same shape
  // that let a stale disable strand the fleet. Flagged so a canary can nag.
  const account = text.replace(/\s+/g, '').toLowerCase().split('@')[0]
  return { account: account || null, expires_at: null, reason: null, valid: !!account, legacy: true }
}

module.exports = {
  PATHS, PROBE, TRIGGERS, DISPLAY_CAPS, EXTRA_USAGE_POLICY,
  BUFFER_FACTOR, FLAKY_TTL_MS, CACHE_READ_WEIGHT,
  parsePin,
}
