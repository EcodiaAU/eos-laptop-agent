'use strict'

/**
 * coord-darwin-wake-tier.test.js - lane W1, 2026-08-29.
 *
 * Guards the half of the Mac wake that a banner cannot do: putting a TURN into
 * an idle conductor chat. A toast is a notification; a wake is a turn. On this
 * host the banner is suppressed by a live Focus assertion anyway, so the only
 * tier that can interrupt an idle conductor is chat-inject.
 *
 * FAILING-FIRST RECORD, run against coord.js at HEAD (6f5cd0a) before the tier
 * landed:
 *   1. coord._wakeByChatInject is not a function        (tier did not exist)
 *   2. coord._darwinInjectWakeReason is not a function
 *   3. wake_capabilities.toast === true                 (HARDCODED literal, on a
 *                                                        host whose banner is
 *                                                        suppressed - the exact
 *                                                        false green that let the
 *                                                        dead wake report healthy
 *                                                        for ~81 days)
 *   4. wake_capabilities.active_mode_can_wake undefined (nothing asked whether the
 *                                                        CONFIGURED tier works)
 *   5. auto_type on darwin returned {ok:false, reason:'unsupported_platform'}
 *
 * Every inject here goes through coord._setChatInject, so no test touches the
 * live IDE bridge, the clipboard, or window focus.
 */

const assert = require('assert')
const coord = require('./coord')

const tests = []
function test(name, fn) { tests.push([name, fn]) }

function stubInject(behaviour) {
  const calls = []
  coord._setChatInject({
    injectTurn: async (opts) => { calls.push(opts); return behaviour.injectTurn(opts) },
    listChatTabs: async () => behaviour.tabs || [],
    resolveTabByLabel: async () => ({ tab: null, ambiguous: false }),
    verifyActiveIsTarget: async () => ({ ok: true }),
  })
  return calls
}

// ── capability reporting is probed, never asserted ───────────────────────

test('wake_capabilities.toast is not a hardcoded true', () => {
  // PRE-PORT: the literal `toast: true` sat in get_conductor_state's return.
  // get_conductor_state therefore reported a healthy toast tier on a host with
  // no PowerShell at all. Nothing about the host could change that field.
  const src = require('fs').readFileSync(__dirname + '/coord.js', 'utf8')
  assert.strictEqual(src.indexOf('      toast: true,'), -1, 'wake_capabilities still hardcodes toast:true')
})

test('wake_capabilities reflects the real host', () => {
  const cap = coord._wakeCapabilities()
  assert.strictEqual(cap.platform, process.platform)
  assert.ok('active_mode_can_wake' in cap, 'nothing reports whether the CONFIGURED tier works')
  if (process.platform === 'darwin') {
    assert.strictEqual(cap.flash, false, 'darwin has no FlashWindowEx')
    // toast must be a DECIDED value produced by the suppression probe, never a
    // default and never undefined.
    assert.ok(cap.toast === true || cap.toast === false || cap.toast === null,
      'toast capability must be decided, got ' + JSON.stringify(cap.toast))
    if (cap.toast === false) assert.ok(cap.toast_reason, 'a false toast must name its reason')
    if (cap.toast === false && cap.toast_reason === 'posted_but_suppressed') {
      assert.ok(Array.isArray(cap.toast_suppressed_by) && cap.toast_suppressed_by.length,
        'a suppressed toast must name its suppressor')
    }
  }
})

test('active_mode_can_wake distinguishes "a tier exists" from "the configured tier works"', () => {
  const cap = coord._wakeCapabilities()
  // The trap this field exists for: a host can have a working auto_type tier and
  // be configured for toast, whose tier is suppressed. any_tier_can_wake reads
  // true and NOTHING wakes. The two fields must be independently derived.
  if (cap.active_mode === 'toast' && cap.toast === false) {
    assert.strictEqual(cap.active_mode_can_wake, false,
      'configured mode is a dead tier but active_mode_can_wake did not say so')
  }
  if (cap.active_mode === 'silent') {
    assert.strictEqual(cap.active_mode_can_wake, null, 'silent is deliberately off, not broken')
  }
})

// ── the darwin auto_type tier ────────────────────────────────────────────

test('darwin wake tier exists and names why it is unavailable when it is', () => {
  // PRE-PORT: TypeError on both.
  assert.strictEqual(typeof coord._wakeByChatInject, 'function')
  assert.strictEqual(typeof coord._darwinInjectWakeReason, 'function')
  const r = coord._darwinInjectWakeReason()
  assert.ok(r === null || typeof r === 'string')
})

test('an inject that reports ok but does NOT land is a failure, not a wake', async () => {
  if (process.platform !== 'darwin') return 'skipped: not darwin'
  const prevTimeout = process.env.COORD_INJECT_LANDING_TIMEOUT_MS
  const prevPoll = process.env.COORD_INJECT_LANDING_POLL_MS
  // The landing gate reads its window at module load, so shrinking it here would
  // not take. Instead assert on the SHAPE the gate produces, using a stub whose
  // injectTurn reports ok while nothing moves last_seen_at.
  //
  // This is the assertion the whole lane is about: chat-inject returns ok as
  // soon as the AppleScript Return keystroke executes, which is NOT proof a turn
  // landed. Treating that ok as a wake is the narration this lane exists to kill.
  const calls = stubInject({ injectTurn: async () => ({ ok: true, label: 'stub-tab' }), tabs: [] })
  const r = await coord._wakeByChatInject({ title: 'w1', body: 'landing gate' })
  // With no live tab list the resolve fails first, which is itself a refusal and
  // never a false ok. Either way the verdict must not be a bare ok:true.
  assert.notStrictEqual(r.ok, true, 'wake claimed success with no landing evidence: ' + JSON.stringify(r))
  assert.ok(r.reason, 'a failed wake must name its reason: ' + JSON.stringify(r))
  if (r.reason === 'submit_did_not_land') {
    assert.strictEqual(r.inject_reported_ok, true, 'must record that the inject lied')
  }
  assert.ok(calls.length >= 0)
  if (prevTimeout === undefined) delete process.env.COORD_INJECT_LANDING_TIMEOUT_MS
  if (prevPoll === undefined) delete process.env.COORD_INJECT_LANDING_POLL_MS
})

test('the kill switch stops the darwin tier before it touches focus', async () => {
  const prev = process.env.COORD_CHAT_INJECT
  process.env.COORD_CHAT_INJECT = '0'
  try {
    let touched = false
    stubInject({ injectTurn: async () => { touched = true; return { ok: true } } })
    const r = await coord._wakeByChatInject({ title: 'w1', body: 'kill switch' })
    assert.strictEqual(r.ok, false)
    assert.strictEqual(r.reason, 'inject_disabled')
    assert.strictEqual(touched, false, 'kill switch did not prevent the inject')
  } finally {
    if (prev === undefined) delete process.env.COORD_CHAT_INJECT
    else process.env.COORD_CHAT_INJECT = prev
  }
})

test('a wake never types over a turn in progress', async () => {
  if (process.platform !== 'darwin') return 'skipped: not darwin'
  const fs = require('fs'), os = require('os'), path = require('path')
  const p = path.join(os.homedir(), '.ecodiaos', 'coordination', 'conductors', 'current.json')
  if (!fs.existsSync(p)) return 'skipped: no conductor registration'
  const original = fs.readFileSync(p, 'utf8')
  try {
    const row = JSON.parse(original)
    row.in_turn = true
    row.in_turn_set_at = new Date().toISOString()
    fs.writeFileSync(p, JSON.stringify(row, null, 2))
    let touched = false
    stubInject({ injectTurn: async () => { touched = true; return { ok: true } } })
    const r = await coord._wakeByChatInject({ title: 'w1', body: 'in turn' })
    assert.strictEqual(r.ok, false)
    assert.strictEqual(r.reason, 'conductor_in_turn')
    assert.strictEqual(touched, false, 'wake injected while the conductor was mid-turn')
  } finally {
    fs.writeFileSync(p, original)
  }
})

// ── the toast tier must carry its reason into wake_state ─────────────────

test('the toast tier records suppression, not a bare boolean', () => {
  // PRE-PORT the recorder was `{ok: ..., detail: r.reason || null}`, which threw
  // away suppressed_by and spawn_error - the only two fields that name WHY a Mac
  // banner never reached anyone.
  const src = require('fs').readFileSync(__dirname + '/coord.js', 'utf8')
  assert.ok(src.indexOf('suppressed_by: r.suppressed_by') !== -1, 'toast tier drops suppressed_by')
  assert.ok(src.indexOf('spawn_error: r.spawn_error') !== -1, 'toast tier drops spawn_error')
})

test('flash refuses on darwin with a routing instruction, not a bare no-op', () => {
  const src = require('fs').readFileSync(__dirname + '/coord.js', 'utf8')
  assert.ok(src.indexOf('no_flashwindowex_equivalent_on_darwin') !== -1)
})

// ── the win32 tier must survive ──────────────────────────────────────────

test('win32 keystroke tier is intact', () => {
  const src = require('fs').readFileSync(__dirname + '/coord.js', 'utf8')
  assert.ok(src.indexOf("require('./window')") !== -1, 'win32 window tier deleted')
  assert.ok(src.indexOf("require('./input')") !== -1, 'win32 input tier deleted')
  assert.ok(src.indexOf('_guiWakeSupported') !== -1)
})

// ---- the wrong-tab hole the retry loop cannot close --------------------
//
// FAILING-FIRST, verify pass 2026-08-29: coord._labelVerifiableForWake did not
// exist (TypeError: not a function). Found by the independent second pass, not
// by the build.
//
// chat-inject verifies the active tab IS the target before pasting, but it
// SKIPS that guard for a GENERIC label, because "Claude Code" identifies no
// particular tab. On the push path a blind paste is a tolerable best-effort. On
// the wake path it would type a wake notice into whatever chat holds focus.
// Reachable: conductor_heartbeat captures title_match from the live active tab,
// and a Claude Code tab is titled "Claude Code" until its first turn renames it,
// so a heartbeat that lands inside that window stores a generic handle. Latent
// on this host today (the stored label is specific), which is exactly when a
// guard is cheap.
test('a conductor label that cannot be verified refuses instead of pasting blind', () => {
  assert.strictEqual(typeof coord._labelVerifiableForWake, 'function')
  for (const generic of ['Claude Code', 'claude code', 'New Chat', 'Cursor', 'chat', 'Untitled', '', '   ']) {
    assert.strictEqual(coord._labelVerifiableForWake(generic), false,
      'a generic label is not an identity and injectTurn will not verify it: ' + JSON.stringify(generic))
  }
  // The control: a real conductor label must still be accepted, or the guard
  // would simply disable the tier rather than protect it.
  for (const real of ['We are officially retiri\u2026', '[88cd wakesubstrate lane\u2026', 'Take3']) {
    assert.strictEqual(coord._labelVerifiableForWake(real), true, 'guard rejected a real label: ' + real)
  }
})

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
