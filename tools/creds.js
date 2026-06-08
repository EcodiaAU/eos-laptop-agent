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

const ACCOUNTS = ['tate', 'code', 'money']

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

  // Honour preferred if it clears the threshold
  if (
    preferred &&
    states[preferred] &&
    states[preferred].headroom_minutes > required_headroom_minutes
  ) {
    return preferred
  }

  // Pick highest-headroom account above threshold
  const eligible = ACCOUNTS
    .filter(a => states[a] && states[a].headroom_minutes > required_headroom_minutes)
    .sort((a, b) => states[b].headroom_minutes - states[a].headroom_minutes)

  if (eligible.length > 0) return eligible[0]

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
  let liveJsonText
  if (USE_KEYCHAIN) {
    liveJsonText = readKeychain()
    if (!liveJsonText) return 'unknown'
  } else {
    if (!fs.existsSync(CLAUDE_CREDENTIALS_PATH)) return 'unknown'
    try {
      liveJsonText = fs.readFileSync(CLAUDE_CREDENTIALS_PATH, 'utf8')
    } catch (_) {
      return 'unknown'
    }
  }

  let parsed
  try { parsed = JSON.parse(liveJsonText) } catch (_) { return 'unknown' }
  const activeToken = parsed && parsed.claudeAiOauth && parsed.claudeAiOauth.accessToken
  if (!activeToken) return 'unknown'

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
  return 'unknown'
}

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

  const source = path.join(CREDS_DIR, account + '.json')
  if (!fs.existsSync(source)) {
    throw new Error('per-account cred file not found: ' + source)
  }

  const previous = exports.current_account()

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
    return { previous, current: account, target: 'keychain' }
  }

  // Windows / Linux: file-swap rotation. .credentials.json IS the source of truth.
  const dir = path.dirname(CLAUDE_CREDENTIALS_PATH)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const tmp = CLAUDE_CREDENTIALS_PATH + '.tmp'
  fs.writeFileSync(tmp, content)
  fs.renameSync(tmp, CLAUDE_CREDENTIALS_PATH)

  return { previous, current: account, target: 'file' }
}
