'use strict'
// RFC 6238 Appendix B official test vectors. If these pass, the TOTP core is
// byte-correct against the standard every authenticator app implements.
const test = require('node:test')
const assert = require('node:assert')
const { base32Decode, totp, verify, parseOtpauth } = require('./totp')

// RFC 6238 seeds are ASCII strings repeated to the algorithm's key length.
const SEED_SHA1 = Buffer.from('12345678901234567890', 'ascii')                     // 20 bytes
const SEED_SHA256 = Buffer.from('12345678901234567890123456789012', 'ascii')       // 32 bytes
const SEED_SHA512 = Buffer.from('1234567890123456789012345678901234567890123456789012345678901234', 'ascii') // 64 bytes

// [time, sha1, sha256, sha512] 8-digit codes, verbatim from RFC 6238 Appendix B.
const VECTORS = [
  [59,          '94287082', '46119246', '90693936'],
  [1111111109,  '07081804', '68084774', '25091201'],
  [1111111111,  '14050471', '67062674', '99943326'],
  [1234567890,  '89005924', '91819424', '93441116'],
  [2000000000,  '69279037', '90698825', '38618901'],
  [20000000000, '65353130', '77737706', '47863826'],
]

test('RFC 6238 SHA1 vectors', () => {
  for (const [time, sha1] of VECTORS) {
    assert.strictEqual(totp(SEED_SHA1, { time, digits: 8, algorithm: 'sha1' }), sha1, `SHA1 @ ${time}`)
  }
})

test('RFC 6238 SHA256 vectors', () => {
  for (const [time, , sha256] of VECTORS) {
    assert.strictEqual(totp(SEED_SHA256, { time, digits: 8, algorithm: 'sha256' }), sha256, `SHA256 @ ${time}`)
  }
})

test('RFC 6238 SHA512 vectors', () => {
  for (const [time, , , sha512] of VECTORS) {
    assert.strictEqual(totp(SEED_SHA512, { time, digits: 8, algorithm: 'sha512' }), sha512, `SHA512 @ ${time}`)
  }
})

test('default 6-digit code is the 8-digit code last-6 truncation-consistent length', () => {
  const c = totp(SEED_SHA1, { time: 59 })
  assert.strictEqual(c.length, 6)
  assert.match(c, /^\d{6}$/)
})

test('base32Decode round-trips the RFC seed', () => {
  // base32("12345678901234567890") = GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ
  const decoded = base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')
  assert.strictEqual(decoded.toString('ascii'), '12345678901234567890')
})

test('base32Decode tolerates spaces, lowercase, and padding', () => {
  const a = base32Decode('gezd gnbv gy3t qojq gezd gnbv gy3t qojq')
  assert.strictEqual(a.toString('ascii'), '12345678901234567890')
})

test('base32 string secret matches Buffer secret (the daemon path)', () => {
  const b32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
  assert.strictEqual(totp(b32, { time: 1111111109, digits: 8 }), totp(SEED_SHA1, { time: 1111111109, digits: 8 }))
})

test('verify accepts the current code and a skewed one within window', () => {
  assert.strictEqual(verify(SEED_SHA1, '94287082', { time: 59, digits: 8, window: 1 }), 0)
  // code from the previous 30s step should match at delta -1
  const prev = totp(SEED_SHA1, { time: 59 - 30, digits: 8 })
  assert.strictEqual(verify(SEED_SHA1, prev, { time: 59, digits: 8, window: 1 }), -1)
  assert.strictEqual(verify(SEED_SHA1, '00000000', { time: 59, digits: 8, window: 1 }), null)
})

test('parseOtpauth extracts issuer, account, secret, and params', () => {
  const p = parseOtpauth('otpauth://totp/GitHub:code@ecodia.au?secret=GEZDGNBVGY3TQOJQ&issuer=GitHub&algorithm=SHA1&digits=6&period=30')
  assert.strictEqual(p.type, 'totp')
  assert.strictEqual(p.issuer, 'GitHub')
  assert.strictEqual(p.account, 'code@ecodia.au')
  assert.strictEqual(p.secret, 'GEZDGNBVGY3TQOJQ')
  assert.strictEqual(p.digits, 6)
  assert.strictEqual(p.period, 30)
  // and the parsed secret actually generates a code
  assert.match(totp(p.secret, { time: 59 }), /^\d{6}$/)
})
