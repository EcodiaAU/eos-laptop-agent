'use strict'
/**
 * real-limit-watch - the TRUE rate-limit trigger (ground truth, not prediction).
 *
 * The predictive path (account-cap-decide + daemons/usage-poller capAutoSwitch)
 * estimates from token counts and can be wrong: a burst that outruns the 5-min
 * poll, or a miscalibrated cap. This is the hard backstop. Claude Code injects a
 * SYNTHETIC assistant message into the live session transcript the instant a cap
 * is actually hit:
 *     "You've hit your session limit · resets <t>"   (5h window)
 *     "You've hit your weekly limit · resets <t>"     (weekly window)
 * That is not an estimate - the account IS blocked. We MUST ignore the lookalike
 *     "API Error: Server is temporarily limiting requests (not your usage limit) ..."
 * which is transient server throttling (it literally says "not your usage limit");
 * firing on it would thrash. On a FRESH real cap-hit we FORCE rotate_to a healthy
 * account (force is justified: the live account is blocked, so a worker on it is
 * blocked too - the reroute is the lesser harm), and SMS Tate, so the NEXT session
 * /worker opens on a fresh account even while he is away (the exact lose-hours
 * failure that started this work). Origin: Tate 2026-06-21 "do the true watch".
 *
 * The daemon calls run() on a 60s interval (detection latency ~1 min, vs the 5-min
 * predictive poll). Pure logic (detectFreshRealLimit) is unit-tested via --selftest.
 *
 * Usage:
 *   node real-limit-watch.js            # live run against ~/.claude/projects
 *   node real-limit-watch.js --dry      # decide + print, no rotate / no SMS
 *   node real-limit-watch.js --selftest # mock scenarios, assert, exit
 */
const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')

const REAL_LIMIT_RE = /You've hit your (session|weekly) limit/
const DEFAULT_FRESH_MS = 12 * 60 * 1000          // act only on a cap-hit seen in the last 12min
const DEFAULT_ALERT_COOLDOWN_MS = 60 * 60 * 1000 // rate-limit the no-target SMS

function readJsonSafe(p, fb) { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch (_) { return fb } }

// Only Claude Code's INJECTED synthetic assistant message carries a real cap
// notice. message.model === '<synthetic>' is the unforgeable discriminator: the
// exact same phrase appearing in a tool_result (e.g. THIS module's own source
// code being written) or in a normal assistant turn discussing cap detection is
// DATA, not a cap event. Matching the raw phrase anywhere in the line caused a
// live FALSE switch on 2026-06-21 (an Edit tool_result echoed this file back).
function extractSyntheticCapText(obj) {
  const m = obj && obj.message
  if (!m || m.model !== '<synthetic>') return ''
  const c = m.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map(p => (p && typeof p.text === 'string') ? p.text : '').join(' ')
  return ''
}

/**
 * PURE. Given a chunk of transcript text, return the freshest real cap-hit
 * { ts, kind } whose timestamp is within freshMs of nowMs, or null. A match must
 * be a SYNTHETIC assistant message (message.model === '<synthetic>') whose text is
 * the cap phrase - this rejects the same phrase living in tool_results, source
 * code, or normal assistant prose. Also rejects the transient-throttle lookalike
 * ("Server is temporarily limiting requests (not your usage limit)") and any
 * historical cap-hit older than the window. This is the discriminating logic the
 * whole watch hinges on, so it is isolated and tested.
 */
function detectFreshRealLimit(text, nowMs, freshMs) {
  freshMs = freshMs || DEFAULT_FRESH_MS
  const cutoff = nowMs - freshMs
  if (!text || text.indexOf("You've hit your") === -1 || text.indexOf('<synthetic>') === -1) return null
  const lines = text.split('\n')
  let best = null
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i]
    if (ln.indexOf("You've hit your") === -1 || ln.indexOf('<synthetic>') === -1) continue  // cheap pre-filter
    let obj
    try { obj = JSON.parse(ln) } catch (_) { continue }
    const capText = extractSyntheticCapText(obj)   // '' unless this IS a synthetic assistant message
    if (!REAL_LIMIT_RE.test(capText)) continue
    const ts = Date.parse(obj.timestamp || '')
    if (!ts || ts < cutoff) continue
    const kind = /weekly limit/.test(capText) ? 'weekly' : 'session'
    if (!best || ts > best.ts) best = { ts, kind }
  }
  return best
}

// Read the last `bytes` of a (possibly multi-MB) transcript without slurping it all.
function readTail(fp, bytes) {
  let fd
  try {
    fd = fs.openSync(fp, 'r')
    const size = fs.fstatSync(fd).size
    const start = Math.max(0, size - bytes)
    const len = size - start
    const buf = Buffer.allocUnsafe(len)
    fs.readSync(fd, buf, 0, len, start)
    return buf.toString('utf8')
  } catch (_) { return '' } finally { if (fd != null) try { fs.closeSync(fd) } catch (_) {} }
}

/**
 * Scan recently-touched transcripts for the freshest real cap-hit across the whole
 * projects tree. Cheap: only opens .jsonl files modified inside the freshness
 * window, reads only their 256KB tail (a cap-hit is the latest event when a session
 * blocks). Returns { ts, kind, file } or null.
 */
function findFreshRealLimit(opts) {
  opts = opts || {}
  const projectsDir = opts.projectsDir || path.join(os.homedir(), '.claude', 'projects')
  const nowMs = opts.now || Date.now()
  const freshMs = opts.freshMs || DEFAULT_FRESH_MS
  const cutoff = nowMs - freshMs
  let best = null
  let projs
  try { projs = fs.readdirSync(projectsDir) } catch (_) { return null }
  for (const proj of projs) {
    const pdir = path.join(projectsDir, proj)
    let files
    try { files = fs.readdirSync(pdir) } catch (_) { continue }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue
      const fp = path.join(pdir, f)
      let st
      try { st = fs.statSync(fp) } catch (_) { continue }
      if (st.mtimeMs < cutoff) continue
      const hit = detectFreshRealLimit(readTail(fp, 256 * 1024), nowMs, freshMs)
      if (hit && (!best || hit.ts > best.ts)) best = { ts: hit.ts, kind: hit.kind, file: fp }
    }
  }
  return best
}

// rotatable = snapshots fresh enough for creds.rotate_to (expiresAt > now+5min),
// reads expiry only, never the token. Mirrors account-cap-decide.liveDecide.
function rotatableEmails(accounts, credsDir, nowMs) {
  credsDir = credsDir || process.env.CREDS_DIR || path.join(os.homedir(), 'PRIVATE', 'ecodia-creds')
  nowMs = nowMs || Date.now()
  const STALE_MS = 5 * 60 * 1000
  const out = []
  for (const email of Object.keys(accounts || {})) {
    const short = email.split('@')[0]
    try {
      const exp = readJsonSafe(path.join(credsDir, short + '.json'), {}).claudeAiOauth.expiresAt
      if (exp && (exp - nowMs) > STALE_MS) out.push(email)
    } catch (_) {}
  }
  return out
}

function defaultAlert(textTatePath) {
  return (fromLabel, msg) => {
    try {
      const out = spawnSync('node', [textTatePath, '--from', fromLabel, msg], { timeout: 20000, encoding: 'utf8' })
      return out.status === 0
    } catch (_) { return false }
  }
}

/**
 * The full watch. Detect -> dedupe -> pick target -> FORCE switch (or alert if no
 * target). Effects (rotate_to via agentTool, SMS) are injectable for testing and
 * suppressed under dryRun. Returns a structured result describing the action.
 */
async function run(opts) {
  opts = opts || {}
  const nowMs = opts.now || Date.now()
  const coordRoot = opts.coordRoot || process.env.COORD_ROOT || path.join(os.homedir(), '.ecodiaos', 'coordination')
  const projectsDir = opts.projectsDir || path.join(os.homedir(), '.claude', 'projects')
  const credsDir = opts.credsDir || process.env.CREDS_DIR || path.join(os.homedir(), 'PRIVATE', 'ecodia-creds')
  const textTatePath = opts.textTatePath || process.env.TEXT_TATE_PATH ||
    path.join(os.homedir(), '.code', 'ecodiaos', 'backend', 'imessage-agent', 'text-tate.js')
  const freshMs = opts.freshMs || DEFAULT_FRESH_MS
  const alertCooldownMs = opts.alertCooldownMs || DEFAULT_ALERT_COOLDOWN_MS
  const stateFile = opts.stateFile || path.join(coordRoot, 'usage', 'real-limit-watch.json')
  const switchRequestFile = opts.switchRequestFile || path.join(coordRoot, 'usage', 'switch-request.json')
  const dryRun = !!opts.dryRun
  const agentTool = opts.agentTool || (() => null)
  const alert = opts.alert || defaultAlert(textTatePath)

  const hit = findFreshRealLimit({ projectsDir, now: nowMs, freshMs })
  if (!hit) return { action: 'none' }

  const state = readJsonSafe(stateFile, {})
  if (state.lastFiredCapTs && hit.ts <= state.lastFiredCapTs) return { action: 'already_fired', cap_at: hit.ts }

  // The capped account is the live identity.
  let liveShort = 'unknown'
  if (opts.getActiveAccount) { try { liveShort = opts.getActiveAccount() } catch (_) {} }
  else { try { liveShort = require('./usage')._getActiveAccount() } catch (_) {} }
  const liveEmail = liveShort && liveShort.includes('@') ? liveShort
    : (liveShort && liveShort !== 'unknown' ? liveShort + '@ecodia.au' : null)

  const accountsState = readJsonSafe(path.join(coordRoot, 'usage', 'accounts.json'), { accounts: {} })
  const decideMod = require('./account-cap-decide')
  const disabled = (opts.disabled || (process.env.ACCOUNTS_DISABLED || '').split(',').map(s => s.trim()).filter(Boolean))
    .map(s => s.includes('@') ? s : s + '@ecodia.au')
  const { usable, staleButHealthy } = decideMod.pickTarget(
    accountsState, liveEmail, { disabled, rotatable: rotatableEmails(accountsState.accounts, credsDir, nowMs) })

  const whenLocal = new Date(hit.ts).toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' })
  const persist = (extra) => { if (!dryRun) try { fs.writeFileSync(stateFile, JSON.stringify({ lastFiredCapTs: hit.ts, kind: hit.kind, live: liveEmail, raised_at: new Date(nowMs).toISOString(), ...extra })) } catch (_) {} }

  if (!usable.length) {
    const staleNote = staleButHealthy.length
      ? ` ${staleButHealthy.join(',')} has budget but its snapshot is STALE - re-auth (account-login) so I can switch.`
      : ' No account has budget.'
    const lastAlert = state.lastAlertTs || 0
    let alerted = false
    if (nowMs - lastAlert >= alertCooldownMs) {
      if (!dryRun) alert('real-limit-watch', `REAL ${hit.kind} cap hit on ${liveEmail || 'live account'} (${whenLocal}). Cannot auto-switch.${staleNote}`)
      alerted = true
      persist({ result: 'no_target_alerted', lastAlertTs: nowMs, staleButHealthy })
    } else {
      persist({ result: 'no_target', staleButHealthy, lastAlertTs: lastAlert })
    }
    return { action: alerted ? 'no_target_alerted' : 'no_target', kind: hit.kind, live: liveEmail, staleButHealthy, cap_at: hit.ts }
  }

  const target = usable[0].email
  const targetShort = target.split('@')[0]
  let status = 'dry_run'
  let via = null
  if (!dryRun) {
    // Primary: rotate through the laptop-agent (localhost:7456). Fallback: if the
    // agent is unreachable, call the creds module DIRECTLY - it writes the Keychain
    // via the `security` CLI from any process, so a switch still fires even when the
    // agent is down. The agent's own ~5h silent outage on 2026-06-22 proved this
    // gap is the exact away-safety hole this watch exists to close. force:true
    // bypasses the active-workers guard (which needs the agent's worker registry).
    let rot = agentTool('creds.rotate_to', { account: targetShort, force: true })
    via = 'agent'
    if (!rot) {
      try { rot = await require('./creds').rotate_to({ account: targetShort, force: true }); via = 'creds-direct' } catch (_) { rot = null }
    }
    status = !rot ? 'agent_unreachable' : rot.target ? 'switched' : (rot.reason || 'noop')
    persist({ result: status, target })
    // Only announce + record a switch-request when the Keychain ACTUALLY changed.
    // rotate_to no-ops to 'already_on_target' once we are on the best account, so a
    // repeated cap message for the SAME incident (Claude Code re-injects it on each
    // blocked retry, each with a new timestamp that passes the dedup) lands here as
    // a noop - we must NOT re-SMS Tate or rewrite the request on those.
    if (status === 'switched') {
      try {
        fs.writeFileSync(switchRequestFile, JSON.stringify({
          target, from: liveEmail, reason: 'REAL ' + hit.kind + ' cap hit (transcript synthetic message)',
          via: 'real-limit-watch', result: status, cap_at: new Date(hit.ts).toISOString(), raised_at: new Date(nowMs).toISOString(),
        }))
      } catch (_) {}
      alert('real-limit-watch', `REAL ${hit.kind} cap hit on ${liveEmail || 'live'} (${whenLocal}) - auto-switched Keychain to ${target}${via === 'creds-direct' ? ' (direct, agent was down)' : ''}. Next session/worker opens fresh.`)
    }
  }
  return { action: 'switch', kind: hit.kind, live: liveEmail, target, status, via, cap_at: hit.ts }
}

// ── selftest ─────────────────────────────────────────────────────────────────
async function selftest() {
  const assert = (cond, msg) => { if (!cond) { console.error('FAIL: ' + msg); process.exitCode = 1 } else console.log('ok: ' + msg) }
  const now = Date.parse('2026-06-21T11:00:00.000Z')
  const mk = (text, tsIso) => JSON.stringify({ type: 'assistant', timestamp: tsIso, message: { model: '<synthetic>', content: [{ type: 'text', text }] } })

  // 1. fresh session cap -> detected
  let r = detectFreshRealLimit(mk("You've hit your session limit · resets 2am (Australia/Brisbane)", '2026-06-21T10:58:00.000Z'), now)
  assert(r && r.kind === 'session' && r.ts === Date.parse('2026-06-21T10:58:00.000Z'), 'fresh session cap detected')

  // 2. fresh weekly cap -> detected, kind=weekly
  r = detectFreshRealLimit(mk("You've hit your weekly limit · resets 9pm (Australia/Brisbane)", '2026-06-21T10:59:30.000Z'), now)
  assert(r && r.kind === 'weekly', 'fresh weekly cap detected as weekly')

  // 3. transient server-throttle lookalike -> IGNORED (the critical no-thrash case)
  r = detectFreshRealLimit(mk('API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited', '2026-06-21T10:59:00.000Z'), now)
  assert(r === null, 'server-throttle lookalike ignored (not a real cap)')

  // 4. stale cap-hit (older than the window) -> IGNORED
  r = detectFreshRealLimit(mk("You've hit your session limit · resets 9am (Australia/Brisbane)", '2026-06-21T10:40:00.000Z'), now)
  assert(r === null, 'stale cap-hit (20min old) ignored')

  // 5. mixed buffer: pick the freshest real cap, ignore lookalike + stale
  const mixed = [
    mk('API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited', '2026-06-21T10:59:50.000Z'),
    mk("You've hit your session limit · resets 9am (Australia/Brisbane)", '2026-06-21T10:30:00.000Z'),
    mk("You've hit your session limit · resets 2am (Australia/Brisbane)", '2026-06-21T10:57:00.000Z'),
  ].join('\n')
  r = detectFreshRealLimit(mixed, now)
  assert(r && r.ts === Date.parse('2026-06-21T10:57:00.000Z'), 'picks freshest real cap in a mixed buffer')

  // 6. no cap text at all -> null
  assert(detectFreshRealLimit(mk('just a normal assistant turn', '2026-06-21T10:59:00.000Z'), now) === null, 'normal text -> null')

  // 6b. REGRESSION (2026-06-21 LIVE false switch): the cap phrase AND the literal
  // '<synthetic>' token both present, but in a NORMAL assistant turn (real model).
  // Must be ignored - only message.model === '<synthetic>' counts.
  const mkReal = (text, tsIso) => JSON.stringify({ type: 'assistant', timestamp: tsIso, message: { model: 'claude-opus-4-8', role: 'assistant', content: [{ type: 'text', text }] } })
  assert(detectFreshRealLimit(mkReal("You've hit your weekly limit - and the marker is model:'<synthetic>'", '2026-06-21T10:59:00.000Z'), now) === null,
    'cap phrase in a real-model assistant turn ignored (model gate, not raw phrase)')

  // 6c. REGRESSION: the cap phrase + '<synthetic>' inside a tool_result (exactly
  // this module's own source code being written back into the transcript). Ignore.
  const mkToolResult = (code, tsIso) => JSON.stringify({ type: 'user', timestamp: tsIso, message: { role: 'user', content: [{ type: 'tool_result', content: code }] }, toolUseResult: { content: code } })
  const srcLike = "const RE = /You've hit your (session|weekly) limit/; // real cap = message.model '<synthetic>'"
  assert(detectFreshRealLimit(mkToolResult(srcLike, '2026-06-21T10:59:00.000Z'), now) === null,
    'cap phrase + <synthetic> token in a tool_result (source code) ignored (model gate)')

  // 7. file-walk: findFreshRealLimit over a fixture dir
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rlw-'))
  try {
    const pdir = path.join(tmp, 'proj-a'); fs.mkdirSync(pdir)
    fs.writeFileSync(path.join(pdir, 's.jsonl'),
      mk('normal', new Date(now - 30000).toISOString()) + '\n' +
      mk("You've hit your session limit · resets 2am (Australia/Brisbane)", new Date(now - 20000).toISOString()) + '\n')
    const f = findFreshRealLimit({ projectsDir: tmp, now })
    assert(f && f.kind === 'session' && f.file.endsWith('s.jsonl'), 'findFreshRealLimit locates the fixture cap-hit')
    // a transcript whose file mtime is fresh but content is only the lookalike -> null
    const pdir2 = path.join(tmp, 'proj-b'); fs.mkdirSync(pdir2)
    fs.writeFileSync(path.join(pdir2, 't.jsonl'), mk('API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited', new Date(now - 10000).toISOString()) + '\n')
    fs.rmSync(path.join(pdir, 's.jsonl'))
    assert(findFreshRealLimit({ projectsDir: tmp, now }) === null, 'lookalike-only tree -> no detection')
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch (_) {} }

  // 8. run() dry: a real cap + a healthy rotatable target -> action:switch (no effects)
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'rlw-run-'))
  try {
    const pdir = path.join(tmp2, 'projects', 'p'); fs.mkdirSync(pdir, { recursive: true })
    fs.writeFileSync(path.join(pdir, 's.jsonl'), mk("You've hit your session limit · resets 2am (Australia/Brisbane)", new Date(now - 20000).toISOString()) + '\n')
    const usageDir = path.join(tmp2, 'coord', 'usage'); fs.mkdirSync(usageDir, { recursive: true })
    fs.writeFileSync(path.join(usageDir, 'accounts.json'), JSON.stringify({
      accounts: {
        'money@ecodia.au': { headroom_5h_fraction: 0.0, headroom_weekly_fraction: 0.3 },
        'code@ecodia.au': { headroom_5h_fraction: 0.95, headroom_weekly_fraction: 0.9 },
      },
    }))
    const credsDir = path.join(tmp2, 'creds'); fs.mkdirSync(credsDir)
    fs.writeFileSync(path.join(credsDir, 'code.json'), JSON.stringify({ claudeAiOauth: { expiresAt: now + 3600 * 1000 } }))
    const res = await run({
      now, dryRun: true,
      projectsDir: path.join(tmp2, 'projects'),
      coordRoot: path.join(tmp2, 'coord'),
      credsDir,
      getActiveAccount: () => 'money@ecodia.au',
      agentTool: () => ({ target: 'code@ecodia.au' }),
    })
    assert(res.action === 'switch' && res.target === 'code@ecodia.au', 'run(dry): real cap + healthy target -> switch to code@')

    // 9. same cap but target snapshot STALE -> no_target_alerted (away-safety)
    fs.writeFileSync(path.join(credsDir, 'code.json'), JSON.stringify({ claudeAiOauth: { expiresAt: now - 1000 } }))
    const res2 = await run({
      now, dryRun: true,
      projectsDir: path.join(tmp2, 'projects'),
      coordRoot: path.join(tmp2, 'coord'),
      credsDir,
      getActiveAccount: () => 'money@ecodia.au',
      agentTool: () => null,
    })
    assert(res2.action === 'no_target_alerted' && res2.staleButHealthy.includes('code@ecodia.au'),
      'run(dry): real cap + only-stale target -> alert Tate to re-auth')
  } finally { try { fs.rmSync(tmp2, { recursive: true, force: true }) } catch (_) {} }

  console.log(process.exitCode ? '\nSELFTEST FAILED' : '\nSELFTEST PASSED (11/11)')
}

if (require.main === module) {
  const arg = process.argv[2]
  if (arg === '--selftest') selftest()
  else run({ dryRun: arg === '--dry' }).then(r => console.log(JSON.stringify(r, null, 1)))
}

module.exports = { detectFreshRealLimit, findFreshRealLimit, rotatableEmails, run, readTail }
