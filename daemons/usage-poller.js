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
    const r = spawnSync(process.execPath, [CCUSAGE_CLI_JS, 'blocks', '--active', '--json'], { encoding: 'utf8', timeout: 30000 })
    if (r.status !== 0 || !r.stdout) return
    const blocks = (JSON.parse(r.stdout).blocks) || []
    const b = blocks.find(x => x.isActive) || blocks[0]
    if (!b || !b.endTime) return
    const cur = b.totalTokens || 0
    const pct = cur / CAP_5H_TOKENS
    if (pct < SWITCH_TRIGGER_PCT) return  // plenty of headroom, nothing to do

    // Cap approaching. Ask the agent for the healthiest account and the live one.
    // pick_healthiest_account honours ACCOUNTS_DISABLED + headroom; current_account
    // is the live Keychain identity. A switch is only worthwhile if the healthiest
    // is a DIFFERENT, enabled account (i.e. a real alternate exists).
    const best = agentTool('creds.pick_healthiest_account', { required_headroom_minutes: 15 })
    const live = agentTool('creds.current_account', {})
    const haveAlternate = best && live && best !== live && best !== 'unknown' && best !== 'current-process'

    if (!haveAlternate) {
      // Single-account reality: nowhere to switch. Hold silently. NO text to Tate.
      console.log('[' + nowIso() + '] cap-auto-switch: ' + Math.round(pct * 100) + '% of 5h block, no alternate account available (best=' + best + ' live=' + live + ') - holding')
      return
    }

    // A healthy alternate exists. Fire the EXISTING switch procedure: schedule a
    // fresh CC chat (scheduler.schedule_delayed = "open a chat via scheduler")
    // whose prompt drives the Claude VS Code OAuth sign-in flow to `best` (which
    // mints a FRESH token, unlike the clobber-prone file-swap). Dedupe per block.
    const st = readJsonSafe(SWITCH_REQUEST_FILE, {})
    if (st.block === b.endTime && st.target === best) return

    const switchPrompt = [
      'You are EcodiaOS. AUTONOMOUS ACCOUNT SWITCH (fired by the usage-poller cap trigger at ' + Math.round(pct * 100) + '% of the 5h block on ' + live + ').',
      'GOAL: switch the active Claude Code account from ' + live + ' to ' + best + ' via the VS Code OAuth sign-in flow (this mints a FRESH token; do NOT use the file-swap rotate_to, which clobbers with a stale snapshot).',
      'STEPS: (1) trigger Claude Code sign-out/sign-in (command palette "Claude Code: Sign In" / the /login link). (2) gui.enable_chrome_cdp and CDP-drive the claude.ai OAuth page: pick the ' + best + '@ecodia.au Google account and approve. (3) verify the new live token: creds.current_account should report ' + best + ' (or the Keychain accessToken changed). (4) confirm the IDE quota bar reflects ' + best + '.',
      'Reference doctrine: claude-max-account-routing-is-vscode-extension-driven, cc-webview-chat-input-and-submit-unreachable, scheduler-cred-rotation-clobbered-live-keychain-2026-06-14. End with coord.signal_done + coord.close_my_tab.',
    ].join('\n\n')

    const sched = agentTool('scheduler.schedule_delayed', {
      name: 'autonomous-account-switch-' + best + '-' + Date.now(),
      delay: 'in 1m',
      prompt: switchPrompt,
    })
    fs.writeFileSync(SWITCH_REQUEST_FILE, JSON.stringify({
      block: b.endTime, target: best, from: live, pct: Math.round(pct * 100),
      raised_at: nowIso(), scheduled: !!sched, status: sched ? 'scheduled' : 'schedule_failed',
    }), 'utf8')
    console.log('[' + nowIso() + '] cap-auto-switch: ' + Math.round(pct * 100) + '% - scheduled OAuth switch ' + live + ' -> ' + best + ' (sched=' + !!sched + ')')
  } catch (e) { console.error('[cap-auto-switch] ' + (e && e.message || e)) }
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
}

main().catch(e => { console.error('fatal: ' + (e && e.stack || e)); process.exit(1) })

// Graceful shutdown - flush a heartbeat with shutdown marker
process.on('SIGTERM', () => { writeHeartbeat({ shutdown: 'SIGTERM' }); process.exit(0) })
process.on('SIGINT', () => { writeHeartbeat({ shutdown: 'SIGINT' }); process.exit(0) })
