'use strict'

// crash-loop-detector.js - detect a silent boot crash-loop and page Tate once.
//
// WHY (2026-08-13 crash-loop hardening, Tate overseas from ~2026-09-24): the
// laptop-agent plist is KeepAlive + ThrottleInterval=10. If boot keeps throwing
// (a bad require the autoload guard cannot catch, a wedged :7456 bind, a corrupt
// .env), launchd respawns every ~10s forever with no alert. Per-file autoload
// try/catch (lib/tool-autoload.js) removes the most common cause, but not all of
// them, so we ALSO need a from-inside detector: each boot stamps a small on-disk
// history; when N boots land inside a short window, ONE rate-limited page goes to
// Tate via text-tate.js (the imessage-agent has its own launchd KeepAlive and
// survives when the IDE/conductor is dead, so it is the one channel that still
// reaches him). Handoff: drafts/away-resilience/HANDOFF-threat-hunt-2026-08-13.md
// (Hunter 4 #1). Doctrine: mac-unattended-resilience-conductor-survival-2026-08-13.
//
// Runs at the TOP of index.js, before the risky autoload, so a boot that later
// dies mid-load is still counted. A single isolated restart (deploy, kickstart)
// never trips: the window prune drops stale stamps, so only rapid successive
// boots accumulate. A cooldown stamp rate-limits to one page per COOLDOWN_MS even
// while the loop continues, so Tate is not paged every 10s.
//
// Defensive by construction: every fs/spawn path is wrapped so the detector can
// NEVER be the thing that crashes boot. On any internal error it returns a benign
// result and lets boot proceed.

const fs = require('fs')
const path = require('path')

const DEFAULTS = {
  windowMs: 5 * 60 * 1000,     // boots inside this window count toward the loop
  threshold: 5,                // >= this many boots in the window = crash-loop
  cooldownMs: 30 * 60 * 1000,  // page at most once per this interval
}

function readJsonArray(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter(n => typeof n === 'number' && isFinite(n)) : []
  } catch (_e) {
    return []
  }
}

function readNumber(file) {
  try {
    const n = parseInt(fs.readFileSync(file, 'utf8').trim(), 10)
    return isFinite(n) ? n : 0
  } catch (_e) {
    return 0
  }
}

// recordBootAndDetect(opts) -> { boots, tripped, paged, reason }
//   historyPath : JSON array file of recent boot epoch-ms (required)
//   stampPath   : cooldown stamp file holding the last page epoch-ms (required)
//   now         : injectable clock (default Date.now())
//   windowMs / threshold / cooldownMs : tunables (defaults above)
//   pager       : injectable fn (message) => void; defaults to a detached
//                 text-tate.js spawn. Overridable so tests never text Tate.
//   textTateScript / logger : optional
function recordBootAndDetect(opts) {
  const o = opts || {}
  const logger = o.logger || console
  const out = { boots: 0, tripped: false, paged: false, reason: null }
  try {
    const historyPath = o.historyPath
    const stampPath = o.stampPath
    if (!historyPath || !stampPath) throw new Error('historyPath + stampPath required')
    const now = typeof o.now === 'number' ? o.now : Date.now()
    const windowMs = o.windowMs || DEFAULTS.windowMs
    const threshold = o.threshold || DEFAULTS.threshold
    const cooldownMs = o.cooldownMs || DEFAULTS.cooldownMs

    // Ensure the parent dir exists (logs/ normally does, but be robust).
    try { fs.mkdirSync(path.dirname(historyPath), { recursive: true }) } catch (_e) {}

    // Append this boot, prune to the window.
    let history = readJsonArray(historyPath)
    history.push(now)
    history = history.filter(t => now - t <= windowMs)
    // Cap the array so a pathological state can never grow unbounded.
    if (history.length > 1000) history = history.slice(history.length - 1000)
    try { fs.writeFileSync(historyPath, JSON.stringify(history)) } catch (e) {
      logger.error('[crashloop] could not write boot history: ' + (e && e.message || e))
    }

    out.boots = history.length
    if (history.length < threshold) {
      out.reason = 'below-threshold'
      return out
    }
    out.tripped = true

    // Rate-limit: only page if the cooldown has elapsed since the last page.
    const lastPage = readNumber(stampPath)
    if (lastPage && (now - lastPage) < cooldownMs) {
      out.reason = 'cooldown'
      return out
    }

    const minutes = Math.round((windowMs / 60000))
    const msg = 'LAPTOP-AGENT CRASH-LOOP: index.js has booted ' + history.length +
      ' times in the last ' + minutes + 'min (launchd KeepAlive + ThrottleInterval=10 ' +
      'respawning a failing boot). The sole dispatcher may be down. Check ' +
      '/Users/ecodia/Library/Logs/eos-laptop-agent.err.log and reopen the conductor.'

    const pager = o.pager || defaultPager(o.textTateScript, logger)
    pager(msg)
    // Write the cooldown stamp optimistically: a crash-looping process may exit
    // immediately after this, so we cannot wait for the send to confirm. One
    // possibly-missed page beats paging every 10s.
    try { fs.writeFileSync(stampPath, String(now)) } catch (e) {
      logger.error('[crashloop] could not write cooldown stamp: ' + (e && e.message || e))
    }
    out.paged = true
    out.reason = 'paged'
    logger.error('[crashloop] PAGED Tate: ' + history.length + ' boots in ' + minutes + 'min')
    return out
  } catch (e) {
    // Never let the detector crash boot.
    try { (o.logger || console).error('[crashloop] detector error (non-fatal): ' + (e && e.message || e)) } catch (_e2) {}
    out.reason = 'error'
    return out
  }
}

// Default pager: detached text-tate.js spawn, fire-and-forget. Detached + unref
// is correct HERE (unlike the scheduler pager) because a crash-looping boot
// process may exit immediately after; the detached child survives parent death
// and still delivers. text-tate.js is pure osascript, zero Claude budget.
function defaultPager(textTateScript, logger) {
  const script = textTateScript ||
    process.env.SCHEDULER_TEXT_TATE_SCRIPT ||
    '/Users/ecodia/.code/ecodiaos/backend/imessage-agent/text-tate.js'
  return function (message) {
    try {
      const child = require('child_process').spawn(
        'node', [script, '--from', 'agent watchdog', message],
        { detached: true, stdio: 'ignore' }
      )
      child.on('error', (e) => {
        try { (logger || console).error('[crashloop] pager spawn error: ' + (e && e.message || e)) } catch (_e) {}
      })
      child.unref()
    } catch (e) {
      try { (logger || console).error('[crashloop] pager send error: ' + (e && e.message || e)) } catch (_e) {}
    }
  }
}

module.exports = { recordBootAndDetect, DEFAULTS }
