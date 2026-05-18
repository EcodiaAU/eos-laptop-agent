// usage.test.js - unit tests for the picker algorithm.
//
// Run with: node tools/usage.test.js
// Exit code 0 = all pass, non-zero = failure.
//
// Tests the deterministic core (pickAccount) by mocking the on-disk state file.

const fs = require('fs')
const path = require('path')
const os = require('os')

// Sandbox accounts.json + active_account.json into a temp dir to avoid clobbering
// real state. We do this BEFORE requiring usage.js so the paths bind cleanly.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-test-'))
const FAKE_COORD = path.join(TMP, 'coordination')
fs.mkdirSync(path.join(FAKE_COORD, 'usage'), { recursive: true })
fs.mkdirSync(path.join(FAKE_COORD, 'workers'), { recursive: true })

// Monkey-patch the COORD_ROOT before usage.js binds it. The cleanest way is
// to swap process.cwd / a constant; easier path: write to the real default
// substrate but in our own keys. For purity we proxy file ops:
const realReadFileSync = fs.readFileSync
const realWriteFileSync = fs.writeFileSync
const realMkdirSync = fs.mkdirSync
const realRenameSync = fs.renameSync
const realAppendFileSync = fs.appendFileSync
const realReaddirSync = fs.readdirSync
const realStatSync = fs.statSync

const REAL_COORD = 'D:\\.code\\EcodiaOS\\coordination'
function reroute(p) {
  if (typeof p !== 'string') return p
  if (p.startsWith(REAL_COORD)) return p.replace(REAL_COORD, FAKE_COORD)
  return p
}
fs.readFileSync = function(p, ...rest) { return realReadFileSync(reroute(p), ...rest) }
fs.writeFileSync = function(p, ...rest) { return realWriteFileSync(reroute(p), ...rest) }
fs.mkdirSync = function(p, ...rest) { return realMkdirSync(reroute(p), ...rest) }
fs.renameSync = function(a, b, ...rest) { return realRenameSync(reroute(a), reroute(b), ...rest) }
fs.appendFileSync = function(p, ...rest) { return realAppendFileSync(reroute(p), ...rest) }
fs.readdirSync = function(p, ...rest) {
  try { return realReaddirSync(reroute(p), ...rest) } catch (e) {
    if (e.code === 'ENOENT') return []
    throw e
  }
}
fs.statSync = function(p, ...rest) { return realStatSync(reroute(p), ...rest) }

const usage = require('./usage')

// ── helpers ──────────────────────────────────────────────────────────────

let failures = 0
function assertEq(actual, expected, msg) {
  if (actual === expected) {
    console.log('  PASS:', msg)
  } else {
    console.log('  FAIL:', msg, '-- expected', expected, 'got', actual)
    failures++
  }
}
function assertTrue(cond, msg) { assertEq(!!cond, true, msg) }

function seedState(accounts, activeAccount) {
  const payload = {
    polled_at: new Date().toISOString(),
    active_account: activeAccount || 'money@ecodia.au',
    accounts: accounts,
  }
  fs.writeFileSync(path.join(REAL_COORD, 'usage', 'accounts.json'), JSON.stringify(payload, null, 2), 'utf8')
}

const CAP_5H = 220_000_000
const CAP_WEEKLY = 1_000_000_000

function mkAcct(t5h, tWeekly) {
  return {
    tokens_5h: t5h,
    tokens_weekly: tWeekly,
    sessions_5h: 1,
    sessions_weekly: 1,
    last_polled_at: new Date().toISOString(),
    remaining_5h: Math.max(0, CAP_5H - t5h),
    remaining_weekly: Math.max(0, CAP_WEEKLY - tWeekly),
    headroom_5h_fraction: Math.max(0, CAP_5H - t5h) / CAP_5H,
    headroom_weekly_fraction: Math.max(0, CAP_WEEKLY - tWeekly) / CAP_WEEKLY,
    headroom_score: Math.min(
      Math.max(0, CAP_5H - t5h) / CAP_5H,
      Math.max(0, CAP_WEEKLY - tWeekly) / CAP_WEEKLY
    ),
    cap_5h: CAP_5H,
    cap_weekly: CAP_WEEKLY,
  }
}

// ── tests ────────────────────────────────────────────────────────────────

console.log('TEST 1: picker chooses highest headroom when all fresh')
seedState({
  'tate@ecodia.au': mkAcct(10_000_000, 50_000_000),   // 95% / 95%
  'code@ecodia.au': mkAcct(50_000_000, 100_000_000),  // 77% / 90%
  'money@ecodia.au': mkAcct(5_000_000, 30_000_000),   // 97% / 97%  <- best
})
let r = usage._pickAccount({ estimated_tokens: 0 })
assertEq(r.account, 'money@ecodia.au', 'picks money@ when it has highest headroom')
assertTrue(r.score > 0, 'score is positive')

console.log('TEST 2: picker excludes named account')
r = usage._pickAccount({ estimated_tokens: 0, exclude: ['money@ecodia.au'] })
assertEq(r.account, 'tate@ecodia.au', 'picks tate@ when money@ excluded (tate@ has more remaining than code@)')

console.log('TEST 3: picker honours buffer factor (0.85)')
// Construct scenario where account A has 100M remaining (both windows),
// account B has 90M. With buffer: A=85M, B=76.5M. Pick A.
// Estimated=80M. A: 85M - 80M = 5M (positive). B: 76.5M - 80M = -3.5M (negative).
// Picker should still pick A (highest score).
seedState({
  'tate@ecodia.au': mkAcct(CAP_5H - 100_000_000, CAP_WEEKLY - 100_000_000),  // 100M remaining each
  'code@ecodia.au': mkAcct(CAP_5H - 90_000_000, CAP_WEEKLY - 90_000_000),    // 90M remaining each
  'money@ecodia.au': mkAcct(CAP_5H, CAP_WEEKLY),                              // 0 remaining (capped)
})
r = usage._pickAccount({ estimated_tokens: 80_000_000 })
assertEq(r.account, 'tate@ecodia.au', 'buffer-aware picker picks tate@ (most headroom)')
assertTrue(r.score > 0, 'buffer-applied score positive for A')

console.log('TEST 4: estimate exceeds even best account -> still returns it but flags reason')
seedState({
  'tate@ecodia.au': mkAcct(CAP_5H - 1_000_000, CAP_WEEKLY - 1_000_000),  // 1M remaining
  'code@ecodia.au': mkAcct(CAP_5H, CAP_WEEKLY),                          // capped
  'money@ecodia.au': mkAcct(CAP_5H, CAP_WEEKLY),                         // capped
})
r = usage._pickAccount({ estimated_tokens: 50_000_000 })  // way more than headroom
assertEq(r.account, 'tate@ecodia.au', 'returns best-of-bad-options')
assertTrue(r.score < 0, 'score is negative (estimate exceeds buffered headroom)')
assertTrue(r.reason.includes('insufficient'), 'reason flags insufficient')

console.log('TEST 5: no state yet (poll never ran) returns null')
fs.writeFileSync(path.join(REAL_COORD, 'usage', 'accounts.json'), JSON.stringify({}, null, 2))
r = usage._pickAccount({ estimated_tokens: 0 })
assertEq(r.account, null, 'returns null when no state')
assertTrue(r.reason.includes('no-state'), 'reason flags no-state')

console.log('TEST 6: all accounts excluded -> null')
seedState({
  'tate@ecodia.au': mkAcct(10_000_000, 50_000_000),
  'code@ecodia.au': mkAcct(50_000_000, 100_000_000),
  'money@ecodia.au': mkAcct(5_000_000, 30_000_000),
})
r = usage._pickAccount({
  estimated_tokens: 0,
  exclude: ['tate@ecodia.au', 'code@ecodia.au', 'money@ecodia.au'],
})
assertEq(r.account, null, 'returns null when all excluded')

console.log('TEST 7: alert detection - current account low')
seedState({
  'tate@ecodia.au': mkAcct(10_000_000, 50_000_000),
  'code@ecodia.au': mkAcct(10_000_000, 50_000_000),
  'money@ecodia.au': mkAcct(CAP_5H * 0.9, CAP_WEEKLY * 0.9),  // 10% remaining, BELOW 20% threshold
}, 'money@ecodia.au')
let alerts = usage._computeAlerts()
assertTrue(alerts.current_account_low, 'current (money@) flagged low')
assertTrue(!alerts.all_low, 'all_low is false (only money@ is low)')

console.log('TEST 8: alert detection - all low')
seedState({
  'tate@ecodia.au': mkAcct(CAP_5H * 0.9, CAP_WEEKLY * 0.9),
  'code@ecodia.au': mkAcct(CAP_5H * 0.9, CAP_WEEKLY * 0.9),
  'money@ecodia.au': mkAcct(CAP_5H * 0.9, CAP_WEEKLY * 0.9),
}, 'money@ecodia.au')
alerts = usage._computeAlerts()
assertTrue(alerts.all_low, 'all_low is true')
assertEq(alerts.accounts_low.length, 3, '3 accounts flagged low')

console.log('TEST 9: tiebreak determinism (KNOWN_ACCOUNTS order)')
// All three identical state -> first KNOWN_ACCOUNTS entry wins (tate@).
const equal = mkAcct(10_000_000, 50_000_000)
seedState({
  'tate@ecodia.au': equal,
  'code@ecodia.au': equal,
  'money@ecodia.au': equal,
})
r = usage._pickAccount({ estimated_tokens: 0 })
assertEq(r.account, 'tate@ecodia.au', 'tiebreak goes to first in KNOWN_ACCOUNTS (deterministic)')

console.log('TEST 10: candidates list returned for observability')
seedState({
  'tate@ecodia.au': mkAcct(10_000_000, 50_000_000),
  'code@ecodia.au': mkAcct(50_000_000, 100_000_000),
  'money@ecodia.au': mkAcct(5_000_000, 30_000_000),
})
r = usage._pickAccount({ estimated_tokens: 0 })
assertEq(r.candidates.length, 3, '3 candidates returned')
assertTrue(r.candidates.every(c => typeof c.score === 'number'), 'all candidates have score')

console.log('TEST 11: flaky account excluded from picker within TTL')
// Reset flaky state by writing empty.
fs.writeFileSync(path.join(REAL_COORD, 'usage', 'flaky.json'), JSON.stringify({}, null, 2))
seedState({
  'tate@ecodia.au': mkAcct(10_000_000, 50_000_000),   // 95%/95% normally wins
  'code@ecodia.au': mkAcct(50_000_000, 100_000_000),  // 77%/90%
  'money@ecodia.au': mkAcct(150_000_000, 500_000_000),// 32%/50%
})
// Mark tate@ flaky -> code@ should win (next-highest non-flaky)
usage._markFlaky('tate@ecodia.au', 'test-spawn-fail')
r = usage._pickAccount({ estimated_tokens: 0 })
assertEq(r.account, 'code@ecodia.au', 'picks code@ when tate@ is flaky')
assertTrue(r.flaky_excluded.includes('tate@ecodia.au'), 'flaky_excluded reports the flaky account')

console.log('TEST 12: ignore_flaky escape hatch overrides flaky exclusion')
r = usage._pickAccount({ estimated_tokens: 0, ignore_flaky: true })
assertEq(r.account, 'tate@ecodia.au', 'picks tate@ when ignore_flaky=true (override)')

console.log('TEST 13: all-flaky returns null with explanatory reason')
usage._markFlaky('code@ecodia.au', 'test-fail')
usage._markFlaky('money@ecodia.au', 'test-fail')
r = usage._pickAccount({ estimated_tokens: 0 })
assertEq(r.account, null, 'returns null when all accounts flaky')
assertTrue(r.reason.includes('flaky'), 'reason mentions flaky')

console.log('TEST 14: clearFlaky removes a flag')
usage._clearFlaky('tate@ecodia.au')
const f = usage._activeFlakySet()
assertTrue(!f.has('tate@ecodia.au'), 'tate@ no longer in active flaky set')
assertTrue(f.has('code@ecodia.au'), 'code@ still flaky')
// Clean up so subsequent test runs start fresh
usage._clearFlaky('code@ecodia.au')
usage._clearFlaky('money@ecodia.au')

// ── summary ──────────────────────────────────────────────────────────────

if (failures > 0) {
  console.log('\n' + failures + ' TEST(S) FAILED')
  process.exit(1)
} else {
  console.log('\nALL TESTS PASSED')
  process.exit(0)
}
