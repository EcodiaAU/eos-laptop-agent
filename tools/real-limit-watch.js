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
const POST_SWITCH_GRACE_MS = 30 * 60 * 1000      // window in which a fresh cap is presumed a lagging re-injection from the account we just switched off
// 2026-06-25 no-target SMS debounce. On a single shared Keychain the cap banner
// bleeds into collateral worker transcripts, so for ONE scan the heaviest
// fresh-capped session can resolve to the (healthy) live account before the
// truly-capped account's heavy session gets its own cap line - the next 60s scan
// self-corrects to capped_not_live. Require the same no-target verdict to persist
// across N scans before alerting Tate. Demand MORE persistence when the blamed
// account still shows comfortable ccusage headroom (a cap on it is implausible),
// but never permanently veto - ccusage can under-report a genuine cap.
const NO_TARGET_MIN_SCANS = 2                     // consecutive no-target scans before the SMS fires
const NO_TARGET_MIN_SCANS_WHEN_HEADROOM = 5       // when the blamed account looks healthy by ccusage, demand more
const NO_TARGET_HEADROOM_FLOOR = 0.25             // headroom fraction above which a real cap on that account is implausible
const NO_TARGET_STREAK_WINDOW_MS = 15 * 60 * 1000 // a pending streak older than this is stale; start fresh
const SAFE_HEADROOM_FLOOR = 0.5                  // an account above this headroom for the cap kind cannot be the real capped account (ccusage undercounts, but not 2x past this)

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
 * blocks). Returns the freshest hit { ts, kind, file, sessionId } PLUS `sessions` -
 * EVERY fresh cap-hit session id (the transcript filename, minus .jsonl). The
 * machine shares ONE keychain, so a cap blocks every live session at once; the
 * `sessions` list lets the caller pick the genuinely-capped account by usage weight
 * instead of trusting the freshest (often a tiny collateral worker). Returns null
 * when nothing fresh.
 */
function findFreshRealLimit(opts) {
  opts = opts || {}
  const projectsDir = opts.projectsDir || path.join(os.homedir(), '.claude', 'projects')
  const nowMs = opts.now || Date.now()
  const freshMs = opts.freshMs || DEFAULT_FRESH_MS
  const cutoff = nowMs - freshMs
  let best = null
  const sessions = []
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
      if (!hit) continue
      const sessionId = f.slice(0, -'.jsonl'.length)
      sessions.push({ sessionId, ts: hit.ts, kind: hit.kind })
      if (!best || hit.ts > best.ts) best = { ts: hit.ts, kind: hit.kind, file: fp, sessionId }
    }
  }
  if (!best) return null
  best.sessions = sessions
  return best
}

// PURE. Given the fresh cap-hit session ids and the poller's session->account map
// (sessions.json: { <sessionId>: { account, total_tokens } }), return the account
// running the HEAVIEST capped session - the one actually burning tokens into the
// cap, not a tiny collateral worker that merely shared the keychain. Falls back to
// `fallbackLive` when no session resolves. This is what makes attribution robust to
// a thrashing/unknown live-account read: the 951M-token code@ session outweighs a
// 110K-token money@ worker, so the cap is correctly pinned to code@.
function resolveCappedAccount(sessions, sessionsJson, fallbackLive) {
  let bestAcct = null, bestTok = -1
  for (const s of (sessions || [])) {
    const row = sessionsJson && sessionsJson[s.sessionId]
    if (!row || !row.account) continue
    const tok = typeof row.total_tokens === 'number' ? row.total_tokens : 0
    if (tok > bestTok) { bestTok = tok; bestAcct = row.account }
  }
  return bestAcct || fallbackLive || null
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

// Headroom fraction for the cap kind from the ccusage snapshot, or null if absent.
function headroomFor(accountsState, email, kind) {
  const a = accountsState && accountsState.accounts && accountsState.accounts[email]
  if (!a) return null
  const f = kind === 'weekly' ? a.headroom_weekly_fraction : a.headroom_5h_fraction
  return (typeof f === 'number') ? f : null
}

/**
 * PURE. Decide whether a FRESH real-cap detection is actually a lagging
 * re-injection from an account we ALREADY switched off, mis-landing on the
 * now-live (healthy) account.
 *
 * After a forced switch away from a capped account, that account's still-open
 * sessions keep retrying; Claude Code re-injects the cap notice on every blocked
 * retry, each with a NEW timestamp that clears the ts-dedup. A later scan reads
 * getActiveAccount() = the account we just switched TO and blames IT - the inverted
 * false alarm Tate hit 2026-06-24 ("REAL weekly cap on money@" while money@ had 90%
 * headroom and code@ was the real capped account).
 *
 * Suppress IFF: (a) the last action was a real 'switched' away from `from` -> `target`,
 * (b) we are still on that `target` (== liveEmail), (c) the switch was within graceMs,
 * and (d) the now-live account still shows healthy headroom for THIS cap kind. (d) is
 * the safety that keeps a genuine fresh cap on the new account from being masked:
 * ccusage can undercount, but a truly-capped account never sits above the floor.
 */
function laggingCapSuppression(o) {
  o = o || {}
  const { liveEmail, kind, nowMs, lastSwitch, accountsState } = o
  const graceMs = o.graceMs || POST_SWITCH_GRACE_MS
  const headroomFloor = (typeof o.headroomFloor === 'number') ? o.headroomFloor : SAFE_HEADROOM_FLOOR
  if (!lastSwitch || lastSwitch.result !== 'switched' || !lastSwitch.from || !lastSwitch.target) return { suppressed: false }
  if (liveEmail && lastSwitch.target !== liveEmail) return { suppressed: false }     // something moved us off the switch target; normal attribution applies
  const switchedAtMs = Date.parse(lastSwitch.raised_at || lastSwitch.cap_at || '')
  if (!switchedAtMs || (nowMs - switchedAtMs) > graceMs) return { suppressed: false } // switch too old to still be lagging
  const hr = headroomFor(accountsState, liveEmail, kind)
  if (hr != null && hr <= headroomFloor) return { suppressed: false }                // now-live account may itself be genuinely capped - do NOT mask
  return {
    suppressed: true,
    cappedAccount: lastSwitch.from,
    reason: `lagging ${kind} cap re-injection from ${lastSwitch.from} (switched off ${Math.round((nowMs - switchedAtMs) / 60000)}min ago; live ${liveEmail} headroom=${hr == null ? 'n/a' : hr.toFixed(2)})`,
  }
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

  // Attribute the cap to the account running the HEAVIEST fresh cap session, not to
  // the live-account read (which is unreliable when current_account() is 'unknown'
  // and thrashes between accounts). The 951M-token code@ session outweighs a 110K
  // collateral money@ worker, so the cap pins to code@ even while the keychain shows
  // money@. Origin: 2026-06-24 inverted "money@ capped" SMS while code@ was capped.
  const sessionsJson = opts.sessionsJson || readJsonSafe(opts.sessionsFile || path.join(coordRoot, 'usage', 'sessions.json'), {})
  const cappedEmail = resolveCappedAccount(hit.sessions, sessionsJson, liveEmail)

  const decideMod = require('./account-cap-decide')
  const disabled = (opts.disabled || (process.env.ACCOUNTS_DISABLED || '').split(',').map(s => s.trim()).filter(Boolean))
    .map(s => s.includes('@') ? s : s + '@ecodia.au')
  const { usable, staleButHealthy } = decideMod.pickTarget(
    accountsState, liveEmail, { disabled, rotatable: rotatableEmails(accountsState.accounts, credsDir, nowMs) })

  const whenLocal = new Date(hit.ts).toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' })
  const persist = (extra) => { if (!dryRun) try { fs.writeFileSync(stateFile, JSON.stringify({ lastFiredCapTs: hit.ts, kind: hit.kind, live: liveEmail, raised_at: new Date(nowMs).toISOString(), ...extra })) } catch (_) {} }

  // Capped-account-not-live guard: if the genuinely-capped account (heaviest fresh
  // cap session) is NOT the account currently live, we are already on a different
  // (healthy) account - there is nothing to switch and, crucially, we must NOT blame
  // the live account. This is the root fix for the inverted alarm: the cap belongs
  // to code@ (951M-token session), we are on money@, so the correct action is none.
  if (cappedEmail && liveEmail && cappedEmail !== liveEmail) {
    persist({ result: 'capped_not_live', capped_account: cappedEmail })
    return { action: 'capped_not_live', kind: hit.kind, cappedAccount: cappedEmail, live: liveEmail, cap_at: hit.ts }
  }

  // Lagging-cap guard: a fresh cap notice arriving just after we switched off a
  // capped account is that account's still-open retries re-injecting, not a cap on
  // the healthy account we moved to. Suppress before it can blame the live account.
  const lastSwitch = opts.lastSwitch || readJsonSafe(switchRequestFile, null)
  const sup = laggingCapSuppression({ liveEmail, kind: hit.kind, nowMs, lastSwitch, accountsState,
    graceMs: opts.graceMs || POST_SWITCH_GRACE_MS, headroomFloor: opts.headroomFloor })
  if (sup.suppressed) {
    persist({ result: 'suppressed_post_switch_lagging_cap', capped_account: sup.cappedAccount, reason: sup.reason })
    return { action: 'suppressed_post_switch', kind: hit.kind, live: liveEmail, cappedAccount: sup.cappedAccount, reason: sup.reason, cap_at: hit.ts }
  }

  if (!usable.length) {
    const staleNote = staleButHealthy.length
      ? ` ${staleButHealthy.join(',')} has budget but its snapshot is STALE - re-auth (account-login) so I can switch.`
      : ' No account has budget.'

    // Debounce: require the no-target verdict (capped == live, no rotatable
    // target) to persist across consecutive scans before alerting. A genuine
    // cap re-injects a fresh cap notice every retry, so the streak builds; a
    // single-scan misattribution to the live account is reset the moment any
    // other outcome (capped_not_live / none / suppressed / switched) runs,
    // because persist() writes a fresh state object without pendingNoTarget.
    // The 2026-06-24 23:44 false "money@ capped" SMS fired on exactly such a
    // one-scan blip (money@ at 52.6% weekly headroom).
    const liveHeadroom = headroomFor(accountsState, liveEmail, hit.kind)
    const minScans = (liveHeadroom != null && liveHeadroom > NO_TARGET_HEADROOM_FLOOR)
      ? NO_TARGET_MIN_SCANS_WHEN_HEADROOM : NO_TARGET_MIN_SCANS
    const prevPending = state.pendingNoTarget
    const sameStreak = !!prevPending &&
      prevPending.account === (liveEmail || null) &&
      prevPending.kind === hit.kind &&
      (nowMs - (prevPending.firstMs || 0)) < NO_TARGET_STREAK_WINDOW_MS
    const scans = sameStreak ? (prevPending.scans || 1) + 1 : 1
    const firstMs = sameStreak ? prevPending.firstMs : nowMs
    const pendingNoTarget = { account: liveEmail || null, kind: hit.kind, firstMs, scans }

    if (scans < minScans) {
      persist({ result: 'no_target_pending', staleButHealthy, lastAlertTs: state.lastAlertTs || 0, pendingNoTarget })
      return { action: 'no_target_pending', kind: hit.kind, live: liveEmail, staleButHealthy, scans, minScans, liveHeadroom, cap_at: hit.ts }
    }

    const lastAlert = state.lastAlertTs || 0
    let alerted = false
    if (nowMs - lastAlert >= alertCooldownMs) {
      if (!dryRun) alert('real-limit-watch', `REAL ${hit.kind} cap hit on ${liveEmail || 'live account'} (${whenLocal}). Cannot auto-switch.${staleNote}`)
      alerted = true
      persist({ result: 'no_target_alerted', lastAlertTs: nowMs, staleButHealthy, pendingNoTarget })
    } else {
      persist({ result: 'no_target', staleButHealthy, lastAlertTs: lastAlert, pendingNoTarget })
    }
    return { action: alerted ? 'no_target_alerted' : 'no_target', kind: hit.kind, live: liveEmail, staleButHealthy, scans, minScans, cap_at: hit.ts }
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

    // 9. same cap but target snapshot STALE -> first scan is held by the debounce
    // (no_target_pending) but still surfaces the stale-but-healthy target so the
    // re-auth need is visible; the SMS fires once the verdict persists (cf. test 19).
    // Under dryRun persist() is a no-op, so a single call can only ever be scan 1.
    fs.writeFileSync(path.join(credsDir, 'code.json'), JSON.stringify({ claudeAiOauth: { expiresAt: now - 1000 } }))
    const res2 = await run({
      now, dryRun: true,
      projectsDir: path.join(tmp2, 'projects'),
      coordRoot: path.join(tmp2, 'coord'),
      credsDir,
      getActiveAccount: () => 'money@ecodia.au',
      agentTool: () => null,
    })
    assert(res2.action === 'no_target_pending' && res2.staleButHealthy.includes('code@ecodia.au'),
      'run(dry): real cap + only-stale target -> first scan held by debounce, stale target surfaced')
  } finally { try { fs.rmSync(tmp2, { recursive: true, force: true }) } catch (_) {} }

  // ── lagging-cap suppression (2026-06-24 inverted-alarm regression) ──────────
  const accts = { accounts: {
    'money@ecodia.au': { headroom_5h_fraction: 0.93, headroom_weekly_fraction: 0.90 },
    'code@ecodia.au': { headroom_5h_fraction: 0.90, headroom_weekly_fraction: 0.95 },
  } }
  const switched = { result: 'switched', from: 'code@ecodia.au', target: 'money@ecodia.au',
    cap_at: '2026-06-24T06:09:23.302Z', raised_at: '2026-06-24T06:10:21.413Z' }
  const t2 = Date.parse('2026-06-24T06:11:21.000Z')   // 1 min after the switch

  // 10. THE incident: fresh cap, we just switched code@ -> money@, money@ healthy -> SUPPRESS, blame stays code@
  let s = laggingCapSuppression({ liveEmail: 'money@ecodia.au', kind: 'weekly', nowMs: t2, lastSwitch: switched, accountsState: accts })
  assert(s.suppressed && s.cappedAccount === 'code@ecodia.au', 'post-switch lagging cap suppressed, blame stays on switched-off account')

  // 11. SAME timing but the now-live account is itself genuinely low -> do NOT mask (real double-cap must fire)
  const acctsLow = { accounts: { 'money@ecodia.au': { headroom_weekly_fraction: 0.15 }, 'code@ecodia.au': { headroom_weekly_fraction: 0.95 } } }
  s = laggingCapSuppression({ liveEmail: 'money@ecodia.au', kind: 'weekly', nowMs: t2, lastSwitch: switched, accountsState: acctsLow })
  assert(!s.suppressed, 'low-headroom live account is NOT suppressed (genuine fresh cap can still fire)')

  // 12. switch too old (>grace) -> normal attribution resumes, no suppression
  const tLate = Date.parse('2026-06-24T06:50:00.000Z')  // ~40min after switch
  s = laggingCapSuppression({ liveEmail: 'money@ecodia.au', kind: 'weekly', nowMs: tLate, lastSwitch: switched, accountsState: accts })
  assert(!s.suppressed, 'stale switch (>30min) does not suppress')

  // 13. something moved us off the switch target -> not a lagging re-injection of THIS switch
  s = laggingCapSuppression({ liveEmail: 'code@ecodia.au', kind: 'weekly', nowMs: t2, lastSwitch: switched, accountsState: accts })
  assert(!s.suppressed, 'live account != switch target -> no suppression')

  // 14. no prior switch / a noop result -> never suppress
  assert(!laggingCapSuppression({ liveEmail: 'money@ecodia.au', kind: 'weekly', nowMs: t2, lastSwitch: null, accountsState: accts }).suppressed, 'no lastSwitch -> no suppression')
  assert(!laggingCapSuppression({ liveEmail: 'money@ecodia.au', kind: 'weekly', nowMs: t2, lastSwitch: { result: 'already_on_target', from: 'code@ecodia.au', target: 'money@ecodia.au', raised_at: switched.raised_at }, accountsState: accts }).suppressed, 'noop switch result -> no suppression')

  // 15. run() end-to-end: fresh cap + we just switched off code@ onto money@ (healthy) -> action suppressed_post_switch, no alert, no re-switch
  const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), 'rlw-sup-'))
  try {
    const pdir = path.join(tmp3, 'projects', 'p'); fs.mkdirSync(pdir, { recursive: true })
    fs.writeFileSync(path.join(pdir, 's.jsonl'), mk("You've hit your weekly limit · resets Jun 26 at 11am (Australia/Brisbane)", new Date(now - 20000).toISOString()) + '\n')
    const usageDir = path.join(tmp3, 'coord', 'usage'); fs.mkdirSync(usageDir, { recursive: true })
    fs.writeFileSync(path.join(usageDir, 'accounts.json'), JSON.stringify({ accounts: {
      'money@ecodia.au': { headroom_5h_fraction: 0.93, headroom_weekly_fraction: 0.90 },
      'code@ecodia.au': { headroom_5h_fraction: 0.90, headroom_weekly_fraction: 0.95 },
    } }))
    let alerted = false
    const res = await run({
      now, dryRun: false,
      projectsDir: path.join(tmp3, 'projects'),
      coordRoot: path.join(tmp3, 'coord'),
      credsDir: path.join(tmp3, 'creds'),
      stateFile: path.join(usageDir, 'real-limit-watch.json'),
      getActiveAccount: () => 'money@ecodia.au',
      lastSwitch: { result: 'switched', from: 'code@ecodia.au', target: 'money@ecodia.au', cap_at: new Date(now - 60000).toISOString(), raised_at: new Date(now - 60000).toISOString() },
      agentTool: () => { throw new Error('must not rotate during suppression') },
      alert: () => { alerted = true; return true },
    })
    assert(res.action === 'suppressed_post_switch' && res.cappedAccount === 'code@ecodia.au' && !alerted,
      'run(): lagging cap after switch -> suppressed, no alert, no rotate')
  } finally { try { fs.rmSync(tmp3, { recursive: true, force: true }) } catch (_) {} }

  // ── dominant-session cap attribution (2026-06-24 root fix) ──────────────────
  const sj = {
    'big-code': { account: 'code@ecodia.au', total_tokens: 951183694 },
    'tiny-money': { account: 'money@ecodia.au', total_tokens: 110212 },
  }
  // heaviest capped session wins, even though the freshest message is the tiny one
  assert(resolveCappedAccount([{ sessionId: 'tiny-money' }, { sessionId: 'big-code' }], sj, 'money@ecodia.au') === 'code@ecodia.au',
    'resolveCappedAccount picks the heaviest capped session (code@), not the live fallback')
  // unknown session ids -> fallback to live
  assert(resolveCappedAccount([{ sessionId: 'nope' }], sj, 'money@ecodia.au') === 'money@ecodia.au',
    'resolveCappedAccount falls back to live when no session resolves')

  // 16. run() end-to-end THE Tate incident: live=money@ (healthy), but the heavy
  // fresh cap session is code@'s -> action capped_not_live, NO alert, NO rotate.
  const tmp4 = fs.mkdtempSync(path.join(os.tmpdir(), 'rlw-cnl-'))
  try {
    const pdir = path.join(tmp4, 'projects', 'p'); fs.mkdirSync(pdir, { recursive: true })
    // session id is the filename stem; make it 'heavy-code'
    fs.writeFileSync(path.join(pdir, 'heavy-code.jsonl'), mk("You've hit your weekly limit · resets Jun 26 at 11am (Australia/Brisbane)", new Date(now - 20000).toISOString()) + '\n')
    const usageDir = path.join(tmp4, 'coord', 'usage'); fs.mkdirSync(usageDir, { recursive: true })
    fs.writeFileSync(path.join(usageDir, 'accounts.json'), JSON.stringify({ accounts: {
      'money@ecodia.au': { headroom_weekly_fraction: 0.90 }, 'code@ecodia.au': { headroom_weekly_fraction: 0.95 },
    } }))
    let alerted = false
    const res = await run({
      now, dryRun: false,
      projectsDir: path.join(tmp4, 'projects'),
      coordRoot: path.join(tmp4, 'coord'),
      credsDir: path.join(tmp4, 'creds'),
      stateFile: path.join(usageDir, 'real-limit-watch.json'),
      getActiveAccount: () => 'money@ecodia.au',
      sessionsJson: { 'heavy-code': { account: 'code@ecodia.au', total_tokens: 951183694 } },
      agentTool: () => { throw new Error('must not rotate when capped account is not live') },
      alert: () => { alerted = true; return true },
    })
    assert(res.action === 'capped_not_live' && res.cappedAccount === 'code@ecodia.au' && res.live === 'money@ecodia.au' && !alerted,
      'run(): cap on non-live code@ while on healthy money@ -> capped_not_live, no alert, no rotate')
  } finally { try { fs.rmSync(tmp4, { recursive: true, force: true }) } catch (_) {} }

  // 17. run() the GENUINE live-cap case still works: live=code@ AND heavy cap session
  // is code@ -> proceeds to switch onto a healthy target (money@).
  const tmp5 = fs.mkdtempSync(path.join(os.tmpdir(), 'rlw-live-'))
  try {
    const pdir = path.join(tmp5, 'projects', 'p'); fs.mkdirSync(pdir, { recursive: true })
    fs.writeFileSync(path.join(pdir, 'heavy-code.jsonl'), mk("You've hit your weekly limit · resets Jun 26 at 11am (Australia/Brisbane)", new Date(now - 20000).toISOString()) + '\n')
    const usageDir = path.join(tmp5, 'coord', 'usage'); fs.mkdirSync(usageDir, { recursive: true })
    fs.writeFileSync(path.join(usageDir, 'accounts.json'), JSON.stringify({ accounts: {
      'money@ecodia.au': { headroom_5h_fraction: 0.95, headroom_weekly_fraction: 0.90 },
      'code@ecodia.au': { headroom_5h_fraction: 0.05, headroom_weekly_fraction: 0.05 },
    } }))
    const credsDir = path.join(tmp5, 'creds'); fs.mkdirSync(credsDir)
    fs.writeFileSync(path.join(credsDir, 'money.json'), JSON.stringify({ claudeAiOauth: { expiresAt: now + 3600 * 1000 } }))
    const res = await run({
      now, dryRun: true,
      projectsDir: path.join(tmp5, 'projects'),
      coordRoot: path.join(tmp5, 'coord'),
      credsDir,
      getActiveAccount: () => 'code@ecodia.au',
      sessionsJson: { 'heavy-code': { account: 'code@ecodia.au', total_tokens: 951183694 } },
      agentTool: () => ({ target: 'money@ecodia.au' }),
    })
    assert(res.action === 'switch' && res.target === 'money@ecodia.au',
      'run(): genuine live cap on code@ still switches onto healthy money@')
  } finally { try { fs.rmSync(tmp5, { recursive: true, force: true }) } catch (_) {} }

  // 18. DEBOUNCE the 2026-06-24 23:44 false alarm: live=money@, the fresh-capped
  // session resolves to money@ (collateral keychain bleed) AND money@ shows
  // healthy ccusage headroom (0.52 > floor) -> a SINGLE scan must NOT alert; it
  // returns no_target_pending and waits for persistence.
  const tmp6 = fs.mkdtempSync(path.join(os.tmpdir(), 'rlw-debounce-'))
  try {
    const pdir = path.join(tmp6, 'projects', 'p'); fs.mkdirSync(pdir, { recursive: true })
    fs.writeFileSync(path.join(pdir, 'money-collateral.jsonl'), mk("You've hit your weekly limit · resets Jun 26 at 11am (Australia/Brisbane)", new Date(now - 20000).toISOString()) + '\n')
    const usageDir = path.join(tmp6, 'coord', 'usage'); fs.mkdirSync(usageDir, { recursive: true })
    fs.writeFileSync(path.join(usageDir, 'accounts.json'), JSON.stringify({ accounts: {
      'money@ecodia.au': { headroom_weekly_fraction: 0.52 },
    } }))
    let alerted = false
    const res = await run({
      now, dryRun: false,
      projectsDir: path.join(tmp6, 'projects'),
      coordRoot: path.join(tmp6, 'coord'),
      credsDir: path.join(tmp6, 'creds'),       // empty -> no rotatable target -> usable=[]
      stateFile: path.join(usageDir, 'real-limit-watch.json'),
      getActiveAccount: () => 'money@ecodia.au',
      sessionsJson: { 'money-collateral': { account: 'money@ecodia.au', total_tokens: 110212 } },
      alert: () => { alerted = true; return true },
    })
    assert(res.action === 'no_target_pending' && !alerted,
      'run(): one-scan no-target on healthy live money@ -> no_target_pending, NO SMS (the 23:44 false alarm)')
  } finally { try { fs.rmSync(tmp6, { recursive: true, force: true }) } catch (_) {} }

  // 19. GENUINE persistent cap still alerts: live=money@, session->money@, money@
  // headroom LOW (0.05 -> minScans=2), no rotatable target. Two consecutive scans
  // sharing one state file -> scan1 pending (no SMS), scan2 fires the SMS.
  const tmp7 = fs.mkdtempSync(path.join(os.tmpdir(), 'rlw-persist-'))
  try {
    const pdir = path.join(tmp7, 'projects', 'p'); fs.mkdirSync(pdir, { recursive: true })
    const sfile = path.join(pdir, 'money-real.jsonl')
    const usageDir = path.join(tmp7, 'coord', 'usage'); fs.mkdirSync(usageDir, { recursive: true })
    fs.writeFileSync(path.join(usageDir, 'accounts.json'), JSON.stringify({ accounts: {
      'money@ecodia.au': { headroom_weekly_fraction: 0.05 },
    } }))
    const stateFile = path.join(usageDir, 'real-limit-watch.json')
    const common = {
      dryRun: false,
      projectsDir: path.join(tmp7, 'projects'),
      coordRoot: path.join(tmp7, 'coord'),
      credsDir: path.join(tmp7, 'creds'),
      stateFile,
      getActiveAccount: () => 'money@ecodia.au',
      sessionsJson: { 'money-real': { account: 'money@ecodia.au', total_tokens: 951183694 } },
    }
    // scan 1
    fs.writeFileSync(sfile, mk("You've hit your weekly limit · resets Jun 26 at 11am (Australia/Brisbane)", new Date(now - 20000).toISOString()) + '\n')
    let a1 = false
    const r1 = await run({ ...common, now, alert: () => { a1 = true; return true } })
    assert(r1.action === 'no_target_pending' && !a1, 'run(): genuine cap scan 1 -> no_target_pending, no SMS yet')
    // scan 2 (fresh cap ts so it clears already_fired; +60s later)
    const now2 = now + 60000
    fs.writeFileSync(sfile, mk("You've hit your weekly limit · resets Jun 26 at 11am (Australia/Brisbane)", new Date(now2 - 20000).toISOString()) + '\n')
    let a2 = false
    const r2 = await run({ ...common, now: now2, alert: () => { a2 = true; return true } })
    assert(r2.action === 'no_target_alerted' && a2, 'run(): genuine cap scan 2 -> no_target_alerted, SMS fires')
  } finally { try { fs.rmSync(tmp7, { recursive: true, force: true }) } catch (_) {} }

  console.log(process.exitCode ? '\nSELFTEST FAILED' : '\nSELFTEST PASSED')
}

if (require.main === module) {
  const arg = process.argv[2]
  if (arg === '--selftest') selftest()
  else run({ dryRun: arg === '--dry' }).then(r => console.log(JSON.stringify(r, null, 1)))
}

module.exports = { detectFreshRealLimit, findFreshRealLimit, resolveCappedAccount, rotatableEmails, headroomFor, laggingCapSuppression, run, readTail }
