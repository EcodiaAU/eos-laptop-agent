'use strict'

/**
 * chat-inject-churn-retry.test.js - lane W1, 2026-08-29.
 *
 * WHY THIS EXISTS, measured rather than reasoned. Two injects at the SAME target
 * 90 seconds apart on this Mac: the first refused with
 * reason:'target_not_focused_after_select', active_label:"Claude Code" - a tab
 * that was not in the tab list 20 seconds later. The second landed on its first
 * attempt (steps clipboard/activate/select/verified/paste/submit). Same target,
 * same code, different moment.
 *
 * The cause is tab churn, not a wrong target. The scheduler opens worker tabs
 * continuously; a freshly-opened Claude Code tab is titled "Claude Code" until
 * its first turn renames it, and its arrival shifts every index after it. So a
 * single-shot select refuses for reasons unrelated to correctness, and for a
 * WAKE a refusal is simply a wake that did not happen.
 *
 * The guard itself is unchanged and must stay absolute: nothing pastes until the
 * active tab IS the target. What is tested here is that a mismatch triggers a
 * RE-RESOLVE against the live list, not a retry into the stale position.
 *
 * FAILING-FIRST RECORD, against chat-inject.js at HEAD (6f5cd0a):
 *   test 1 -> {ok:false, reason:'target_not_focused_after_select'}   (no retry at all)
 *   test 2 -> steps had no 'reselect' entry
 * Test 3 (a target that truly vanishes must still refuse) PASSED at HEAD, and is
 * kept as the control: without it, "always retry until something is focused"
 * would pass tests 1 and 2 while destroying the guard.
 */

const assert = require('assert')
const path = require('path')

const ide = require('./ide')
const applescript = require('./applescript')
const injectLock = require('./inject-lock')

const CC = 'mainThreadWebview-claudeVSCodePanel'
const TARGET = '[435f wakesubstrate lane'

function tab(label, index, isActive) {
  return { label: label, index: index, isActive: !!isActive, viewType: CC, tabId: 'ttab_' + index }
}
function groups(tabs) { return { groups: [{ viewColumn: 1, isActive: true, tabs: tabs }] } }

// Install stubs over the SAME module objects chat-inject captured at require
// time. Nothing here touches the real IDE bridge, clipboard, or window focus.
function install(tabSequence) {
  let call = 0
  const calls = { command: [], paste: 0, submit: 0, clipboard: 0, activate: 0 }
  ide.tabs = async () => {
    const i = Math.min(call++, tabSequence.length - 1)
    return groups(tabSequence[i])
  }
  ide.command = async (o) => { calls.command.push(o.cmd + (o.args ? ':' + JSON.stringify(o.args) : '')); return { ok: true } }
  ide.clipboard_write = async () => { calls.clipboard++; return { ok: true } }
  applescript.activate_app = async () => { calls.activate++; return { ok: true } }
  applescript.keystroke = async (o) => {
    if (o && o.key === 'v') calls.paste++
    else calls.submit++
    return { ok: true }
  }
  injectLock.acquire = async () => ({ ok: true, token: 't' })
  injectLock.release = () => {}
  return calls
}

// Required AFTER the stubs exist is unnecessary (it captures module objects, not
// their methods, at load), but load it once here for clarity.
const chatInject = require('./chat-inject')

const tests = []
function test(name, fn) { tests.push([name, fn]) }

test('a churn mismatch retries against the LIVE list and lands', async () => {
  // Sequence, one entry per ide.tabs() call:
  //   [0] initial resolveTabByLabel -> target at index 4
  //   [1] verifyActiveIsTarget      -> a newborn "Claude Code" tab is active
  //   [2] retry resolveTabByLabel   -> target has SHIFTED to index 5
  //   [3] verifyActiveIsTarget      -> target now active at its new index
  const calls = install([
    [tab('Take3', 0), tab(TARGET, 4), tab('other', 6)],
    [tab('Claude Code', 4, true), tab(TARGET, 5)],
    [tab('Claude Code', 4), tab(TARGET, 5)],
    [tab('Claude Code', 4), tab(TARGET, 5, true)],
  ])
  const r = await chatInject.injectTurn({ label: TARGET, viewColumn: 1, index: 4, text: 'hello', settleMs: 1 })
  assert.strictEqual(r.ok, true, 'churn refused instead of retrying: ' + JSON.stringify(r))
  assert.ok(r.steps.indexOf('reselect') !== -1, 'no re-resolve happened: ' + JSON.stringify(r.steps))
  assert.ok(r.steps.indexOf('verified') !== -1, 'pasted without verifying')
  assert.strictEqual(calls.paste, 1)
  assert.strictEqual(calls.submit, 1)
  // The retry must select the SHIFTED index (5 -> openEditorAtIndex6), never the
  // stale one it already failed on.
  assert.ok(calls.command.indexOf('workbench.action.openEditorAtIndex6') !== -1,
    'retry did not select the shifted index: ' + JSON.stringify(calls.command))
})

test('the guard is still absolute: no paste until the target is focused', async () => {
  // Every attempt sees a stranger active. This must refuse, and must never paste.
  const stranger = [tab('Claude Code', 4, true), tab(TARGET, 5)]
  const calls = install([stranger, stranger, stranger, stranger, stranger, stranger, stranger, stranger])
  const r = await chatInject.injectTurn({ label: TARGET, viewColumn: 1, index: 4, text: 'hello', settleMs: 1 })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.reason, 'target_not_focused_after_select')
  assert.strictEqual(calls.paste, 0, 'PASTED INTO A STRANGER: the guard was weakened')
  assert.strictEqual(calls.submit, 0, 'SUBMITTED INTO A STRANGER: the guard was weakened')
  assert.ok(r.attempts >= 2, 'gave up without retrying: ' + JSON.stringify(r))
})

test('a target that genuinely vanished refuses rather than taking its index', async () => {
  // THE CONTROL. This is the failure mode a naive "retry until focused" would
  // introduce: the tab is gone, something else now holds index 4, and pasting
  // into it is exactly the misroute the whole guard exists to prevent.
  const calls = install([
    [tab(TARGET, 4), tab('other', 5)],
    [tab('Claude Code', 4, true), tab('other', 5)],
    [tab('Claude Code', 4), tab('other', 5)],   // target GONE from the live list
  ])
  const r = await chatInject.injectTurn({ label: TARGET, viewColumn: 1, index: 4, text: 'hello', settleMs: 1 })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.reason, 'target_tab_gone_on_retry')
  assert.strictEqual(calls.paste, 0, 'pasted into whatever took the index')
})

test('an ambiguous label on retry refuses rather than guessing', async () => {
  const calls = install([
    [tab(TARGET, 4), tab('other', 5)],
    [tab('Claude Code', 4, true), tab(TARGET, 5)],
    [tab(TARGET, 5), tab(TARGET, 6)],   // duplicated label: no unique answer
  ])
  const r = await chatInject.injectTurn({ label: TARGET, viewColumn: 1, index: 4, text: 'hello', settleMs: 1 })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.reason, 'ambiguous_label_on_retry')
  assert.strictEqual(calls.paste, 0)
})

test('a first-try match still lands with no retry at all', async () => {
  // Regression control: the common case must not pay for the retry path.
  const ok = [tab('Take3', 0), tab(TARGET, 4, true)]
  const calls = install([ok, ok, ok, ok])
  const r = await chatInject.injectTurn({ label: TARGET, viewColumn: 1, index: 4, text: 'hello', settleMs: 1 })
  assert.strictEqual(r.ok, true, JSON.stringify(r))
  assert.strictEqual(r.steps.indexOf('reselect'), -1, 'retried when the first select was already right')
  assert.strictEqual(calls.paste, 1)
})

;(async () => {
  let pass = 0, fail = 0
  for (const [name, fn] of tests) {
    try { await fn(); pass++; console.log('PASS ' + name) }
    catch (e) { fail++; console.log('FAIL ' + name + '\n      ' + (e && e.message)) }
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed')
  process.exit(fail ? 1 : 0)
})()
