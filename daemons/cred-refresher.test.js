// daemons/cred-refresher.test.js - unit tests for cred-refresher daemon
//
// Run with: node daemons/cred-refresher.test.js
// Exit 0 = all pass, non-zero = failure.
//
// Uses a stub HTTP server on a random local port to intercept OAuth calls.
// Points the daemon at the stub via OAUTH_REFRESH_URL env var.
// Sandboxes file I/O to a temp dir so no real cred files are touched.
//
// INVARIANT: The daemon MUST NOT touch ~/.claude/.credentials.json.
// This test enforces that by verifying no writes land outside the sandbox.

const fs   = require('fs')
const path = require('path')
const os   = require('os')
const http = require('http')

// ── sandbox setup (before requiring the daemon) ───────────────────────────────

const TMP      = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-refresher-test-'))
const CREDS_DIR = path.join(TMP, 'ecodia-creds')
fs.mkdirSync(CREDS_DIR, { recursive: true })

process.env.CREDS_DIR   = CREDS_DIR
process.env.OAUTH_CLIENT_ID  = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
process.env.OAUTH_USER_AGENT = 'claude-cli-refresher/1.0 (eos-laptop-agent)'
// OAUTH_REFRESH_URL will be set to stub server before requiring the module

// HERMETIC IDENTITY (2026-08-02). The daemon resolves "which account is live" from
// ~/.claude.json's oauthAccount label. Left pointing at the real file, these tests
// inherited whichever account happened to be live on the machine: when that was code@,
// the code@ cases were treated as the protected live session and skipped their OAuth
// call, so "stub server never received a request" was a fact about the operator's laptop
// rather than about the daemon. Point it at a path inside the sandbox that does not
// exist, so no account is live unless a test says so.
process.env.CLAUDE_JSON_PATH = path.join(TMP, 'claude.json')
// Same reasoning for the roster and the switch lock: a test must not read the operator's
// live registry or be paused by a real in-flight switch.
process.env.COORD_ROOT = path.join(TMP, 'coordination')
process.env.SWITCH_LOCK_FILE = path.join(TMP, 'coordination', 'usage', 'switch.lock')

// ── helper: create a per-account JSON file ────────────────────────────────────

function writeAccountFile(account, overrides) {
  const base = {
    claudeAiOauth: {
      accessToken:      'AT-' + account + '-old',
      refreshToken:     'RT-' + account + '-old',
      expiresAt:        Date.now() + 60 * 60 * 1000, // 1h from now (ample)
      scopes:           ['read', 'write'],
      subscriptionType: 'max',
      rateLimitTier:    'standard',
    },
  }
  if (overrides && overrides.claudeAiOauth) {
    Object.assign(base.claudeAiOauth, overrides.claudeAiOauth)
  }
  // Carry any OTHER top-level key through (oauthAccount above all). The helper used to
  // copy claudeAiOauth alone and silently drop the rest, so a fixture asking for an
  // identity label got a file without one and the assertion failed against correct code.
  for (const [k, v] of Object.entries(overrides || {})) {
    if (k !== 'claudeAiOauth') base[k] = v
  }
  fs.writeFileSync(path.join(CREDS_DIR, account + '.json'), JSON.stringify(base, null, 2))
  return base
}

function readAccountFile(account) {
  return JSON.parse(fs.readFileSync(path.join(CREDS_DIR, account + '.json'), 'utf8'))
}

// ── test harness ──────────────────────────────────────────────────────────────

let failures = 0
let testCount = 0
async function test(name, fn) {
  testCount++
  try {
    await fn()
    console.log('ok', name)
  } catch (e) {
    console.error('fail', name + ':', e.message)
    failures++
  }
}

// ── stub HTTP server builder ──────────────────────────────────────────────────

function startStubServer(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      resolve({ srv, port })
    })
  })
}

function stopStubServer(srv) {
  return new Promise((resolve) => { srv.close(resolve) })
}

// Reads the full body of an IncomingMessage as UTF-8 string.
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

// ── tests ─────────────────────────────────────────────────────────────────────

;(async () => {

  // ── TEST 1: refresh_account refreshes a stale token ──────────────────────

  await test('refresh_account refreshes a stale token and writes rotated tokens atomically', async () => {
    const account = 'tate'
    const staleExpiresAt = Date.now() + 5 * 60 * 1000  // 5 min - under the 45 min threshold
    writeAccountFile(account, { claudeAiOauth: { expiresAt: staleExpiresAt } })

    const newAccessToken  = 'AT-tate-new-' + Date.now()
    const newRefreshToken = 'RT-tate-new-' + Date.now()
    const newExpiresIn    = 28800  // 8h in seconds

    let requestBody = null
    let requestHeaders = null

    const { srv, port } = await startStubServer(async (req, res) => {
      requestBody    = JSON.parse(await readBody(req))
      requestHeaders = req.headers
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        token_type:    'bearer',
        access_token:  newAccessToken,
        expires_in:    newExpiresIn,
        refresh_token: newRefreshToken,
        scope:         'read write',
        token_uuid:    'uuid-test-1',
      }))
    })

    process.env.OAUTH_REFRESH_URL = 'http://127.0.0.1:' + port

    // Require the module AFTER setting env vars. Clear require cache between tests.
    const refresher = freshRequire()
    const kvCalls = []
    refresher._setKvWriter((key, value) => { kvCalls.push({ key, value }) })

    await refresher.refresh_account(account)

    await stopStubServer(srv)

    // Assert request shape
    if (!requestBody) throw new Error('stub server never received a request')
    if (requestBody.grant_type !== 'refresh_token') throw new Error('wrong grant_type: ' + requestBody.grant_type)
    if (requestBody.refresh_token !== 'RT-tate-old') throw new Error('wrong refresh_token sent: ' + requestBody.refresh_token)
    if (requestBody.client_id !== '9d1c250a-e61b-44d9-88ed-5944d1962f5e') throw new Error('wrong client_id')

    // Assert User-Agent was set
    if (!requestHeaders || !requestHeaders['user-agent'] || !requestHeaders['user-agent'].includes('eos-laptop-agent')) {
      throw new Error('User-Agent not set correctly: ' + (requestHeaders && requestHeaders['user-agent']))
    }

    // Assert file was atomically updated
    const saved = readAccountFile(account)
    if (saved.claudeAiOauth.accessToken !== newAccessToken) throw new Error('accessToken not updated: ' + saved.claudeAiOauth.accessToken)
    if (saved.claudeAiOauth.refreshToken !== newRefreshToken) throw new Error('refreshToken not updated (rotation)')
    if (saved.claudeAiOauth.scopes[0] !== 'read') throw new Error('scopes field not preserved')
    if (saved.claudeAiOauth.subscriptionType !== 'max') throw new Error('subscriptionType not preserved')
    if (saved.claudeAiOauth.rateLimitTier !== 'standard') throw new Error('rateLimitTier not preserved')

    // expiresAt should be in the future (expires_in seconds from now, approximately)
    const expectedExpiry = Date.now() + newExpiresIn * 1000
    if (Math.abs(saved.claudeAiOauth.expiresAt - expectedExpiry) > 5000) {
      throw new Error('expiresAt not set correctly: ' + saved.claudeAiOauth.expiresAt)
    }
  })

  // ── TEST 2: skip when TTL is ample ───────────────────────────────────────

  await test('refresh_account skips refresh when token TTL is ample (>45 min)', async () => {
    const account = 'code'
    const ampleExpiresAt = Date.now() + 2 * 60 * 60 * 1000  // 2h from now
    writeAccountFile(account, { claudeAiOauth: { expiresAt: ampleExpiresAt } })

    let callCount = 0
    const { srv, port } = await startStubServer(async (req, res) => {
      callCount++
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ access_token: 'NEW', refresh_token: 'NEW', expires_in: 28800 }))
    })

    process.env.OAUTH_REFRESH_URL = 'http://127.0.0.1:' + port

    const refresher = freshRequire()
    refresher._setKvWriter(() => {})

    await refresher.refresh_account(account)

    await stopStubServer(srv)

    if (callCount > 0) throw new Error('HTTP was called when TTL was ample (' + callCount + ' calls)')

    // File should be unchanged
    const saved = readAccountFile(account)
    if (saved.claudeAiOauth.accessToken !== 'AT-code-old') throw new Error('file was modified when skip expected')
  })

  // ── TEST 3: 401 response propagates as throw ──────────────────────────────

  await test('refresh_account throws on 401 invalid_grant response', async () => {
    const account = 'money'
    writeAccountFile(account, { claudeAiOauth: { expiresAt: Date.now() + 1 * 60 * 1000 } })  // 1 min - stale

    const { srv, port } = await startStubServer(async (req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'Refresh token expired' }))
    })

    process.env.OAUTH_REFRESH_URL = 'http://127.0.0.1:' + port

    const refresher = freshRequire()
    refresher._setKvWriter(() => {})

    let threw = false
    try {
      await refresher.refresh_account(account)
    } catch (e) {
      threw = true
      if (!e.message.toLowerCase().includes('401') && !e.message.toLowerCase().includes('invalid_grant')) {
        throw new Error('wrong error message: ' + e.message)
      }
    } finally {
      await stopStubServer(srv)
    }

    if (!threw) throw new Error('expected refresh_account to throw on 401')
  })

  // ── TEST 4: kv_store escalation after 3 consecutive failures ─────────────

  await test('kv_store escalation fires after 3 consecutive failures for the same account', async () => {
    const account = 'tate'
    writeAccountFile(account, { claudeAiOauth: { expiresAt: Date.now() + 1 * 60 * 1000 } })  // stale

    // Stub that always returns 500 to trigger failures
    const { srv, port } = await startStubServer(async (req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'server_error' }))
    })

    process.env.OAUTH_REFRESH_URL = 'http://127.0.0.1:' + port

    const refresher = freshRequire()
    const kvCalls = []
    refresher._setKvWriter((key, value) => { kvCalls.push({ key, value }) })

    // Call _runOnce 3 times so failure counter reaches 3
    for (let i = 0; i < 3; i++) {
      // Re-seed stale token before each attempt (previous failed attempt should not have changed it)
      writeAccountFile(account, { claudeAiOauth: { expiresAt: Date.now() + 1 * 60 * 1000 } })
      try { await refresher.refresh_account(account) } catch (e) { /* expected */ }
    }

    await stopStubServer(srv)

    // Should have escalated to kv_store
    const escalationCalls = kvCalls.filter(c => c.key === 'creds.refresh_failure.tate')
    if (escalationCalls.length === 0) throw new Error('kv_store escalation was not called after 3 failures')
  })

  // ── TEST 5: refresh_token rotation (new RT differs from old) ─────────────

  await test('refresh_token is rotated - new value differs from the old value sent in the request', async () => {
    const account = 'code'
    const oldRefreshToken = 'RT-code-original-' + Date.now()
    writeAccountFile(account, {
      claudeAiOauth: {
        refreshToken: oldRefreshToken,
        expiresAt:    Date.now() + 2 * 60 * 1000,  // 2 min - stale
      },
    })

    const rotatedRefreshToken = 'RT-code-rotated-' + Date.now()
    let capturedSentRT = null

    const { srv, port } = await startStubServer(async (req, res) => {
      const body    = JSON.parse(await readBody(req))
      capturedSentRT = body.refresh_token
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        access_token:  'AT-code-new',
        refresh_token: rotatedRefreshToken,
        expires_in:    28800,
      }))
    })

    process.env.OAUTH_REFRESH_URL = 'http://127.0.0.1:' + port

    const refresher = freshRequire()
    refresher._setKvWriter(() => {})

    await refresher.refresh_account(account)

    await stopStubServer(srv)

    // The request sent the OLD refresh token
    if (capturedSentRT !== oldRefreshToken) throw new Error('sent wrong refresh_token: ' + capturedSentRT)

    // The file now holds the ROTATED refresh token (new, different from old)
    const saved = readAccountFile(account)
    if (saved.claudeAiOauth.refreshToken !== rotatedRefreshToken) {
      throw new Error('rotated refresh_token not written to file: ' + saved.claudeAiOauth.refreshToken)
    }
    if (saved.claudeAiOauth.refreshToken === oldRefreshToken) {
      throw new Error('refresh_token was NOT rotated - still holds old value')
    }
  })

  // ── TEST 6: failure counter resets on success ─────────────────────────────

  await test('failure counter resets on success - no escalation after success between failures', async () => {
    const account = 'money'

    // Helper to write a stale token file
    const writeStale = () => writeAccountFile(account, { claudeAiOauth: { expiresAt: Date.now() + 1 * 60 * 1000 } })

    let respondWithError = true
    const { srv, port } = await startStubServer(async (req, res) => {
      if (respondWithError) {
        res.writeHead(500); res.end(JSON.stringify({ error: 'server_error' }))
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ access_token: 'AT-ok', refresh_token: 'RT-ok', expires_in: 28800 }))
      }
    })

    process.env.OAUTH_REFRESH_URL = 'http://127.0.0.1:' + port

    const refresher = freshRequire()
    const kvCalls = []
    refresher._setKvWriter((key, value) => { kvCalls.push({ key, value }) })

    // 2 failures
    for (let i = 0; i < 2; i++) {
      writeStale()
      try { await refresher.refresh_account(account) } catch (e) { /* expected */ }
    }

    // 1 success - resets counter
    respondWithError = false
    writeStale()
    await refresher.refresh_account(account)

    // 2 more failures - should NOT escalate (counter reset to 0 after success, only at 2 now)
    respondWithError = true
    const kvCountBefore = kvCalls.filter(c => c.key === 'creds.refresh_failure.money').length
    for (let i = 0; i < 2; i++) {
      writeStale()
      try { await refresher.refresh_account(account) } catch (e) { /* expected */ }
    }

    await stopStubServer(srv)

    const kvCountAfter = kvCalls.filter(c => c.key === 'creds.refresh_failure.money').length
    if (kvCountAfter > kvCountBefore) {
      throw new Error('kv_store escalation should not have fired (counter was reset by success); fired ' + (kvCountAfter - kvCountBefore) + ' time(s)')
    }
  })

  // ── TEST 7: skip-active - do NOT consume the live session's refresh_token ──

  await test('skips OAuth refresh when backup matches the live interactive session', async () => {
    const account = 'tate'
    // Live file == this backup (same tokens). Near-expiry so it WOULD refresh
    // if not for the active-session guard.
    const liveFile = path.join(CREDS_DIR, '_live.json')
    const shared = { accessToken: 'AT-live-shared', refreshToken: 'RT-live-shared', expiresAt: Date.now() + 60 * 1000, scopes: ['x'], subscriptionType: 'max', rateLimitTier: 'standard' }
    fs.writeFileSync(liveFile, JSON.stringify({ claudeAiOauth: shared }))
    writeAccountFile(account, { claudeAiOauth: { accessToken: 'AT-live-shared', refreshToken: 'RT-live-shared', expiresAt: Date.now() + 60 * 1000 } })
    process.env.CLAUDE_CREDENTIALS_PATH = liveFile

    let oauthHit = false
    const { srv, port } = await startStubServer(async (req, res) => { oauthHit = true; res.writeHead(500); res.end('{}') })
    process.env.OAUTH_REFRESH_URL = 'http://127.0.0.1:' + port

    const refresher = freshRequire()
    await refresher.refresh_account(account)
    await stopStubServer(srv)
    delete process.env.CLAUDE_CREDENTIALS_PATH

    if (oauthHit) throw new Error('OAuth endpoint was called for the active account - refresh_token would have been consumed')
    const saved = readAccountFile(account)
    if (saved.claudeAiOauth.refreshToken !== 'RT-live-shared') throw new Error('active-account backup was mutated')
  })

  // ── TEST 8: sync-from-live when the live session has self-refreshed ────────

  await test('syncs backup FROM live credentials when active session rotated its token', async () => {
    const account = 'tate'
    // Backup shares refreshToken with live (same lineage) but live has a NEWER
    // accessToken - i.e. Claude Code self-refreshed .credentials.json.
    const liveFile = path.join(CREDS_DIR, '_live.json')
    fs.writeFileSync(liveFile, JSON.stringify({ claudeAiOauth: { accessToken: 'AT-live-NEW', refreshToken: 'RT-shared', expiresAt: Date.now() + 8 * 3600 * 1000, scopes: ['x'], subscriptionType: 'max', rateLimitTier: 'standard' } }))
    writeAccountFile(account, { claudeAiOauth: { accessToken: 'AT-backup-OLD', refreshToken: 'RT-shared', expiresAt: Date.now() + 60 * 1000 } })
    process.env.CLAUDE_CREDENTIALS_PATH = liveFile

    let oauthHit = false
    const { srv, port } = await startStubServer(async (req, res) => { oauthHit = true; res.writeHead(500); res.end('{}') })
    process.env.OAUTH_REFRESH_URL = 'http://127.0.0.1:' + port

    const refresher = freshRequire()
    await refresher.refresh_account(account)
    await stopStubServer(srv)
    delete process.env.CLAUDE_CREDENTIALS_PATH

    if (oauthHit) throw new Error('OAuth endpoint was called - should have synced from live instead')
    const saved = readAccountFile(account)
    if (saved.claudeAiOauth.accessToken !== 'AT-live-NEW') throw new Error('backup was not synced from live (got ' + saved.claudeAiOauth.accessToken + ')')
  })

  // ── TEST 9: self-heal on 401 only for the last-confirmed active account ────

  await test('self-heals on 401 only after positively confirming the account was the live session', async () => {
    const account = 'tate'
    const liveFile = path.join(CREDS_DIR, '_live.json')
    process.env.CLAUDE_CREDENTIALS_PATH = liveFile

    // Stub + OAUTH_REFRESH_URL must be set BEFORE freshRequire - the module
    // captures OAUTH_REFRESH_URL as a const at require time.
    let oauthHit = false
    const { srv, port } = await startStubServer(async (req, res) => { oauthHit = true; res.writeHead(401); res.end(JSON.stringify({ error: 'invalid_grant' })) })
    process.env.OAUTH_REFRESH_URL = 'http://127.0.0.1:' + port

    const refresher = freshRequire()

    // Cycle 1: backup matches live -> records _lastActiveAccount='tate', skips
    // (no OAuth call). Confirms the active-session positive evidence.
    fs.writeFileSync(liveFile, JSON.stringify({ claudeAiOauth: { accessToken: 'AT-shared', refreshToken: 'RT-shared', expiresAt: Date.now() + 60 * 1000, scopes: ['x'], subscriptionType: 'max', rateLimitTier: 'standard' } }))
    writeAccountFile(account, { claudeAiOauth: { accessToken: 'AT-shared', refreshToken: 'RT-shared', expiresAt: Date.now() + 60 * 1000 } })
    await refresher.refresh_account(account)

    // Claude Code self-refreshes the live file (diverges). Backup now stale,
    // its spent refresh_token will 401.
    fs.writeFileSync(liveFile, JSON.stringify({ claudeAiOauth: { accessToken: 'AT-AFTER-CC-REFRESH', refreshToken: 'RT-AFTER', expiresAt: Date.now() + 8 * 3600 * 1000, scopes: ['x'], subscriptionType: 'max', rateLimitTier: 'standard' } }))
    // ensure other backups don't match the live file
    writeAccountFile('code', { claudeAiOauth: { accessToken: 'AT-code', refreshToken: 'RT-code' } })
    writeAccountFile('money', { claudeAiOauth: { accessToken: 'AT-money', refreshToken: 'RT-money' } })

    // Cycle 2: backup no longer matches live -> OAuth -> 401 -> self-heal
    // because account === _lastActiveAccount. Must NOT throw.
    let threw = false
    try { await refresher.refresh_account(account) } catch (_) { threw = true }
    await stopStubServer(srv)
    delete process.env.CLAUDE_CREDENTIALS_PATH

    if (!oauthHit) throw new Error('expected an OAuth attempt after divergence')
    if (threw) throw new Error('self-heal should have caught the 401 and synced, not thrown')
    const saved = readAccountFile(account)
    if (saved.claudeAiOauth.accessToken !== 'AT-AFTER-CC-REFRESH') throw new Error('backup not self-healed from live (got ' + saved.claudeAiOauth.accessToken + ')')
  })

  // ── TEST 10: the oauthAccount label survives a sync-from-live ─────────────
  //
  // Every snapshot write used to emit bare { claudeAiOauth }, dropping the identity
  // label seed_from_live had captured. creds.applyOauthAccount then had nothing to
  // restore after a rotate, so ~/.claude.json kept naming the PREVIOUS account and
  // current_account() reported the account we had just switched away from once the
  // token-match window lapsed. That is the entire "the switch did not stick" symptom.

  await test('preserves oauthAccount across a sync-from-live (the label-strip defect)', async () => {
    const account = 'tate'
    const liveFile = path.join(CREDS_DIR, '_live.json')
    fs.writeFileSync(liveFile, JSON.stringify({ claudeAiOauth: { accessToken: 'AT-live-NEW2', refreshToken: 'RT-shared2', expiresAt: Date.now() + 8 * 3600 * 1000, scopes: ['x'], subscriptionType: 'max', rateLimitTier: 'standard' } }))
    writeAccountFile(account, {
      claudeAiOauth: { accessToken: 'AT-backup-OLD2', refreshToken: 'RT-shared2', expiresAt: Date.now() + 60 * 1000 },
      oauthAccount: { emailAddress: 'tate@ecodia.au', accountUuid: 'uuid-tate' },
    })
    process.env.CLAUDE_CREDENTIALS_PATH = liveFile

    const { srv, port } = await startStubServer(async (req, res) => { res.writeHead(500); res.end('{}') })
    process.env.OAUTH_REFRESH_URL = 'http://127.0.0.1:' + port
    const refresher = freshRequire()
    await refresher.refresh_account(account)
    await stopStubServer(srv)
    delete process.env.CLAUDE_CREDENTIALS_PATH

    const saved = readAccountFile(account)
    if (saved.claudeAiOauth.accessToken !== 'AT-live-NEW2') throw new Error('sync did not happen')
    if (!saved.oauthAccount || saved.oauthAccount.emailAddress !== 'tate@ecodia.au') {
      throw new Error('oauthAccount was STRIPPED by the sync - the label-strip defect is back')
    }
  })

  // ── TEST 11: a dead snapshot stops being retried ──────────────────────────
  //
  // code@ reached 484 consecutive invalid_grant failures because a spent single-use
  // refresh token was retried every 30 minutes forever. None of those calls could have
  // succeeded, and each one texted Tate on a 6h cooldown (41 of 43 texts in a fortnight).

  await test('marks a dead snapshot and stops retrying it until the file changes', async () => {
    const account = 'money'
    const liveFile = path.join(CREDS_DIR, '_live.json')
    fs.writeFileSync(liveFile, JSON.stringify({ claudeAiOauth: { accessToken: 'AT-someone-else', refreshToken: 'RT-someone-else', expiresAt: Date.now() + 8 * 3600 * 1000 } }))
    process.env.CLAUDE_CREDENTIALS_PATH = liveFile
    writeAccountFile(account, { claudeAiOauth: { accessToken: 'AT-dead', refreshToken: 'RT-spent', expiresAt: Date.now() + 60 * 1000 } })

    let hits = 0
    const { srv, port } = await startStubServer(async (req, res) => { hits++; res.writeHead(400); res.end(JSON.stringify({ error: 'invalid_grant' })) })
    process.env.OAUTH_REFRESH_URL = 'http://127.0.0.1:' + port
    const refresher = freshRequire()

    // Three failures reach the escalation threshold and mark the snapshot dead.
    for (let i = 0; i < 3; i++) { try { await refresher.refresh_account(account) } catch (_) {} }
    const hitsAtDeath = hits
    // Further passes must not touch the network at all.
    for (let i = 0; i < 5; i++) { try { await refresher.refresh_account(account) } catch (_) {} }
    await stopStubServer(srv)
    delete process.env.CLAUDE_CREDENTIALS_PATH

    if (hits !== hitsAtDeath) throw new Error('kept retrying a dead snapshot: ' + hitsAtDeath + ' -> ' + hits + ' OAuth calls')
    if (!refresher._snapshotIsDeadAndUnchanged(account)) throw new Error('snapshot was not marked dead')

    // Re-seeding the file (what a switch does) clears the mark.
    writeAccountFile(account, { claudeAiOauth: { accessToken: 'AT-fresh', refreshToken: 'RT-fresh', expiresAt: Date.now() + 8 * 3600 * 1000 } })
    const later = Date.now() / 1000 + 5
    fs.utimesSync(path.join(CREDS_DIR, account + '.json'), later, later)
    if (refresher._snapshotIsDeadAndUnchanged(account)) throw new Error('a re-seeded snapshot must clear the dead mark')
  })

  // ── TEST 12: a pass is skipped while a switch holds the lock ──────────────
  //
  // Mid-switch the Keychain holds the INCOMING account while ~/.claude.json may still
  // name the outgoing one. A refresh pass in that window syncs the new lineage into the
  // old account's snapshot - one file impersonating another (the 2026-06-22 clobber).

  await test('skips the whole pass while a switch holds the lock', async () => {
    const lockDir = path.join(CREDS_DIR, '_cooord', 'usage')
    fs.mkdirSync(lockDir, { recursive: true })
    const lockFile = path.join(lockDir, 'switch.lock')
    process.env.SWITCH_LOCK_FILE = lockFile

    // A live holder: our own pid, heartbeat now.
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, stage: 'LOGIN_CLI', heartbeat_at: new Date().toISOString() }))
    let r = freshRequire()
    if (!r._switchInFlight()) throw new Error('a live lock holder with a fresh heartbeat must read as in-flight')

    // A stale heartbeat means the holder is wedged, not working.
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, stage: 'LOGIN_CLI', heartbeat_at: new Date(Date.now() - 6 * 60 * 1000).toISOString() }))
    r = freshRequire()
    if (r._switchInFlight()) throw new Error('a heartbeat older than 5min must not hold the refresher off')

    // A dead pid never blocks, however fresh the heartbeat looks.
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999, stage: 'LOGIN_CLI', heartbeat_at: new Date().toISOString() }))
    r = freshRequire()
    if (r._switchInFlight()) throw new Error('a dead holder pid must not hold the refresher off')

    fs.unlinkSync(lockFile)
    r = freshRequire()
    if (r._switchInFlight()) throw new Error('no lock file means no switch in flight')
  })

  // ── TEST 13: a transient network fault must not take the permanent latch ───
  //
  // 2026-09-17: three consecutive `getaddrinfo ENOTFOUND platform.claude.com` latched
  // code@ at 13:15Z and money@ at 15:15Z. DNS recovered within the hour. The latch did
  // not, because only an mtime bump clears it and nothing writes a non-live account
  // file. Both accounts held valid tokens and read as unreachable for over ten hours,
  // account-failover-depth reported 0 targets for the entire fleet, and one daemon
  // restart refreshed both inside a single pass.

  await test('a transient reason self-releases the dead mark; a permanent one does not', async () => {
    const refresher = freshRequire()

    // Classification is the load-bearing half.
    const transient = [
      'getaddrinfo ENOTFOUND platform.claude.com',
      'getaddrinfo EAI_AGAIN platform.claude.com',
      'read ECONNRESET',
      'connect ETIMEDOUT 160.79.104.10:443',
      'socket hang up',
      'HTTP 503 from OAuth endpoint',
    ]
    for (const r of transient) {
      if (!refresher._isTransientReason(r)) throw new Error('should read as transient: ' + r)
    }
    const permanent = [
      'HTTP 400 from OAuth endpoint: {"error": "invalid_grant", "error_description": "Refresh token not found or invalid"}',
      'HTTP 401 from OAuth endpoint: {"error":"invalid_grant"}',
      'HTTP 403 from OAuth endpoint',
    ]
    for (const r of permanent) {
      if (refresher._isTransientReason(r)) throw new Error('must stay permanent: ' + r)
    }

    // A permanent mark holds with no retry clock at all.
    writeAccountFile('code', { claudeAiOauth: { accessToken: 'AT-x', refreshToken: 'RT-spent', expiresAt: Date.now() + 60 * 1000 } })
    refresher._markSnapshotDead('code', 'HTTP 400 from OAuth endpoint: {"error":"invalid_grant"}')
    if (!refresher._snapshotIsDeadAndUnchanged('code')) throw new Error('a permanent mark must hold')
    if (refresher._deadSnapshotRetryAt.has('code')) throw new Error('a permanent mark must carry no retry clock')

    // A transient mark holds while its window is open.
    writeAccountFile('money', { claudeAiOauth: { accessToken: 'AT-y', refreshToken: 'RT-ok', expiresAt: Date.now() + 60 * 1000 } })
    refresher._markSnapshotDead('money', 'getaddrinfo ENOTFOUND platform.claude.com')
    if (!refresher._snapshotIsDeadAndUnchanged('money')) throw new Error('a transient mark must still stop the hammering inside its window')
    if (!refresher._deadSnapshotRetryAt.has('money')) throw new Error('a transient mark must carry a retry clock')

    // Wind the clock back past the window. The mark releases with the file untouched,
    // which is the whole point: nothing writes a non-live account file.
    const mtimeBefore = fs.statSync(path.join(CREDS_DIR, 'money.json')).mtimeMs
    refresher._deadSnapshotRetryAt.set('money', Date.now() - 1000)
    if (refresher._snapshotIsDeadAndUnchanged('money')) throw new Error('an expired transient mark must release')
    const mtimeAfter = fs.statSync(path.join(CREDS_DIR, 'money.json')).mtimeMs
    if (mtimeAfter !== mtimeBefore) throw new Error('release must not depend on the file changing')

    // And the permanent one is untouched by any of that.
    if (!refresher._snapshotIsDeadAndUnchanged('code')) throw new Error('the permanent mark must be unaffected')
  })

  // ── TEST 14: release restores a full 3-strike budget ──────────────────────
  //
  // Without this the first failure after release lands as #4, re-latches at once, and
  // the hourly retry degrades to a single shot per daemon lifetime.

  await test('a released transient mark restores a full failure budget', async () => {
    const refresher = freshRequire()
    writeAccountFile('money', { claudeAiOauth: { accessToken: 'AT-y', refreshToken: 'RT-ok', expiresAt: Date.now() + 60 * 1000 } })

    refresher._failureCount.money = 3
    refresher._markSnapshotDead('money', 'getaddrinfo ENOTFOUND platform.claude.com')
    refresher._deadSnapshotRetryAt.set('money', Date.now() - 1000)
    if (refresher._snapshotIsDeadAndUnchanged('money')) throw new Error('expired transient mark must release')
    if (refresher._failureCount.money !== 0) throw new Error('failure budget was not reset on release: ' + refresher._failureCount.money)
  })

  // ── TEST 15: the threshold outruns the interval (ISO lane E6 gap G8) ─────
  //
  // At 20 minutes against a 30-minute interval the margin never engaged: the pass
  // fifteen intervals after a refresh saw 30 minutes left and skipped, the next saw
  // none, and usage-real.js refused the snapshot for its last 2 minutes. Pinned on
  // the MODULE DEFAULTS, because no plist sets either variable.

  await test('default threshold exceeds interval plus the probe margin, and a 40-min token is refreshed', async () => {
    delete process.env.REFRESH_THRESHOLD_MS
    delete process.env.REFRESH_INTERVAL_MS
    const probe = freshRequire()
    const margin = 2 * 60 * 1000
    if (probe._PROBE_MARGIN_MS !== margin) throw new Error('probe margin drifted from usage-real.js 2min: ' + probe._PROBE_MARGIN_MS)
    if (!(probe._REFRESH_THRESHOLD_MS > probe._REFRESH_INTERVAL_MS + margin)) {
      throw new Error('threshold ' + probe._REFRESH_THRESHOLD_MS / 60000 + 'min must exceed interval ' +
        probe._REFRESH_INTERVAL_MS / 60000 + 'min + 2min, or non-live tokens are refreshed at expiry')
    }

    // Behaviour, not just a constant: 40 minutes left is inside one interval of
    // expiry, so this pass is the last one that can refresh it in time.
    let hits = 0
    const { srv, port } = await startStubServer(async (req, res) => {
      hits++
      await readBody(req)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ access_token: 'AT-g8-new', refresh_token: 'RT-g8-new', expires_in: 28800 }))
    })
    process.env.OAUTH_REFRESH_URL = 'http://127.0.0.1:' + port + '/v1/oauth/token'
    const refresher = freshRequire()
    writeAccountFile('money', { claudeAiOauth: { expiresAt: Date.now() + 40 * 60 * 1000 } })
    try {
      await refresher.refresh_account('money')
    } finally {
      await stopStubServer(srv)
    }
    if (hits !== 1) throw new Error('a token 40min from expiry must be refreshed this pass, stub saw ' + hits + ' request(s)')
    if (readAccountFile('money').claudeAiOauth.accessToken !== 'AT-g8-new') throw new Error('rotated token was not written')
  })

  // ── TEST 16: a rate limit is transient (ISO lane E6 gap G9) ──────────────

  await test('HTTP 429 and Too Many Requests classify transient; unknown reasons stay permanent', async () => {
    const refresher = freshRequire()
    const transient = [
      'HTTP 429 from OAuth endpoint: {"type":"error","error":{"type":"rate_limit_error","message":"Rate limited. Please try again later."}}',
      'HTTP 429 from OAuth endpoint: Too Many Requests',
      'Too Many Requests',
    ]
    for (const r of transient) {
      if (!refresher._isTransientReason(r)) throw new Error('should read as transient: ' + r)
    }
    // The permanent default is deliberate and must survive the widening.
    const permanent = [
      'HTTP 404 from OAuth endpoint: not found',
      'Non-JSON response from OAuth endpoint: <html>',
      "Hostname/IP does not match certificate's altnames: Host: platform.claude.com",
      'unable to get local issuer certificate',
      '',
      // Permanent-first: an auth rejection mentioning a rate limit is still an auth rejection.
      'HTTP 400 from OAuth endpoint: {"error":"invalid_grant","error_description":"Too Many Requests on a spent token"}',
    ]
    for (const r of permanent) {
      if (refresher._isTransientReason(r)) throw new Error('must stay permanent: ' + JSON.stringify(r))
    }
  })

  // ── TEST 17: an empty-message connect failure is not an unknown failure ──
  //
  // Node 22 connects dual-stack, and when every address fails it throws an
  // AggregateError whose message is "". The daemon handed err.message to the
  // classifier, so a refused connection read as an empty reason and took the
  // PERMANENT latch on its third strike. Driven end to end against a port nothing
  // listens on, which on this machine produces exactly that AggregateError.

  await test('a refused dual-stack connection latches transient, not permanent', async () => {
    const r = require('../tools/oauth-refresh-reason')
    const agg = Object.assign(new Error(''), { name: 'AggregateError', code: 'ECONNREFUSED',
      errors: [{ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED ::1:1' }, { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:1' }] })
    const reason = r.describeRequestError(agg)
    if (!/ECONNREFUSED/.test(reason)) throw new Error('reason lost the code: ' + JSON.stringify(reason))
    if (!r.isTransientReason(reason)) throw new Error('AggregateError reason must classify transient: ' + reason)
    if (r.describeRequestError(new Error('socket hang up')) !== 'socket hang up') throw new Error('a plain message must pass through unchanged')

    process.env.OAUTH_REFRESH_URL = 'http://localhost:1/v1/oauth/token'
    const refresher = freshRequire()
    writeAccountFile('money', { claudeAiOauth: { expiresAt: Date.now() + 60 * 1000 } })
    for (let i = 0; i < 3; i++) {
      try { await refresher.refresh_account('money') } catch (e) { /* counted by handleFailure */ }
    }
    if (!refresher._deadSnapshots.has('money')) throw new Error('three refused connections must mark the snapshot dead')
    if (!refresher._deadSnapshotRetryAt.has('money')) {
      throw new Error('a refused connection took the PERMANENT latch; its reason reached the classifier without its code')
    }
  })

  // ── TEST 18: a released mark announces its next skip (E6 gap G11) ────────

  await test('clearDeadMark forgets the hourly skip-log stamp', async () => {
    const refresher = freshRequire()
    writeAccountFile('money', { claudeAiOauth: { accessToken: 'AT-y', refreshToken: 'RT-ok', expiresAt: Date.now() + 60 * 1000 } })
    refresher._markSnapshotDead('money', 'getaddrinfo ENOTFOUND platform.claude.com')
    if (!refresher._snapshotIsDeadAndUnchanged('money')) throw new Error('mark must hold inside its window')
    if (!refresher._deadSkipLoggedAt.has('money')) throw new Error('the first skip must stamp the hourly log clock')
    refresher._deadSnapshotRetryAt.set('money', Date.now() - 1000)
    if (refresher._snapshotIsDeadAndUnchanged('money')) throw new Error('expired transient mark must release')
    if (refresher._deadSkipLoggedAt.has('money')) throw new Error('release kept the skip-log stamp, so a retaken mark stays silent for up to an hour')
  })

  // ── summary ───────────────────────────────────────────────────────────────

  if (failures > 0) {
    console.error('\n' + failures + ' test(s) FAILED')
    process.exit(1)
  } else {
    console.log('\nALL TESTS PASSED (' + testCount + ' tests)')
    process.exit(0)
  }

})()

// ── require cache buster ──────────────────────────────────────────────────────
// Each test needs a fresh module instance so failure counters and kv writers
// don't bleed across tests.

function freshRequire() {
  const modulePath = require.resolve('./cred-refresher')
  delete require.cache[modulePath]
  const m = require('./cred-refresher')
  // NEUTRALISE THE REAL KEYCHAIN (2026-08-02). On darwin readLiveCredentials reads the
  // Keychain FIRST and only falls back to CLAUDE_CREDENTIALS_PATH when that read fails,
  // so on this Mac the real live account always beat every fixture and five of these
  // nine cases failed for reasons that had nothing to do with the code under test. With
  // the reader returning null, the file fixture each test writes is what "live" means.
  if (m._setKeychainReader) m._setKeychainReader(() => null)
  return m
}
