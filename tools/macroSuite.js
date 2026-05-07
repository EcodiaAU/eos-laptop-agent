// tools/macroSuite.js
// Higher-level macro dispatcher. Distinct from tools/macro.js which runs raw
// AHK scripts. macroSuite orchestrates input.* + screenshot.* via Node handlers
// in ../macroHandlers/. Auto-loaded by index.js as `macroSuite.<fn>`.
//
// Surface:
//   macroSuite.run({ name, params?, dryRun? })  -> executes a macro
//   macroSuite.list()                           -> registry contents
//   macroSuite.describe({ name })               -> dry-run plan only
//
// Wait/sleep discipline (Tate addendum 29 Apr 2026 15:08 AEST): handlers must
// use polling waits (waitForPageReady / waitForVisualSettle / pollFor2FA) over
// static sleeps. See macroHandlers/common.js for the helpers.
//
// Authored by fork_mojldsgx_7b55bf, 29 Apr 2026.

const fs = require('fs')
const path = require('path')

const { makeHelpers } = require('../macroHandlers/common')
const { HANDLERS } = require('../macroHandlers')

const REGISTRY_PATH = path.join(__dirname, '..', 'macros', 'registry.json')

function loadRegistry() {
  try {
    return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'))
  } catch (e) {
    return { macros: [] }
  }
}

async function run({ name, params, dryRun }) {
  if (!name) throw new Error('macroSuite.run requires { name }')
  const handler = HANDLERS[name]
  if (!handler) {
    throw new Error(`Unknown macro: ${name}. Available: ${Object.keys(HANDLERS).join(', ')}`)
  }
  const helpers = makeHelpers(!!dryRun)
  const startTs = Date.now()
  let result, error
  try {
    result = await handler.handle({ params: params || {}, helpers })
  } catch (e) {
    error = e && e.message ? e.message : String(e)
    result = { success: false, error }
  }
  const durationMs = Date.now() - startTs

  // Build a sanitized run record. Handlers may include screenshots in `result`,
  // we keep them in the live result but the runRecord only carries metadata.
  const sanitizedParams = sanitizeForLog(params || {})
  const runRecord = {
    name,
    params: sanitizedParams,
    success: !!(result && result.success),
    error: error || (result && result.error) || null,
    duration_ms: durationMs,
    ts: new Date().toISOString(),
    dry_run: !!dryRun,
    steps: helpers.plan.length,
    timings: helpers.timings,
  }

  return {
    macro: name,
    dryRun: !!dryRun,
    duration_ms: durationMs,
    plan: helpers.plan,
    timings: helpers.timings,
    result,
    runRecord,
  }
}

async function list() {
  const registry = loadRegistry()
  const handlers = Object.values(HANDLERS).map(h => ({
    name: h.name,
    description: h.description,
    params: h.params || {},
  }))
  return { registry, handlers }
}

async function describe({ name }) {
  return run({ name, params: {}, dryRun: true })
}

function sanitizeForLog(args) {
  if (!args || typeof args !== 'object') return args
  const out = {}
  for (const [k, v] of Object.entries(args)) {
    if (/password|secret|token|2fa|code/i.test(k)) {
      out[k] = '[REDACTED]'
    } else if (typeof v === 'string' && v.length > 200) {
      out[k] = v.slice(0, 200) + '...[trunc]'
    } else if (typeof v === 'object' && v !== null) {
      out[k] = sanitizeForLog(v)
    } else {
      out[k] = v
    }
  }
  return out
}

module.exports = { run, list, describe }