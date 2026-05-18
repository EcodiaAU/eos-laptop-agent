// Silent process execution helper.
// Replaces execSync(cmd, opts) and bare spawn(cmd, opts) with wrappers
// that prevent Windows console-window flashing under PM2-parented agents.
//
// Per ~/ecodiaos/patterns/windows-spawn-must-use-spawnSync-with-create-no-window-not-execSync-with-windowsHide.md:
// `windowsHide: true` alone is INSUFFICIENT when the parent process has a console.
// We must ALSO pass `creationFlags: 0x08000000 /* CREATE_NO_WINDOW */`.

const { spawnSync } = require('child_process')

const CREATE_NO_WINDOW = 0x08000000

/**
 * Drop-in replacement for execSync(cmd, opts).
 * Returns stdout as a string by default (preserving execSync's contract),
 * or returns undefined if opts.stdio === 'ignore'.
 *
 * Throws on non-zero exit, mirroring execSync semantics.
 *
 * Supports: encoding, timeout, cwd, env, stdio, input, maxBuffer.
 */
function runSilent(cmd, opts = {}) {
  const encoding = opts.encoding || 'utf-8'
  const stdioIgnore = opts.stdio === 'ignore'

  const spawnOpts = {
    shell: true,
    windowsHide: true,
    creationFlags: CREATE_NO_WINDOW,
    encoding,
  }
  if (opts.timeout != null) spawnOpts.timeout = opts.timeout
  if (opts.cwd != null) spawnOpts.cwd = opts.cwd
  if (opts.env != null) spawnOpts.env = opts.env
  if (opts.input != null) spawnOpts.input = opts.input
  if (opts.maxBuffer != null) spawnOpts.maxBuffer = opts.maxBuffer
  else spawnOpts.maxBuffer = 1024 * 1024 * 10

  const result = spawnSync(cmd, spawnOpts)

  if (result.error) throw result.error
  if (typeof result.status === 'number' && result.status !== 0) {
    const err = new Error(`Command failed: ${cmd}\n${result.stderr || ''}`)
    err.status = result.status
    err.stdout = result.stdout
    err.stderr = result.stderr
    throw err
  }

  if (stdioIgnore) return undefined
  if (typeof result.stdout === 'string') return result.stdout
  return (result.stdout || Buffer.alloc(0)).toString(encoding)
}

module.exports = { runSilent, CREATE_NO_WINDOW }
