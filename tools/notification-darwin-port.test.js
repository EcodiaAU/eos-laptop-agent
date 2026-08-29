'use strict'

/**
 * notification-darwin-port.test.js - the Mac wake tier, lane W1, 2026-08-29.
 *
 * FAILING-FIRST RECORD. Every assertion here was run against the PRE-PORT
 * tools/notification.js (118 lines, one spawnSync('powershell') path) before
 * the port landed, and the observed failures were:
 *
 *   1. capability is not a function                     -> capability() absent
 *   2. toast().mechanism === undefined                  -> no darwin path at all
 *   3. toast() reason === undefined, burntErr === ''    -> a failure with NO reason,
 *                                                          which is the defect: a
 *                                                          missing binary reaches
 *                                                          spawnSync's r.error and
 *                                                          never stderr, so the old
 *                                                          return value could not be
 *                                                          told apart from success
 *   4. flash_window() === {ok:false, target, count}     -> a silent no-op, no
 *                                                          unsupported_on_platform
 *   5. beep() === {ok:false}                            -> powershell spawn on a Mac
 *
 * Anything that only asserts the post-port shape would have passed on a file
 * that had never worked, so each case below names the pre-port value it caught.
 */

const assert = require('assert')
const notification = require('./notification')

const IS_MAC = process.platform === 'darwin'
const tests = []
function test(name, fn) { tests.push([name, fn]) }

// ── capability(): the surface the canary reads ───────────────────────────

test('capability() exists and reports the real platform', () => {
  // PRE-PORT: TypeError, notification.capability is not a function.
  assert.strictEqual(typeof notification.capability, 'function')
  const cap = notification.capability()
  assert.strictEqual(cap.platform, process.platform)
  for (const tier of ['toast', 'beep', 'flash_window']) {
    assert.ok(cap[tier], 'capability missing tier ' + tier)
    assert.strictEqual(typeof cap[tier].ok, 'boolean', tier + '.ok must be a decided boolean')
  }
})

test('capability() never reports ok:true with an unspawnable mechanism', () => {
  // The whole 81-day defect in one assertion: a tier may only claim ok when the
  // binary it needs is actually present on THIS host.
  const cap = notification.capability()
  const { spawnSync } = require('child_process')
  for (const tier of ['toast', 'beep', 'flash_window']) {
    const mech = cap[tier].mechanism
    if (cap[tier].ok !== true) continue
    assert.ok(mech, tier + ' claims ok with no named mechanism')
    const bin = mech === 'osascript' ? 'osascript' : (mech === 'afplay' ? 'afplay' : mech)
    const probe = spawnSync('command', ['-v', bin], { encoding: 'utf8', shell: true, timeout: 4000 })
    assert.strictEqual(probe.status, 0, tier + ' claims ok but its binary "' + bin + '" is not on PATH')
  }
})

// ── toast(): honest on a Mac ─────────────────────────────────────────────

test('toast() takes the osascript path on darwin, never powershell', async () => {
  if (!IS_MAC) return 'skipped: not darwin'
  // PRE-PORT: mechanism was undefined and mechanism_attempts was
  // ['BurntToast','NotifyIcon-balloon'] - both PowerShell, on a host with none.
  const r = await notification.toast({ title: 'w1-test', body: 'osascript path' })
  assert.strictEqual(r.mechanism, 'osascript')
  assert.ok(!r.mechanism_attempts, 'darwin toast must not report win32 attempt list')
})

test('toast() never returns a bare reasonless failure', async () => {
  // THE defect. Pre-port on this Mac the return was
  //   {ok:false, mechanism_attempts:[...], burntErr:'', balloonErr:''}
  // i.e. failed, with both error strings EMPTY, because spawnSync puts a missing
  // binary on r.error (ENOENT) and never on stderr. A failure that names nothing
  // is operationally identical to no signal, which is why nobody noticed.
  const r = await notification.toast({ title: 'w1-test', body: 'reason required' })
  if (r.ok === true) return
  const named = r.reason || r.spawn_error || r.unsupported_on_platform
  assert.ok(named, 'a failing toast MUST name why: got ' + JSON.stringify(r))
})

test('toast() reports suppression rather than claiming a banner appeared', async () => {
  if (!IS_MAC) return 'skipped: not darwin'
  // osascript exits 0 even when Focus suppresses the banner and even when the
  // posting bundle has no notification authorisation. Returning ok:true off that
  // exit code would have shipped a SECOND silent no-op with a green light.
  const r = await notification.toast({ title: 'w1-test', body: 'suppression check' })
  const focus = notification._focusState()
  if (focus.active === true) {
    assert.strictEqual(r.ok, false, 'toast claimed ok while a Focus assertion is live')
    assert.ok(Array.isArray(r.suppressed_by) && r.suppressed_by.length, 'suppressed toast must name its suppressor')
    assert.strictEqual(r.delivered_to_centre, true, 'a suppressed notification is still filed; say so')
  } else if (r.ok === true) {
    assert.strictEqual(r.verified, 'posted_no_known_suppressor')
  }
})

test('toast() cannot be broken by quotes or backslashes in title or body', async () => {
  if (!IS_MAC) return 'skipped: not darwin'
  // Data travels as argv, never concatenated into script source, so this is a
  // regression guard on that design and not merely an escaping test.
  const nasty = 'a"b\\c\'d\\\\e "with title" f'
  const r = await notification.toast({ title: nasty, body: nasty })
  assert.notStrictEqual(r.reason, 'osascript_nonzero', 'osascript failed to parse: ' + JSON.stringify(r.stderr))
  assert.notStrictEqual(r.reason, 'spawn_failed')
  assert.strictEqual(r.title, nasty, 'title must round-trip unmangled')
})

// ── flash_window(): refuse, do not pretend ───────────────────────────────

test('flash_window() refuses explicitly on darwin', async () => {
  if (!IS_MAC) return 'skipped: not darwin'
  // PRE-PORT: {ok:false, target:'(foreground)', count:3}. Indistinguishable from
  // "the window was not found", so it read as a transient miss forever.
  const r = await notification.flash_window({ titleContains: 'anything' })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.unsupported_on_platform, 'darwin')
  assert.strictEqual(r.reason, 'no_flashwindowex_equivalent_on_darwin')
  assert.ok(r.alternative, 'a refusal must route the caller somewhere that works')
})

// ── beep(): the one tier Focus does not suppress ─────────────────────────

test('beep() actually plays on darwin', async () => {
  if (!IS_MAC) return 'skipped: not darwin'
  // PRE-PORT: {ok:false} - it spawned powershell. Audio is worth having here
  // precisely because Focus suppresses banners and does not suppress afplay.
  const r = await notification.beep({})
  assert.strictEqual(r.mechanism, 'afplay')
  assert.strictEqual(r.ok, true, 'afplay failed: ' + JSON.stringify(r))
})

// ── the win32 path must survive the port ─────────────────────────────────

test('win32 paths are still present and unreachable from darwin', () => {
  const src = require('fs').readFileSync(__dirname + '/notification.js', 'utf8')
  assert.ok(src.indexOf('BurntToast') !== -1, 'win32 BurntToast path was deleted')
  assert.ok(src.indexOf('NotifyIcon') !== -1, 'win32 balloon path was deleted')
  assert.ok(src.indexOf('FlashWindowEx') !== -1, 'win32 flash path was deleted')
  assert.ok(src.indexOf("process.platform === 'win32'") !== -1, 'no platform branch')
})

// ── focus probe honesty ──────────────────────────────────────────────────

test('_focusState() reports unknown rather than guessing off', () => {
  const f = notification._focusState()
  assert.ok(f.active === true || f.active === false || f.active === null)
  if (f.active === null) {
    assert.ok(f.reason, 'unknown focus state must carry a reason')
  }
  if (f.active === true) {
    assert.ok(f.since, 'a live assertion must report when it started')
  }
})

test('_focusState() honours invalidation records', () => {
  // An assertion UUID present in BOTH the assert list and the invalidation list
  // is OVER. Reading only the assert list would report DND on forever, since
  // macOS never prunes the assert list.
  const os = require('os'), path = require('path'), fs = require('fs')
  const p = path.join(os.homedir(), 'Library', 'DoNotDisturb', 'DB', 'Assertions.json')
  if (!fs.existsSync(p)) return 'skipped: no assertions store'
  const doc = JSON.parse(fs.readFileSync(p, 'utf8'))
  const invalidated = new Set()
  const asserted = []
  for (const blk of (doc.data || [])) {
    for (const r of (blk.storeInvalidationRecords || [])) {
      const u = r && r.invalidationAssertion && r.invalidationAssertion.assertionUUID
      if (u) invalidated.add(u)
    }
    for (const r of (blk.storeAssertionRecords || [])) if (r && r.assertionUUID) asserted.push(r.assertionUUID)
  }
  const f = notification._focusState()
  // Set SIZES are not the predicate. The invalidation list retains UUIDs of
  // assertions macOS has already dropped from the assert list, so a host with
  // one live assertion and one old invalidated one has equal sizes and is still
  // in DND. The only correct test is per-UUID membership.
  const live = asserted.filter((u) => !invalidated.has(u))
  if (asserted.length > 0 && live.length === 0) {
    assert.strictEqual(f.active, false, 'every asserted UUID is invalidated, DND must read off')
  }
  if (live.length > 0) {
    assert.strictEqual(f.active, true, 'a non-invalidated assertion exists, DND must read on')
  }
})

// ── runner ───────────────────────────────────────────────────────────────

;(async () => {
  let pass = 0, fail = 0, skip = 0
  for (const [name, fn] of tests) {
    try {
      const r = await fn()
      if (typeof r === 'string' && r.startsWith('skipped')) { skip++; console.log('SKIP ' + name + ' (' + r + ')') }
      else { pass++; console.log('PASS ' + name) }
    } catch (e) {
      fail++
      console.log('FAIL ' + name + '\n      ' + (e && e.message))
    }
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed, ' + skip + ' skipped')
  process.exit(fail ? 1 : 0)
})()
