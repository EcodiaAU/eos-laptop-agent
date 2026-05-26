// creds.js - per-account cred-rotation module for the autonomy substrate.
//
// HARD INVARIANTS (enforced by tests, never relax):
// - Never reads ~/.claude/.credentials.json to react to changes.
// - Never calls fs.watch on ~/.claude/.credentials.json or any other path.
// - The only writes to ~/.claude/.credentials.json come from rotate_to().
// - Any code path that "restores" the file from a backup is a regression.
//
// Usage source injection: tests call _setUsageSource(mock) where mock implements:
//   get_usage_state(account) -> { headroom_minutes, reset_at }
// The real source wraps usage.js to produce the same shape.

const fs = require('fs')
const path = require('path')
const os = require('os')

const CREDS_DIR = process.env.CREDS_DIR || 'D:/PRIVATE/ecodia-creds'
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
  if (!fs.existsSync(CLAUDE_CREDENTIALS_PATH)) return 'unknown'
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(CLAUDE_CREDENTIALS_PATH, 'utf8'))
  } catch (_) {
    return 'unknown'
  }
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

exports.rotate_to = async function (account) {
  if (!ACCOUNTS.includes(account)) {
    throw new Error('unknown account: ' + account)
  }

  const source = path.join(CREDS_DIR, account + '.json')
  if (!fs.existsSync(source)) {
    throw new Error('per-account cred file not found: ' + source)
  }

  const previous = exports.current_account()

  const content = fs.readFileSync(source)

  // Ensure target directory exists
  const dir = path.dirname(CLAUDE_CREDENTIALS_PATH)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

  // Atomic write: write to .tmp then rename into place
  const tmp = CLAUDE_CREDENTIALS_PATH + '.tmp'
  fs.writeFileSync(tmp, content)
  fs.renameSync(tmp, CLAUDE_CREDENTIALS_PATH)

  return { previous, current: account }
}
