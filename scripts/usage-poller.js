#!/usr/bin/env node
// usage-poller.js - scheduled cron entrypoint.
//
// Runs `usage._poll()` once and exits. Designed to be invoked by Windows
// Task Scheduler every 5 minutes. Writes account state + audit log to
// D:\.code\EcodiaOS\coordination\usage\.
//
// Registration (one-time, run in elevated PowerShell):
//
//   schtasks /create /sc MINUTE /mo 5 /tn "ecodia-usage-poller" `
//     /tr "node.exe D:\.code\eos-laptop-agent\scripts\usage-poller.js" `
//     /ru "$env:USERNAME" /rl LIMITED /f
//
// Logs to %USERPROFILE%\.ecodiaos\usage-poller.log (one JSON line per run).

const fs = require('fs')
const path = require('path')
const os = require('os')

const usage = require(path.join(__dirname, '..', 'tools', 'usage.js'))

const LOG_PATH = path.join(os.homedir(), '.ecodiaos', 'usage-poller.log')

function logLine(obj) {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true })
    fs.appendFileSync(LOG_PATH, JSON.stringify(obj) + '\n', 'utf8')
  } catch (e) {}
}

;(async () => {
  const startMs = Date.now()
  try {
    const result = usage._poll()
    const elapsedMs = Date.now() - startMs
    const summary = {
      ts: new Date().toISOString(),
      ok: true,
      elapsed_ms: elapsedMs,
      active_account: result.active_account,
      per_account_5h_tokens: Object.fromEntries(
        Object.keys(result.accounts).map(a => [a, result.accounts[a].tokens_5h])
      ),
      per_account_weekly_tokens: Object.fromEntries(
        Object.keys(result.accounts).map(a => [a, result.accounts[a].tokens_weekly])
      ),
      per_account_headroom: Object.fromEntries(
        Object.keys(result.accounts).map(a => [a, +(result.accounts[a].headroom_score).toFixed(4)])
      ),
    }
    logLine(summary)
    process.exit(0)
  } catch (e) {
    logLine({ ts: new Date().toISOString(), ok: false, error: e.message, stack: (e.stack || '').split('\n').slice(0, 5).join('  ||  ') })
    process.exit(1)
  }
})()
