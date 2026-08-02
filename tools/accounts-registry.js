'use strict'
// tools/accounts-registry.js - THE roster. One file, one reader, for "which Claude Max
// accounts exist, which are usable right now, and how do you log into each".
//
// WHY THIS EXISTS
// ACCOUNTS_DISABLED lived in four places at once: eos-laptop-agent/.env and the three
// launchd plists (cred-refresher, laptop-agent, usage-poller). Editing one and not the
// others silently changed behaviour depending on which process asked, because launchd
// hands the plist value to daemons while a manual run picks up .env. Worse, the flag had
// no expiry: tate@ was disabled 2026-06-22 for a paused subscription, the subscription
// came back, and the flag stayed. With tate@ excluded and code@'s snapshot rotted, the
// auto-switcher had an empty target set and could not fire for weeks while texting Tate
// every six hours. A disable with no expiry is how a temporary assertion becomes
// permanent damage.
//
// So: one JSON file, atomic writes, every disable carrying a reason and an expiry, and
// alarms surfaced rather than swallowed.
//
// SEMANTICS (deliberate, argued out during the 2026-08-02 design review):
//   missing file        -> bootstrap all-enabled + alarm. Fail-OPEN, because the failure
//                          this system actually suffers is stranding, not over-permission.
//   unparseable file    -> fall back to the .last-good sibling; if there is none, all
//                          enabled + a loud alarm.
//   disable w/o expiry+reason -> HONORED as disabled, and alarmed. This is the one place
//                          we do NOT fail open: an operator who deliberately disabled an
//                          account should not have that silently revoked by a validator.
//                          The stranding class was stale ENV FLAGS nobody could see, not
//                          honored explicit disables that show up in an alarm every run.
//   expired disable     -> treated as ENABLED + alarmed, so the account comes back on its
//                          own and the operator still sees that it happened.
//
// snapshot_state is advisory metadata for the usage probe half. It NEVER gates target
// selection: switching is a full OAuth re-login, which needs no snapshot at all. That is
// the whole point of the 2026-08 rebuild.

const fs = require('fs')
const path = require('path')
const os = require('os')

const COORD_ROOT = process.env.COORD_ROOT || path.join(os.homedir(), '.ecodiaos', 'coordination')
const REGISTRY_FILE = path.join(COORD_ROOT, 'accounts-registry.json')
const LAST_GOOD_FILE = REGISTRY_FILE + '.last-good'
const CREDS_DIR = process.env.CREDS_DIR || path.join(os.homedir(), 'PRIVATE', 'ecodia-creds')
const KV_MIRROR = path.join(CREDS_DIR, 'kv-mirror')

const SNAPSHOT_STATES = ['missing', 'fresh', 'stale', 'dead']
const LOGIN_METHODS = ['google-sso', 'magic-link']

// The known fleet. A row here is a fact about which accounts EXIST; `enabled` is the
// separate, mutable question of whether one may be switched to right now.
function defaultRegistry(nowIso) {
  const mk = (short, login_method, extra) => Object.assign({
    email: short + '@ecodia.au',
    short,
    enabled: true,
    login_method,
    disabled_reason: null,
    disabled_expires_at: null,
    snapshot_state: 'missing',
    snapshot_state_at: null,
    snapshot_state_reason: null,
    last_switch_ok_at: null,
    consecutive_switch_failures: 0,
    // Seeded on the first successful /api/oauth/profile call; the usage probe compares
    // org_uuid against the anthropic-organization-id response header for free per-probe
    // identity corroboration.
    org_uuid: null,
    account_uuid: null,
  }, extra)

  return {
    version: 1,
    updated_at: nowIso,
    updated_by: 'bootstrap',
    accounts: {
      // pw_mirror_provenance matters: 'kv' means kv-mirror-refresh.sh can regenerate the
      // file from kv_store, 'local-only' means the file on disk is the only copy and a
      // rotation needs Tate to seed the kv key first. tate@ is local-only as of
      // 2026-08-02 (mirror dated 2026-06-19, no kv key).
      tate: mk('tate', 'google-sso', {
        pw_mirror: path.join(KV_MIRROR, 'google_workspace_tate_password.json'),
        pw_mirror_provenance: 'local-only',
        totp_service: 'google-tate',
      }),
      code: mk('code', 'google-sso', {
        pw_mirror: path.join(KV_MIRROR, 'google_workspace_code_password.json'),
        pw_mirror_provenance: 'kv',
        totp_service: 'google-code',
      }),
      // money@ is an alias of tate@ for mail, so its Claude login is a magic link read
      // out of the tate@ mailbox via the Workspace service account. No password, no TOTP.
      money: mk('money', 'magic-link', {
        pw_mirror: null,
        pw_mirror_provenance: null,
        totp_service: null,
      }),
    },
  }
}

function nowIso() { return new Date().toISOString() }

function atomicWrite(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp-' + process.pid
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, file)
}

// read() -> { registry, alarms:[] }. NEVER throws: a roster reader that throws takes the
// whole switch path down with it.
function read(opts) {
  opts = opts || {}
  const file = opts.file || REGISTRY_FILE
  const alarms = []
  let raw = null
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') {
      const reg = defaultRegistry(nowIso())
      if (opts.bootstrap !== false) {
        try { atomicWrite(file, reg) } catch (we) { alarms.push('registry bootstrap write failed: ' + we.message) }
      }
      alarms.push('accounts-registry was MISSING at ' + file + ' - bootstrapped all-enabled. Every account is switchable until someone says otherwise.')
      return { registry: reg, alarms, source: 'bootstrap' }
    }
    alarms.push('accounts-registry unreadable (' + e.code + ') - falling back to all-enabled defaults.')
    return { registry: defaultRegistry(nowIso()), alarms, source: 'error-default' }
  }

  let parsed = null
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    // Do not echo the parse error: it quotes file content.
    alarms.push('accounts-registry is CORRUPT (unparseable JSON) - trying .last-good.')
    try {
      parsed = JSON.parse(fs.readFileSync(opts.lastGoodFile || LAST_GOOD_FILE, 'utf8'))
      alarms.push('recovered the roster from .last-good; the live file still needs repair.')
    } catch (e2) {
      alarms.push('no usable .last-good either - using all-enabled defaults. FIX THE FILE.')
      return { registry: defaultRegistry(nowIso()), alarms, source: 'corrupt-default' }
    }
  }

  if (!parsed || typeof parsed !== 'object' || !parsed.accounts || typeof parsed.accounts !== 'object') {
    alarms.push('accounts-registry has no accounts map - using all-enabled defaults.')
    return { registry: defaultRegistry(nowIso()), alarms, source: 'shape-default' }
  }

  const now = Date.now()
  for (const [short, row] of Object.entries(parsed.accounts)) {
    if (!row || typeof row !== 'object') continue
    row.short = row.short || short
    row.email = row.email || (short + '@ecodia.au')
    if (!LOGIN_METHODS.includes(row.login_method)) {
      alarms.push(short + ' has an unknown login_method "' + row.login_method + '" - a switch to it cannot be driven.')
    }
    if (row.snapshot_state && !SNAPSHOT_STATES.includes(row.snapshot_state)) {
      row.snapshot_state = 'missing'
    }
    if (row.enabled === false) {
      const hasReason = typeof row.disabled_reason === 'string' && row.disabled_reason.trim().length > 0
      const expMs = row.disabled_expires_at ? Date.parse(row.disabled_expires_at) : NaN
      if (!hasReason || !isFinite(expMs)) {
        // Honored, not silently revoked - but it must be visible on every single read.
        alarms.push(short + ' is disabled with no reason and/or no expiry. That is how tate@ stayed off for six weeks after its subscription came back. Honoring it, but set both fields or re-enable it.')
      } else if (expMs <= now) {
        row.enabled = true
        row._reenabled_by_expiry = true
        alarms.push(short + ' had a disable that EXPIRED at ' + row.disabled_expires_at + ' (' + (row.disabled_reason || 'no reason') + ') - treating it as enabled again.')
      }
    }
  }

  return { registry: parsed, alarms, source: 'file' }
}

// enabled() -> ['tate','code','money'] (short names), the answer every consumer wants.
function enabled(opts) {
  const { registry } = read(opts)
  return Object.keys(registry.accounts).filter(k => registry.accounts[k] && registry.accounts[k].enabled !== false)
}

// disabledEmails() - the shape the legacy ACCOUNTS_DISABLED consumers expect, so
// account-cap-decide and real-limit-watch can swap their env parse for this call with no
// other change.
function disabledEmails(opts) {
  const { registry } = read(opts)
  const out = []
  for (const [short, row] of Object.entries(registry.accounts)) {
    if (row && row.enabled === false) { out.push(short); out.push(row.email || (short + '@ecodia.au')) }
  }
  return out
}

function get(short, opts) {
  const { registry } = read(opts)
  return registry.accounts[normalizeShort(short)] || null
}

function normalizeShort(s) {
  if (typeof s !== 'string') return ''
  return s.trim().toLowerCase().split('@')[0]
}

function mutate(short, fn, opts) {
  opts = opts || {}
  const file = opts.file || REGISTRY_FILE
  const { registry, alarms } = read(opts)
  const key = normalizeShort(short)
  if (!registry.accounts[key]) return { ok: false, reason: 'unknown-account', alarms }
  fn(registry.accounts[key])
  registry.updated_at = nowIso()
  registry.updated_by = opts.by || 'accounts-registry'
  try {
    atomicWrite(file, registry)
    // Only a file that both parsed and validated becomes the recovery copy.
    try { atomicWrite(opts.lastGoodFile || LAST_GOOD_FILE, registry) } catch (e) {}
  } catch (e) {
    return { ok: false, reason: 'write-failed: ' + e.message, alarms }
  }
  return { ok: true, account: registry.accounts[key], alarms }
}

// disable() REFUSES without a reason and an expiry. This is the guard that makes the
// stale-flag failure mode structurally impossible rather than merely discouraged.
function disable(short, o) {
  o = o || {}
  if (!o.reason || String(o.reason).trim().length === 0) {
    return { ok: false, reason: 'refused: a disable needs a reason' }
  }
  const exp = o.expires_at ? Date.parse(o.expires_at) : NaN
  if (!isFinite(exp)) {
    return { ok: false, reason: 'refused: a disable needs an ISO disabled_expires_at (an open-ended disable is how the fleet gets stranded)' }
  }
  return mutate(short, row => {
    row.enabled = false
    row.disabled_reason = String(o.reason)
    row.disabled_expires_at = new Date(exp).toISOString()
  }, o)
}

function enable(short, o) {
  return mutate(short, row => {
    row.enabled = true
    row.disabled_reason = null
    row.disabled_expires_at = null
  }, o || {})
}

// markSnapshot - advisory only. A 'dead' snapshot means the usage probe cannot read that
// account's utilization until it is live again; it does NOT make the account unswitchable.
function markSnapshot(short, state, reason, o) {
  if (!SNAPSHOT_STATES.includes(state)) return { ok: false, reason: 'invalid snapshot_state' }
  return mutate(short, row => {
    row.snapshot_state = state
    row.snapshot_state_at = nowIso()
    row.snapshot_state_reason = reason || null
  }, o || {})
}

function recordSwitchResult(short, ok, reason, o) {
  return mutate(short, row => {
    if (ok) {
      row.last_switch_ok_at = nowIso()
      row.consecutive_switch_failures = 0
    } else {
      row.consecutive_switch_failures = (row.consecutive_switch_failures || 0) + 1
    }
    row.last_switch_reason = reason || null
  }, o || {})
}

function setIdentity(short, { org_uuid, account_uuid }, o) {
  return mutate(short, row => {
    if (org_uuid) row.org_uuid = org_uuid
    if (account_uuid) row.account_uuid = account_uuid
  }, o || {})
}

// validate() - the canary entry point. Returns the alarms a read would surface, plus
// checks that only matter periodically (a login prerequisite that has gone missing).
function validate(opts) {
  const { registry, alarms, source } = read(opts)
  const out = alarms.slice()
  for (const [short, row] of Object.entries(registry.accounts)) {
    if (!row || row.enabled === false) continue
    if (row.login_method === 'google-sso') {
      if (!row.pw_mirror) {
        out.push(short + ' is google-sso with no pw_mirror configured - a switch to it can only proceed while its Chrome Google session is still live.')
      } else if (!fs.existsSync(row.pw_mirror)) {
        out.push(short + ' pw_mirror is MISSING at ' + row.pw_mirror + (row.pw_mirror_provenance === 'kv' ? ' - regenerate with kv-mirror-refresh.sh.' : ' - provenance is local-only, so it cannot be regenerated without Tate.'))
      }
    }
  }
  return { ok: out.length === 0, alarms: out, source }
}

function bootstrapIfMissing(opts) {
  return read(opts)
}

module.exports = {
  REGISTRY_FILE, LAST_GOOD_FILE, SNAPSHOT_STATES, LOGIN_METHODS,
  read, enabled, disabledEmails, get, disable, enable,
  markSnapshot, recordSwitchResult, setIdentity, validate, bootstrapIfMissing,
  _defaultRegistry: defaultRegistry, _normalizeShort: normalizeShort, _atomicWrite: atomicWrite,
}
