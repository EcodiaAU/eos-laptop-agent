// daemons/cred-refresher.js
//
// Proactively refreshes per-account Claude OAuth tokens every 30 minutes so
// they never expire while the scheduler is mid-dispatch. Access tokens last
// 8 hours; refreshing every 30 min is conservative and safe.
//
// ============================================================
// INVARIANT - DO NOT REMOVE THIS COMMENT:
//   This daemon reads and writes ONLY to D:/PRIVATE/ecodia-creds/{account}.json.
//   It MUST NEVER read, write, or watch ~/.claude/.credentials.json.
//   That file is owned exclusively by tools/creds.js::rotate_to (Phase 1).
//   Any change that causes this daemon to touch .credentials.json is a bug.
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
try {
  require('dotenv').config({ path: 'D:/PRIVATE/ecodia-creds/supabase.env' })
} catch (_) {
  // dotenv missing or file absent - env vars may still be set by PM2
}

const fs   = require('fs')
const path = require('path')
const http  = require('http')
const https = require('https')

// ── config ────────────────────────────────────────────────────────────────────

const ACCOUNTS = ['tate', 'code', 'money']

const CREDS_DIR          = process.env.CREDS_DIR          || 'D:/PRIVATE/ecodia-creds'
const OAUTH_REFRESH_URL  = process.env.OAUTH_REFRESH_URL  || 'https://platform.claude.com/v1/oauth/token'
const OAUTH_CLIENT_ID    = process.env.OAUTH_CLIENT_ID    || '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const OAUTH_USER_AGENT   = process.env.OAUTH_USER_AGENT   || 'claude-cli-refresher/1.0 (eos-laptop-agent)'
const REFRESH_INTERVAL_MS   = Number(process.env.REFRESH_INTERVAL_MS)   || 30 * 60 * 1000
const REFRESH_THRESHOLD_MS  = Number(process.env.REFRESH_THRESHOLD_MS)  || 20 * 60 * 1000
const FAILURE_ESCALATION_COUNT = 3

// ── failure counter (per-account, resets on success) ─────────────────────────

const failureCount = { tate: 0, code: 0, money: 0 }

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
async function refresh_account(account) {
  const fileData = readAccountFile(account)
  const oauth    = fileData.claudeAiOauth

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
  }
}

// Run a single pass over all accounts.
async function _runOnce() {
  for (const account of ACCOUNTS) {
    try {
      await refresh_account(account)
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
