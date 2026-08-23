'use strict'

// tool-autoload.js - fault-tolerant loader for the laptop-agent tool modules.
//
// WHY THIS EXISTS (2026-08-13 crash-loop hardening, Tate overseas from ~2026-09-24):
// index.js used to require() every file in tools/ inside a bare loop with NO
// per-file try/catch. One load-time throw - a bad dep after `npm i`, a half-
// written commit, an extension update that broke a shared module - crashed boot
// before app.listen. The laptop-agent plist is KeepAlive + ThrottleInterval=10,
// so launchd respawned the crashing process every ~10s FOREVER, silently: no
// API, no dispatch, no alert. The dispatcher is the sole path for all scheduled
// work, so a silent boot crash-loop is survival-critical when no human is at the
// keyboard. Handoff: drafts/away-resilience/HANDOFF-threat-hunt-2026-08-13.md
// (Hunter 4 #1). Doctrine: mac-unattended-resilience-conductor-survival-2026-08-13.
//
// This loader wraps each require() so a single bad tool file is SKIPPED and
// logged (filename + error), and the agent still comes up with every remaining
// tool. A degraded agent (missing one tool) is strictly better than a dead one.
//
// The test-file skip filter is preserved verbatim from the old inline loop: test
// and harness files run assertions and call process.exit() at load (no
// require.main guard), which would kill the server mid-autoload. Match BOTH the
// suffix conventions (*.test.js / *.spec.js / *.bench.js / *.integration.js) AND
// the `test-` prefix convention - tools/test-tab-title-match.js slipped the old
// suffix-only filter, ran its suite at require(), printed "7 passed" and exited
// before app.listen; the agent was down ~5h on 2026-06-22.
// ALSO the `-test.js` suffix convention (tools/route-test.js): a hands-on manual
// CLI with an unguarded top-level IIFE that pasted a marker into Tate's first CC
// tab and called process.exit(0) at require - launchd respawned it into a paste-
// loop (2026-08-23). It carries its own require.main guard now, but a manual
// harness has no business being autoloaded as a tool, so the filter skips it too.

const fs = require('fs')
const path = require('path')

const SKIP_RE = /(^test-|-test\.js$|\.(test|spec|bench|integration)\.js$)/

// loadTools({ toolDir, logger, requireFn }) -> { tools, loaded, failed }
//   tools   : { "<module>.<export>": fn }  (registry, same shape as before)
//   loaded  : [ "<module>", ... ]           (modules that loaded cleanly)
//   failed  : [ { file, error }, ... ]       (modules that threw at require)
//
// logger defaults to console; requireFn is injectable so a test can point the
// loader at a fixture directory without going through Node's module cache for
// the real tools. A require throw NEVER propagates - it is captured into failed.
function loadTools(opts) {
  const o = opts || {}
  const toolDir = o.toolDir
  const logger = o.logger || console
  const requireFn = o.requireFn || require
  if (!toolDir) throw new Error('loadTools: toolDir required')

  const tools = {}
  const loaded = []
  const failed = []

  let files
  try {
    files = fs.readdirSync(toolDir)
  } catch (e) {
    // The tools directory itself is unreadable. Log and return an empty registry
    // rather than throwing - the caller can still bring up the bare HTTP surface.
    logger.error('[autoload] tools directory unreadable (' + toolDir + '): ' + (e && e.message || e))
    return { tools, loaded, failed }
  }

  for (const file of files) {
    if (!file.endsWith('.js')) continue
    if (SKIP_RE.test(file)) continue
    const moduleName = path.basename(file, '.js')
    try {
      const mod = requireFn(path.join(toolDir, file))
      if (mod && typeof mod === 'object') {
        for (const [name, fn] of Object.entries(mod)) {
          tools[moduleName + '.' + name] = fn
        }
      }
      loaded.push(moduleName)
    } catch (e) {
      // A single bad tool file must NOT crash boot. Skip it, keep going.
      failed.push({ file, error: (e && e.message) || String(e) })
      logger.error('[autoload] SKIPPED tool file ' + file + ' (load-time error): ' +
        ((e && e.stack) || (e && e.message) || String(e)))
    }
  }

  if (failed.length) {
    logger.error('[autoload] ' + failed.length + ' tool file(s) failed to load and were skipped: ' +
      failed.map(f => f.file).join(', ') + '. Agent came up with the remaining ' + loaded.length + '.')
  }

  return { tools, loaded, failed }
}

module.exports = { loadTools, SKIP_RE }
