#!/usr/bin/env node
// daemons/refresh-clobber-watchdog.js
//
// Watches ~/.claude/.credentials.json for mtime changes. When the file mutates
// OUTSIDE of an active swap_lock window (i.e. CC's OAuth refresh wrote new
// tokens), we cross-check:
//   - kv_store-like: active_account.json says we should be loaded on account X
//   - sha of file content matches the X backup at ~/.ecodia-creds/X.json?
//
// THREE possible outcomes per detected mutation:
//   (a) During-swap: the swap.lock file exists. Ignore (normal swap_creds op).
//   (b) Post-refresh-clean: file changed, no lock. Re-sha + compare against the
//       active_account's backup. If still a near-match (account NOT swapped),
//       update our backup with the new refreshed token + log a maintenance
//       event. This is the common case: CC silently refreshed our access token,
//       we capture the new one for future swaps.
//   (c) Refresh-clobber: file changed, no lock, AND the new content does NOT
//       match active_account's backup (we asked for X but file holds Y's
//       signature). Restore from backup, log a warning, send a coord message
//       to chat.conductor.inbox.
//
// "Signature match" = best-effort: the OAuth-refresh path only rotates the
// accessToken + (optionally) refreshToken. Other identity bits (account-bound
// scopes, identity claims if they appear) stay. For v1 we use a shallow check:
//   - parse the JSON
//   - take claudeAiOauth.scopes (if present), email/account identifier,
//     organization, etc. as a "stable identity signature"
//   - compare to backup
//
// If JSON parse fails or shape is unexpected, default to (c) Refresh-clobber
// (safer to restore than to silently accept).
//
// Watch mechanism:
//   - fs.watch on ~/.claude/ for change events on .credentials.json
//   - Debounce 250ms (the file write is atomic but fs.watch can fire twice)
//   - Re-process on each change

const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const http = require('http')

const COORD_ROOT = 'D:\\.code\\EcodiaOS\\coordination'
const CREDENTIALS_DIR = path.join(os.homedir(), '.claude')
const CREDENTIALS_FILE = path.join(CREDENTIALS_DIR, '.credentials.json')
const CREDS_BACKUP_DIR = path.join(os.homedir(), '.ecodia-creds')
const ACTIVE_ACCOUNT_FILE = path.join(COORD_ROOT, 'active_account.json')
const SWAP_LOCK_FILE = path.join(COORD_ROOT, 'locks', 'swap.lock')
const WATCHDOG_LOG_FILE = path.join(COORD_ROOT, 'usage', 'refresh_clobber_audit.jsonl')
const WATCHDOG_HEARTBEAT_FILE = path.join(COORD_ROOT, 'usage', 'watchdog.heartbeat')
const COORD_URL = process.env.COORD_URL || 'http://localhost:7456'

const DEBOUNCE_MS = 300
const SWAP_LOCK_GRACE_MS = 2_000  // tolerate lock file lingering 2s post-release

function nowIso() { return new Date().toISOString() }
function sha256Hex(buf) { return crypto.createHash('sha256').update(buf).digest('hex') }

function ensureDirs() {
  for (const d of [path.dirname(WATCHDOG_LOG_FILE), CREDS_BACKUP_DIR]) {
    try { fs.mkdirSync(d, { recursive: true }) } catch (e) {}
  }
}

function logEvent(entry) {
  try {
    fs.appendFileSync(WATCHDOG_LOG_FILE, JSON.stringify({ ts: nowIso(), ...entry }) + '\n', 'utf8')
  } catch (e) {}
}

function writeHeartbeat(payload) {
  try {
    fs.writeFileSync(WATCHDOG_HEARTBEAT_FILE, JSON.stringify({ ts: nowIso(), pid: process.pid, ...payload }, null, 2), 'utf8')
  } catch (e) {}
}

function readJsonSafe(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch (e) { return fallback }
}

function currentActiveAccount() {
  const row = readJsonSafe(ACTIVE_ACCOUNT_FILE, null)
  return (row && row.account) || null
}

function swapLockHeld() {
  if (!fs.existsSync(SWAP_LOCK_FILE)) return false
  try {
    const stat = fs.statSync(SWAP_LOCK_FILE)
    return (Date.now() - stat.mtimeMs) < (60_000 + SWAP_LOCK_GRACE_MS)
  } catch (e) {
    return false
  }
}

// Extract a stable identity signature from the creds JSON. Refresh rotates
// accessToken (+ sometimes refreshToken), but identity claims, scopes, and
// organization metadata stay stable per-account.
function identitySignature(buf) {
  try {
    const j = JSON.parse(buf.toString('utf8'))
    const oauth = j.claudeAiOauth || {}
    const sig = {
      scopes: oauth.scopes || null,
      // The access/refresh tokens are the prefix string up to the first "-" -
      // include just the first 16 chars of refresh token (its prefix is
      // account-stable across refreshes of access-only).
      refreshTokenPrefix: typeof oauth.refreshToken === 'string' ? oauth.refreshToken.slice(0, 24) : null,
      organizationName: oauth.organizationName || null,
      organizationUuid: oauth.organizationUuid || null,
      accountUuid: oauth.accountUuid || null,
      email: oauth.email || null,
    }
    return sha256Hex(Buffer.from(JSON.stringify(sig)))
  } catch (e) {
    return null
  }
}

function backupSigFor(account) {
  const backupPath = path.join(CREDS_BACKUP_DIR, account + '.json')
  if (!fs.existsSync(backupPath)) return null
  try {
    return { sig: identitySignature(fs.readFileSync(backupPath)), path: backupPath }
  } catch (e) {
    return null
  }
}

// Send a coord message via POST /api/tool { tool: "coord.send_message", ... }
// (best-effort - swallow on failure; the watchdog also writes a local audit log).
function postCoordMessage(body) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      tool: 'coord.send_message',
      params: {
        to: 'chat.conductor.inbox',
        body: body,
      },
    })
    let token = ''
    try { token = fs.readFileSync(path.join(os.homedir(), '.ecodiaos', 'laptop-agent.token'), 'utf8').trim() } catch (e) {}
    const u = require('url').parse(COORD_URL + '/api/tool')
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.path, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...(token ? { 'Authorization': 'Bearer ' + token } : {}),
      },
      timeout: 3000,
    }, res => {
      let chunks = ''; res.on('data', c => chunks += c); res.on('end', () => resolve({ ok: res.statusCode === 200, body: chunks }))
    })
    req.on('error', () => resolve({ ok: false, error: 'request_error' }))
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }) })
    req.write(payload)
    req.end()
  })
}

// Restore the current loaded creds from the backup of the expected account.
function restoreFromBackup(account) {
  const backupPath = path.join(CREDS_BACKUP_DIR, account + '.json')
  if (!fs.existsSync(backupPath)) {
    return { ok: false, error: 'no backup at ' + backupPath }
  }
  try {
    const credsDir = path.dirname(CREDENTIALS_FILE)
    const tmpPath = path.join(credsDir, '.credentials.json.watchdog-restore-' + process.pid + '-' + Date.now())
    fs.copyFileSync(backupPath, tmpPath)
    fs.renameSync(tmpPath, CREDENTIALS_FILE)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

// Update the backup with the new refreshed creds (refresh-clean case).
function updateBackupFromCurrent(account) {
  const backupPath = path.join(CREDS_BACKUP_DIR, account + '.json')
  try {
    const tmpPath = backupPath + '.tmp-' + process.pid + '-' + Date.now()
    fs.copyFileSync(CREDENTIALS_FILE, tmpPath)
    fs.renameSync(tmpPath, backupPath)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

// State for change-handling
let lastHandledSha = null
let lastHandledMs = 0

async function handleChange() {
  ensureDirs()
  // Read current file
  let buf
  try { buf = fs.readFileSync(CREDENTIALS_FILE) } catch (e) {
    logEvent({ event: 'read_failed', error: e.message }); return
  }
  const sha = sha256Hex(buf)
  if (sha === lastHandledSha) return  // duplicate fs.watch event
  lastHandledSha = sha
  lastHandledMs = Date.now()

  // (a) During-swap: ignore
  if (swapLockHeld()) {
    logEvent({ event: 'change_during_swap', new_sha: sha })
    return
  }

  const currentSig = identitySignature(buf)
  const active = currentActiveAccount()
  if (!active) {
    logEvent({ event: 'no_active_account_seeded', new_sha: sha })
    return
  }
  const backupInfo = backupSigFor(active)

  // No backup yet -> seed it (first-run path)
  if (!backupInfo) {
    const r = updateBackupFromCurrent(active)
    logEvent({ event: 'seed_backup_first_run', account: active, new_sha: sha, seed_ok: r.ok, error: r.error })
    return
  }

  // (b) Refresh-clean: signature still matches -> CC just rotated tokens
  if (currentSig && backupInfo.sig === currentSig) {
    const r = updateBackupFromCurrent(active)
    logEvent({ event: 'refresh_clean_backup_updated', account: active, new_sha: sha, update_ok: r.ok, error: r.error })
    return
  }

  // (c) Refresh-clobber: signature mismatch. We asked for X, file holds Y.
  // Restore from X's backup.
  const restore = restoreFromBackup(active)
  logEvent({
    event: 'refresh_clobber_detected',
    expected_account: active,
    observed_sig: currentSig,
    expected_sig: backupInfo.sig,
    new_sha: sha,
    restore_ok: restore.ok,
    restore_error: restore.error,
  })
  // Surface to conductor inbox
  await postCoordMessage({
    type: 'refresh_clobber_warning',
    source: 'refresh-clobber-watchdog',
    expected_account: active,
    restore_ok: restore.ok,
    restore_error: restore.error,
    detail: 'Loaded .credentials.json drifted from active_account=' + active + '. ' + (restore.ok ? 'Restored from backup.' : 'Restore FAILED: ' + restore.error),
  })
}

function start() {
  ensureDirs()
  console.log('[' + nowIso() + '] refresh-clobber-watchdog starting, watching ' + CREDENTIALS_FILE)
  writeHeartbeat({ event: 'started' })

  if (!fs.existsSync(CREDENTIALS_FILE)) {
    console.error('credentials file does not exist: ' + CREDENTIALS_FILE)
    process.exit(1)
  }

  // Debounce wrapper
  let debounceTimer = null
  const onChange = () => {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      handleChange().catch(e => logEvent({ event: 'handle_change_threw', error: e.message }))
    }, DEBOUNCE_MS)
  }

  // Watch the directory rather than the file directly (fs.watch on files is
  // unreliable when files are atomic-renamed over - the watch detaches).
  // Filter events to the .credentials.json filename.
  const watcher = fs.watch(CREDENTIALS_DIR, { persistent: true }, (evt, filename) => {
    if (filename === '.credentials.json') onChange()
  })

  watcher.on('error', e => {
    logEvent({ event: 'watcher_error', error: e.message })
    console.error('watcher error: ' + e.message)
  })

  // Heartbeat every 60s
  setInterval(() => writeHeartbeat({ event: 'alive', last_handled_sha: lastHandledSha, last_handled_ms: lastHandledMs }), 60_000)

  // Initial state-capture (in case the file is already in a state we should know about)
  // Don't trigger restore on startup - just log current sha.
  try {
    const sha = sha256Hex(fs.readFileSync(CREDENTIALS_FILE))
    lastHandledSha = sha
    lastHandledMs = Date.now()
    logEvent({ event: 'initial_capture', new_sha: sha, active: currentActiveAccount() })
  } catch (e) {}
}

process.on('SIGTERM', () => { writeHeartbeat({ shutdown: 'SIGTERM' }); process.exit(0) })
process.on('SIGINT', () => { writeHeartbeat({ shutdown: 'SIGINT' }); process.exit(0) })

start()
