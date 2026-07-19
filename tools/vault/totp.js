'use strict'
// tools/vault/totp.js - RFC 6238 TOTP + RFC 4238 HOTP + otpauth:// parsing.
// The algorithmic heart of the 2FA vault daemon. PURE: no secrets, no I/O, no
// state. Generates a one-time code from a seed; the daemon calls this inside its
// own process and fills the result via cdp.nativeFill, so a live code is never
// returned to the conductor. Zero external deps (node:crypto only), so it cannot
// drag an unaudited package into the trusted daemon.
// Design spec: backend/docs/security/2fa-credential-vault-architecture-2026-07-17.md (section 6, backend 1).
const crypto = require('crypto')

// RFC 4648 base32 decode. otpauth:// seeds are base32 (A-Z2-7), case-insensitive,
// padding + spaces tolerated. Returns a Buffer of the raw secret bytes.
function base32Decode(input) {
  if (typeof input !== 'string') throw new Error('base32Decode: string required')
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '')
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0
  let value = 0
  const out = []
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch)
    if (idx === -1) throw new Error(`base32Decode: invalid character "${ch}"`)
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      bits -= 8
      out.push((value >>> bits) & 0xff)
    }
  }
  return Buffer.from(out)
}

// RFC 4226 HOTP. counter is an integer; algo one of sha1|sha256|sha512.
function hotp(secretBuf, counter, opts) {
  opts = opts || {}
  const digits = opts.digits || 6
  const algo = (opts.algorithm || 'sha1').toLowerCase()
  // 8-byte big-endian counter.
  const buf = Buffer.alloc(8)
  // Use BigInt so counters past 2^32 (RFC 6238 test vector T=20000000000) are exact.
  let c = BigInt(counter)
  for (let i = 7; i >= 0; i--) {
    buf[i] = Number(c & 0xffn)
    c >>= 8n
  }
  const hmac = crypto.createHmac(algo, secretBuf).update(buf).digest()
  // Dynamic truncation (RFC 4226 section 5.3).
  const offset = hmac[hmac.length - 1] & 0x0f
  const binCode = ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff)
  const code = (binCode % Math.pow(10, digits)).toString().padStart(digits, '0')
  return code
}

// RFC 6238 TOTP. secret is a base32 string OR a Buffer. Options: time (seconds
// since epoch, default now), step (period seconds, default 30), t0 (epoch start,
// default 0), digits (default 6), algorithm (default sha1).
function totp(secret, opts) {
  opts = opts || {}
  const secretBuf = Buffer.isBuffer(secret) ? secret : base32Decode(secret)
  const time = (opts.time != null) ? opts.time : Math.floor(Date.now() / 1000)
  const step = opts.step || 30
  const t0 = opts.t0 || 0
  const counter = Math.floor((time - t0) / step)
  return hotp(secretBuf, counter, { digits: opts.digits || 6, algorithm: opts.algorithm || 'sha1' })
}

// Verify a submitted code within a +/- window of steps (clock-skew tolerance).
// Returns the matched delta (0 = current step) or null. The daemon does not need
// this for FILLING (it generates the current code), but keeps it for self-test /
// enrollment confirmation.
function verify(secret, code, opts) {
  opts = opts || {}
  const window = opts.window == null ? 1 : opts.window
  const time = (opts.time != null) ? opts.time : Math.floor(Date.now() / 1000)
  const step = opts.step || 30
  for (let delta = -window; delta <= window; delta++) {
    const candidate = totp(secret, Object.assign({}, opts, { time: time + delta * step }))
    if (candidate === String(code)) return delta
  }
  return null
}

// Parse an otpauth://totp/... URI (the "can't scan the QR? enter this key"
// string) into its fields. The daemon parses the seed out-of-band during
// enrollment; the conductor never sees this string (DOM-redacted before capture).
function parseOtpauth(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('otpauth://')) {
    throw new Error('parseOtpauth: not an otpauth:// URI')
  }
  const u = new URL(uri)
  const type = u.hostname.toLowerCase() // totp | hotp
  const label = decodeURIComponent(u.pathname.replace(/^\//, ''))
  const params = u.searchParams
  const secret = params.get('secret')
  if (!secret) throw new Error('parseOtpauth: no secret param')
  let issuer = params.get('issuer') || null
  let account = label
  if (label.includes(':')) {
    const [iss, acc] = label.split(':')
    if (!issuer) issuer = decodeURIComponent(iss.trim())
    account = decodeURIComponent(acc.trim())
  }
  return {
    type,
    issuer,
    account,
    secret, // base32
    algorithm: (params.get('algorithm') || 'SHA1').toLowerCase(),
    digits: parseInt(params.get('digits') || '6', 10),
    period: parseInt(params.get('period') || '30', 10),
  }
}

module.exports = { base32Decode, hotp, totp, verify, parseOtpauth }
