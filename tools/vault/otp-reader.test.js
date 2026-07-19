'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { matchesAllowlist, isAfterWatermark, correlateToLogin, extractCode, pickOtp } = require('./otp-reader')

const ALLOW = [{ service: 'stripe', inbox: 'code@ecodia.au', sender: 'no-reply@stripe.com', subjectPattern: /verification code/i }]
const LOGIN = (over) => Object.assign({ service: 'stripe', nonce: 'n1', launchedAt: 1000 }, over)
const MSG = (over) => Object.assign({ inbox: 'code@ecodia.au', sender: 'no-reply@stripe.com', subject: 'Your verification code', body: 'Code: 447281', ts: 1010 }, over)

test('happy path: correlated login + allowlisted + fresh -> fills the code', () => {
  const r = pickOtp({ service: 'stripe', messages: [MSG()], allowlist: ALLOW, watermark: 1005, inflightLogin: LOGIN(), now: 1010, maxAgeSeconds: 120 })
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.code, '447281')
})

test('THE ATTACK: no daemon-initiated login -> refuse (off-box recovery cannot harvest)', () => {
  const r = pickOtp({ service: 'stripe', messages: [MSG()], allowlist: ALLOW, watermark: 1005, inflightLogin: null, now: 1010 })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.reason, 'no-daemon-initiated-login')
})

test('stale login (older than maxAge) -> refuse', () => {
  const r = pickOtp({ service: 'stripe', messages: [MSG()], allowlist: ALLOW, watermark: 1005, inflightLogin: LOGIN({ launchedAt: 800 }), now: 1010, maxAgeSeconds: 120 })
  assert.strictEqual(r.reason, 'login-stale')
})

test('a code at/before the watermark is NOT accepted (pre-existing code cannot be replayed)', () => {
  const r = pickOtp({ service: 'stripe', messages: [MSG({ ts: 1005 })], allowlist: ALLOW, watermark: 1005, inflightLogin: LOGIN(), now: 1010 })
  assert.strictEqual(r.reason, 'no-fresh-allowlisted-code')
})

test('wrong sender is rejected even with a valid login (allowlist is exact-sender)', () => {
  const r = pickOtp({ service: 'stripe', messages: [MSG({ sender: 'phish@stripe-support.com' })], allowlist: ALLOW, watermark: 1005, inflightLogin: LOGIN(), now: 1010 })
  assert.strictEqual(r.reason, 'no-fresh-allowlisted-code')
})

test('wrong inbox rejected (no whole-estate scan)', () => {
  const m = matchesAllowlist('stripe', MSG({ inbox: 'tate@ecodia.au' }), ALLOW)
  assert.strictEqual(m.reason, 'inbox-mismatch')
})

test('subject not matching the pattern rejected', () => {
  const m = matchesAllowlist('stripe', MSG({ subject: 'Welcome to Stripe' }), ALLOW)
  assert.strictEqual(m.reason, 'subject-mismatch')
})

test('picks the newest fresh code when several arrive', () => {
  const msgs = [MSG({ ts: 1008, body: 'Code: 111111' }), MSG({ ts: 1012, body: 'Code: 222222' })]
  const r = pickOtp({ service: 'stripe', messages: msgs, allowlist: ALLOW, watermark: 1005, inflightLogin: LOGIN(), now: 1013 })
  assert.strictEqual(r.code, '222222')
})

test('extractCode pulls 6-8 digit codes, ignores other numbers', () => {
  assert.strictEqual(extractCode('Your code is 447281 (expires in 10 min)'), '447281')
  assert.strictEqual(extractCode('no code here'), null)
})

test('isAfterWatermark is strict greater-than', () => {
  assert.strictEqual(isAfterWatermark(1006, 1005), true)
  assert.strictEqual(isAfterWatermark(1005, 1005), false)
})

test('login for a different service does not satisfy the bind', () => {
  const r = correlateToLogin('stripe', { service: 'github', launchedAt: 1000 }, 1010, 120)
  assert.strictEqual(r.reason, 'login-service-mismatch')
})
