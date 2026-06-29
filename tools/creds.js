// creds.js - per-account cred-rotation module for the autonomy substrate.
//
// Phase 1 of the autonomy substrate plan (2026-05-26). Implements credential
// rotation for the scheduler: pick the healthiest account, swap credentials
// atomically, and identify the current account without watching any file.
//
// HARD INVARIANTS (enforced by tests, never relax):
// - Never reads ~/.claude/.credentials.json to react to changes.
// - Never calls fs.watch on ~/.claude/.credentials.json or any other path.
// - The only writes to ~/.claude/.credentials.json come from rotate_to().
// - Any code path that "restores" the file from a backup is a regression.
//
// Tasks implemented:
//   1.2 pick_healthiest_account + AllAccountsCappedError + _setUsageSource
//   1.3 rotate_to (atomic via writeFileSync+renameSync) + current_account
//   1.4 fs.watch regression guard (enforced by creds.test.js final test)
//
// Usage source injection: tests call _setUsageSource(mock) where mock implements:
//   get_usage_state(account) -> { headroom_minutes, reset_at }
// The real source wraps usage.js to produce the same shape.

const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')

// On Mac, Claude Code stores its live OAuth credentials in the macOS Keychain
// (service "Claude Code-credentials", account "ecodia"). The ~/.claude/.credentials.json
// file is vestigial and is NOT read by the Mac binary, so file-swap rotation
// does not change which account Anthropic sees. Confirmed empirically 2026-06-08
// after Tate's money@ login updated the Keychain (mdat changed) but left
// .credentials.json unchanged. We use `security` CLI for Keychain read/write.
const USE_KEYCHAIN = process.platform === 'darwin'
const KEYCHAIN_SERVICE = 'Claude Code-credentials'
const KEYCHAIN_ACCOUNT = 'ecodia'

function readKeychain() {
  if (!USE_KEYCHAIN) return null
  const res = spawnSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w'], {
    encoding: 'utf8',
    timeout: 5000,
  })
  if (res.status !== 0) return null
  return res.stdout.trim()
}

function writeKeychain(jsonContent) {
  if (!USE_KEYCHAIN) throw new Error('writeKeychain called on non-Mac platform')
  // CRITICAL: `security -w` hex-encodes the entire stored blob when the
  // input contains embedded newlines or non-printable bytes (verified
  // empirically 2026-06-08: pretty-printed tate.json with internal \n's
  // round-tripped as hex; minified money.json round-tripped clean).
  // The hex-encoded blob breaks Claude Code's OAuth read because the
  // hex-string text does not parse as JSON.
  //
  // Fix: minify the JSON (single-line, no whitespace) before writing.
  // Falls back to trimmed raw string if the input is not valid JSON,
  // which keeps the path safe for diagnostic uses.
  let payload
  try {
    payload = JSON.stringify(JSON.parse(jsonContent))
  } catch (_) {
    payload = String(jsonContent).replace(/\s+$/, '')
  }
  // -U updates the entry in place if it exists; without -U a duplicate error fires.
  const res = spawnSync('security', [
    'add-generic-password',
    '-U',
    '-s', KEYCHAIN_SERVICE,
    '-a', KEYCHAIN_ACCOUNT,
    '-w', payload,
  ], { encoding: 'utf8', timeout: 5000 })
  if (res.status !== 0) {
    throw new Error('keychain write failed: status=' + res.status + ' stderr=' + (res.stderr || '').slice(0, 300))
  }
  return true
}

exports._readKeychain = readKeychain
exports._writeKeychain = writeKeychain
exports.USE_KEYCHAIN = USE_KEYCHAIN

const CREDS_DIR = process.env.CREDS_DIR || (
  process.platform === 'win32'
    ? 'D:/PRIVATE/ecodia-creds'
    : path.join(os.homedir(), 'PRIVATE', 'ecodia-creds')
)
const CLAUDE_CREDENTIALS_PATH =
  process.env.CLAUDE_CREDENTIALS_PATH ||
  path.join(os.homedir(), '.claude', '.credentials.json')

// ~/.claude.json holds `oauthAccount` - the DISPLAY identity (emailAddress,
// accountUuid, organizationUuid, seat/rate-limit tiers) that `claude auth status`
// and the VS Code extension UI read, and that usage attribution can key off.
// The Keychain holds the TOKEN (what authenticates/bills); ~/.claude.json holds
// the LABEL. A headless rotate_to that swaps only the token leaves this label
// stale, so the switch BILLS the new account but DISPLAYS the old one - the exact
// "you didn't switch at all" confusion (2026-06-22). rotate_to now swaps both;
// seed_from_live snapshots oauthAccount alongside the token.
const CLAUDE_JSON_PATH =
  process.env.CLAUDE_JSON_PATH ||
  path.join(os.homedir(), '.claude.json')

// Merge a snapshot's saved oauthAccount into ~/.claude.json (best-effort, atomic).
// Only writes when the snapshot actually carries an oauthAccount (older snapshots
// predate capture; those rotations leave the label as-is rather than wipe it).
function applyOauthAccount(parsedSnapshot) {
  try {
    const oa = parsedSnapshot && parsedSnapshot.oauthAccount
    if (!oa || !oa.emailAddress) return { applied: false, reason: 'snapshot_has_no_oauthAccount' }
    if (!fs.existsSync(CLAUDE_JSON_PATH)) return { applied: false, reason: 'no_claude_json' }
    const j = JSON.parse(fs.readFileSync(CLAUDE_JSON_PATH, 'utf8'))
    j.oauthAccount = oa
    const tmp = CLAUDE_JSON_PATH + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(j, null, 2))
    fs.renameSync(tmp, CLAUDE_JSON_PATH)
    return { applied: true, emailAddress: oa.emailAddress }
  } catch (e) {
    return { applied: false, reason: e.message }
  }
}
exports.applyOauthAccount = applyOauthAccount

const ACCOUNTS = ['tate', 'code', 'money']

// Accounts the operator has flagged as paused/unaffordable. pick_healthiest_account
// will never select them; rotate_to refuses to rotate to them. Set via env var
// ACCOUNTS_DISABLED as a comma-separated short-name list. Origin: 2026-06-11
// code@ plan paused.
const DISABLED_ACCOUNTS = new Set(
  (process.env.ACCOUNTS_DISABLED || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
)
exports._DISABLED_ACCOUNTS = DISABLED_ACCOUNTS

// ── AllAccountsCappedError ────────────────────────────────────────────────────

class AllAccountsCappedError extends Error {
  constructor(resets) {
    super('all three accounts are capped - no account has sufficient headroom')
    this.name = 'AllAccountsCappedError'
    // resets: { tate: <reset_at iso>, code: <reset_at iso>, money: <reset_at iso> }
    this.resets = resets
  }
}

exports.AllAccountsCappedError = AllAccountsCappedError

// ── usage source (injected by tests, lazy-loads real usage.js in production) ─

let _usageSource = null

// Injection seam for tests. Mock must implement:
//   get_usage_state(account) -> { headroom_minutes, reset_at }
exports._setUsageSource = function (source) {
  _usageSource = source
}

function buildRealUsageSource() {
  // Wraps the real usage.js exported get_usage_state (which returns full state
  // for all accounts) into the simpler per-account interface the seam expects.
  const usage = require('./usage')
  return {
    get_usage_state(account) {
      const full = usage._readAccountsState()
      if (!full || !full.accounts) {
        // No poll data yet - return max headroom so we don't block rotation
        return { headroom_minutes: Infinity, reset_at: null }
      }
      // Normalise short-form account name to the full canonical form
      const canonical = usage._normalizeAccount(account) || account
      const a = full.accounts[canonical]
      if (!a) return { headroom_minutes: 0, reset_at: null }
      // Convert token headroom to approximate minutes using a 10M tokens/hr estimate.
      // The creds layer only needs a coarse signal; scheduling precision lives in scheduler.js.
      const headroom_tokens = Math.min(a.remaining_5h || 0, a.remaining_weekly || 0)
      const TOKENS_PER_MINUTE = 10_000_000 / 60
      const headroom_minutes = headroom_tokens / TOKENS_PER_MINUTE
      // reset_at: earlier of the two window resets (conservative)
      const reset_at = full.polled_at || null
      return { headroom_minutes: Math.floor(headroom_minutes), reset_at }
    },
  }
}

function getUsageSource() {
  if (!_usageSource) _usageSource = buildRealUsageSource()
  return _usageSource
}

// ── pick_healthiest_account ───────────────────────────────────────────────────
//
// Returns the short-form account name ('tate' | 'code' | 'money') to use for
// the next scheduled dispatch.
//
// Params:
//   preferred (string, optional) - prefer this account if it has enough headroom
//   required_headroom_minutes (number, optional, default 15) - minimum headroom
//
// Throws AllAccountsCappedError if no account meets the threshold.

exports.pick_healthiest_account = async function ({
  preferred = null,
  required_headroom_minutes = 15,
  preferred_retention_minutes = 2,
} = {}) {
  // 2026-06-08 Mac-day: when CREDS_DIR doesn't exist or has zero per-account
  // files, cred-rotation is impossible. Return 'current-process' so the
  // scheduler dispatches on whatever account is already loaded in
  // ~/.claude/.credentials.json. The scheduler's rotate_to() also handles
  // 'current-process' as a no-op. This is the no-rotation Mac-bootstrap mode
  // until D:/PRIVATE/ecodia-creds gets transferred and CREDS_DIR is pointed
  // at it.
  if (!fs.existsSync(CREDS_DIR)) {
    return 'current-process'
  }
  const haveAny = ACCOUNTS.some(a => fs.existsSync(path.join(CREDS_DIR, a + '.json')))
  if (!haveAny) {
    return 'current-process'
  }

  const usage = getUsageSource()
  const states = {}
  for (const acct of ACCOUNTS) {
    states[acct] = usage.get_usage_state(acct)
  }

  // Sticky-to-live retention (2026-06-25 single-keychain stickiness, hardened
  // 2026-06-29). The live/preferred interactive account is ALWAYS the busiest, so
  // its 5h headroom routinely dips below the 15-min worker-dispatch threshold
  // during normal work. Evicting it there rotated the shared keychain onto
  // another account every time Tate was active - and the 5h window self-heals in
  // minutes, so the switch bought nothing and broke the flow (recurring
  // code@ -> money@ onto a weekly-capped account). Retain the preferred account
  // through transient dips: abandon it only when genuinely near-exhausted on its
  // tightest window (headroom_minutes <= preferred_retention_minutes, default 2),
  // not merely busy. The eligible-pick below still uses the full
  // required_headroom_minutes for choosing among NON-preferred candidates (fresh
  // worker dispatch / genuine failover).
  if (
    preferred &&
    !DISABLED_ACCOUNTS.has(preferred) &&
    states[preferred] &&
    states[preferred].headroom_minutes > preferred_retention_minutes
  ) {
    return preferred
  }

  // Pick highest-headroom account above threshold, excluding disabled accounts.
  const eligible = ACCOUNTS
    .filter(a => !DISABLED_ACCOUNTS.has(a))
    .filter(a => states[a] && states[a].headroom_minutes > required_headroom_minutes)
    .sort((a, b) => states[b].headroom_minutes - states[a].headroom_minutes)

  if (eligible.length > 0) return eligible[0]

  // 2026-06-14 sole-enabled fallback. If exactly one account is enabled, return
  // it even when it is below the headroom threshold. With one usable account
  // there is nothing to fail over TO, so running it degraded beats throwing
  // AllAccountsCapped and freezing ALL dispatch (the original "everything stuck"
  // symptom). Dispatch eligibility must not hard-block the only account; the cap
  // WARNING (checkCapWarning + the poller cap-alert) is the signal to switch.
  const enabledAll = ACCOUNTS.filter(a => !DISABLED_ACCOUNTS.has(a))
  if (enabledAll.length === 1) return enabledAll[0]

  // All capped - build reset map and throw
  const resets = {}
  for (const a of ACCOUNTS) resets[a] = (states[a] && states[a].reset_at) || null
  throw new AllAccountsCappedError(resets)
}

// ── current_account ───────────────────────────────────────────────────────────
//
// Reads ~/.claude/.credentials.json and identifies which per-account file it
// matches by comparing access tokens. Returns short-form name or 'unknown'.
//
// This function only READS .credentials.json; it never writes or watches it.

exports.current_account = function () {
  // On Mac, the live OAuth blob lives in the Keychain (Claude Code does NOT
  // read .credentials.json on darwin). Read the Keychain blob and hash-match
  // its accessToken against the per-account files. Fall back to the file path
  // on non-Mac platforms (existing Windows behaviour).
  // Authoritative-when-fresh: match the live access token against the per-account
  // snapshot files. The token IS the billing identity, so a match is definitive -
  // but the snapshots freeze the token at capture time while the live token
  // (Keychain on Mac) rotates ~hourly on refresh, so this only matches for the
  // first hour after a rotate_to. Every other path falls through to the
  // refresh-stable oauthAccount label below.
  let liveJsonText
  if (USE_KEYCHAIN) {
    liveJsonText = readKeychain()
  } else if (fs.existsSync(CLAUDE_CREDENTIALS_PATH)) {
    try { liveJsonText = fs.readFileSync(CLAUDE_CREDENTIALS_PATH, 'utf8') } catch (_) {}
  }
  if (liveJsonText) {
    let parsed
    try { parsed = JSON.parse(liveJsonText) } catch (_) { parsed = null }
    const activeToken = parsed && parsed.claudeAiOauth && parsed.claudeAiOauth.accessToken
    if (activeToken) {
      for (const acct of ACCOUNTS) {
        const file = path.join(CREDS_DIR, acct + '.json')
        if (!fs.existsSync(file)) continue
        try {
          const acctData = JSON.parse(fs.readFileSync(file, 'utf8'))
          if (acctData && acctData.claudeAiOauth && acctData.claudeAiOauth.accessToken === activeToken) {
            return acct
          }
        } catch (_) {}
      }
    }
  }
  // Token match failed or the live blob was unreadable. The per-account SNAPSHOT
  // files freeze the access token at capture time, but the live access token
  // rotates ~hourly on refresh - so for most of every cycle this returned
  // 'unknown'. That silently collapsed the scheduler's sticky-to-live preference
  // to null (scheduler.js treats 'unknown' as "no live account") and let
  // per-dispatch pick_healthiest clobber the shared keychain onto the
  // higher-headroom-minutes account: the recurring "random code@ -> money@"
  // switch onto a weekly-capped account that breaks the interactive flow. Fall
  // back to the DISPLAY identity in ~/.claude.json oauthAccount, which changes
  // only on a REAL account switch (not on token refresh) and is kept in sync by
  // rotate_to/applyOauthAccount. Origin: 2026-06-29 Tate report.
  return currentAccountFromOauthLabel()
}

// Resolve the live account from the ~/.claude.json oauthAccount display label.
// emailAddress local-part maps 1:1 to a short account name (code@ecodia.au ->
// 'code'). Returns 'unknown' when the file/label is absent or names an account
// outside ACCOUNTS. This is the refresh-stable identity source that backstops the
// token match in current_account().
function currentAccountFromOauthLabel() {
  try {
    if (!fs.existsSync(CLAUDE_JSON_PATH)) return 'unknown'
    const j = JSON.parse(fs.readFileSync(CLAUDE_JSON_PATH, 'utf8'))
    const email = j && j.oauthAccount && j.oauthAccount.emailAddress
    const short = email ? String(email).split('@')[0].trim().toLowerCase() : null
    if (short && ACCOUNTS.includes(short)) return short
  } catch (_) {}
  return 'unknown'
}
exports._currentAccountFromOauthLabel = currentAccountFromOauthLabel

// ── rotate_to ─────────────────────────────────────────────────────────────────
//
// Atomically replaces ~/.claude/.credentials.json with the per-account file for
// the given account. Uses writeFileSync(tmp) + renameSync(tmp, target) to
// guarantee atomicity on NTFS (same volume, same rename domain).
//
// Returns { previous, current } where previous is the short-form name before
// rotation (or 'unknown') and current is the account name just written.
//
// Throws:
//   Error('unknown account: <name>') if account is not in ['tate','code','money']
//   Error('per-account cred file not found: <path>') if the source file is absent

// Count active worker rows. On Mac, the Keychain entry is shared across every
// Claude Code process on the machine; rotating it while OTHER workers have
// in-flight tokens kicks them out with a 401 the moment their access token
// expires. The safety gate: only rotate when no other workers are active.
// The caller can pass {force: true} or {caller_tab_id: <id>} to bypass /
// exclude themselves from the count.
function countActiveWorkers(excludeTabId) {
  const COORD_ROOT = process.env.COORD_ROOT || (
    process.platform === 'win32'
      ? 'D:\\.code\\EcodiaOS\\coordination'
      : path.join(os.homedir(), '.ecodiaos', 'coordination')
  )
  const workersDir = path.join(COORD_ROOT, 'workers')
  if (!fs.existsSync(workersDir)) return { count: 0, tabs: [] }
  let count = 0
  const tabs = []
  for (const file of fs.readdirSync(workersDir)) {
    if (!file.endsWith('.json')) continue
    try {
      const w = JSON.parse(fs.readFileSync(path.join(workersDir, file), 'utf8'))
      if (excludeTabId && w.tab_id === excludeTabId) continue
      if (w.terminated_at) continue
      count++
      tabs.push({ tab_id: w.tab_id, account: w.account_active_when_spawned })
    } catch (_) {}
  }
  return { count, tabs }
}

exports._countActiveWorkers = countActiveWorkers

exports.rotate_to = async function (accountOrParams) {
  // Agent dispatcher passes the full params object as the first argument; CLI/test
  // callers historically pass a bare string. Accept either to avoid a dispatcher
  // shape mismatch ([object Object] errors).
  const params = (accountOrParams && typeof accountOrParams === 'object')
    ? accountOrParams
    : { account: accountOrParams }
  const account = params.account
  const force = !!params.force
  const callerTabId = params.caller_tab_id || null

  // 2026-06-08 Mac-day: when pick_healthiest_account returned 'current-process'
  // (no cred files available), rotate_to is a no-op.
  if (account === 'current-process') {
    return { previous: exports.current_account(), current: 'current-process', no_rotation: true }
  }

  if (!ACCOUNTS.includes(account)) {
    throw new Error('unknown account: ' + account)
  }

  // Disabled-account guard: operator-paused accounts must never become the
  // live Keychain identity, regardless of force. The interactive conductor
  // would re-login to find itself routed to a paused plan. Origin: 2026-06-11
  // code@ plan paused.
  if (DISABLED_ACCOUNTS.has(account)) {
    return {
      previous: exports.current_account(),
      current: exports.current_account(),
      deferred: true,
      reason: 'account_disabled',
      account,
      hint: 'account is in ACCOUNTS_DISABLED env var (operator-paused plan); remove from list to re-enable',
    }
  }

  // 2026-06-14 relogin-loop root-cause fix (Guard A: sole-enabled account).
  // The Mac Keychain holds the LIVE, continuously-refreshed OAuth token for the
  // logged-in account. The per-account files are point-in-time SNAPSHOTS whose
  // access+refresh tokens go stale within ~1h. current_account() matches by
  // accessToken, so once the live token refreshes past the snapshot it returns
  // 'unknown', which made rotate_to believe it had to rotate and CLOBBER the
  // live token with the older snapshot. The snapshot's refreshToken is already
  // server-rotated, so the next refresh 401s and the account is signed out -
  // every cron fire. When `account` is the ONLY non-disabled account, the live
  // session must already BE it (there is nothing else to dispatch on), so there
  // is nothing to rotate: use the live Keychain as-is and never touch it.
  const _enabled = ACCOUNTS.filter(a => !DISABLED_ACCOUNTS.has(a))
  if (_enabled.length === 1 && _enabled[0] === account && !force) {
    return { previous: account, current: account, no_rotation: true, reason: 'sole_enabled_account_use_live' }
  }

  const source = path.join(CREDS_DIR, account + '.json')
  if (!fs.existsSync(source)) {
    throw new Error('per-account cred file not found: ' + source)
  }

  const previous = exports.current_account()

  // Guard B: already on the target account per current_account(). Skip the
  // Keychain write entirely - rewriting the snapshot over the live token is the
  // same clobber as a cross-account rotation. Belt-and-suspenders alongside the
  // sole-enabled fast-path above, for any future multi-account config.
  if (previous === account && !force) {
    return { previous, current: account, no_rotation: true, reason: 'already_on_target' }
  }

  // Safety gate: never rotate while other workers are mid-flight (Mac Keychain
  // is a single shared resource; rotation kicks any other-account session out
  // with a 401 on its next refresh). Skip the gate when target == current,
  // when force is set, or when there are zero other workers.
  if (previous !== account) {
    const { count, tabs } = countActiveWorkers(callerTabId)
    if (count > 0 && !force) {
      return {
        previous,
        current: previous,
        deferred: true,
        reason: 'active_workers_present',
        active_count: count,
        active_tabs: tabs.slice(0, 10),
        hint: 'pass {force: true} to bypass, or wait for these workers to terminate before rotating',
      }
    }
  }

  const content = fs.readFileSync(source, 'utf8')

  // 2026-06-11 stale-source guard. Mac Keychain rotation with a stale blob
  // silently kicks every Claude Code session on the machine into a 401 the
  // moment the next API call fires - INCLUDING the interactive conductor
  // session, which is NOT in ~/.ecodiaos/coordination/workers/ and therefore
  // is invisible to the Layer 9 safety gate above. Without this guard the
  // scheduler repeatedly clobbers Tate's live token every cron fire whenever
  // no dispatched workers happen to be active (the gate's only protection).
  // Refuse the rotation when the source per-account file is past or near
  // expiry; the scheduler's deferred-handling branch will dispatch on the
  // currently-authenticated account instead. Origin: 2026-06-11 30-min
  // relogin loop diagnosis (all three per-account files were stale fossils
  // because cred-refresher was reading the .credentials.json mirror instead
  // of the Keychain - see daemons/cred-refresher.js readLiveCredentials).
  const STALE_THRESHOLD_MS = 5 * 60 * 1000
  let _parsedSource
  try { _parsedSource = JSON.parse(content) } catch (_) {}
  const _sourceExpiry = _parsedSource && _parsedSource.claudeAiOauth && _parsedSource.claudeAiOauth.expiresAt
  if (!_sourceExpiry || (_sourceExpiry - Date.now()) < STALE_THRESHOLD_MS) {
    return {
      previous,
      current: previous,
      deferred: true,
      reason: 'source_token_stale',
      source: source,
      source_expires_at: _sourceExpiry || null,
      source_age_min: _sourceExpiry ? Math.round((Date.now() - _sourceExpiry) / 60000) : null,
      hint: 'per-account file is stale; cred-refresher must sync it from the live Keychain before this rotation is safe',
    }
  }

  if (USE_KEYCHAIN) {
    // Mac: write the per-account JSON blob into the Keychain entry that the
    // Claude Code Mac binary actually reads. Atomic by virtue of
    // `security add-generic-password -U` overwriting in place.
    writeKeychain(content)
    // Also mirror to .credentials.json for legacy diagnostics + the cred-refresher's
    // live-session detection (it reads the file to identify which account is live).
    try {
      const dir = path.dirname(CLAUDE_CREDENTIALS_PATH)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      const tmp = CLAUDE_CREDENTIALS_PATH + '.tmp'
      fs.writeFileSync(tmp, content)
      fs.renameSync(tmp, CLAUDE_CREDENTIALS_PATH)
    } catch (_) {
      // best-effort mirror; Keychain is the source of truth on Mac
    }
    // Swap the DISPLAY identity too so `claude auth status` / the extension UI /
    // usage attribution follow the token. Stale label = the 2026-06-22 "didn't
    // switch" illusion. Best-effort: a snapshot without oauthAccount leaves it.
    const oaRes = applyOauthAccount(_parsedSource)
    return { previous, current: account, target: 'keychain', oauthAccount: oaRes }
  }

  // Windows / Linux: file-swap rotation. .credentials.json IS the source of truth.
  const dir = path.dirname(CLAUDE_CREDENTIALS_PATH)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const tmp = CLAUDE_CREDENTIALS_PATH + '.tmp'
  fs.writeFileSync(tmp, content)
  fs.renameSync(tmp, CLAUDE_CREDENTIALS_PATH)

  const oaRes = applyOauthAccount(_parsedSource)
  return { previous, current: account, target: 'file', oauthAccount: oaRes }
}

// ── seed_from_live ────────────────────────────────────────────────────────────
//
// Captures the current live OAuth blob (Mac Keychain on darwin, .credentials.json
// elsewhere) into the per-account backup file for `account`. Use after Tate logs
// into Claude Code as that account to re-arm rotation. The Keychain blob is the
// canonical fresh token pair; the per-account file is the rotation target.
//
// Returns { account, source, dest, expiresAt, expires_in_min }.
exports.seed_from_live = function (accountOrParams) {
  const params = (accountOrParams && typeof accountOrParams === 'object')
    ? accountOrParams
    : { account: accountOrParams }
  const account = params.account
  if (!ACCOUNTS.includes(account)) {
    throw new Error('unknown account: ' + account + ' (expected one of ' + ACCOUNTS.join(',') + ')')
  }

  let liveText = null
  let liveSource = null
  if (USE_KEYCHAIN) {
    liveText = readKeychain()
    liveSource = 'keychain:' + KEYCHAIN_SERVICE + '/' + KEYCHAIN_ACCOUNT
  }
  if (!liveText) {
    if (!fs.existsSync(CLAUDE_CREDENTIALS_PATH)) {
      throw new Error('no live credentials source available (Keychain empty AND ' + CLAUDE_CREDENTIALS_PATH + ' missing)')
    }
    liveText = fs.readFileSync(CLAUDE_CREDENTIALS_PATH, 'utf8')
    liveSource = CLAUDE_CREDENTIALS_PATH
  }

  let parsed
  try { parsed = JSON.parse(liveText) } catch (_) {
    throw new Error('live credentials are not valid JSON (source: ' + liveSource + ')')
  }
  const o = parsed && parsed.claudeAiOauth
  if (!o || !o.accessToken) {
    throw new Error('live credentials lack claudeAiOauth.accessToken (source: ' + liveSource + ')')
  }
  if (!o.expiresAt || (o.expiresAt - Date.now()) < 5 * 60 * 1000) {
    throw new Error('refusing to seed ' + account + ' from stale live blob (expiresAt=' + o.expiresAt + ', age=' + Math.round((Date.now() - (o.expiresAt || 0)) / 60000) + 'min). Log in as ' + account + ' in Claude Code first.')
  }

  // Anti-clobber identity guard (2026-06-22). seed_from_live trusts the caller to
  // NAME the account that owns the live blob; it does not verify it. On 2026-06-22
  // a seed_from_live({account:'tate'}) ran while code@ was the live Keychain
  // identity, writing code@'s token into tate.json. current_account() then matched
  // the live token to tate.json and the auto-switch reasoned about the WRONG live
  // account (the silent-stall root cause). Offline, alias-safe guard: refuse when
  // the live blob is byte-identical to a DIFFERENT account's current snapshot -
  // that proves the live identity is the other account, not `account`.
  // (Token-equality sidesteps the money@/tate@ alias-email ambiguity an API-email
  // check would hit.)
  for (const other of ACCOUNTS) {
    if (other === account) continue
    try {
      const otherTok = JSON.parse(fs.readFileSync(path.join(CREDS_DIR, other + '.json'), 'utf8'))?.claudeAiOauth?.accessToken
      if (otherTok && otherTok === o.accessToken) {
        throw new Error('CLOBBER GUARD: live token already belongs to ' + other + '.json; refusing to also write it as ' + account + '.json (live identity is ' + other + ', not ' + account + '). Log in as ' + account + ' before seeding.')
      }
    } catch (e) { if (/CLOBBER GUARD/.test(e.message)) throw e }
  }

  // Capture the live DISPLAY identity (oauthAccount from ~/.claude.json) into the
  // snapshot so a future rotate_to can restore the label alongside the token.
  // Guarded by emailAddress == this account (alias-safe: money@'s oauthAccount
  // reads money@ecodia.au, not tate@), so we never snapshot the wrong label even
  // if ~/.claude.json is mid-drift. Missing/mismatched -> snapshot carries no
  // oauthAccount and rotate_to leaves the label as-is (no regression).
  let oauthCaptured = false
  try {
    const cj = JSON.parse(fs.readFileSync(CLAUDE_JSON_PATH, 'utf8'))
    const oa = cj && cj.oauthAccount
    if (oa && oa.emailAddress === account + '@ecodia.au') { parsed.oauthAccount = oa; oauthCaptured = true }
  } catch (_) {}

  const dest = path.join(CREDS_DIR, account + '.json')
  const tmp = dest + '.tmp'
  if (!fs.existsSync(CREDS_DIR)) fs.mkdirSync(CREDS_DIR, { recursive: true })
  // Write minified to match the Keychain canonical form
  fs.writeFileSync(tmp, JSON.stringify(parsed), 'utf8')
  fs.renameSync(tmp, dest)

  return {
    account,
    source: liveSource,
    dest,
    expiresAt: o.expiresAt,
    expires_in_min: Math.round((o.expiresAt - Date.now()) / 60000),
    oauthAccountCaptured: oauthCaptured,
  }
}
