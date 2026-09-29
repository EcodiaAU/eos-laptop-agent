// dispatch-precheck.js - a zero-token gate a leased row passes BEFORE dispatchOne
// opens a worker tab. (2026-09-29, Tate: "a mechanical check that fires before
// this gmail inbox poll scheduled worker, so that we aren't just wasting tokens".)
//
// WHY. A worker tab's cost is mostly fixed overhead. Measured over the 65
// gmail-inbox-poll fires in the 14 days to 2026-09-29: median 10.4M cache-read,
// 195k cache-write, 32k output tokens per fire, and the fires whose own Phase 0
// found nothing to judge cost the same as the rest. When a cron's deterministic
// half can say "nothing to do" in a minute of plain Node, the tab is pure waste.
//
// HOW. tools/dispatch-prechecks.json maps an EXACT row name to an argv. dispatchOne
// runs it under the launch-lock after the austerity, claim and breaker gates and
// before any account pick, worktree or tab. The LAST non-empty stdout line must be
// JSON {"verdict":"skip"|"spawn","reason":"..."}.
//
// FAILS OPEN, ALWAYS. Missing registry, bad entry, non-zero exit, timeout, crash,
// unparseable output, or any verdict other than the exact string "skip" all return
// spawn, which is today's behaviour. A broken precheck therefore costs its savings
// and never silences a cron. run() never rejects.
//
// WHY A FILE AND NOT A COLUMN OR A PROMPT DIRECTIVE. Rows are insertable through
// the remote scheduler MCP, so a row-carried command would be shell on this Mac
// for anyone who can insert a row. The registry lives on disk, reviewed like code.
// It is re-read on every call, so an entry can be added, tuned or disabled
// ("enabled": false) without restarting the agent.
'use strict'

const fs = require('fs')
const path = require('path')
const { execFile } = require('child_process')

const DEFAULT_REGISTRY = path.join(__dirname, 'dispatch-prechecks.json')
const DEFAULT_TIMEOUT_MS = 150000
const MAX_TIMEOUT_MS = 300000 // this runs under the fleet-wide launch-lock

let _registryPath = process.env.EOS_DISPATCH_PRECHECKS || DEFAULT_REGISTRY
let _runner = null // test seam: (file, args, opts) => Promise<{code, stdout, timedOut}>

exports._setRegistryPath = function (p) { _registryPath = p || DEFAULT_REGISTRY }
exports._setRunner = function (fn) { _runner = fn }

function loadRegistry() {
  try {
    const obj = JSON.parse(fs.readFileSync(_registryPath, 'utf8'))
    return (obj && typeof obj === 'object' && obj.prechecks && typeof obj.prechecks === 'object') ? obj.prechecks : {}
  } catch (e) {
    return {}
  }
}

exports.entryFor = function entryFor(row) {
  if (!row || typeof row.name !== 'string') return null
  const reg = loadRegistry()
  if (!Object.prototype.hasOwnProperty.call(reg, row.name)) return null
  const e = reg[row.name]
  if (!e || e.enabled === false) return null
  const types = Array.isArray(e.types) && e.types.length ? e.types : ['cron']
  if (!types.includes(row.type)) return null
  return e
}

function defaultRunner(file, args, opts) {
  return new Promise((resolve) => {
    execFile(file, args, opts, (err, stdout) => {
      if (!err) return resolve({ code: 0, stdout: String(stdout || ''), timedOut: false })
      resolve({
        code: typeof err.code === 'number' ? err.code : -1,
        stdout: String(stdout || ''),
        timedOut: !!(err.killed || err.signal),
      })
    })
  })
}

function lastJsonLine(stdout) {
  const lines = String(stdout || '').split('\n').map(s => s.trim()).filter(Boolean)
  if (!lines.length) return null
  try { return JSON.parse(lines[lines.length - 1]) } catch (e) { return null }
}

// -> { verdict: 'skip'|'spawn', cause, reason, ms }. cause 'no-entry' means the
// row has no precheck and the caller should stay silent.
exports.run = async function run(row) {
  const t0 = Date.now()
  const out = (verdict, cause, reason) => ({ verdict, cause, reason: reason || '', ms: Date.now() - t0 })
  let entry
  try { entry = exports.entryFor(row) } catch (e) { return out('spawn', 'registry-error', e.message) }
  if (!entry) return out('spawn', 'no-entry')
  const argv = entry.argv
  if (!Array.isArray(argv) || !argv.length || !argv.every(a => typeof a === 'string') || !path.isAbsolute(argv[0])) {
    return out('spawn', 'bad-entry', 'argv must be a non-empty string array with an absolute executable')
  }
  const timeout = Math.min(Math.max(Number(entry.timeout_ms) || DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS)
  let res
  try {
    res = await (_runner || defaultRunner)(argv[0], argv.slice(1), {
      timeout,
      maxBuffer: 4 * 1024 * 1024,
      env: Object.assign({}, process.env, { EOS_PRECHECK_ROW_ID: String(row.id || ''), EOS_PRECHECK_ROW_NAME: String(row.name || '') }),
    })
  } catch (e) {
    return out('spawn', 'runner-threw', e && e.message)
  }
  if (res.timedOut) return out('spawn', 'timeout', 'no verdict within ' + timeout + 'ms')
  if (res.code !== 0) return out('spawn', 'exit-' + res.code)
  const v = lastJsonLine(res.stdout)
  if (!v || typeof v !== 'object') return out('spawn', 'unparseable', String(res.stdout || '').slice(-200))
  if (v.verdict === 'skip') return out('skip', 'verdict', String(v.reason || ''))
  return out('spawn', 'verdict', String(v.reason || ''))
}
