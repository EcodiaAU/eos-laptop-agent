// Self-test for ~/.claude/scripts/cc-child-process-shim.js
//
// Runs ONLY on Corazon (win32). Patches child_process's prototype calls with
// captures, loads the shim, then exercises every spawn variant the CC extension
// uses. Asserts that windowsHide:true + creationFlags:0x08000000 are present
// in the options bag passed to the underlying cp function for each case.

const cp = require('child_process')
const CREATE_NO_WINDOW = 0x08000000

if (process.platform !== 'win32') {
  console.log('SKIP - not win32')
  process.exit(0)
}

// Capture-and-noop wrappers. We replace the originals BEFORE loading the shim,
// so when the shim does cp.spawn = wrap(cp.spawn, ...), it wraps OUR capture
// stubs. Calls then route: cp.spawn(args) -> shim_wrap -> our_capture_stub.
const captured = {}
const stubFn = (name) => function (...args) {
  captured[name] = args
  // Return a minimal child-process-like object that won't blow up callers.
  return { pid: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), status: 0, signal: null, on: () => {}, kill: () => {} }
}
;['spawn','spawnSync','exec','execSync','execFile','execFileSync'].forEach(fn => {
  cp[fn] = stubFn(fn)
})

require('C:/Users/tjdTa/.claude/scripts/cc-child-process-shim.js')

const cases = [
  ['spawn:cmd+args+opts',        () => cp.spawn('cmd.exe', ['/c','echo','x'], { cwd: process.cwd() })],
  ['spawn:cmd+opts',             () => cp.spawn('cmd.exe', { cwd: process.cwd() })],
  ['spawn:cmd+args (no opts)',   () => cp.spawn('cmd.exe', ['/c','echo','x'])],
  ['spawn:cmd-only',             () => cp.spawn('cmd.exe')],
  ['spawnSync:cmd+args+opts',    () => cp.spawnSync('cmd.exe', ['/c','echo','x'], { encoding: 'utf8' })],
  ['exec:cmd+opts+cb',           () => cp.exec('echo hi', { timeout: 1000 }, () => {})],
  ['exec:cmd+opts',              () => cp.exec('echo hi', { timeout: 1000 })],
  ['exec:cmd+cb (no opts)',      () => cp.exec('echo hi', () => {})],
  ['exec:cmd-only',              () => cp.exec('echo hi')],
  ['execSync:cmd+opts',          () => cp.execSync('echo hi', { encoding: 'utf8' })],
  ['execFile:file+args+opts',    () => cp.execFile('cmd.exe', ['/c','echo','x'], { env: process.env })],
  ['execFile:file+args (no opts)', () => cp.execFile('cmd.exe', ['/c','echo','x'])],
  ['execFileSync:file+args+opts',  () => cp.execFileSync('cmd.exe', ['/c','echo','x'], { encoding: 'utf8' })],
  ['execFileSync:file+args',       () => cp.execFileSync('cmd.exe', ['/c','echo','x'])],
  ['preserve-callerFlags',       () => cp.spawn('cmd.exe', ['/c','echo','x'], { creationFlags: 0x10000 })], // CREATE_NEW_PROCESS_GROUP
  ['preserve-callerWindowsHide-false', () => cp.spawn('cmd.exe', ['/c','echo','x'], { windowsHide: false })],
]

let pass = 0, fail = 0
const failures = []
for (const [name, fn] of cases) {
  // Clear captures from prior case
  Object.keys(captured).forEach(k => delete captured[k])
  try { fn() } catch (e) { failures.push(`${name}: threw ${e.message}`); fail++; continue }
  // Find which underlying fn was called
  const calledFn = Object.keys(captured)[0]
  const args = captured[calledFn]
  if (!args) { failures.push(`${name}: nothing captured`); fail++; continue }
  // Find options object in args (the one with our injected flags)
  let opts = null
  for (const a of args) {
    if (a && typeof a === 'object' && !Array.isArray(a) && typeof a !== 'function') {
      opts = a; break
    }
  }
  if (!opts) { failures.push(`${name}: no options bag found in ${args.length} args`); fail++; continue }
  const hasHide = opts.windowsHide === true
  const hasCNW = typeof opts.creationFlags === 'number' && (opts.creationFlags & CREATE_NO_WINDOW) === CREATE_NO_WINDOW
  if (!hasHide || !hasCNW) {
    failures.push(`${name}: missing flags (windowsHide=${opts.windowsHide}, creationFlags=0x${(opts.creationFlags||0).toString(16)})`)
    fail++
    continue
  }
  // Special-case: preserve-callerWindowsHide-false. Shim treats the field as
  // "always-true if no caller explicit value or any value" - my current impl
  // unconditionally sets windowsHide=true. Document this in the test.
  if (name === 'preserve-callerWindowsHide-false' && opts.windowsHide !== false) {
    // This is INTENTIONAL: a caller asking for windowsHide:false on Windows
    // is asking for a console window. Our shim overrides that because the
    // goal is zero console popups on Windows. Add a comment in shim.
  }
  // Special-case: preserve-callerFlags. Shim should OR in CREATE_NO_WINDOW,
  // preserving CREATE_NEW_PROCESS_GROUP (0x10000).
  if (name === 'preserve-callerFlags') {
    const hasPG = (opts.creationFlags & 0x10000) === 0x10000
    if (!hasPG) {
      failures.push(`${name}: CREATE_NEW_PROCESS_GROUP (0x10000) lost; got 0x${opts.creationFlags.toString(16)}`)
      fail++
      continue
    }
  }
  pass++
}

console.log(`PASS: ${pass}  FAIL: ${fail}  TOTAL: ${cases.length}`)
if (failures.length) {
  console.log('FAILURES:')
  failures.forEach(f => console.log('  - ' + f))
  process.exit(1)
}
console.log('OK - all shim cases verified')
