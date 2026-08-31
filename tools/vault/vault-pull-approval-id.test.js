'use strict'
/**
 * isApprovalRequestId - the guard that keeps a trace tag out of the uuid approval lookup.
 *
 * Why: public.vault_approvals.id is a uuid column and approve() looks up
 * `WHERE id = ${requestId}` before it can decide the approval does not exist, so a
 * non-uuid requestId throws Postgres 22P02 rather than returning "no such approval".
 * bank-feed-refresh-prompt.cjs deliberately sets requestId to a human trace tag
 * ('ba-cron-20260831') so a landed capture is traceable to that cron in the vault-pull
 * log and in the recon filename. Result, measured on the 2026-08-31 pull: all 8 results
 * of the bank-feed run carried
 *   approvalError: 'invalid input syntax for type uuid: "ba-cron-20260831"'
 * a permanent error that would mask a real approval failure if one ever occurred.
 *
 * The import itself was never affected (the throw is caught), which is exactly why this
 * needs a test rather than an eyeball: nothing downstream goes red when it regresses.
 */
const assert = require('assert')
const { isApprovalRequestId } = require('./vault-pull.js')

let pass = 0
function t(name, fn) { fn(); pass++; console.log('  ok - ' + name) }

console.log('isApprovalRequestId')

t('accepts a real vault_approvals uuid', () => {
  // shape taken from a live vault_inbox result id, 2026-08-31
  assert.strictEqual(isApprovalRequestId('b64c6da2-68af-47d1-9324-8ed633a40787'), true)
})

t('accepts an uppercase uuid (Postgres is case-insensitive on uuid input)', () => {
  assert.strictEqual(isApprovalRequestId('B64C6DA2-68AF-47D1-9324-8ED633A40787'), true)
})

t('tolerates surrounding whitespace', () => {
  assert.strictEqual(isApprovalRequestId(' b64c6da2-68af-47d1-9324-8ed633a40787\n'), true)
})

t('rejects the bank-feed cron trace tag that caused the 22P02', () => {
  assert.strictEqual(isApprovalRequestId('ba-cron-20260831'), false)
})

t('rejects the resend trace tag minted for the 2026-08-31 manual re-send', () => {
  assert.strictEqual(isApprovalRequestId('ba-resend-20260831'), false)
})

t('rejects the older hand-run bank-feed tags', () => {
  for (const tag of ['ba-b31-20260815', 'ba-b32-20260815', 'ba-recon-20260814', 'ba-recon2-20260815']) {
    assert.strictEqual(isApprovalRequestId(tag), false, tag + ' must not reach approve()')
  }
})

t('rejects a tag that merely CONTAINS a uuid (whole-string match)', () => {
  assert.strictEqual(isApprovalRequestId('ba-cron-b64c6da2-68af-47d1-9324-8ed633a40787'), false)
  assert.strictEqual(isApprovalRequestId('b64c6da2-68af-47d1-9324-8ed633a40787-retry'), false)
})

t('rejects a uuid with a non-hex character in it', () => {
  assert.strictEqual(isApprovalRequestId('g64c6da2-68af-47d1-9324-8ed633a40787'), false)
})

t('rejects a uuid with wrong group lengths', () => {
  assert.strictEqual(isApprovalRequestId('b64c6da2-68af-47d1-9324-8ed633a4078'), false)
  assert.strictEqual(isApprovalRequestId('b64c6da-68af-47d1-9324-8ed633a40787'), false)
})

t('rejects non-strings and empties without throwing', () => {
  for (const v of [null, undefined, '', '   ', 0, 42, {}, [], true]) {
    assert.strictEqual(isApprovalRequestId(v), false, JSON.stringify(v) + ' must be false')
  }
})

console.log(`\n${pass} passed`)
