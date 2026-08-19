#!/usr/bin/env node
'use strict'
// scripts/switch-run.js - the DOING half of an account switch.
//
// llm-helper-justified: the api.anthropic.com call in verify() is /api/oauth/usage, a
// quota-metering endpoint, not inference. It exists here for one reason: it is the only
// check that proves the newly installed token actually works against the vendor. Every
// other verification reads a local file we ourselves just wrote.
//
// Invoked as `bash scripts/account-switch.sh <tate|code|money>`, which is still THE one
// sanctioned entry point. All judgement lives in tools/switch-core.js; this file performs
// effects and reports.
//
// WHY THIS REPLACED THE OLD PAIR OF SCRIPTS
//   1. Nothing waited for the result. real-limit-watch spawned the switch detached and
//      never read its exit code, and account-switch.sh ended in a grep|tail pipeline, so
//      its exit status described the grep. A failed switch was recorded as
//      "switch_launched" and reported to Tate as success.
//   2. There was no state to crash into. A crash after `claude auth login` rewrote the
//      Keychain left the machine on the new account with every label naming the old one,
//      no history row, and nothing that ever noticed. RECONCILE now runs at startup.
//   3. swap_history.json had never once been written. Its only writer was
//      cowork.swap_creds, dead code superseded twice. Every reader of it read [].
//   4. Failure fell through to the next target even after the Keychain had already
//      flipped, which logs into a third account nobody chose.
//
// Output contract: exactly one line beginning SWITCH_RESULT= carrying JSON. Callers read
// that. "Launched" is not a result.

const fs = require('fs')
const path = require('path')
const os = require('os')
const http = require('http')
const https = require('https')
const crypto = require('crypto')
const { spawn, spawnSync } = require('child_process')

const AGENT_ROOT = path.resolve(__dirname, '..')
const cfg = require(path.join(AGENT_ROOT, 'tools', 'usage-config'))
const core = require(path.join(AGENT_ROOT, 'tools', 'switch-core'))
const registry = require(path.join(AGENT_ROOT, 'tools', 'accounts-registry'))
const usageReal = require(path.join(AGENT_ROOT, 'tools', 'usage-real'))

const ACCOUNT_LOGIN_SH = process.env.ACCOUNT_LOGIN_SH ||
  path.join(os.homedir(), '.code', 'ecodiaos', 'backend', 'scripts', 'account-login.sh')
const BROWSER_JS = path.join(AGENT_ROOT, 'scripts', 'account-switch-browser.js')
const CLAUDE_JSON = process.env.CLAUDE_JSON_PATH || path.join(os.homedir(), '.claude.json')

const args = process.argv.slice(2)
const TARGET = (args.find(a => !a.startsWith('-')) || '').trim().toLowerCase()
const DRY = args.includes('--dry')
const PIN_TARGET = args.includes('--pin-target')
const MAX_ATTEMPTS = Number(process.env.SWITCH_MAX_ATTEMPTS) || 2

const RUN_ID = 'sw_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex')
let TMPDIR = null

// ── small utilities ──────────────────────────────────────────────────────────

function log(msg) { process.stdout.write('[switch-run ' + RUN_ID + '] ' + msg + '\n') }
function readJson(p, fb) { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch (e) { return fb } }
function writeJsonAtomic(p, o) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const t = p + '.tmp-' + process.pid
  fs.writeFileSync(t, JSON.stringify(o, null, 2) + '\n', 'utf8')
  fs.renameSync(t, p)
}
function sha(s) { return s ? crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16) : null }
function pidAlive(pid) { try { process.kill(pid, 0); return true } catch (e) { return false } }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// ── lock, with a heartbeat rather than an age ────────────────────────────────

let _heartbeatTimer = null
let _stage = 'IDLE'

function writeLock() {
  writeJsonAtomic(cfg.PATHS.SWITCH_LOCK_FILE, {
    run_id: RUN_ID, pid: process.pid, pgid: (() => { try { return process.getpgid(0) } catch (e) { return null } })(),
    target: TARGET, stage: _stage, heartbeat_at: new Date().toISOString(), started_at: new Date().toISOString(),
  })
}
function beat(stage) {
  if (stage) _stage = stage
  const cur = readJson(cfg.PATHS.SWITCH_LOCK_FILE, null)
  if (!cur || cur.run_id !== RUN_ID) return
  cur.stage = _stage
  cur.heartbeat_at = new Date().toISOString()
  writeJsonAtomic(cfg.PATHS.SWITCH_LOCK_FILE, cur)
  writeJsonAtomic(cfg.PATHS.SWITCH_STATE_FILE, {
    run_id: RUN_ID, state: _stage, target: TARGET, started_at: cur.started_at, updated_at: cur.heartbeat_at,
  })
}
function releaseLock() {
  if (_heartbeatTimer) clearInterval(_heartbeatTimer)
  const cur = readJson(cfg.PATHS.SWITCH_LOCK_FILE, null)
  if (cur && cur.run_id === RUN_ID) { try { fs.unlinkSync(cfg.PATHS.SWITCH_LOCK_FILE) } catch (e) {} }
}

// Reap a wedged holder's PROCESS GROUP, not just its pid. account-login.sh spawns a
// `claude auth login` child plus a FIFO feeder; killing the script alone orphans them.
// One such orphan sat holding a PKCE verifier from 19 July until 2 August.
function reapGroup(pgid, pid) {
  if (pgid) { try { process.kill(-pgid, 'SIGTERM') } catch (e) {} }
  else if (pid) { try { process.kill(pid, 'SIGTERM') } catch (e) {} }
}

function reapStrayLogins() {
  // Any claude-auth-login not owned by this run is a leftover: it holds a verifier for a
  // flow nobody is completing and will happily consume a paste code meant for us.
  const r = spawnSync('pgrep', ['-f', 'claude auth login'], { encoding: 'utf8' })
  if (r.status !== 0 || !r.stdout) return 0
  let n = 0
  for (const line of r.stdout.trim().split('\n')) {
    const pid = Number(line.trim())
    if (!pid || pid === process.pid) continue
    try { process.kill(pid, 'SIGTERM'); n++ } catch (e) {}
  }
  if (n) log('reaped ' + n + ' stray claude-auth-login process(es) before starting')
  return n
}

// ── identity readers ─────────────────────────────────────────────────────────

function keychainRaw() {
  if (process.platform !== 'darwin') return null
  const r = spawnSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-a', 'ecodia', '-w'],
    { encoding: 'utf8', timeout: 5000 })
  return r.status === 0 ? (r.stdout || '').trim() : null
}
function keychainTokenSha() {
  try { return sha(JSON.parse(keychainRaw()).claudeAiOauth.accessToken) } catch (e) { return null }
}
function claudeJsonEmail() {
  try { return readJson(CLAUDE_JSON, {}).oauthAccount.emailAddress || null } catch (e) { return null }
}
function activeAccountEmail() {
  const r = readJson(cfg.PATHS.ACTIVE_ACCOUNT_FILE, null)
  return (r && r.account) || null
}
function authStatusText() {
  const bin = resolveClaudeBinary()
  if (!bin) return ''
  const r = spawnSync(bin, ['auth', 'status'], { encoding: 'utf8', timeout: 20000 })
  return ((r.stdout || '') + (r.stderr || ''))
}
function resolveClaudeBinary() {
  // Never `which claude`: the homebrew symlink dangles after a VS Code extension update.
  const base = path.join(os.homedir(), '.vscode', 'extensions')
  try {
    const dirs = fs.readdirSync(base).filter(d => /^anthropic\.claude-code-/.test(d)).sort()
    for (let i = dirs.length - 1; i >= 0; i--) {
      const p = path.join(base, dirs[i], 'resources', 'native-binary', 'claude')
      if (fs.existsSync(p)) return p
    }
  } catch (e) {}
  return null
}

// The one thing that cannot lie about which account the machine is on.
async function liveEmailFromToken() {
  let token = null
  try { token = JSON.parse(keychainRaw()).claudeAiOauth.accessToken } catch (e) { return null }
  if (!token) return null
  const v = await probeProfile(token)
  return v.ok ? v.email : null
}

function probeProfile(token) {
  return httpsGetJson(cfg.PROBE.PROFILE_URL, token).then(r => {
    if (r.status !== 200) return { ok: false, status: r.status }
    try {
      const j = JSON.parse(r.body)
      const acct = (j && (j.account || j)) || {}
      const email = acct.email || acct.emailAddress || null
      return email ? { ok: true, email } : { ok: false, status: 200 }
    } catch (e) { return { ok: false, status: 200 } }
  })
}
function probeUsage(token) {
  return httpsGetJson(cfg.PROBE.URL, token).then(r => ({ ok: r.status === 200, status: r.status }))
}
function httpsGetJson(url, token) {
  return new Promise((resolve) => {
    const req = https.request(url, {
      method: 'GET', timeout: cfg.PROBE.TIMEOUT_MS,
      headers: {
        'Authorization': 'Bearer ' + token,
        'anthropic-beta': cfg.PROBE.BETA_HEADER,
        'User-Agent': cfg.PROBE.USER_AGENT,
        'Accept': 'application/json',
      },
    }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', d => { body += d })
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }))
    })
    req.on('timeout', () => { try { req.destroy() } catch (e) {}; resolve({ status: 0, body: '' }) })
    req.on('error', () => resolve({ status: 0, body: '' }))
    req.end()
  })
}

// ── preflight helpers ────────────────────────────────────────────────────────

function cdpAlive() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: 9222, path: '/json/version', timeout: 4000 }, (res) => {
      res.resume(); resolve(res.statusCode === 200)
    })
    req.on('timeout', () => { try { req.destroy() } catch (e) {}; resolve(false) })
    req.on('error', () => resolve(false))
  })
}

// A google-sso leg needs either a usable password mirror or a live Google session. The
// mirror files are inconsistent on disk (one JSON-encoded, one raw), so accept both and
// never let a parse error carry the value into a message.
function loginPrereq(row) {
  if (!row) return { ok: false, which: 'registry_row', detail: 'no registry row' }
  if (row.login_method === 'magic-link') {
    const reader = path.join(os.homedir(), '.code', 'ecodiaos', 'backend', 'scripts', 'eos-read-maglink-sa.js')
    if (!fs.existsSync(reader)) return { ok: false, which: 'maglink_reader', detail: 'eos-read-maglink-sa.js is missing' }
    return { ok: true }
  }
  if (row.login_method === 'google-sso') {
    if (row.pw_mirror && fs.existsSync(row.pw_mirror)) {
      let raw
      try { raw = fs.readFileSync(row.pw_mirror, 'utf8') } catch (e) { return { ok: false, which: 'pw_mirror', detail: 'unreadable' } }
      let val = null
      try { const j = JSON.parse(raw); val = typeof j === 'string' ? j : null } catch (e) { val = null }
      if (val === null) val = raw.replace(/\r?\n$/, '')
      if (!val || !val.length) return { ok: false, which: 'pw_mirror', detail: 'empty (content withheld)' }
      return { ok: true }
    }
    // No mirror is survivable while the canonical Chrome profile still holds a live
    // Google session; the browser half will simply never be asked for a password.
    return { ok: true, warn: 'no password mirror: this leg depends on the live Google session in canonical Chrome' }
  }
  return { ok: false, which: 'login_method', detail: 'unknown login_method ' + row.login_method }
}

// ── the run ──────────────────────────────────────────────────────────────────

function emit(result) {
  // Always land on a TERMINAL state. Returning without one leaves switch-state.json
  // reading mid-flight, and the next run's RECONCILE then "repairs" a crash that never
  // happened (a clean --dry run did exactly that the first time this shipped).
  try {
    if (TMPDIR) {
      writeJsonAtomic(cfg.PATHS.SWITCH_STATE_FILE, {
        run_id: RUN_ID, state: result && result.ok ? 'DONE' : 'FAILED',
        target: TARGET, updated_at: new Date().toISOString(),
        reason: (result && result.reason) || null,
      })
    }
  } catch (e) {}
  process.stdout.write('SWITCH_RESULT=' + JSON.stringify(result) + '\n')
  return result
}

function appendSwapHistory(row) {
  // swap_history.json finally gets a writer. Its readers have been reading [] since the
  // file was invented, which is why attribution had no switch audit trail to reconstruct
  // from.
  let hist = readJson(cfg.PATHS.SWAP_HISTORY_FILE, [])
  if (!Array.isArray(hist)) hist = []
  hist.push(row)
  writeJsonAtomic(cfg.PATHS.SWAP_HISTORY_FILE, hist.slice(-500))
}

async function reconcile(reason) {
  // Read the PRIOR state before stamping our own, or we diagnose ourselves: beat()
  // writes state=RECONCILE, the read then returns RECONCILE, and every run reports a
  // crash that never happened.
  const st = readJson(cfg.PATHS.SWITCH_STATE_FILE, null)
  beat('RECONCILE')
  const tokenEmail = await liveEmailFromToken()
  const verdict = core.reconcileVerdict({
    switchState: st, tokenEmail,
    claudeJsonEmail: claudeJsonEmail(), activeAccountEmail: activeAccountEmail(),
  })
  if (!verdict.needed) return { reconciled: false }
  if (!verdict.ok) { log('RECONCILE: ' + verdict.reason); return { reconciled: false, reason: verdict.reason } }

  log('RECONCILE: ' + verdict.reason)
  if (!DRY) {
    if (verdict.repair.includes('claude_json')) {
      try {
        const j = readJson(CLAUDE_JSON, {})
        j.oauthAccount = Object.assign({}, j.oauthAccount, { emailAddress: tokenEmail })
        writeJsonAtomic(CLAUDE_JSON, j)
      } catch (e) { log('RECONCILE: could not repair the ~/.claude.json label: ' + e.message) }
    }
    if (verdict.repair.includes('active_account')) {
      try {
        const usage = require(path.join(AGENT_ROOT, 'tools', 'usage'))
        usage._setActiveAccount(tokenEmail, 'switch-run:reconcile')
      } catch (e) { log('RECONCILE: could not repair active_account: ' + e.message) }
    }
    appendSwapHistory({
      at: new Date().toISOString(), run_id: RUN_ID, result: 'reconciled',
      to: tokenEmail, repaired: verdict.repair, trigger: reason || 'startup',
    })
  }
  return { reconciled: true, tokenEmail, repaired: verdict.repair }
}

async function runLogin(target, row) {
  // The CLI half prints OAUTH_URL/CODE_FILE then blocks for the paste code; the browser
  // half drives the consent focuslessly and writes that code. Both halves are spawned
  // into THIS process group so a reap takes the whole tree.
  const out = path.join(TMPDIR, 'acct-login-' + target + '.out')
  fs.writeFileSync(out, '')
  const child = spawn('bash', [ACCOUNT_LOGIN_SH, target], {
    stdio: ['ignore', fs.openSync(out, 'a'), fs.openSync(out, 'a')],
    env: Object.assign({}, process.env, { EOS_SWITCH_TMPDIR: TMPDIR }),
  })

  const deadline = Date.now() + 60000
  let oauthUrl = null, codeFile = null
  while (Date.now() < deadline) {
    const text = fs.readFileSync(out, 'utf8')
    const u = text.match(/^OAUTH_URL=(.+)$/m)
    const c = text.match(/^CODE_FILE=(.+)$/m)
    if (u && c) { oauthUrl = u[1].trim(); codeFile = c[1].trim(); break }
    if (child.exitCode !== null) break
    beat()
    await sleep(500)
  }
  if (!oauthUrl || !codeFile) {
    try { process.kill(-child.pid, 'SIGTERM') } catch (e) { try { child.kill('SIGTERM') } catch (e2) {} }
    return { ok: false, stage: 'LOGIN_CLI', reason: 'no OAUTH_URL from account-login.sh within 60s', child }
  }

  beat('BROWSER_DRIVE')
  const browser = spawn('node', [BROWSER_JS, target], {
    stdio: ['ignore', fs.openSync(out, 'a'), fs.openSync(out, 'a')],
    env: Object.assign({}, process.env, {
      OAUTH_URL: oauthUrl, CODE_FILE: codeFile,
      LOGIN_METHOD: row.login_method || '', TOTP_SERVICE: row.totp_service || '',
      PW_MIRROR_PATH: row.pw_mirror || '',
      // hCaptcha solver key (2026-08-03). From env or the local cred mirror; empty is fine,
      // the browser driver just exhausts on the captcha as before when it is absent.
      CAPSOLVER_API_KEY: process.env.CAPSOLVER_API_KEY ||
        (() => { try { return require('fs').readFileSync(require('os').homedir() + '/PRIVATE/ecodia-creds/kv-mirror/capsolver_api_key', 'utf8').trim() } catch (_e) { return '' } })(),
      TWOCAPTCHA_API_KEY: process.env.TWOCAPTCHA_API_KEY ||
        (() => { try { return require('fs').readFileSync(require('os').homedir() + '/PRIVATE/ecodia-creds/kv-mirror/twocaptcha_api_key', 'utf8').trim() } catch (_e) { return '' } })(),
    }),
  })

  // Wait for a TERMINAL marker from the CLI half, beating throughout. The window is
  // generous on purpose: the magic-link leg legitimately waits up to 12 minutes for mail
  // and the 2FA path can wait longer still. The lock heartbeat, not this timeout, is what
  // distinguishes slow from wedged.
  const hardDeadline = Date.now() + (Number(process.env.SWITCH_LEG_TIMEOUT_MS) || 16 * 60 * 1000)
  let terminal = null
  while (Date.now() < hardDeadline) {
    const text = fs.readFileSync(out, 'utf8')
    if (/^DONE:/m.test(text)) { terminal = 'DONE'; break }
    if (/^(FAILED|TIMEOUT):/m.test(text)) { terminal = 'FAILED'; break }
    if (child.exitCode !== null && browser.exitCode !== null) { terminal = child.exitCode === 0 ? 'DONE' : 'FAILED'; break }
    beat()
    await sleep(1000)
  }

  const tail = (() => { try { return fs.readFileSync(out, 'utf8').split('\n').slice(-6).join(' | ').slice(0, 400) } catch (e) { return '' } })()
  for (const c of [child, browser]) {
    if (c && c.exitCode === null) { try { process.kill(-c.pid, 'SIGTERM') } catch (e) { try { c.kill('SIGTERM') } catch (e2) {} } }
  }
  if (terminal !== 'DONE') {
    return { ok: false, stage: 'BROWSER_DRIVE', reason: (terminal || 'leg timed out') + ': ' + tail, logFile: out }
  }
  return { ok: true, logFile: out }
}

async function verify(target) {
  beat('VERIFY')
  const targetEmail = target + '@ecodia.au'
  let token = null
  try { token = JSON.parse(keychainRaw()).claudeAiOauth.accessToken } catch (e) {}
  const probe = token ? await probeUsage(token) : { ok: false }
  return core.verifyIdentity({
    targetEmail,
    preTokenSha: global.__PRE_TOKEN_SHA || null,
    keychainTokenSha: keychainTokenSha(),
    claudeJsonEmail: claudeJsonEmail(),
    activeAccountEmail: activeAccountEmail(),
    authStatusText: authStatusText(),
    probe,
  })
}

async function main() {
  if (!TARGET) return emit({ ok: false, code: core.EXIT.USAGE, reason: 'usage: switch-run.js <tate|code|money> [--dry] [--pin-target]' })

  // Lock first, so two triggers can never drive two concurrent logins into one Keychain.
  const existing = readJson(cfg.PATHS.SWITCH_LOCK_FILE, null)
  const verdict = core.lockVerdict(existing, { pidAlive })
  if (verdict.action === 'wait') {
    return emit({ ok: false, code: core.EXIT.IN_PROGRESS, reason: verdict.reason, in_progress: true })
  }
  if (verdict.action === 'reclaim') {
    log('reclaiming the switch lock: ' + verdict.reason)
    reapGroup(existing && existing.pgid, existing && existing.pid)
    try { fs.unlinkSync(cfg.PATHS.SWITCH_LOCK_FILE) } catch (e) {}
  }

  TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'eos-switch-' + RUN_ID + '-'))
  writeLock()
  _heartbeatTimer = setInterval(() => { try { beat() } catch (e) {} }, 30000)
  if (_heartbeatTimer.unref) _heartbeatTimer.unref()

  const cleanup = () => {
    releaseLock()
    try { fs.rmSync(TMPDIR, { recursive: true, force: true }) } catch (e) {}
  }
  process.on('exit', cleanup)
  process.on('SIGTERM', () => { cleanup(); process.exit(core.EXIT.FAILED) })
  process.on('SIGINT', () => { cleanup(); process.exit(core.EXIT.FAILED) })

  // Any half-switch left by a previous crash is resolved before we add another.
  await reconcile('switch-run start')

  beat('PREFLIGHT')
  reapStrayLogins()
  const reg = registry.read().registry
  const row = reg.accounts[TARGET]
  const pinRaw = (() => { try { return fs.readFileSync(cfg.PATHS.PIN_FILE, 'utf8') } catch (e) { return null } })()
  const currentEmail = await liveEmailFromToken()
  const currentShort = currentEmail ? currentEmail.split('@')[0] : null

  const pre = core.preflightVerdict({
    target: TARGET, registry: reg, pinRaw, currentShort,
    cdpAlive: await cdpAlive(), prereq: loginPrereq(row),
  })
  if (!pre.ok) return emit({ ok: false, code: pre.code, reason: pre.reason, from: currentEmail })
  if (DRY) return emit({ ok: true, code: core.EXIT.VERIFIED, dry: true, target: TARGET, from: currentEmail, reason: 'preflight clean' })

  global.__PRE_TOKEN_SHA = keychainTokenSha()
  const drainDeadline = new Date(Date.now() + cfg.TRIGGERS.POST_SWITCH_GRACE_MS).toISOString()

  // Seed the OUTGOING account from the Keychain before the login overwrites it, and
  // identify it from the TOKEN rather than the label: seeding under a stale label writes
  // one account's live lineage into another account's file.
  beat('SEED_OUTGOING')
  if (currentShort && reg.accounts[currentShort]) {
    try {
      const creds = require(path.join(AGENT_ROOT, 'tools', 'creds'))
      await creds.seed_from_live({ account: currentShort })
      log('seeded the outgoing snapshot for ' + currentShort + ' (identified from its token, not its label)')
    } catch (e) { log('seed_from_live failed for ' + currentShort + ': ' + e.message + ' (continuing: switching does not need it)') }
  } else {
    log('seed skipped: could not identify the outgoing account from its token')
  }

  let attempt = 0
  let lastReason = null
  while (attempt < MAX_ATTEMPTS) {
    attempt++
    beat('LOGIN_CLI')
    log('attempt ' + attempt + '/' + MAX_ATTEMPTS + ' -> ' + TARGET + ' (' + (row.login_method || '?') + ')')
    const leg = await runLogin(TARGET, row)
    const flipped = keychainTokenSha() !== global.__PRE_TOKEN_SHA

    if (leg.ok) {
      const v = await verify(TARGET)
      if (v.ok) {
        beat('RECORD')
        const result = {
          ok: true, code: core.EXIT.VERIFIED, target: TARGET, to: TARGET + '@ecodia.au',
          from: currentEmail, attempt, verify: v.checks, drain_deadline: drainDeadline, run_id: RUN_ID,
        }
        appendSwapHistory(Object.assign({ at: new Date().toISOString(), result: 'verified' }, result))
        writeJsonAtomic(cfg.PATHS.SWITCH_REQUEST_FILE, {
          target: TARGET + '@ecodia.au', from: currentEmail, reason: process.env.SWITCH_REASON || 'switch-run',
          via: 'account-switch.sh', result: 'verified', drain_deadline: drainDeadline,
          raised_at: new Date().toISOString(),
        })
        try { registry.recordSwitchResult(TARGET, true, null, { by: 'switch-run' }) } catch (e) {}
        notifyConductor(result)
        reawakenConductor(result)
        beat('DONE')
        return emit(result)
      }
      lastReason = v.reason
      log('verification failed: ' + v.reason)
    } else {
      lastReason = leg.reason
      log('leg failed at ' + leg.stage + ': ' + String(leg.reason).slice(0, 200))
    }

    const ladder = core.failLadder({ flipped, attempt, maxAttempts: MAX_ATTEMPTS, remainingTargets: [], pinnedTarget: PIN_TARGET })
    log('ladder: ' + ladder.action + ' - ' + ladder.reason)
    if (ladder.action === 'repair') { await reconcile('post-flip repair'); continue }
    if (ladder.action === 'retry_same') continue
    break
  }

  beat('FAILED')
  try { registry.recordSwitchResult(TARGET, false, lastReason, { by: 'switch-run' }) } catch (e) {}
  const failResult = {
    ok: false, code: core.EXIT.FAILED, target: TARGET, from: currentEmail,
    attempts: attempt, reason: lastReason, run_id: RUN_ID,
  }
  appendSwapHistory(Object.assign({ at: new Date().toISOString(), result: 'failed' }, failResult))
  await reconcile('after a failed switch')
  return emit(failResult)
}

function notifyConductor(result) {
  // Best-effort: a conductor tab that knows a switch happened can decide what to do with
  // its own in-flight work. Never blocks the switch.
  try {
    const payload = JSON.stringify({
      tool: 'coord.send_message',
      params: {
        to: 'chat.conductor.inbox',
        body: { type: 'account_switch', from: result.from, to: result.to, drain_deadline: result.drain_deadline },
      },
    })
    let token = ''
    try { token = (fs.readFileSync(path.join(AGENT_ROOT, '.env'), 'utf8').match(/^AGENT_TOKEN=(.+)$/m) || [])[1] || '' } catch (e) {}
    spawnSync('curl', ['-sS', '-m', '8', 'http://127.0.0.1:' + (process.env.AGENT_PORT || 7456) + '/api/tool',
      '-X', 'POST', '-H', 'content-type: application/json',
      '-H', 'authorization: Bearer ' + token.trim(), '--data-binary', payload], { encoding: 'utf8', timeout: 10000 })
  } catch (e) {}
}

// REAWAKEN (2026-08-19). notifyConductor above only pings a LIVE conductor's inbox. But the
// switch that matters is the cap-triggered one: the prior account is capped, so the
// conductor tab is DEAD and there is nothing to inject into. A courtesy ping to a corpse is
// not continuity. So on a verified switch, when the caller asks for reawaken
// (SWITCH_REAWAKEN=1, set only by real-limit-watch's cap path), arm a FRESH conductor tab on
// the new account through the always-on laptop-agent scheduler - the one process that runs
// independent of any live conductor. The row opens as a fresh Claude Code tab that reads the
// resume brief and IS the conductor. Doctrine: mac-unattended-resilience-conductor-survival,
// account-switch-hcaptcha-solved-via-2captcha-2026-08-19.
function reawakenConductor(result) {
  if (process.env.SWITCH_REAWAKEN !== '1') return
  try {
    // Storm guard: never arm two reawaken rows inside a cooldown. The scheduler's same-name
    // guard is the second layer; this stamp is the first and cheapest.
    const COOLDOWN_MS = 15 * 60 * 1000
    const stampFile = path.join(path.dirname(cfg.PATHS.SWITCH_STATE_FILE), 'reawaken-stamp.json')
    try {
      const prev = JSON.parse(fs.readFileSync(stampFile, 'utf8'))
      if (prev && prev.at && (Date.now() - Date.parse(prev.at)) < COOLDOWN_MS) {
        log('reawaken skipped: armed ' + Math.round((Date.now() - Date.parse(prev.at)) / 60000) + 'min ago (cooldown)')
        return
      }
    } catch (_e) {}

    const brief = [
      '[EOS-CONDUCTOR-REAWAKEN] REPORT-BACK: none',
      'You are EcodiaOS, the conductor, resuming after an AUTOMATIC account switch. The live',
      'Claude account was switched from ' + result.from + ' to ' + result.to + ' because the prior',
      'account hit a usage cap and the conductor tab went dark. You are its successor on the',
      'fresh account, and this tab IS the conductor now - not a worker, do not signal_done and',
      'terminate. Resume autonomous operation immediately: read the three CLAUDE.md layers, then',
      'status_board P1/P2 active rows, then the continuity ledger (backend/continuity/lib.cjs',
      'ledger) and away-state, then pick up the highest-priority open work and carry it to a',
      'verified close, self-scheduling successors per doctrine. Do not wait for Tate.',
    ].join(' ')

    const payload = JSON.stringify({
      tool: 'scheduler.schedule_delayed',
      params: {
        name: 'cowork.conductor-reawaken-after-switch',
        prompt: brief,
        delay: 'in 1m',
        preferred_account: result.target, // open on the account we just switched TO
        priority_class: 'high',
      },
    })
    let token = ''
    try { token = (fs.readFileSync(path.join(AGENT_ROOT, '.env'), 'utf8').match(/^AGENT_TOKEN=(.+)$/m) || [])[1] || '' } catch (e) {}
    const r = spawnSync('curl', ['-sS', '-m', '10', 'http://127.0.0.1:' + (process.env.AGENT_PORT || 7456) + '/api/tool',
      '-X', 'POST', '-H', 'content-type: application/json',
      '-H', 'authorization: Bearer ' + token.trim(), '--data-binary', payload], { encoding: 'utf8', timeout: 12000 })
    try { fs.writeFileSync(stampFile, JSON.stringify({ at: new Date().toISOString(), to: result.to, run_id: RUN_ID })) } catch (_e) {}
    log('reawaken armed: fresh conductor tab scheduled on ' + result.to + ' (' + String(r.stdout || '').slice(0, 120) + ')')
  } catch (e) { log('reawaken failed (non-fatal): ' + e.message) }
}

main()
  .then(r => { process.exitCode = (r && typeof r.code === 'number') ? r.code : core.EXIT.FAILED })
  .catch(e => {
    emit({ ok: false, code: core.EXIT.FAILED, reason: 'unhandled: ' + String(e && e.message || e).slice(0, 200), run_id: RUN_ID })
    process.exitCode = core.EXIT.FAILED
  })
