// tools/usage-real-403.test.js
//
// Regression guard for the 401/403 conflation fixed 2026-08-26.
//
// probeAccount treated 401 and 403 as the same thing ("on a snapshot this means the stored
// lineage is dead"). They are not the same. money@ecodia.au sat at 277 consecutive failures
// reading as a dead snapshot while its access token was FRESH: cred-refresher had renewed it
// minutes earlier with 7.7h of validity left. The live body was an org-policy block,
// error_code oauth_not_allowed_for_organization, which no re-login can clear. Six days of
// signal pointed at a credential that was never broken, and account-switch.sh --dry kept
// answering "preflight clean" because dry only checks local preconditions and never
// exercises the forbidden OAuth flow.
//
// The invariant: a 403 must name the real cause on the row. A 401 must NOT inherit it.
const path = require('path')
const ur = require(path.join(__dirname, 'usage-real.js'))

const ORG_403 = JSON.stringify({
  type: 'error',
  error: {
    type: 'permission_error',
    message: 'OAuth authentication is currently not allowed for this organization.',
    details: { error_visibility: 'user_facing', error_code: 'oauth_not_allowed_for_organization' },
  },
})

let failed = 0
const ok = (c, n) => { console.log((c ? '  PASS: ' : '  FAIL: ') + n); if (!c) failed++ }

;(async () => {
  const now = Date.now()
  console.log('-- 403 is an org policy block, not a dead token --')
  ur._setKeychainReader(() => JSON.stringify({ claudeAiOauth: { accessToken: 'x', expiresAt: now + 3600e3 } }))

  ur._setFetch(async () => ({ status: 403, headers: {}, body: ORG_403 }))
  const org = await ur.probeAccount('tate', { nowMs: now, liveShort: 'tate' })
  ok(org.probe_status === 'http_403', 'org-policy 403 still reports probe_status http_403')
  ok(!!org.probe_reason, 'org-policy 403 sets a probe_reason (the old code set none)')
  ok(/org policy/i.test(org.probe_reason || ''), 'probe_reason names ORG POLICY as the cause')
  ok(/re-login CANNOT fix/i.test(org.probe_reason || ''), 'probe_reason says a re-login cannot fix it')

  ur._setFetch(async () => ({ status: 401, headers: {}, body: '{}' }))
  const dead = await ur.probeAccount('tate', { nowMs: now, liveShort: 'tate' })
  ok(dead.probe_status === 'http_401', '401 still reports http_401')
  ok(!dead.probe_reason, '401 (a genuinely dead token) does NOT inherit the org-policy reason')

  ur._setFetch(async () => ({ status: 403, headers: {}, body: '{"nope":1}' }))
  const other = await ur.probeAccount('tate', { nowMs: now, liveShort: 'tate' })
  ok(/NOT a dead token/i.test(other.probe_reason || ''), 'a 403 of unknown shape still says it is not a dead token')

  ur._setFetch(null); ur._setKeychainReader(null)
  console.log(failed ? '\nFAILED ' + failed : '\nALL TESTS PASSED')
  process.exit(failed ? 1 : 0)
})()
