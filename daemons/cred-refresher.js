// daemons/cred-refresher.js
//
// Proactively refreshes per-account Claude OAuth tokens every 30 minutes so
// they never expire while the scheduler is mid-dispatch. Access tokens last
// 8 hours; refreshing every 30 min is conservative and safe.
//
// ============================================================
// INVARIANT - DO NOT REMOVE THIS COMMENT:
//   This daemon WRITES ONLY to D:/PRIVATE/ecodia-creds/{account}.json.
//   It MUST NEVER write to, and MUST NEVER register a filesystem watch on,
//   the live credentials file at ~/.claude/.credentials.json. That file is
//   written exclusively by tools/creds.js::rotate_to and by Claude Code's own
//   in-place OAuth refresh.
//
//   2026-05-28 amendment: a ONE-SHOT READ of the live credentials file is now
//   permitted (readLiveCredentials), for the SOLE purpose of identifying which
//   account is the live interactive session so we DO NOT consume its single-use
//   refresh_token. This is the OPPOSITE of the clobber pattern (which watched +
//   wrote-back). Read-to-skip is protective. The watch + write-back ban is what
//   is load-bearing; a read-only snapshot to avoid a token-lineage collision
//   is safe. Root cause it fixes: overnight the refresher refreshed the backup
//   of the account Tate's live session was on, rotating the single-use
//   refresh_token out from under Claude Code, so Claude Code's own refresh
//   failed and Tate had to re-login (2026-05-28 cred-collision diagnosis).
// ============================================================
//
// Per-account file shape (claudeAiOauth wrapper):
//   { claudeAiOauth: { accessToken, refreshToken, expiresAt (ms epoch),
//                      scopes, subscriptionType, rateLimitTier } }
//
// Only accessToken, refreshToken, expiresAt change on each refresh.
// scopes, subscriptionType, rateLimitTier are preserved as-is.
//
// refresh_token ROTATES on every successful OAuth refresh (single-use).
// The new refresh_token MUST be written back atomically or the next refresh
// will 401. Atomic write: writeFileSync(tmp) -> renameSync(tmp, target).
//
// After 3 consecutive failures for an account, writes to kv_store key
// creds.refresh_failure.<account> so the VPS watchdog (Phase 6) sees it.
//
// Env vars:
//   CREDS_DIR          path to dir holding {tate,code,money}.json
//                      default: D:/PRIVATE/ecodia-creds
//   OAUTH_REFRESH_URL  OAuth token endpoint
//                      default: https://platform.claude.com/v1/oauth/token
//   OAUTH_CLIENT_ID    OAuth client_id
//                      default: 9d1c250a-e61b-44d9-88ed-5944d1962f5e
//   OAUTH_USER_AGENT   User-Agent header sent with every refresh request
//                      default: claude-cli-refresher/1.0 (eos-laptop-agent)
//   REFRESH_INTERVAL_MS   loop interval, default 30 * 60 * 1000 (30 min)
//   REFRESH_THRESHOLD_MS  how far in advance to refresh, default 20 * 60 * 1000 (20 min)
//   SUPABASE_URL          Supabase REST endpoint (for kv_store escalation)
//   SUPABASE_SERVICE_KEY  Supabase service role key (for kv_store escalation)
//
// Run under PM2 (see ecosystem.config.js).
// When required as a module, the start loop is NOT called automatically.

'use strict'

// Load supabase creds from the canonical local file if present. Must happen
// before any code reads SUPABASE_URL / SUPABASE_SERVICE_KEY from process.env.
const fs   = require('fs')
const path = require('path')
const os   = require('os')
const http  = require('http')
const https = require('https')
const { spawnSync } = require('child_process')

const _DEFAULT_CREDS_DIR = process.platform === 'win32'
  ? 'D:/PRIVATE/ecodia-creds'
  : path.join(os.homedir(), 'PRIVATE', 'ecodia-creds')

try {
  require('dotenv').config({ path: path.join(_DEFAULT_CREDS_DIR, 'supabase.env') })
} catch (_) {
  // dotenv missing or file absent - env vars may still be set by PM2
}

// ── config ────────────────────────────────────────────────────────────────────

const ACCOUNTS = ['tate', 'code', 'money']

// Accounts the operator has flagged as paused/unaffordable. The refresher
// will not attempt OAuth refresh against them (their refresh_token is
// expected to be invalid) and creds.rotate_to refuses to pick them. Set
// via env var ACCOUNTS_DISABLED as a comma-separated short-name list.
// Origin: 2026-06-11 code@ plan paused.
const DISABLED_ACCOUNTS = new Set(
  (process.env.ACCOUNTS_DISABLED || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
)

const CREDS_DIR          = process.env.CREDS_DIR          || _DEFAULT_CREDS_DIR
const OAUTH_REFRESH_URL  = process.env.OAUTH_REFRESH_URL  || 'https://platform.claude.com/v1/oauth/token'
const OAUTH_CLIENT_ID    = process.env.OAUTH_CLIENT_ID    || '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const OAUTH_USER_AGENT   = process.env.OAUTH_USER_AGENT   || 'claude-cli-refresher/1.0 (eos-laptop-agent)'
const REFRESH_INTERVAL_MS   = Number(process.env.REFRESH_INTERVAL_MS)   || 30 * 60 * 1000
const REFRESH_THRESHOLD_MS  = Number(process.env.REFRESH_THRESHOLD_MS)  || 20 * 60 * 1000
const FAILURE_ESCALATION_COUNT = 3

// ── loud alarm channel (SMS Tate) ─────────────────────────────────────────────
// The kv_store escalation below is a SILENT log nobody reads, and it skips
// entirely when SUPABASE_* env is absent (it is, under launchd). That silence is
// the 2026-06-21 root cause: code@/money@ refresh tokens died and rotted for
// 14-32h with zero alarm, so when the live account capped there was no fresh
// snapshot to rotate to and the switch had to be done by hand. A dead snapshot
// must SCREAM the moment it dies - while a healthy account is still live and a
// 30-second re-auth is all that is needed - not surface days later as a stall.
// text-tate.js is the free, secret-free iMessage channel launchd crons already
// use to reach Tate. Rate-limited per account so a persistent failure (re-tried
// every 30 min) does not spam.
const TEXT_TATE_PATH = process.env.TEXT_TATE_PATH ||
  path.join(os.homedir(), '.code', 'ecodiaos', 'backend', 'imessage-agent', 'text-tate.js')
const ALERT_COOLDOWN_MS = Number(process.env.CRED_ALERT_COOLDOWN_MS) || 6 * 60 * 60 * 1000
const _lastAlertAt = { tate: 0, code: 0, money: 0 }

// SMS Tate that an account's token has died and needs a re-auth. Rate-limited.
// Returns true if a message was actually sent. Never throws (best-effort alarm).
function alertTateRefreshDead(account, consecutive, reason) {
  const now = Date.now()
  if (now - (_lastAlertAt[account] || 0) < ALERT_COOLDOWN_MS) return false
  const short = String(reason || '').slice(0, 90)
  const msg = `Claude account ${account}@ cannot auto-refresh (${consecutive} fails): ${short}. Snapshot is dead - it cannot be switched to until you re-auth ${account}@ (run account-login). Other accounts still cover, but this one is offline for auto-switch.`
  try {
    const r = spawnSync('node', [TEXT_TATE_PATH, '--from', 'cred-refresher', msg], {
      timeout: 20000, encoding: 'utf8',
    })
    if (r.status === 0) {
      _lastAlertAt[account] = now
      console.error('[cred-refresher] SMS-alerted Tate: ' + account + ' refresh dead')
      return true
    }
    console.error('[cred-refresher] text-tate alert FAILED (status ' + r.status + '): ' + ((r.stderr || r.stdout || '').trim().slice(0, 200)))
  } catch (e) {
    console.error('[cred-refresher] text-tate alert threw: ' + e.message)
  }
  return false
}

// ── failure counter (per-account, resets on success) ─────────────────────────

const failureCount = { tate: 0, code: 0, money: 0 }

// Tracks which account most recently matched the live interactive session.
// Used to gate the 401 self-heal: we only sync a backup from live credentials
// after a 401 when we have POSITIVE prior evidence that account WAS the live
// session (and the live session has since rotated its single-use refresh_token,
// spending the one in our backup). Without this gate, an account whose backup
// happens not to match any other backup would falsely self-heal. null until
// a cycle observes a live match.
let _lastActiveAccount = null

// ── kv_store writer (dependency-injected seam for tests) ─────────────────────

let _kvWriter = defaultKvWriter

function _setKvWriter(fn) {
  _kvWriter = fn
}

async function defaultKvWriter(key, value) {
  const supabaseUrl = process.env.SUPABASE_URL
  const serviceKey  = process.env.SUPABASE_SERVICE_KEY
  if (!supabaseUrl || !serviceKey) {
    console.warn('[cred-refresher] SUPABASE_URL or SUPABASE_SERVICE_KEY not set - kv_store escalation skipped')
    return
  }

  const body = JSON.stringify({ key, value, updated_at: new Date().toISOString() })
  const url  = supabaseUrl.replace(/\/$/, '') + '/rest/v1/kv_store'
  const parsed = new URL(url)
  const isHttps = parsed.protocol === 'https:'
  const transport = isHttps ? https : http

  return new Promise((resolve, reject) => {
    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (isHttps ? 443 : 80),
      path:     parsed.pathname + '?on_conflict=key',
      method:   'POST',
      headers: {
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(body),
        'apikey':         serviceKey,
        'Authorization':  'Bearer ' + serviceKey,
        'Prefer':         'resolution=merge-duplicates',
      },
    }
    const req = transport.request(options, (res) => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve()
        } else {
          reject(new Error('kv_store upsert failed: HTTP ' + res.statusCode + ' ' + data))
        }
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

// ── core HTTP helper ──────────────────────────────────────────────────────────

function postJson(urlStr, headers, bodyObj) {
  return new Promise((resolve, reject) => {
    const body   = JSON.stringify(bodyObj)
    const parsed = new URL(urlStr)
    const isHttps = parsed.protocol === 'https:'
    const transport = isHttps ? https : http
    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (isHttps ? 443 : 80),
      path:     parsed.pathname + (parsed.search || ''),
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent':     OAUTH_USER_AGENT,
        ...headers,
      },
    }
    const req = transport.request(options, (res) => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => resolve({ status: res.statusCode, body: data }))
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

// ── file helpers ──────────────────────────────────────────────────────────────

function accountFilePath(account) {
  return path.join(CREDS_DIR, account + '.json')
}

function readAccountFile(account) {
  const p = accountFilePath(account)
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

// Path to the live credentials file Claude Code uses on non-Mac platforms.
// ONE-SHOT READ ONLY - never write, never watch (see the INVARIANT block at
// the top of this file).
//
// 2026-06-11: on darwin the LIVE source-of-truth is the macOS Keychain entry
// "Claude Code-credentials/ecodia". ~/.claude/.credentials.json is a vestigial
// best-effort mirror that drifts (the Claude Code Mac binary in-place refreshes
// the Keychain blob without touching the file). Reading the file for
// live-session detection misled the refresher into thinking a fossil tate.json
// was active when the real Keychain had a totally different token lineage,
// which is what allowed scheduler.dispatchOne -> rotate_to to repeatedly
// clobber the live Keychain blob with the stale per-account file (Tate's
// 30-minute re-login loop, 2026-06-11).
const KEYCHAIN_SERVICE = 'Claude Code-credentials'
const KEYCHAIN_ACCOUNT = 'ecodia'
const USE_KEYCHAIN = process.platform === 'darwin'
const LIVE_CREDENTIALS_PATH =
  process.env.CLAUDE_CREDENTIALS_PATH ||
  path.join(require('os').homedir(), '.claude', '.credentials.json')

function _readKeychainText() {
  if (!USE_KEYCHAIN) return null
  const res = spawnSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w'], {
    encoding: 'utf8',
    timeout: 5000,
  })
  if (res.status !== 0) return null
  return (res.stdout || '').trim()
}

// Read the live credentials once. Returns { accessToken, refreshToken, raw }
// or null. Used only to identify + protect the active interactive session's
// token lineage AND to seed the existing "sync backup from live credentials
// (active session)" branch in refresh_account so the per-account files stay
// alive when Claude Code self-refreshes the Keychain.
//
// Mac: prefer the Keychain blob; fall back to the file mirror if the Keychain
// read fails (e.g. permission denied in a foreign environment) so tests
// continue to exercise the file path.
function readLiveCredentials() {
  let text = null
  if (USE_KEYCHAIN) {
    text = _readKeychainText()
  }
  if (!text) {
    try {
      if (!fs.existsSync(LIVE_CREDENTIALS_PATH)) return null
      text = fs.readFileSync(LIVE_CREDENTIALS_PATH, 'utf8')
    } catch (_) {
      return null
    }
  }
  try {
    const parsed = JSON.parse(text)
    const o = parsed && parsed.claudeAiOauth
    if (!o || !o.accessToken) return null
    return { accessToken: o.accessToken, refreshToken: o.refreshToken, raw: parsed }
  } catch (_) {
    return null
  }
}

// The live account's short name from the refresh-stable ~/.claude.json oauthAccount
// label (2026-06-29). The token-match below (backupMatchesLive) goes stale within
// ~1h of any Claude Code refresh, which made this refresher mis-identify the live
// account: it skipped whichever backup happened to match the live token (money@,
// freshly self-healed) and hammered the TRUE live account's (code@) dead snapshot
// with invalid_grant refreshes (failure #244 + "code refresh dead" SMS spam). The
// oauthAccount label changes only on a real switch, so it names the live account
// reliably. Mirrors creds.current_account()'s fallback.
function liveShortFromOauthLabel() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'))
    const email = cfg && cfg.oauthAccount && cfg.oauthAccount.emailAddress
    if (!email) return null
    const short = email.split('@')[0].trim().toLowerCase()
    return ACCOUNTS.includes(short) ? short : null
  } catch (_) { return null }
}

// True when this account's backup shares the live session's token lineage
// (same access token OR same refresh token). If so, Claude Code owns this
// account's refresh - we must NOT consume its single-use refresh_token.
function backupMatchesLive(oauth, live) {
  if (!live) return false
  if (oauth.accessToken && oauth.accessToken === live.accessToken) return true
  if (oauth.refreshToken && live.refreshToken && oauth.refreshToken === live.refreshToken) return true
  return false
}

// Atomic write: write to .tmp then rename over target.
function writeAccountFileAtomic(account, data) {
  const target = accountFilePath(account)
  const tmp    = target + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  fs.renameSync(tmp, target)
}

// ── main refresh logic ────────────────────────────────────────────────────────

// Refresh a single account if its token is within the threshold window.
// Throws if the HTTP call fails or returns a non-2xx status.
// On success: resets failure counter, atomically writes new tokens.
// On failure: increments failure counter; escalates to kv_store at threshold.
async function refresh_account(account, live) {
  const fileData = readAccountFile(account)
  const oauth    = fileData.claudeAiOauth

  // ACTIVE-ACCOUNT PROTECTION (2026-05-28): if this backup shares the live
  // interactive session's token lineage, Claude Code owns its refresh. OAuth-
  // refreshing here would consume the single-use refresh_token out from under
  // the live session and force a re-login. Skip - and sync the backup FROM the
  // live file so the scheduler can still rotate to a valid token. (Sync is a
  // no-op while they're identical; it matters after Claude Code self-refreshes.)
  if (live === undefined) live = readLiveCredentials()
  // Live-account identity is the refresh-stable oauthAccount label FIRST, with the
  // token-match as a secondary signal (still valid right after a sync, before the
  // next Claude Code refresh). Either makes THIS account the protected live one.
  const liveShort = liveShortFromOauthLabel()
  const isLiveByLabel = liveShort && liveShort === account
  if (isLiveByLabel || backupMatchesLive(oauth, live)) {
    _lastActiveAccount = account  // positive evidence: this account IS the live session
    if (live && live.raw && live.raw.claudeAiOauth && live.raw.claudeAiOauth.accessToken !== oauth.accessToken) {
      // Sync the backup FROM the live Keychain so the snapshot stays valid for an
      // emergency rotate. This also HEALS a snapshot whose own refresh token died
      // (the code@ invalid_grant case): the live session's token replaces it.
      writeAccountFileAtomic(account, { claudeAiOauth: live.raw.claudeAiOauth })
      console.log('[cred-refresher] synced ' + account + ' backup from live credentials (active session, identity=' + (isLiveByLabel ? 'oauthAccount' : 'token-match') + ')')
    } else {
      console.log('[cred-refresher] skipped ' + account + ' - active interactive session owns its refresh')
    }
    failureCount[account] = 0
    return
  }

  const now         = Date.now()
  const timeToExpiry = oauth.expiresAt - now

  if (timeToExpiry > REFRESH_THRESHOLD_MS) {
    // TTL is ample - no refresh needed
    return
  }

  // Token is stale or close to expiry - refresh it
  let response
  try {
    response = await postJson(
      OAUTH_REFRESH_URL,
      {},
      {
        grant_type:    'refresh_token',
        refresh_token: oauth.refreshToken,
        client_id:     OAUTH_CLIENT_ID,
      }
    )
  } catch (err) {
    await handleFailure(account, err.message)
    throw err
  }

  if (response.status < 200 || response.status >= 300) {
    // SELF-HEAL (2026-05-28): a 401/invalid_grant here often means the live
    // interactive session already rotated this account's single-use
    // refresh_token (Claude Code self-refreshed .credentials.json after our
    // last skip, so the backup's refresh_token is now spent). If the live file
    // does NOT match any OTHER account's backup, the live file IS this
    // account's session - sync the backup from it instead of escalating a
    // false "refresh failing" alarm.
    // Gate on POSITIVE prior evidence: only self-heal the account we last
    // confirmed was the live session. This avoids a false self-heal for an
    // account whose backup merely fails to match any other backup (e.g. in
    // isolated tests where live credentials are unrelated to the mocks).
    if (
      (response.status === 401 || /invalid_grant/i.test(response.body || '')) &&
      account === _lastActiveAccount
    ) {
      const liveNow = live || readLiveCredentials()
      if (liveNow && liveNow.raw && liveNow.raw.claudeAiOauth) {
        const others = ACCOUNTS.filter(a => a !== account)
        const liveMatchesOther = others.some(a => {
          try { return backupMatchesLive(readAccountFile(a).claudeAiOauth, liveNow) } catch { return false }
        })
        if (!liveMatchesOther) {
          writeAccountFileAtomic(account, { claudeAiOauth: liveNow.raw.claudeAiOauth })
          failureCount[account] = 0
          console.log('[cred-refresher] self-healed ' + account + ' backup from live credentials after 401 (live session had rotated the token)')
          return
        }
      }
    }
    const errMsg = 'HTTP ' + response.status + ' from OAuth endpoint: ' + response.body
    await handleFailure(account, errMsg)
    throw new Error(errMsg)
  }

  let parsed
  try {
    parsed = JSON.parse(response.body)
  } catch (_) {
    const errMsg = 'Non-JSON response from OAuth endpoint: ' + response.body
    await handleFailure(account, errMsg)
    throw new Error(errMsg)
  }

  // Write back - preserve scopes, subscriptionType, rateLimitTier; update tokens
  const updated = {
    claudeAiOauth: {
      accessToken:      parsed.access_token,
      refreshToken:     parsed.refresh_token,
      expiresAt:        now + (parsed.expires_in * 1000),
      scopes:           oauth.scopes,
      subscriptionType: oauth.subscriptionType,
      rateLimitTier:    oauth.rateLimitTier,
    },
  }

  writeAccountFileAtomic(account, updated)

  // Reset failure counter on success
  failureCount[account] = 0

  console.log('[cred-refresher] refreshed ' + account + ' (expires in ' + Math.round(parsed.expires_in / 60) + 'min)')
}

// Handle a failure for an account: increment counter and escalate if needed.
async function handleFailure(account, reason) {
  failureCount[account] = (failureCount[account] || 0) + 1

  console.error('[cred-refresher] failure #' + failureCount[account] + ' for ' + account + ': ' + reason)

  if (failureCount[account] >= FAILURE_ESCALATION_COUNT) {
    const key   = 'creds.refresh_failure.' + account
    const value = {
      account,
      consecutive_failures: failureCount[account],
      last_reason:          reason,
      escalated_at:         new Date().toISOString(),
    }
    try {
      await _kvWriter(key, value)
      console.error('[cred-refresher] escalated ' + account + ' failure to kv_store key ' + key)
    } catch (kvErr) {
      console.error('[cred-refresher] kv_store escalation itself failed: ' + kvErr.message)
    }
    // LOUD alarm: the kv write above is silent (and skips with no SUPABASE env).
    // SMS Tate so a dead snapshot is known immediately, not days later. The live
    // account (tate@) is never alerted here - if it is failing it IS the live
    // session and Claude Code owns its refresh; this fires for code@/money@.
    alertTateRefreshDead(account, failureCount[account], reason)
  }
}

// Run a single pass over all accounts. Reads the live credentials ONCE
// up-front and passes the snapshot to each account so the active-session
// protection (skip + sync) is consistent across the pass.
async function _runOnce() {
  const live = readLiveCredentials()
  for (const account of ACCOUNTS) {
    if (DISABLED_ACCOUNTS.has(account)) {
      // No-op + no failure count: this account is operator-paused.
      continue
    }
    try {
      await refresh_account(account, live)
    } catch (e) {
      // Error already logged and counted in refresh_account/handleFailure.
      // Continue to next account.
    }
  }
}

// ── loop (only called when run as main script) ────────────────────────────────

function start_loop() {
  const intervalStr = Math.round(REFRESH_INTERVAL_MS / 60000) + ' min'
  console.log('[cred-refresher] starting, interval=' + intervalStr + ', threshold=' + Math.round(REFRESH_THRESHOLD_MS / 60000) + 'min')
  _runOnce()
  setInterval(_runOnce, REFRESH_INTERVAL_MS)
}

// ── exports (testable seams) ──────────────────────────────────────────────────

module.exports = {
  refresh_account,
  _runOnce,
  _setKvWriter,
  // Expose config values used by tests
  _REFRESH_THRESHOLD_MS: REFRESH_THRESHOLD_MS,
}

// ── entrypoint ────────────────────────────────────────────────────────────────

if (require.main === module) {
  start_loop()

  process.on('SIGTERM', () => { console.log('[cred-refresher] SIGTERM - exiting'); process.exit(0) })
  process.on('SIGINT',  () => { console.log('[cred-refresher] SIGINT - exiting');  process.exit(0) })
}
