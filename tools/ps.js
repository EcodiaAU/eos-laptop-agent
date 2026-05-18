// ps.js - diagnostic + escape-hatch tools for the PS daemon (lib/ps-daemon).
//
// Most tools should NOT call ps.run directly - they should use the daemon via
// the per-tool helper (clipboard.js, window.js, uia.js etc do this). ps.run
// is exposed here for ad-hoc diagnostics and for callers that genuinely need
// raw PS exec from outside the laptop-agent tool family.

const psd = require('../lib/ps-daemon')

async function stats() {
  return psd.stats()
}

async function run(params) {
  params = params || {}
  const script = params.script
  if (typeof script !== 'string' || !script.length) throw new Error('script (non-empty string) required')
  const opts = { timeout_ms: params.timeout_ms || 8000 }
  return await psd.runOrFallback(script, opts)
}

async function ensureAlive() {
  psd.ensureAlive()
  // Give the daemon a beat to initialize
  await new Promise(r => setTimeout(r, 250))
  return psd.stats()
}

async function restart() {
  psd.shutdown()
  await new Promise(r => setTimeout(r, 500))
  psd.ensureAlive()
  await new Promise(r => setTimeout(r, 500))
  return psd.stats()
}

module.exports = {
  stats: stats,
  run: run,
  ensureAlive: ensureAlive,
  restart: restart,
}
