// creds.test.js - unit tests for cred-rotation module
//
// Run with: node tools/creds.test.js
// Exit 0 = all pass, non-zero = failure.
//
// Sandboxes into temp dirs. Env vars CREDS_DIR and CLAUDE_CREDENTIALS_PATH
// must be set BEFORE requiring creds.js so the module reads them at load time.
//
// REGRESSION GUARD: monkey-patch fs.watch BEFORE requiring creds.js so any
// accidental watcher introduced in the module causes the final test to fail.
// This guards against reintroducing the refresh-clobber-watchdog pattern.

const fs = require('fs')
const path = require('path')
const os = require('os')

// ── fs.watch regression guard (must be first, before require('./creds')) ────
const watchCalls = []
const realFsWatch = fs.watch
fs.watch = function (filename) {
  watchCalls.push(String(filename))
  return realFsWatch.apply(fs, arguments)
}

// ── sandbox setup ────────────────────────────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'creds-test-'))
const CREDS_DIR = path.join(TMP, 'ecodia-creds')
fs.mkdirSync(CREDS_DIR, { recursive: true })
process.env.CREDS_DIR = CREDS_DIR

const CLAUDE_DIR = path.join(TMP, 'claude')
fs.mkdirSync(CLAUDE_DIR, { recursive: true })
process.env.CLAUDE_CREDENTIALS_PATH = path.join(CLAUDE_DIR, '.credentials.json')

// Sandbox ~/.claude.json so current_account()'s oauthAccount fallback (the
// 2026-06-29 refresh-stable identity source) reads a fixture, never the
// operator's real account label. Seed it to code@ so the fallback is testable.
process.env.CLAUDE_JSON_PATH = path.join(CLAUDE_DIR, 'claude.json')
fs.writeFileSync(process.env.CLAUDE_JSON_PATH, JSON.stringify({ oauthAccount: { emailAddress: 'code@ecodia.au' } }))

// ── seed three account files ─────────────────────────────────────────────────
const TATE = { claudeAiOauth: { accessToken: 'AT-tate', refreshToken: 'RT-tate', expiresAt: 9999999999000 } }
const CODE = { claudeAiOauth: { accessToken: 'AT-code', refreshToken: 'RT-code', expiresAt: 9999999999000 } }
const MONEY = { claudeAiOauth: { accessToken: 'AT-money', refreshToken: 'RT-money', expiresAt: 9999999999000 } }
fs.writeFileSync(path.join(CREDS_DIR, 'tate.json'), JSON.stringify(TATE))
fs.writeFileSync(path.join(CREDS_DIR, 'code.json'), JSON.stringify(CODE))
fs.writeFileSync(path.join(CREDS_DIR, 'money.json'), JSON.stringify(MONEY))

// ── usage mock (matches the injection-seam interface creds.js expects) ───────
// get_usage_state(account) -> { headroom_minutes, reset_at }
const usageMock = {
  states: {
    tate:  { headroom_minutes: 200, reset_at: '2026-05-26T23:00:00Z' },
    code:  { headroom_minutes: 100, reset_at: '2026-05-26T22:00:00Z' },
    money: { headroom_minutes: 50,  reset_at: '2026-05-27T00:00:00Z' },
  },
  get_usage_state(account) { return this.states[account] },
}

// ── require after env + patch ─────────────────────────────────────────────────
const creds = require('./creds')
creds._setUsageSource(usageMock)

// ── test harness ─────────────────────────────────────────────────────────────
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

// ── pick_healthiest_account tests ─────────────────────────────────────────────

;(async () => {

  await test('pick_healthiest_account returns tate when it has most headroom', async () => {
    const pick = await creds.pick_healthiest_account({})
    if (pick !== 'tate') throw new Error('expected tate, got ' + pick)
  })

  await test('pick_healthiest_account honours preferred when above threshold', async () => {
    const pick = await creds.pick_healthiest_account({ preferred: 'code' })
    if (pick !== 'code') throw new Error('expected code (preferred), got ' + pick)
  })

  await test('pick_healthiest_account RETAINS preferred through a transient dip (2026-06-29)', async () => {
    // A busy live account routinely dips below the 15-min worker threshold but
    // stays well above the 2-min retention floor. It must be retained, not
    // clobbered onto another account (the recurring code@ -> money@ switch).
    usageMock.states.money.headroom_minutes = 5
    const pick = await creds.pick_healthiest_account({ preferred: 'money', required_headroom_minutes: 15 })
    usageMock.states.money.headroom_minutes = 50  // restore
    if (pick !== 'money') throw new Error('expected money (retained through dip), got ' + pick)
  })

  await test('pick_healthiest_account falls back from preferred only when near-exhausted', async () => {
    usageMock.states.money.headroom_minutes = 1  // below the 2-min retention floor
    const pick = await creds.pick_healthiest_account({ preferred: 'money', required_headroom_minutes: 15 })
    usageMock.states.money.headroom_minutes = 50  // restore
    if (pick !== 'tate') throw new Error('expected tate (fallback when preferred exhausted), got ' + pick)
  })

  await test('pick_healthiest_account throws AllAccountsCappedError when none have headroom', async () => {
    usageMock.states.tate.headroom_minutes = 5
    usageMock.states.code.headroom_minutes = 5
    usageMock.states.money.headroom_minutes = 5
    let threw = false
    try {
      await creds.pick_healthiest_account({ required_headroom_minutes: 15 })
    } catch (e) {
      threw = true
      if (e.name !== 'AllAccountsCappedError') throw new Error('wrong error name: ' + e.name)
      if (!e.resets || typeof e.resets !== 'object') throw new Error('error missing resets object')
    } finally {
      usageMock.states.tate.headroom_minutes = 200  // restore
      usageMock.states.code.headroom_minutes = 100
      usageMock.states.money.headroom_minutes = 50
    }
    if (!threw) throw new Error('should have thrown AllAccountsCappedError')
  })

  // ── rotate_to tests ──────────────────────────────────────────────────────

  await test('rotate_to copies the right account file to claude credentials path', async () => {
    if (creds.USE_KEYCHAIN) { console.log('  (skip on darwin: rotate_to writes the Keychain, not the file path)'); return }
    await creds.rotate_to('code')
    const content = JSON.parse(fs.readFileSync(process.env.CLAUDE_CREDENTIALS_PATH, 'utf8'))
    if (content.claudeAiOauth.accessToken !== 'AT-code') {
      throw new Error('wrong account written: ' + content.claudeAiOauth.accessToken)
    }
  })

  await test('rotate_to is atomic - corrupted .tmp does not leak', async () => {
    if (creds.USE_KEYCHAIN) { console.log('  (skip on darwin: rotate_to writes the Keychain, not the file path)'); return }
    // Write a corrupted .tmp file; rotate_to must overwrite it atomically
    fs.writeFileSync(process.env.CLAUDE_CREDENTIALS_PATH + '.tmp', 'CORRUPT')
    await creds.rotate_to('tate')
    const content = JSON.parse(fs.readFileSync(process.env.CLAUDE_CREDENTIALS_PATH, 'utf8'))
    if (content.claudeAiOauth.accessToken !== 'AT-tate') {
      throw new Error('partial write leaked through: ' + content.claudeAiOauth.accessToken)
    }
  })

  // rotate_to is TOMBSTONED as of 2026-08-02: snapshot-to-Keychain writes are banned and
  // switching is a full OAuth re-login (scripts/switch-run.js). These two cases used to
  // assert that it THREW on a bad input; the contract is now that it never switches
  // anything and returns a pointer at the real path. It returns rather than throws so a
  // missed caller degrades to a no-op instead of taking a daemon down mid-poll.

  await test('rotate_to is tombstoned: it never rotates, whatever it is asked', async () => {
    const r = await creds.rotate_to('eve')
    if (!r.tombstoned) throw new Error('expected a tombstone response')
    if (!r.no_rotation) throw new Error('a tombstoned rotate_to must report no_rotation')
    if (!/account-switch\.sh/.test(r.use || '')) throw new Error('the tombstone must name the real switch path')
  })

  await test('rotate_to touches nothing even with a missing per-account file', async () => {
    const tatePath = path.join(process.env.CREDS_DIR, 'tate.json')
    const backup = fs.readFileSync(tatePath)
    const before = creds.current_account()
    fs.unlinkSync(tatePath)
    try {
      const r = await creds.rotate_to('tate')
      if (!r.tombstoned) throw new Error('expected a tombstone response')
      if (creds.current_account() !== before) throw new Error('the live account moved: a tombstone must be inert')
    } finally {
      fs.writeFileSync(tatePath, backup)
    }
  })

  await test('rotate_to keeps the current-process no-op contract (callers rely on it not throwing)', async () => {
    const r = await creds.rotate_to({ account: 'current-process' })
    if (!r.no_rotation || r.current !== 'current-process') throw new Error('current-process contract broken: ' + JSON.stringify(r))
  })

  // ── current_account tests ────────────────────────────────────────────────

  await test('current_account identifies account by matching access token', async () => {
    if (creds.USE_KEYCHAIN) { console.log('  (skip on darwin: live token is in the Keychain, not the file fixture)'); return }
    await creds.rotate_to('tate')
    const acct = creds.current_account()
    if (acct !== 'tate') throw new Error('expected tate, got ' + acct)
  })

  await test('current_account falls back to oauthAccount label when token match fails (2026-06-29)', async () => {
    // The refresh-stable identity source: token rotates ~hourly so the snapshot
    // match goes stale, but ~/.claude.json oauthAccount stays put. Fixture seeds
    // code@; the resolver must return 'code' regardless of platform/keychain.
    if (creds._currentAccountFromOauthLabel() !== 'code') {
      throw new Error('expected code from oauthAccount fallback, got ' + creds._currentAccountFromOauthLabel())
    }
    // And the public current_account() returns it too when no token matches.
    if (creds.current_account() !== 'code') {
      throw new Error('expected code from current_account(), got ' + creds.current_account())
    }
  })

  await test('current_account returns unknown when no token match and no oauth label', async () => {
    if (creds.USE_KEYCHAIN) { console.log('  (skip on darwin: cannot clear the shared Keychain blob from a test)'); return }
    const credPath = process.env.CLAUDE_CREDENTIALS_PATH
    const jsonPath = process.env.CLAUDE_JSON_PATH
    const credBackup = fs.readFileSync(credPath)
    const jsonBackup = fs.readFileSync(jsonPath)
    fs.unlinkSync(credPath)
    fs.unlinkSync(jsonPath)  // remove both identity sources
    const acct = creds.current_account()
    fs.writeFileSync(credPath, credBackup)  // restore
    fs.writeFileSync(jsonPath, jsonBackup)
    if (acct !== 'unknown') throw new Error('expected unknown, got ' + acct)
  })

  // ── regression guard ─────────────────────────────────────────────────────

  // THE PIN MOVED (2026-08-02). It used to be enforced inside rotate_to, described as the
  // single force-proof chokepoint because rotate_to owned the only writeKeychain call
  // site. That stopped being true once account-switch.sh started writing the Keychain
  // directly via `claude auth login`, which is why the pin had to be re-implemented in
  // the shell wrapper as a second, differently-parsed check. rotate_to is now tombstoned
  // and switch-run.js PREFLIGHT is the one chokepoint, using the shared parsePin so both
  // pin formats mean the same thing everywhere. The pin's own behaviour is asserted in
  // tools/switch-core.js --selftest (legacy string, JSON, expired, and pin-names-target).
  // What matters HERE is only that rotate_to can no longer move the live account at all,
  // pin or no pin.
  await test('ACCOUNT PIN: rotate_to cannot move the live account under any input (enforcement moved to switch-run PREFLIGHT)', async () => {
    const pinPath = creds._accountPinPath()
    fs.mkdirSync(require("path").dirname(pinPath), { recursive: true })
    fs.writeFileSync(pinPath, "code")
    const before = creds.current_account()
    try {
      const forced = await creds.rotate_to({ account: "money", force: true })
      if (!forced.tombstoned) throw new Error("force did not hit the tombstone: " + JSON.stringify(forced))
      if (creds.current_account() !== before) throw new Error("the live account moved despite the tombstone")
    } finally { try { fs.unlinkSync(pinPath) } catch (_) {} }
  })

  await test('REGRESSION: creds module never calls fs.watch', async () => {
    if (watchCalls.length > 0) {
      throw new Error(
        'fs.watch was called for: ' + watchCalls.join(', ') +
        '. This is the refresh-clobber-watchdog regression. Remove the watcher from creds.js.'
      )
    }
  })

  // ── summary ──────────────────────────────────────────────────────────────

  if (failures > 0) {
    console.error('\n' + failures + ' test(s) FAILED')
    process.exit(1)
  } else {
    console.log('\nALL TESTS PASSED (' + 10 + ' tests)')
    process.exit(0)
  }

})()
