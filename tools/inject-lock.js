'use strict'

/**
 * inject-lock.js - a SINGLE cross-process mutex for turn injection.
 *
 * Injection (select a Claude Code tab, focus it, paste, submit) drives the ONE
 * global focus + clipboard. Multiple processes do it: coord push delivery
 * (chat-inject.js), the iMessage router (imessage-agent/inject-turn.js), and any
 * worker. With no coordination, two injections that overlap race for focus - one
 * selects tab A, the other steals focus to tab B, and the first one's paste lands
 * in B. That is a silent misroute.
 *
 * This lock serialises the whole critical section ACROSS processes. It is a
 * directory created atomically (mkdir fails if it exists - the POSIX atomic
 * create), with an owner file for debugging + stale detection. A holder that
 * crashes mid-inject leaves a stale lock; any waiter older than STALE_MS breaks
 * it. Acquisition polls with jitter up to timeoutMs, then gives up (the caller
 * leaves its message in the inbox rather than blind-injecting).
 *
 * The lock PATH is the contract shared by every injector. Both this file and
 * imessage-agent/inject-turn.js must point at the same EOS_INJECT_LOCK path.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')

const LOCK_DIR = process.env.EOS_INJECT_LOCK || path.join(os.homedir(), '.ecodiaos', 'coordination', 'inject.lock')
const OWNER_FILE = path.join(LOCK_DIR, 'owner.json')
const STALE_MS = Number(process.env.EOS_INJECT_LOCK_STALE_MS || 15000)

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

function readOwner() {
  try { return JSON.parse(fs.readFileSync(OWNER_FILE, 'utf8')) } catch (e) { return null }
}

function forceRelease() {
  try { fs.rmSync(LOCK_DIR, { recursive: true, force: true }) } catch (e) {}
}

/**
 * acquire({timeoutMs, who}) -> {ok, token?, reason?, held_by?}. On ok, call
 * release(token) (or the returned token.release()) in a finally. Never throws.
 */
async function acquire(opts) {
  opts = opts || {}
  const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : 8000
  const who = opts.who || 'inject'
  const start = Date.now()
  // Ensure the parent dir exists (the lock's parent, not the lock itself).
  try { fs.mkdirSync(path.dirname(LOCK_DIR), { recursive: true }) } catch (e) {}
  for (;;) {
    try {
      fs.mkdirSync(LOCK_DIR) // atomic: throws EEXIST if held
      try { fs.writeFileSync(OWNER_FILE, JSON.stringify({ pid: process.pid, who: who, at: Date.now() })) } catch (e) {}
      const token = { who: who, acquired_at: Date.now(), release: () => forceRelease() }
      return { ok: true, token: token }
    } catch (e) {
      if (e.code !== 'EEXIST') return { ok: false, reason: 'lock_error:' + e.message }
      const owner = readOwner()
      const age = owner && owner.at ? Date.now() - owner.at : Infinity
      if (age > STALE_MS) {
        // Holder died mid-inject (or never wrote an owner). Break it and retry.
        forceRelease()
        continue
      }
      if (Date.now() - start > timeoutMs) {
        return { ok: false, reason: 'lock_timeout', held_by: owner }
      }
      await sleep(80 + Math.floor(Math.random() * 70)) // jitter avoids thundering herd
    }
  }
}

function release(token) {
  // token is advisory; the lock is a shared dir so any holder releases the same
  // path. We only release if we still appear to be the owner (best-effort).
  try {
    const owner = readOwner()
    if (!owner || owner.pid === process.pid) forceRelease()
  } catch (e) { forceRelease() }
}

module.exports = { acquire, release, forceRelease, LOCK_DIR, STALE_MS }
