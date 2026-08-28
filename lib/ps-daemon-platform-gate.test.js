'use strict'

// Unit test for the 2026-08-29 PowerShell platform gate (Co-Exist lane B1 pass 5).
//
// WHAT WAS BROKEN. lib/ps-daemon.js hardcodes POWERSHELL_EXE = 'powershell.exe'
// and every GUI primitive in tools/window.js (foreground / windows /
// focus_window) is Win32 PowerShell: Add-Type of user32.dll, P/Invoke of
// GetForegroundWindow and EnumWindows. The canonical host has been a Mac since
// 2026-06-08 and `which pwsh powershell powershell.exe` returns nothing.
//
// The daemon therefore never spawns, runOrFallback drops to spawnSync, spawnSync
// throws ENOENT, and the throw is caught and returned as a generic {ok:false}.
// Every caller sits inside an empty `catch (e) {}` - wakeConductor's flash and
// auto_type tiers are the load-bearing example - so a primitive that CANNOT work
// on this platform failed silently, per call, indefinitely. Pass 4 measured the
// whole chain end to end: wake policy set to auto_type, last_wake_at advanced,
// conductor last_seen_at did not move.
//
// THE FIX. Refuse at the bottom of the stack, before any spawn, with a reason a
// caller can act on: {ok:false, reason:'unsupported_platform', unsupported_platform:true}.
// An explicitly-set POWERSHELL_EXE that resolves on disk still wins, so a Mac
// with pwsh installed is not locked out by platform string alone.
//
// Run: node lib/ps-daemon-platform-gate.test.js

const assert = require('assert')
const path = require('path')

let failures = 0
function check(name, fn) {
  try { fn(); console.log('  PASS  ' + name) }
  catch (e) { failures++; console.log('  FAIL  ' + name + '\n        ' + e.message) }
}

function freshPsd(env) {
  delete require.cache[require.resolve('./ps-daemon.js')]
  const saved = {}
  for (const k of Object.keys(env)) { saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k] }
  const mod = require('./ps-daemon.js')
  return { mod: mod, restore: () => {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]
    }
  } }
}

async function main() {
  console.log('platform under test: ' + process.platform)

  // ── The gate refuses on a non-win32 host with no usable PowerShell ───────
  const a = freshPsd({ POWERSHELL_EXE: undefined })
  try {
    check('psSupported() is exported so callers can ask before they try', () => {
      assert.strictEqual(typeof a.mod.psSupported, 'function')
    })

    if (process.platform !== 'win32') {
      check('psSupported() is false on this host', () => {
        assert.strictEqual(a.mod.psSupported().ok, false)
      })
      check('psSupported() names the platform in its reason', () => {
        assert.strictEqual(a.mod.psSupported().reason, 'unsupported_platform')
      })

      const fb = a.mod.runFallback('Write-Output hi')
      check('runFallback refuses without spawning', () => {
        assert.strictEqual(fb.ok, false)
        assert.strictEqual(fb.reason, 'unsupported_platform')
        assert.strictEqual(fb.unsupported_platform, true)
      })
      check('the refusal says WHY, not just that it failed', () => {
        assert.ok(/darwin|platform/i.test(String(fb.error || '')),
          'error was ' + JSON.stringify(fb.error))
      })

      const rof = await a.mod.runOrFallback('Write-Output hi')
      check('runOrFallback refuses the same way', () => {
        assert.strictEqual(rof.ok, false)
        assert.strictEqual(rof.reason, 'unsupported_platform')
      })

      const run = await a.mod.run('Write-Output hi')
      check('run() refuses rather than queueing against a daemon that cannot exist', () => {
        assert.strictEqual(run.ok, false)
        assert.strictEqual(run.reason, 'unsupported_platform')
      })

      check('ensureAlive() is a no-op instead of a respawn loop', () => {
        a.mod.ensureAlive()
        assert.strictEqual(a.mod.stats().alive, false)
      })
      check('stats() reports the platform verdict so a health probe can read it', () => {
        assert.strictEqual(a.mod.stats().platform_supported, false)
      })
    }
  } finally { a.restore() }

  // ── An explicit, resolvable POWERSHELL_EXE still wins ────────────────────
  // /bin/sh is not PowerShell; it is a real executable, which is all the gate
  // is allowed to assert. The gate's job is "is there something to run", not
  // "is that something genuinely pwsh".
  const b = freshPsd({ POWERSHELL_EXE: '/bin/sh' })
  try {
    check('an explicit resolvable POWERSHELL_EXE overrides the platform check', () => {
      assert.strictEqual(b.mod.psSupported().ok, true)
    })
  } finally { b.restore() }

  // ── An explicit but MISSING POWERSHELL_EXE does not fool the gate ────────
  const c = freshPsd({ POWERSHELL_EXE: path.join('/nonexistent', 'pwsh-' + Date.now()) })
  try {
    check('an explicit but missing POWERSHELL_EXE is still unsupported', () => {
      assert.strictEqual(c.mod.psSupported().ok, false)
    })
  } finally { c.restore() }

  console.log('\n' + (failures === 0
    ? 'ALL PASS - the Win32 GUI substrate refuses loudly on a Mac instead of failing silent.'
    : failures + ' FAILURE(S)'))
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
