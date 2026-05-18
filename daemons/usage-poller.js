#!/usr/bin/env node
// daemons/usage-poller.js
//
// Long-running daemon that invokes tools/usage._poll() every POLL_INTERVAL_MS.
// Each poll runs `ccusage session --json` + `ccusage blocks --json`, attributes
// sessions to accounts via worker rows + active_account snapshots, and writes
// the rolling per-account state to D:\.code\EcodiaOS\coordination\usage\accounts.json.
//
// Designed to be run under PM2 (ecosystem.config.js adds this app) so it
// auto-restarts on crash. Single-process - polls are sequential (~5-10s each
// for the npx invocation). Holds no file locks; usage.js writes atomically.
//
// Env overrides:
//   POLL_INTERVAL_MS         default 300_000 (5min)
//   POLL_INITIAL_DELAY_MS    default 5_000   (5s before first poll)
//   CAPS_5H_TOKENS           default 220_000_000 (passed through to usage.js)
//   CAPS_WEEKLY_TOKENS       default 1_000_000_000

const path = require('path')
const fs = require('fs')

const AGENT_ROOT = path.resolve(__dirname, '..')
const usage = require(path.join(AGENT_ROOT, 'tools', 'usage'))

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 5 * 60 * 1000
const POLL_INITIAL_DELAY_MS = Number(process.env.POLL_INITIAL_DELAY_MS) || 5_000
const HEARTBEAT_FILE = path.join('D:\\.code\\EcodiaOS\\coordination\\usage', 'poller.heartbeat')

function nowIso() { return new Date().toISOString() }

function writeHeartbeat(payload) {
  try {
    fs.writeFileSync(HEARTBEAT_FILE, JSON.stringify({ ts: nowIso(), pid: process.pid, ...payload }, null, 2), 'utf8')
  } catch (e) {}
}

async function runOnePoll() {
  const t0 = Date.now()
  try {
    const result = usage._poll()
    const elapsed = Date.now() - t0
    const summary = {}
    if (result && result.accounts) {
      for (const acct of Object.keys(result.accounts)) {
        const a = result.accounts[acct]
        summary[acct] = {
          tokens_5h: a.tokens_5h,
          tokens_weekly: a.tokens_weekly,
          headroom_score: a.headroom_score,
        }
      }
    }
    console.log('[' + nowIso() + '] poll OK in ' + elapsed + 'ms', JSON.stringify(summary))
    writeHeartbeat({ ok: true, elapsed_ms: elapsed, summary: summary })
  } catch (e) {
    const elapsed = Date.now() - t0
    console.error('[' + nowIso() + '] poll FAILED in ' + elapsed + 'ms: ' + e.message)
    writeHeartbeat({ ok: false, elapsed_ms: elapsed, error: e.message })
  }
}

async function main() {
  console.log('[' + nowIso() + '] usage-poller starting, interval=' + POLL_INTERVAL_MS + 'ms, initial=' + POLL_INITIAL_DELAY_MS + 'ms')
  await new Promise(r => setTimeout(r, POLL_INITIAL_DELAY_MS))
  await runOnePoll()
  setInterval(runOnePoll, POLL_INTERVAL_MS)
}

main().catch(e => { console.error('fatal: ' + (e && e.stack || e)); process.exit(1) })

// Graceful shutdown - flush a heartbeat with shutdown marker
process.on('SIGTERM', () => { writeHeartbeat({ shutdown: 'SIGTERM' }); process.exit(0) })
process.on('SIGINT', () => { writeHeartbeat({ shutdown: 'SIGINT' }); process.exit(0) })
