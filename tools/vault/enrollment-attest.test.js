'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { verifyEnrollment, newSigner } = require('./enrollment-attest')

const STMT = () => ({ v: '1', service: 'bank-australia', origin: 'https://bankaust.com.au', label: 'Log in to Bank Australia', keyId: 'k-abc123' })

test('a genuinely phone-signed statement verifies', () => {
  const phone = newSigner()
  const sig = phone.sign(STMT())
  assert.strictEqual(verifyEnrollment(phone.publicX963B64, STMT(), sig), true)
})

test('THE FORGERY DEFENCE: the conductor cannot forge a statement (no private key)', () => {
  const phone = newSigner()
  const attacker = newSigner()   // the conductor makes its own keypair and signs
  const sig = attacker.sign(STMT())
  // verified against the REAL phone key => rejected
  assert.strictEqual(verifyEnrollment(phone.publicX963B64, STMT(), sig), false)
})

test('WYSIWYS: tampering the label after signing is rejected', () => {
  const phone = newSigner()
  const sig = phone.sign(STMT())
  const swapped = Object.assign(STMT(), { label: 'Log in to GitHub' })   // conductor shows a benign label
  assert.strictEqual(verifyEnrollment(phone.publicX963B64, swapped, sig), false)
})

test('ORIGIN AUTHENTICITY: re-homing the origin after signing is rejected', () => {
  const phone = newSigner()
  const sig = phone.sign(STMT())
  const phish = Object.assign(STMT(), { origin: 'https://bankaust.com.au.evil' })
  assert.strictEqual(verifyEnrollment(phone.publicX963B64, phish, sig), false)
})

test('unknown fields cannot be smuggled into a statement', () => {
  const phone = newSigner()
  assert.throws(() => phone.sign(Object.assign(STMT(), { extra: 'x' })))
})

test('a garbage signature returns false, does not throw', () => {
  const phone = newSigner()
  assert.strictEqual(verifyEnrollment(phone.publicX963B64, STMT(), Buffer.from('nope').toString('base64')), false)
})
