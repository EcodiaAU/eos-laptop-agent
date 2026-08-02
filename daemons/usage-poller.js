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
const { spawn, spawnSync } = require('child_process')

const AGENT_ROOT = path.resolve(__dirname, '..')
const usage = require(path.join(AGENT_ROOT, 'tools', 'usage'))

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 5 * 60 * 1000
const POLL_INITIAL_DELAY_MS = Number(process.env.POLL_INITIAL_DELAY_MS) || 5_000
// COORD_ROOT comes from the shared config now (2026-08-02). This file used to carry its
// own fallback of /Users/ecodia/.code/ecodiaos/coordination, a path that does not exist,
// while usage.js, coord.js, real-limit-watch.js and account-cap-decide.js all defaulted
// to ~/.ecodiaos/coordination. Only the plist env masked the split, so a bootout without
// that env would have written the heartbeat and switch-request into a ghost directory
// while accounts.json carried on at the real path.
const usageCfg = require(path.join(AGENT_ROOT, 'tools', 'usage-config'))
const usageReal = require(path.join(AGENT_ROOT, 'tools', 'usage-real'))
const accountsRegistry = require(path.join(AGENT_ROOT, 'tools', 'accounts-registry'))
const ACCOUNT_SWITCH_SH = path.join(AGENT_ROOT, 'scripts', 'account-switch.sh')
const _COORD_ROOT = usageCfg.PATHS.COORD_ROOT
const HEARTBEAT_FILE = usageCfg.PATHS.HEARTBEAT_FILE

// ── ground-truth probe tick ──────────────────────────────────────────────────
// Asks the vendor what each account's utilization actually is, staggered so the three
// accounts never fire together. SHADOW MODE while USAGE_REAL_DECIDES is unset: the
// readings are written into accounts.json under each account's `real` block and logged,
// but every decision still runs on the legacy numbers. Flipping the flag is a separate,
// deliberate step after the readings have been watched for a day.
const PROBE_TICK_MS = Number(process.env.PROBE_TICK_MS) || 60 * 1000
const REAL_PROBE_ENABLED = process.env.USAGE_REAL_PROBE !== '0'
let _probeInFlight = false

async function probeTick() {
  if (!REAL_PROBE_ENABLED || _probeInFlight) return
  _probeInFlight = true
  try {
    const state = usage._readAccountsState ? (usage._readAccountsState() || {}) : {}
    const accounts = state.accounts || {}
    const nowMs = Date.now()
    const live = usageReal._currentLiveShort()
    const roster = accountsRegistry.enabled()
    // probeDue works in short names; accounts.json is keyed by email.
    const byShort = {}
    for (const short of roster) byShort[short] = accounts[short + '@ecodia.au'] || {}
    const due = usageReal.probeDue(byShort, nowMs, { order: roster })
    for (const short of due) {
      const email = short + '@ecodia.au'
      const row = accounts[email] || {}
      const regRow = accountsRegistry.get(short) || {}
      const res = await usageReal.probeAccount(short, {
        prior: row.real || {},
        nowMs: Date.now(),
        liveShort: live,
        registryRow: regRow,
        verifyIdentity: !((row.real || {}).identity_verified_at),
        onIdentity: (s, ids) => { try { accountsRegistry.setIdentity(s, ids, { by: 'usage-poller' }) } catch (e) {} },
      })
      usage._mergeRealBlock(email, res)
      if (res.probe_status !== 'ok') {
        console.log('[' + nowIso() + '] probe ' + short + ': ' + res.probe_status)
      }
    }
  } catch (e) {
    console.error('[probe-tick] ' + (e && e.message || e))
  } finally {
    _probeInFlight = false
  }
}

// probeSummary - per-account probe age + status, carried on the heartbeat so a canary can
// tell "the poller is alive" from "the poller is alive but blind". Silence in a measuring
// system reads identical to health unless the measurement itself is measured.
function probeSummary() {
  try {
    const state = usage._readAccountsState() || {}
    const out = {}
    for (const [email, row] of Object.entries(state.accounts || {})) {
      const real = row.real || {}
      out[email] = {
        status: real.probe_status || 'never',
        age_s: real.probed_at ? Math.round((Date.now() - Date.parse(real.probed_at)) / 1000) : null,
        util_5h: real.utilization_5h != null ? Math.round(real.utilization_5h * 100) : null,
        util_7d: real.utilization_7d != null ? Math.round(real.utilization_7d * 100) : null,
        capped: !!real.capped,
      }
    }
    return out
  } catch (e) { return {} }
}

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
// (CAP_5H_TOKENS and SWITCH_TRIGGER_PCT deleted 2026-08-02. Both were assigned here and
// never read: capAutoSwitch delegates the whole decision to account-cap-decide.js. They
// looked exactly like live tuning knobs while carrying 735M and 0.80 against a live cap
// of 41.5M, so anyone calibrating from this file read a number 17.7x off.)
const CCUSAGE_CLI_JS = process.env.CCUSAGE_CLI_JS || '/opt/homebrew/lib/node_modules/ccusage/dist/cli.js'
const SWITCH_REQUEST_FILE = path.join(_COORD_ROOT, 'usage', 'switch-request.json')

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
    // Decide, then hand off to the ONE sanctioned switch path.
    //
    // EXECUTION CHANGED 2026-08-02: this used to call creds.rotate_to, which writes a
    // stored snapshot into the Keychain. backend/CLAUDE.md had already banned that for
    // moving the live conductor, and the reason is structural: the Keychain holds one
    // identity and Anthropic refresh tokens are single-use, so a non-live snapshot is
    // usually a spent token. rotate_to therefore either refused (the stale-source guard)
    // or installed a dead lineage. account-switch.sh performs a full OAuth re-login and
    // mints fresh tokens, so it needs no snapshot at all.
    //
    // DETACHED, never spawnSync. A switch leg can legitimately run for minutes (the
    // money@ magic-link wait alone is bounded at 12), and a synchronous call would stall
    // this daemon's whole event loop: the 60-second cap watch, the probe tick and the
    // heartbeat all stop, and the heartbeat canary then reports a dead poller during
    // exactly the window a switch is in flight. The exit handler below reads the real
    // result; "launched" is never recorded as success.
    if (switchInFlight()) return
    const decideR = spawnSync(process.execPath, [path.join(AGENT_ROOT, 'tools', 'account-cap-decide.js')], { encoding: 'utf8', timeout: 25000 })
    let d = null
    try { d = JSON.parse(decideR.stdout) } catch (_) { return }
    if (!d || !d.shouldSwitch || !d.target) return  // hold / no-usable-target (alerting lives in the module)

    const targetShort = String(d.target).split('@')[0]
    const logFd = (() => { try { return fs.openSync(usageCfg.PATHS.SWITCH_LOG_FILE, 'a') } catch (e) { return 'ignore' } })()
    const child = spawn('bash', [ACCOUNT_SWITCH_SH, targetShort], {
      detached: true, stdio: ['ignore', logFd, logFd],
      env: Object.assign({}, process.env, { SWITCH_REASON: d.reason || 'cap-auto-switch' }),
    })
    child.unref()
    console.log('[' + nowIso() + '] cap-auto-switch: launching ' + d.live + ' -> ' + d.target + ' (' + d.reason + ')')
    child.on('exit', (code) => {
      // switch-run.js owns switch-request.json and swap_history.json; writing them here
      // too would race its RECORD step and corrupt real-limit-watch's suppression input,
      // which reads that file. Log the outcome and leave the files to their owner.
      const verdict = code === 0 ? 'verified'
        : code === 3 ? 'already_in_progress'
        : code === 4 ? 'no_op'
        : 'FAILED(' + code + ')'
      console.log('[' + nowIso() + '] cap-auto-switch result: ' + d.live + ' -> ' + d.target + ' = ' + verdict +
        (code === 0 ? '' : ' (see ' + usageCfg.PATHS.SWITCH_LOG_FILE + ')'))
    })
  } catch (e) { console.error('[cap-auto-switch] ' + (e && e.message || e)) }
}

// True while a switch holds the lock with a live heartbeat. Age alone would misjudge a
// slow-but-healthy leg, so a holder counts as gone only when its pid is dead or its
// heartbeat has stopped moving.
function switchInFlight() {
  let lock
  try { lock = JSON.parse(fs.readFileSync(usageCfg.PATHS.SWITCH_LOCK_FILE, 'utf8')) } catch (e) { return false }
  if (!lock || !lock.pid) return false
  try { process.kill(lock.pid, 0) } catch (e) { return false }
  const beatAt = Date.parse(lock.heartbeat_at || '')
  if (!isFinite(beatAt)) return true
  return (Date.now() - beatAt) < 5 * 60 * 1000
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
    writeHeartbeat({ ok: true, elapsed_ms: elapsed, summary: summary, probe: probeSummary() })
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
  // Ground-truth probe. The tick is 60s but each account is only probed on its own
  // stagger slot, so the vendor sees ~36 requests/hour across the fleet.
  if (REAL_PROBE_ENABLED) {
    probeTick()
    setInterval(probeTick, PROBE_TICK_MS)
    console.log('[' + nowIso() + '] usage ground-truth probe armed, tick=' + PROBE_TICK_MS +
      'ms, deciding=' + (process.env.USAGE_REAL_DECIDES === '1' ? 'YES' : 'no (shadow)'))
  }
}

main().catch(e => { console.error('fatal: ' + (e && e.stack || e)); process.exit(1) })

// Graceful shutdown - flush a heartbeat with shutdown marker
process.on('SIGTERM', () => { writeHeartbeat({ shutdown: 'SIGTERM' }); process.exit(0) })
process.on('SIGINT', () => { writeHeartbeat({ shutdown: 'SIGINT' }); process.exit(0) })
