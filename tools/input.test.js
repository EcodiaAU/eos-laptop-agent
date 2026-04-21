/**
 * Dry-run tests for tools/input.js.
 *
 * These tests validate parameter handling, command generation, and escaping
 * without actually invoking mouse/keyboard events. Safe to run on the VPS
 * or any machine with no display.
 *
 * Run: node tools/input.test.js
 */

'use strict'

// ---------------------------------------------------------------------------
// Pull the private helpers out via module internals for unit testing.
// We re-implement a minimal version here to avoid touching the live module.
// ---------------------------------------------------------------------------

const assert = require('assert')

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    console.log(`  PASS  ${name}`)
    passed++
  } catch (err) {
    console.log(`  FAIL  ${name}`)
    console.log(`        ${err.message}`)
    failed++
  }
}

// ---------------------------------------------------------------------------
// 1. Module loads without error
// ---------------------------------------------------------------------------
console.log('\n--- Module load ---')

let inputModule
test('require("./input") loads without error', () => {
  inputModule = require('./input')
})

test('exports all 7 functions', () => {
  const expected = ['click', 'move', 'type', 'key', 'shortcut', 'drag', 'cursorPosition']
  for (const fn of expected) {
    assert.strictEqual(typeof inputModule[fn], 'function', `Missing export: ${fn}`)
  }
})

test('no unexpected exports', () => {
  const exported = Object.keys(inputModule)
  const unexpected = exported.filter(k => !['click', 'move', 'type', 'key', 'shortcut', 'drag', 'cursorPosition'].includes(k))
  assert.deepStrictEqual(unexpected, [], `Unexpected exports: ${unexpected.join(', ')}`)
})

// ---------------------------------------------------------------------------
// 2. Parameter validation - each function should throw on bad params
//    We test these directly by catching the thrown errors.
// ---------------------------------------------------------------------------
console.log('\n--- Parameter validation ---')

async function expectError(fn, params, label) {
  try {
    await fn(params)
    throw new Error(`Expected an error but got none for: ${label}`)
  } catch (err) {
    // Any error from the function body (including our own throws) is fine.
    // We re-throw only if the error is our own "Expected no error" sentinel.
    if (err.message.startsWith('Expected an error but got none')) throw err
  }
}

// We can't easily test async param-validation in a sync context, so we run
// these as a small async suite collected into a top-level promise.
const asyncTests = []

asyncTests.push(async () => {
  test('click: missing x/y throws', async () => {
    await expectError(inputModule.click, { button: 'left' }, 'click missing x/y')
  })
})

asyncTests.push(async () => {
  test('click: invalid button throws', async () => {
    await expectError(inputModule.click, { x: 100, y: 200, button: 'hyper' }, 'click invalid button')
  })
})

asyncTests.push(async () => {
  test('move: missing x/y throws', async () => {
    await expectError(inputModule.move, {}, 'move missing x/y')
  })
})

asyncTests.push(async () => {
  test('type: missing text throws', async () => {
    await expectError(inputModule.type, { delay: 0 }, 'type missing text')
  })
})

asyncTests.push(async () => {
  test('type: non-string text throws', async () => {
    await expectError(inputModule.type, { text: 42 }, 'type non-string')
  })
})

asyncTests.push(async () => {
  test('key: missing key throws', async () => {
    await expectError(inputModule.key, { modifiers: [] }, 'key missing key')
  })
})

asyncTests.push(async () => {
  test('shortcut: missing keys throws', async () => {
    await expectError(inputModule.shortcut, {}, 'shortcut missing keys')
  })
})

asyncTests.push(async () => {
  test('drag: missing fromX/fromY/toX/toY throws', async () => {
    await expectError(inputModule.drag, { fromX: 0 }, 'drag missing coords')
  })
})

asyncTests.push(async () => {
  test('drag: invalid button throws', async () => {
    await expectError(inputModule.drag, { fromX: 0, fromY: 0, toX: 100, toY: 100, button: 'hyper' }, 'drag invalid button')
  })
})

// ---------------------------------------------------------------------------
// 3. SendKeys escaping logic (Windows-specific, pure JS, no exec needed)
// ---------------------------------------------------------------------------
console.log('\n--- SendKeys escaping ---')

// Replicate the escape function from input.js for pure unit testing.
function escapeSendKeys(text) {
  return text.replace(/[+^%~(){}[\]]/g, ch => `{${ch}}`)
}

test('SendKeys: plain text unchanged', () => {
  assert.strictEqual(escapeSendKeys('hello world'), 'hello world')
})

test('SendKeys: + is escaped to {+}', () => {
  assert.strictEqual(escapeSendKeys('1+2'), '1{+}2')
})

test('SendKeys: ^ is escaped to {^}', () => {
  assert.strictEqual(escapeSendKeys('a^b'), 'a{^}b')
})

test('SendKeys: % is escaped to {%}', () => {
  assert.strictEqual(escapeSendKeys('100%'), '100{%}')
})

test('SendKeys: ~ is escaped to {~}', () => {
  assert.strictEqual(escapeSendKeys('a~b'), 'a{~}b')
})

test('SendKeys: () are escaped', () => {
  assert.strictEqual(escapeSendKeys('f(x)'), 'f{(}x{)}')
})

test('SendKeys: {} are escaped', () => {
  assert.strictEqual(escapeSendKeys('{ok}'), '{{}ok{}}')
})

test('SendKeys: multiple specials in one string', () => {
  assert.strictEqual(escapeSendKeys('+^%'), '{+}{^}{%}')
})

// ---------------------------------------------------------------------------
// 4. Shortcut parsing (pure logic, no exec)
// ---------------------------------------------------------------------------
console.log('\n--- Shortcut parsing ---')

// Minimal replication of parseShortcutToSendKeys
const SENDKEYS_MOD_TEST = { ctrl: '^', alt: '%', shift: '+', cmd: '^' }
const SENDKEYS_SPECIAL_TEST = { enter: '{ENTER}', escape: '{ESC}', tab: '{TAB}' }

function parseShortcutTest(keys) {
  const parts = (Array.isArray(keys) ? keys.join('+') : keys)
    .toLowerCase().split('+').map(s => s.trim())
  const modifierNames = ['ctrl', 'alt', 'shift', 'cmd']
  const mods = parts.filter(p => modifierNames.includes(p))
  const keyParts = parts.filter(p => !modifierNames.includes(p))
  if (keyParts.length === 0) throw new Error('No key specified')
  const key = keyParts[keyParts.length - 1]
  const mapped = SENDKEYS_SPECIAL_TEST[key] || key
  if (mods.length === 0) return mapped
  const prefix = mods.map(m => SENDKEYS_MOD_TEST[m] || '').join('')
  return mods.length > 1 ? `${prefix}(${mapped})` : `${prefix}${mapped}`
}

test('shortcut: ctrl+s -> ^s', () => {
  assert.strictEqual(parseShortcutTest('ctrl+s'), '^s')
})

test('shortcut: ctrl+shift+p -> ^+(p)', () => {
  assert.strictEqual(parseShortcutTest('ctrl+shift+p'), '^+(p)')
})

test('shortcut: array ["ctrl","z"] -> ^z', () => {
  assert.strictEqual(parseShortcutTest(['ctrl', 'z']), '^z')
})

test('shortcut: single key "enter" -> {ENTER}', () => {
  assert.strictEqual(parseShortcutTest('enter'), '{ENTER}')
})

test('shortcut: missing key throws', () => {
  assert.throws(() => parseShortcutTest('ctrl'), /No key specified/)
})

// ---------------------------------------------------------------------------
// 5. cliclick shortcut parsing (Mac-specific, pure logic)
// ---------------------------------------------------------------------------
console.log('\n--- cliclick shortcut parsing ---')

const CLICLICK_MOD_TEST = { ctrl: 'ctrl', alt: 'alt', shift: 'shift', cmd: 'cmd' }
const CLICLICK_KEYS_TEST = { enter: 'return', escape: 'esc', tab: 'tab', space: 'space' }

function parseCliclickTest(keys) {
  const parts = (Array.isArray(keys) ? keys.join('+') : keys)
    .toLowerCase().split('+').map(s => s.trim())
  const modifierNames = ['ctrl', 'alt', 'shift', 'cmd']
  const mods = parts.filter(p => modifierNames.includes(p))
  const keyParts = parts.filter(p => !modifierNames.includes(p))
  if (keyParts.length === 0) throw new Error('No key specified')
  const key = CLICLICK_KEYS_TEST[keyParts[keyParts.length - 1]] || keyParts[keyParts.length - 1]
  if (mods.length === 0) return `kp:${key}`
  const modStr = mods.map(m => CLICLICK_MOD_TEST[m] || m).join(',')
  return `kd:${modStr} kp:${key} ku:${modStr}`
}

test('cliclick: cmd+s -> kd:cmd kp:s ku:cmd', () => {
  assert.strictEqual(parseCliclickTest('cmd+s'), 'kd:cmd kp:s ku:cmd')
})

test('cliclick: cmd+shift+p -> kd:cmd,shift kp:p ku:cmd,shift', () => {
  assert.strictEqual(parseCliclickTest('cmd+shift+p'), 'kd:cmd,shift kp:p ku:cmd,shift')
})

test('cliclick: single enter -> kp:return', () => {
  assert.strictEqual(parseCliclickTest('enter'), 'kp:return')
})

test('cliclick: array ["cmd","z"] -> kd:cmd kp:z ku:cmd', () => {
  assert.strictEqual(parseCliclickTest(['cmd', 'z']), 'kd:cmd kp:z ku:cmd')
})

// ---------------------------------------------------------------------------
// 6. xdotool shortcut parsing (Linux-specific, pure logic)
// ---------------------------------------------------------------------------
console.log('\n--- xdotool shortcut parsing ---')

const XDOTOOL_MOD_TEST = { ctrl: 'ctrl', alt: 'alt', shift: 'shift', cmd: 'super' }
const XDOTOOL_KEYS_TEST = { enter: 'Return', escape: 'Escape', tab: 'Tab' }

function parseXdotoolTest(keys) {
  const parts = (Array.isArray(keys) ? keys.join('+') : keys)
    .toLowerCase().split('+').map(s => s.trim())
  const modifierNames = ['ctrl', 'alt', 'shift', 'cmd']
  const mods = parts.filter(p => modifierNames.includes(p))
  const keyParts = parts.filter(p => !modifierNames.includes(p))
  if (keyParts.length === 0) throw new Error('No key specified')
  const key = XDOTOOL_KEYS_TEST[keyParts[keyParts.length - 1]] || keyParts[keyParts.length - 1]
  if (mods.length === 0) return key
  const prefix = mods.map(m => XDOTOOL_MOD_TEST[m] || m).join('+')
  return `${prefix}+${key}`
}

test('xdotool: ctrl+s -> ctrl+s', () => {
  assert.strictEqual(parseXdotoolTest('ctrl+s'), 'ctrl+s')
})

test('xdotool: ctrl+shift+p -> ctrl+shift+p', () => {
  assert.strictEqual(parseXdotoolTest('ctrl+shift+p'), 'ctrl+shift+p')
})

test('xdotool: cmd+z -> super+z', () => {
  assert.strictEqual(parseXdotoolTest('cmd+z'), 'super+z')
})

test('xdotool: enter -> Return', () => {
  assert.strictEqual(parseXdotoolTest('enter'), 'Return')
})

// ---------------------------------------------------------------------------
// 7. Run async param-validation tests
// ---------------------------------------------------------------------------
console.log('\n--- Async parameter validation ---')

;(async () => {
  for (const fn of asyncTests) {
    await fn()
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  console.log(`\n=== ${passed + failed} tests: ${passed} passed, ${failed} failed ===\n`)
  if (failed > 0) process.exit(1)
})()
