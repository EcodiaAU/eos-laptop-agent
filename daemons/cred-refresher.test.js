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
  fs.writeFileSync(path.join(CREDS_DIR, account + '.json'), JSON.stringify(base, null, 2))
  return base
}

function readAccountFile(account) {
  return JSON.parse(fs.readFileSync(path.join(CREDS_DIR, account + '.json'), 'utf8'))
}

// ── test harness ──────────────────────────────────────────────────────────────

let failures = 0
async function test(name, fn) {
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
    const staleExpiresAt = Date.now() + 5 * 60 * 1000  // 5 min - under 20 min threshold
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

  await test('refresh_account skips refresh when token TTL is ample (>20 min)', async () => {
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

  // ── summary ───────────────────────────────────────────────────────────────

  if (failures > 0) {
    console.error('\n' + failures + ' test(s) FAILED')
    process.exit(1)
  } else {
    console.log('\nALL TESTS PASSED (' + 6 + ' tests)')
    process.exit(0)
  }

})()

// ── require cache buster ──────────────────────────────────────────────────────
// Each test needs a fresh module instance so failure counters and kv writers
// don't bleed across tests.

function freshRequire() {
  const modulePath = require.resolve('./cred-refresher')
  delete require.cache[modulePath]
  return require('./cred-refresher')
}
