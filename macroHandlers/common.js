// macroHandlers/common.js
// Shared helpers for macro handlers. Wraps input.* + screenshot.* so dryRun
// records a step plan without executing. Also provides polling waits and
// per-step timing logger.
//
// WAIT/SLEEP DISCIPLINE (Tate addendum 29 Apr 2026 15:08 AEST):
// - After input.shortcut [ctrl, l] (focus URL bar): >=200ms
// - After input.type URL: >=200ms
// - After input.key enter (page nav): use waitForPageReady, NOT a static sleep
// - After input.click on any field: 800-1500ms (let dropdown/autofill render)
// - After form submission: use waitForPageReady, NOT a static sleep
// - For 2FA detection: poll screenshot every 1s for up to 15s
// Polling waits are PREFERRED over static sleeps. Static sleeps are fallback only.
//
// Authored by fork_mojldsgx_7b55bf, 29 Apr 2026.

const path = require('path')

const inputTool = require(path.join(__dirname, '..', 'tools', 'input.js'))
const screenshotTool = require(path.join(__dirname, '..', 'tools', 'screenshot.js'))

function makeHelpers(dryRun) {
  const plan = []
  const timings = []

  const wrap = (modName, fnName, fn) => async (args) => {
    const stepArgs = sanitizeArgs(args)
    const t0 = Date.now()
    plan.push({ tool: `${modName}.${fnName}`, args: stepArgs })
    if (dryRun) {
      timings.push({ step: `${modName}.${fnName}`, ms: 0, dryRun: true })
      return { dryRun: true, planned: `${modName}.${fnName}`, args: stepArgs }
    }
    const r = await fn(args || {})
    timings.push({ step: `${modName}.${fnName}`, ms: Date.now() - t0 })
    return r
  }

  const helpers = {
    input: {
      click: wrap('input', 'click', inputTool.click),
      move: wrap('input', 'move', inputTool.move),
      type: wrap('input', 'type', inputTool.type),
      key: wrap('input', 'key', inputTool.key),
      shortcut: wrap('input', 'shortcut', inputTool.shortcut),
      drag: wrap('input', 'drag', inputTool.drag),
    },
    screenshot: {
      screenshot: async (args) => {
        const t0 = Date.now()
        plan.push({ tool: 'screenshot.screenshot', args: { format: (args || {}).format || 'png' } })
        if (dryRun) {
          timings.push({ step: 'screenshot.screenshot', ms: 0, dryRun: true })
          return { dryRun: true, image: null }
        }
        const r = await screenshotTool.screenshot(args || {})
        timings.push({ step: 'screenshot.screenshot', ms: Date.now() - t0 })
        return r
      },
    },
    sleep: async (ms) => {
      plan.push({ tool: 'sleep', args: { ms } })
      if (!dryRun) await new Promise(r => setTimeout(r, ms))
      timings.push({ step: 'sleep', ms })
    },
    note: (msg) => {
      plan.push({ tool: 'note', args: { message: msg } })
    },
    mark: (label) => {
      timings.push({ step: `mark:${label}`, ms: Date.now(), absolute: true })
    },
    plan,
    timings,
    dryRun,
  }
  return helpers
}

function sanitizeArgs(args) {
  if (!args || typeof args !== 'object') return args
  const out = {}
  for (const [k, v] of Object.entries(args)) {
    if (/password|secret|token|2fa|code/i.test(k)) {
      out[k] = '[REDACTED]'
    } else if (typeof v === 'string' && v.length > 200) {
      out[k] = v.slice(0, 200) + '...[trunc]'
    } else if (typeof v === 'object' && v !== null) {
      out[k] = sanitizeArgs(v)
    } else {
      out[k] = v
    }
  }
  return out
}

function simpleHash(b64) {
  let h = 0
  for (let i = 0; i < Math.min(b64.length, 8000); i += 13) {
    h = (h * 31 + b64.charCodeAt(i)) >>> 0
  }
  return h.toString(16)
}

// waitForVisualSettle - poll until the screenshot hash stops changing.
// Use after a click/input that may trigger an animation or partial redraw.
async function waitForVisualSettle(helpers, intervalMs, maxMs) {
  intervalMs = intervalMs || 800
  maxMs = maxMs || 6000
  helpers.note(`waitForVisualSettle interval=${intervalMs} max=${maxMs}`)
  if (helpers.dryRun) return { settled: true, dryRun: true }
  const start = Date.now()
  let lastHash = null
  while (Date.now() - start < maxMs) {
    await new Promise(r => setTimeout(r, intervalMs))
    const shot = await screenshotTool.screenshot({ format: 'png' })
    if (!shot.image) return { settled: false, error: 'screenshot failed' }
    const hash = simpleHash(shot.image)
    if (lastHash && lastHash === hash) return { settled: true, hash, ms: Date.now() - start }
    lastHash = hash
  }
  return { settled: false, ms: Date.now() - start, reason: 'maxMs exceeded' }
}

// waitForVisualChange - poll until the screenshot hash diverges from baseline.
// Use IMMEDIATELY after a navigation trigger (Enter on URL bar, click Sign In)
// to confirm the page actually started loading. If the baseline is null, the
// first screenshot becomes the baseline.
async function waitForVisualChange(helpers, baselineHash, intervalMs, maxMs) {
  intervalMs = intervalMs || 500
  maxMs = maxMs || 10000
  helpers.note(`waitForVisualChange interval=${intervalMs} max=${maxMs}`)
  if (helpers.dryRun) return { changed: true, dryRun: true }
  const start = Date.now()
  let baseline = baselineHash
  if (!baseline) {
    const first = await screenshotTool.screenshot({ format: 'png' })
    if (!first.image) return { changed: false, error: 'baseline screenshot failed' }
    baseline = simpleHash(first.image)
  }
  while (Date.now() - start < maxMs) {
    await new Promise(r => setTimeout(r, intervalMs))
    const shot = await screenshotTool.screenshot({ format: 'png' })
    if (!shot.image) continue
    const hash = simpleHash(shot.image)
    if (hash !== baseline) return { changed: true, hash, baseline, ms: Date.now() - start }
  }
  return { changed: false, ms: Date.now() - start, reason: 'maxMs exceeded' }
}

// waitForPageReady - the canonical post-navigation wait. Two-phase:
// (1) wait for the screenshot to diverge from the pre-nav baseline (page started)
// (2) wait for it to settle (page finished rendering / hydrating)
// Use after URL-bar Enter, after Sign In click, after any form submit.
async function waitForPageReady(helpers, opts) {
  opts = opts || {}
  const changeMaxMs = opts.changeMaxMs || 10000
  const settleIntervalMs = opts.settleIntervalMs || 800
  const settleMaxMs = opts.settleMaxMs || 8000
  helpers.note('waitForPageReady (change + settle)')
  if (helpers.dryRun) return { ready: true, dryRun: true }
  const start = Date.now()
  // Capture pre-nav baseline.
  const pre = await screenshotTool.screenshot({ format: 'png' })
  if (!pre.image) return { ready: false, error: 'pre screenshot failed' }
  const baseline = simpleHash(pre.image)
  const changed = await waitForVisualChange(helpers, baseline, 500, changeMaxMs)
  const settled = await waitForVisualSettle(helpers, settleIntervalMs, settleMaxMs)
  return { ready: settled.settled, changed: changed.changed, settled: settled.settled, ms: Date.now() - start }
}

// pollFor2FA - poll screenshot every intervalMs for up to maxMs and return the
// final shot. Caller decides whether to surface the screenshot to a human or
// retry with a fetched code. We do not OCR here; the conductor decides.
async function pollFor2FA(helpers, intervalMs, maxMs) {
  intervalMs = intervalMs || 1000
  maxMs = maxMs || 15000
  helpers.note(`pollFor2FA interval=${intervalMs} max=${maxMs}`)
  if (helpers.dryRun) return { polled: true, dryRun: true }
  const start = Date.now()
  let lastShot = null
  while (Date.now() - start < maxMs) {
    await new Promise(r => setTimeout(r, intervalMs))
    lastShot = await screenshotTool.screenshot({ format: 'png' })
    if (!lastShot.image) continue
  }
  return { polled: true, ms: Date.now() - start, screenshot: lastShot && lastShot.image ? `${lastShot.image.length} bytes b64` : null }
}

// Open a fresh tab and navigate via address bar, then wait for the page to be
// ready. Replaces ad-hoc shortcut+type+enter sequences across handlers.
async function newTabAndNavigate(helpers, url, opts) {
  opts = opts || {}
  helpers.note(`open new tab and navigate to ${url}`)
  await helpers.input.shortcut({ keys: ['ctrl', 't'] })
  await helpers.sleep(400)
  await helpers.input.shortcut({ keys: ['ctrl', 'l'] })
  await helpers.sleep(200) // bar focus + clear
  await helpers.input.type({ text: url, delay: 5 })
  await helpers.sleep(200)
  await helpers.input.key({ key: 'enter' })
  // Page-ready polling instead of a static 3-5s sleep.
  await waitForPageReady(helpers, { changeMaxMs: opts.changeMaxMs || 10000, settleMaxMs: opts.settleMaxMs || 8000 })
}

module.exports = {
  makeHelpers,
  waitForVisualSettle,
  waitForVisualChange,
  waitForPageReady,
  pollFor2FA,
  newTabAndNavigate,
}