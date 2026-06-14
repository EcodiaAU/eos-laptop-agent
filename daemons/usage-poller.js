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
const { spawnSync } = require('child_process')

const AGENT_ROOT = path.resolve(__dirname, '..')
const usage = require(path.join(AGENT_ROOT, 'tools', 'usage'))

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 5 * 60 * 1000
const POLL_INITIAL_DELAY_MS = Number(process.env.POLL_INITIAL_DELAY_MS) || 5_000
const _COORD_ROOT = process.env.COORD_ROOT || (
  process.platform === 'win32'
    ? 'D:\\.code\\EcodiaOS\\coordination'
    : '/Users/ecodia/.code/ecodiaos/coordination'
)
const HEARTBEAT_FILE = path.join(_COORD_ROOT, 'usage', 'poller.heartbeat')

function nowIso() { return new Date().toISOString() }

function writeHeartbeat(payload) {
  try {
    fs.writeFileSync(HEARTBEAT_FILE, JSON.stringify({ ts: nowIso(), pid: process.pid, ...payload }, null, 2), 'utf8')
  } catch (e) {}
}

// ── proactive 5h-cap alert ───────────────────────────────────────────────────
// 2026-06-14. The chronic "we hit the cap and got stuck" problem: account
// switching works (CDP sign-in to the next account), but nothing warns BEFORE
// the live account caps. This reads the active ccusage 5h block (the same fixed
// window Claude Code's UI shows) and iMessages Tate when it crosses 80% / 92% of
// the calibrated limit, so he can switch with runway. Defensive: never throws,
// never blocks the poll. Calibrated from Tate's live reading 2026-06-14 (54% at
// ~397M tokens -> ~735M real 5h limit).
const CAP_5H_TOKENS = Number(process.env.CAPS_5H_TOKENS) || 735_000_000
const CCUSAGE_CLI_JS = process.env.CCUSAGE_CLI_JS || '/opt/homebrew/lib/node_modules/ccusage/dist/cli.js'
const CAP_ALERT_STATE = path.join(_COORD_ROOT, 'usage', 'cap-alert-state.json')
const TATE_PHONE_FILE = '/Users/ecodia/PRIVATE/ecodia-creds/kv-mirror/tate_phone.json'
const WARN_PCT = 0.80
const CRIT_PCT = 0.92

function readJsonSafe(p, fb) { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch (_) { return fb } }

function tatePhone() {
  const d = readJsonSafe(TATE_PHONE_FILE, null)
  if (!d) return null
  if (typeof d === 'string') return d.trim()
  // canonical E.164 first, then formatted display, then explicit phone fields.
  // NOT Object.values()[0] - that grabbed apple_id_on_phone (an email) before.
  const cand = d.e164 || d.display || d.phone || d.number || d.mobile || d.value
  if (typeof cand === 'string' && cand.trim()) return cand.trim()
  for (const v of Object.values(d)) {
    if (typeof v === 'string' && /^[+]?[\d\s()-]{8,}$/.test(v)) return v.trim()
  }
  return null
}

function agentToken() {
  try {
    const m = fs.readFileSync(path.join(AGENT_ROOT, '.env'), 'utf8').match(/^AGENT_TOKEN=(.+)$/m)
    if (m) return m[1].trim()
  } catch (_) {}
  return process.env.AGENT_TOKEN || ''
}

function sendIMessage(to, text) {
  const payload = JSON.stringify({ tool: 'applescript.message_send', params: { to, service: 'iMessage', text } })
  const r = spawnSync('curl', [
    '-sS', '-m', '15', 'http://127.0.0.1:' + (process.env.AGENT_PORT || 7456) + '/api/tool',
    '-X', 'POST', '-H', 'content-type: application/json',
    '-H', 'authorization: Bearer ' + agentToken(), '--data-binary', payload,
  ], { encoding: 'utf8', timeout: 20000 })
  return r.status === 0
}

function capAlert() {
  try {
    const r = spawnSync(process.execPath, [CCUSAGE_CLI_JS, 'blocks', '--active', '--json'], { encoding: 'utf8', timeout: 30000 })
    if (r.status !== 0 || !r.stdout) return
    const blocks = (JSON.parse(r.stdout).blocks) || []
    const b = blocks.find(x => x.isActive) || blocks[0]
    if (!b || !b.endTime) return
    const cur = b.totalTokens || 0
    const proj = (b.projection && b.projection.totalTokens) || cur
    const pct = cur / CAP_5H_TOKENS
    const projPct = proj / CAP_5H_TOKENS
    const level = pct >= CRIT_PCT ? 'crit' : ((pct >= WARN_PCT || projPct >= 1.0) ? 'warn' : 'ok')
    if (level === 'ok') return
    const st = readJsonSafe(CAP_ALERT_STATE, {})
    // one alert per block per level; crit supersedes warn; never repeat
    if (st.block === b.endTime && (st.level === level || st.level === 'crit')) return
    const phone = tatePhone()
    if (!phone) { console.error('[cap-alert] no Tate phone resolved'); return }
    const aest = new Date(new Date(b.endTime).getTime() + 10 * 3600 * 1000)
    const hh = String(aest.getUTCHours()).padStart(2, '0')
    const mm = String(aest.getUTCMinutes()).padStart(2, '0')
    const msg = 'EcodiaOS 5h cap ' + Math.round(pct * 100) + '% used (proj ' + Math.round(projPct * 100) +
      '% by reset ' + hh + ':' + mm + ' AEST) on the live account. Switch accounts (CDP sign-in) before it caps.'
    if (sendIMessage(phone, msg)) {
      fs.writeFileSync(CAP_ALERT_STATE, JSON.stringify({ block: b.endTime, level, pct: Math.round(pct * 100), sent_at: nowIso() }), 'utf8')
      console.log('[' + nowIso() + '] cap-alert ' + level + ' sent: ' + Math.round(pct * 100) + '%')
    }
  } catch (e) { console.error('[cap-alert] ' + (e && e.message || e)) }
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
    capAlert()
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
