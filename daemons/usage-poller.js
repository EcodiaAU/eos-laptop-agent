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

// ── 5h-cap auto-switch trigger ───────────────────────────────────────────────
// 2026-06-14. The chronic "hit the cap and get stuck" problem. Tate's rule
// (verbatim): "idc when your thing is near capped, it needs to trigger you to do
// the gui switch if other accounts are available". So the cap-approaching signal
// must TRIGGER an autonomous CDP sign-in switch to a healthy account, NOT text
// Tate. This reads the active ccusage 5h block (the same window Claude Code's UI
// shows). When it crosses the threshold, it asks the laptop-agent for the
// healthiest OTHER account; if one with real headroom exists, it raises a
// switch-request that the switch executor consumes (CDP sign-in to that account,
// which mints a FRESH token - unlike the file-swap which clobbers with a stale
// snapshot). If no alternate account is enabled+healthy (the current single-
// account reality), it holds silently. It NEVER texts Tate. Defensive: never
// throws, never blocks the poll. Calibrated from Tate's live reading 2026-06-14
// (54% at ~397M tokens -> ~735M real 5h limit).
const CAP_5H_TOKENS = Number(process.env.CAPS_5H_TOKENS) || 735_000_000
const CCUSAGE_CLI_JS = process.env.CCUSAGE_CLI_JS || '/opt/homebrew/lib/node_modules/ccusage/dist/cli.js'
const SWITCH_REQUEST_FILE = path.join(_COORD_ROOT, 'usage', 'switch-request.json')
const SWITCH_TRIGGER_PCT = 0.80   // raise the switch request at 80% of the 5h block

function readJsonSafe(p, fb) { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch (_) { return fb } }

function agentToken() {
  try {
    const m = fs.readFileSync(path.join(AGENT_ROOT, '.env'), 'utf8').match(/^AGENT_TOKEN=(.+)$/m)
    if (m) return m[1].trim()
  } catch (_) {}
  return process.env.AGENT_TOKEN || ''
}

// Call a laptop-agent tool over localhost. Returns parsed result or null.
function agentTool(tool, params) {
  try {
    const payload = JSON.stringify({ tool, params: params || {} })
    const r = spawnSync('curl', [
      '-sS', '-m', '12', 'http://127.0.0.1:' + (process.env.AGENT_PORT || 7456) + '/api/tool',
      '-X', 'POST', '-H', 'content-type: application/json',
      '-H', 'authorization: Bearer ' + agentToken(), '--data-binary', payload,
    ], { encoding: 'utf8', timeout: 15000 })
    if (r.status !== 0 || !r.stdout) return null
    const j = JSON.parse(r.stdout)
    return j && j.ok ? j.result : null
  } catch (_) { return null }
}

function capAutoSwitch() {
  try {
    // Fast cap-switch path (every poll, ~5min). Uses the SAME honest decision as
    // the 25-min cron: account-cap-decide.js (cache-read-EXCLUDED usage via
    // tools/usage, calibrated caps, rotatable-snapshot gate, and a no-usable-target
    // SMS fired inside the module). Single source of truth - no second heuristic.
    // The prior path read cache-inflated ccusage b.totalTokens / cap and so crossed
    // 80% almost immediately, scheduling a FALSE OAuth-switch chat every 5h block
    // (2026-06-21). Execution is now creds.rotate_to: instant + headless, safe
    // because the cred-refresher keeps all snapshots fresh (it was NOT safe when
    // snapshots rotted, hence the old heavyweight OAuth-CC-chat). rotate_to is its
    // own dedupe + guard: no-ops when already on target, DEFERS under active worker
    // tabs (never clobbers a mid-flight Keychain), refuses a stale snapshot, skips
    // disabled accounts. The 25-min cron remains the robust backstop (a worker can
    // force / re-login if rotate_to keeps deferring).
    const decideR = spawnSync(process.execPath, [path.join(AGENT_ROOT, 'tools', 'account-cap-decide.js')], { encoding: 'utf8', timeout: 25000 })
    let d = null
    try { d = JSON.parse(decideR.stdout) } catch (_) { return }
    if (!d || !d.shouldSwitch || !d.target) return  // hold / no-usable-target (SMS handled in the module)

    const targetShort = String(d.target).split('@')[0]
    const rot = agentTool('creds.rotate_to', { account: targetShort })
    const status = !rot ? 'agent_unreachable'
      : rot.target ? 'switched'
      : rot.deferred ? ('deferred:' + (rot.reason || 'workers'))
      : (rot.reason || 'noop')
    fs.writeFileSync(SWITCH_REQUEST_FILE, JSON.stringify({
      target: d.target, from: d.live, reason: d.reason, via: 'rotate_to',
      result: status, raised_at: nowIso(),
    }), 'utf8')
    console.log('[' + nowIso() + '] cap-auto-switch: ' + d.live + ' -> ' + d.target + ' via rotate_to (' + status + ')')
  } catch (e) { console.error('[cap-auto-switch] ' + (e && e.message || e)) }
}

// ── TRUE RATE-LIMIT WATCH (ground truth, not prediction) ─────────────────────
// Thin wrapper over tools/real-limit-watch (pure detector + selftest live there).
// Detects a FRESH "You've hit your (session|weekly) limit" synthetic message that
// Claude Code injects into a live transcript the instant a cap is actually hit,
// then FORCE rotate_to a healthy account + SMS Tate so the next session/worker
// opens fresh. Injects the daemon's localhost agentTool + the self-healing live-
// account resolver. Runs every 60s (see main()). Origin: Tate 2026-06-21.
const realLimitWatchMod = require(path.join(AGENT_ROOT, 'tools', 'real-limit-watch'))
const REAL_LIMIT_WATCH_INTERVAL_MS = Number(process.env.REAL_LIMIT_WATCH_INTERVAL_MS) || 60 * 1000
function realLimitWatch() {
  Promise.resolve(realLimitWatchMod.run({ agentTool, getActiveAccount: usage._getActiveAccount, coordRoot: _COORD_ROOT }))
    .then(r => {
      if (r && r.action && r.action !== 'none' && r.action !== 'already_fired') {
        console.log('[' + nowIso() + '] real-limit-watch: ' + JSON.stringify(r))
      }
    })
    .catch(e => console.error('[real-limit-watch] ' + (e && e.message || e)))
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
    capAutoSwitch()
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
  // True rate-limit watch on a tight interval (ground-truth backstop, ~1min
  // latency) - independent of the 5-min predictive usage poll above.
  realLimitWatch()
  setInterval(realLimitWatch, REAL_LIMIT_WATCH_INTERVAL_MS)
  console.log('[' + nowIso() + '] real-limit-watch armed, interval=' + REAL_LIMIT_WATCH_INTERVAL_MS + 'ms')
}

main().catch(e => { console.error('fatal: ' + (e && e.stack || e)); process.exit(1) })

// Graceful shutdown - flush a heartbeat with shutdown marker
process.on('SIGTERM', () => { writeHeartbeat({ shutdown: 'SIGTERM' }); process.exit(0) })
process.on('SIGINT', () => { writeHeartbeat({ shutdown: 'SIGINT' }); process.exit(0) })
