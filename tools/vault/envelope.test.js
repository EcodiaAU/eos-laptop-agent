'use strict'
const test = require('node:test')
const assert = require('node:assert')
const crypto = require('crypto')
const { sealTo, openWith, newRecipient } = require('./envelope')

test('seal to a public key, open only with the matching private key', () => {
  const r = newRecipient()
  const blob = sealTo(r.publicX963B64, 'tates-bank-password')
  assert.doesNotMatch(blob, /tates-bank-password/)
  assert.strictEqual(openWith(r.ecdh, blob), 'tates-bank-password')
})

test('THE PROPERTY: the host holds only the blob + public key and CANNOT open it', () => {
  const r = newRecipient()
  const blob = sealTo(r.publicX963B64, 'secret')
  // the host has the public key and the blob, but NOT r.ecdh's private key.
  // Simulate every private key it could try; a fresh keypair cannot open it.
  const attacker = crypto.createECDH('prime256v1'); attacker.generateKeys()
  assert.throws(() => openWith(attacker, blob))
})

test('accepts a 64-byte raw public key (CryptoKit rawRepresentation form)', () => {
  const r = newRecipient()
  const blob = sealTo(r.publicRawB64, 'secret2')   // raw 64-byte, no 0x04 prefix
  assert.strictEqual(openWith(r.ecdh, blob), 'secret2')
})

test('a tampered blob fails the GCM tag', () => {
  const r = newRecipient()
  const blob = sealTo(r.publicX963B64, 'secret3')
  const b = Buffer.from(blob, 'base64'); b[b.length - 1] ^= 0xff
  assert.throws(() => openWith(r.ecdh, b.toString('base64')))
})

test('blob layout is ephPub(65) + iv(12) + ct + tag(16)', () => {
  const r = newRecipient()
  const buf = Buffer.from(sealTo(r.publicX963B64, 'x'), 'base64')
  assert.strictEqual(buf[0], 0x04)                 // x963 uncompressed marker
  assert.strictEqual(buf.length, 65 + 12 + 1 + 16) // 1-byte plaintext
})

test('ORIGIN-BINDING: a blob sealed for origin A cannot be opened for origin B', () => {
  const r = newRecipient()
  const blob = sealTo(r.publicX963B64, 'bank-password', 'https://bank.example.com')
  // correct origin opens
  assert.strictEqual(openWith(r.ecdh, blob, 'https://bank.example.com'), 'bank-password')
  // attacker-chosen phishing origin fails the GCM tag
  assert.throws(() => openWith(r.ecdh, blob, 'https://bank-phish.evil.com'))
  // and omitting the origin also fails (cannot strip the binding)
  assert.throws(() => openWith(r.ecdh, blob))
})

test('ORIGIN-BINDING: the origin is authenticated, so tampering the stored origin breaks decryption', () => {
  const r = newRecipient()
  const origin = 'https://accounts.google.com'
  const blob = sealTo(r.publicX963B64, 'pw', origin)
  // an injected conductor that swaps the origin it feeds the opener gets nothing
  assert.throws(() => openWith(r.ecdh, blob, 'https://accounts-google.evil'))
  assert.strictEqual(openWith(r.ecdh, blob, origin), 'pw')
})
