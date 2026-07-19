'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { normalizeOrigin, accountHintMatches, matchTab, makeVerifyTab } = require('./verify-tab')

test('normalizeOrigin drops path/query/trailing slash', () => {
  assert.strictEqual(normalizeOrigin('https://github.com/login?x=1'), 'https://github.com')
  assert.strictEqual(normalizeOrigin('https://github.com/'), 'https://github.com')
})

test('lookalike host does NOT match (no substring games)', () => {
  const r = matchTab({ origin: 'https://github.com.evil.io', accountHint: 'code@ecodia.au' },
    { registered_origin: 'https://github.com', registered_account: 'code@ecodia.au' })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.reason, 'origin-mismatch')
})

test('matching origin + account passes', () => {
  const r = matchTab({ origin: 'https://github.com/', accountHint: 'Signed in as code@ecodia.au' },
    { registered_origin: 'https://github.com', registered_account: 'code@ecodia.au' })
  assert.strictEqual(r.ok, true)
})

test('THE T4 DEFENCE: tate@ page cannot be cleared by a code@ registration on same origin', () => {
  // live tab is the tate@ Google account; registration is code@ Google (same origin)
  const r = matchTab({ origin: 'https://accounts.google.com', accountHint: 'tate@ecodia.au' },
    { registered_origin: 'https://accounts.google.com', registered_account: 'code@ecodia.au' })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.reason, 'account-mismatch')
})

test('account hint matches on local-part when page shows only the name', () => {
  assert.strictEqual(accountHintMatches('Welcome, code', 'code@ecodia.au'), true)
  assert.strictEqual(accountHintMatches('tate', 'code@ecodia.au'), false)
})

test('no registered account => origin is the only gate', () => {
  const r = matchTab({ origin: 'https://vercel.com', accountHint: '' }, { registered_origin: 'https://vercel.com' })
  assert.strictEqual(r.ok, true)
})

test('missing account hint when one is required fails closed', () => {
  const r = matchTab({ origin: 'https://github.com', accountHint: '' },
    { registered_origin: 'https://github.com', registered_account: 'code@ecodia.au' })
  assert.strictEqual(r.reason, 'account-mismatch')
})

test('makeVerifyTab: a CDP read error fails closed (returns false, never throws)', async () => {
  const vt = makeVerifyTab(async () => { throw new Error('cdp down') })
  assert.strictEqual(await vt('tab1', 'https://github.com', 'code@ecodia.au'), false)
})

test('makeVerifyTab: composes the reader with the matcher', async () => {
  const vt = makeVerifyTab(async () => ({ origin: 'https://github.com', accountHint: 'code@ecodia.au' }))
  assert.strictEqual(await vt('tab1', 'https://github.com', 'code@ecodia.au'), true)
  assert.strictEqual(await vt('tab1', 'https://github.com', 'tate@ecodia.au'), false)
})
