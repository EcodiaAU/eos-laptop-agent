// usage.js - account-usage measurement, attribution, and selection.
//
// File-backed substrate at D:\.code\EcodiaOS\coordination\usage\:
//   accounts.json         - per-account rolling state {tokens_5h, tokens_weekly, ...}
//   sessions.json         - session_id -> {account, last_polled_at, total_tokens}
//   audit/<iso-date>.jsonl - daily audit log of poll deltas
//
// Plus active_account at:
//   D:\.code\EcodiaOS\coordination\active_account.json - {account, since_ts, set_by}
//
// SPIKE 1 confirmed JSONL schema (5:30am 18 May 2026):
//   Each assistant message line has:
//     timestamp: ISO-8601
//     sessionId: matches the JSONL filename stem
//     message.usage.input_tokens
//     message.usage.output_tokens
//     message.usage.cache_creation_input_tokens
//     message.usage.cache_read_input_tokens
//   Cache reads/creations DO count against Max-plan caps per Anthropic billing docs
//   - we sum all 4 fields for the headroom math (conservative).
//
// SPIKE 2 confirmed ccusage works on Windows; we use its session JSON output
// to get pre-aggregated per-session totals, then attribute sessions -> accounts
// via the worker rows + the active_account at conductor session start.
//
// Account selection (coord.pick_account):
//   score(a) = min(remaining_5h, remaining_weekly) * 0.85 - estimated_tokens
//   0.85 = the 15% conservative buffer (per spec).
//
// Cap assumptions (Max 20x, AUD 1020/mo):
//   5h session: 220M tokens (rough; tuneable via CAPS env override)
//   weekly:    1B tokens
// These are first-pass numbers; the headroom math is correct regardless of
// the exact cap value, and we surface a warning at <20% to give Tate room
// to tune.

const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')

// CREATE_NO_WINDOW — required alongside windowsHide under PM2-parented agents
// to fully suppress the Windows console flash. Per
// ~/ecodiaos/patterns/windows-spawn-must-use-spawnSync-with-create-no-window-not-execSync-with-windowsHide.md
const CREATE_NO_WINDOW = 0x08000000

// ccusage CLI direct entry. Invoking node.exe + cli.js avoids the cmd.exe
// /d /s /c shell wrapper and the npx-CLI re-exec — both of those layers were
// empirically still flashing a console under PM2 even with CREATE_NO_WINDOW
// (libuv seems to re-allocate a console for the npm-wrapper child). Falling
// back to bare-node invocation eliminates the wrappers entirely.
// Override via CCUSAGE_CLI_JS env if the global install lives elsewhere.
const CCUSAGE_CLI_JS = process.env.CCUSAGE_CLI_JS || (
  process.platform === 'win32'
    ? 'D:\\SSD_Turbo\\node-global\\node_modules\\ccusage\\dist\\cli.js'
    : '/opt/homebrew/lib/node_modules/ccusage/dist/cli.js'
)
const NODE_EXE = process.execPath  // current node binary, always valid

// Mac canonical coordination root is ~/.ecodiaos/coordination (the path the
// launchd usage-poller plist sets via COORD_ROOT, and the path coord.* +
// account-cap-decide.js read). The prior Mac default '/Users/ecodia/.code/
// ecodiaos/coordination' DISAGREED with all of those, so a poller started
// without the plist env silently wrote honest data to a file nobody reads while
// consumers served a stale file - a latent "measurement disconnect" found
// 2026-06-21. Default now matches the canonical path; env still overrides.
const COORD_ROOT = process.env.COORD_ROOT || (
  process.platform === 'win32'
    ? 'D:\\.code\\EcodiaOS\\coordination'
    : path.join(os.homedir(), '.ecodiaos', 'coordination')
)
const USAGE_DIR = path.join(COORD_ROOT, 'usage')
const AUDIT_DIR = path.join(USAGE_DIR, 'audit')
const ACCOUNTS_FILE = path.join(USAGE_DIR, 'accounts.json')
const SESSIONS_FILE = path.join(USAGE_DIR, 'sessions.json')
const FLAKY_FILE = path.join(USAGE_DIR, 'flaky.json')  // {account: flaky_at_iso}
const ACTIVE_ACCOUNT_FILE = path.join(COORD_ROOT, 'active_account.json')
const WORKERS_DIR = path.join(COORD_ROOT, 'workers')

// Defaults; override via env CAPS_5H_TOKENS / CAPS_WEEKLY_TOKENS.
const DEFAULT_CAP_5H = 220_000_000
// 2026-06-10: was 1_000_000_000, which is provably below the real ceiling -
// money@ ran at 2.49B weekly while serving live interactive sessions fine,
// yet headroom_score pinned 0 (min of the two fractions) and the dispatcher
// deferred EVERY cron on AllAccountsCappedError for the rest of the week.
// 6.6B = the 20B/week org budget split across 3 accounts. The 5h window is
// the real throttle; weekly is a budget rail, not a hard vendor cap.
const DEFAULT_CAP_WEEKLY = 6_600_000_000
const BUFFER_FACTOR = 0.85  // 15% conservative buffer
const HEADROOM_WARNING_FRACTION = 0.20  // <20% remaining = warn
const FLAKY_TTL_MS = 10 * 60 * 1000  // 10min cooldown after a dispatch failure

const KNOWN_ACCOUNTS = ['tate@ecodia.au', 'code@ecodia.au', 'money@ecodia.au']
const DEFAULT_ACTIVE = 'money@ecodia.au'  // conductor pins here per spec

// Accept short ("tate") or full ("tate@ecodia.au"), return canonical full form.
// Returns null if input does not match any known account.
// Authoritative entry point for any "is this a valid account?" check across
// usage.js and cowork.js. Added 2026-05-18 to fix swap_creds short/full mismatch.
function normalizeAccount(input) {
  if (!input) return null
  const s = String(input).trim().toLowerCase()
  if (KNOWN_ACCOUNTS.includes(s)) return s
  // Short form path: append the ecodia domain and re-check.
  // KNOWN_ACCOUNTS is the single source of truth for valid suffixes.
  for (const full of KNOWN_ACCOUNTS) {
    const short = full.split('@')[0]
    if (s === short) return full
  }
  return null
}

// Short form lookup for callers that need it (e.g. cowork.swap_creds backup file path).
function shortForm(full) {
  if (!full) return null
  return String(full).split('@')[0]
}

function ensureDirs() {
  for (const d of [USAGE_DIR, AUDIT_DIR, WORKERS_DIR]) {
    try { fs.mkdirSync(d, { recursive: true }) } catch (e) {}
  }
}

function atomicWriteJson(filepath, obj) {
  const tmp = filepath + '.tmp-' + process.pid + '-' + Date.now()
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8')
  fs.renameSync(tmp, filepath)
}

function readJsonSafe(filepath, fallback) {
  try { return JSON.parse(fs.readFileSync(filepath, 'utf8')) } catch (e) { return fallback }
}

function getCaps() {
  const cap5h = Number(process.env.CAPS_5H_TOKENS) || DEFAULT_CAP_5H
  const capWeekly = Number(process.env.CAPS_WEEKLY_TOKENS) || DEFAULT_CAP_WEEKLY
  return { cap_5h: cap5h, cap_weekly: capWeekly }
}

// Limit-relevant token count for a ccusage row. ccusage `totalTokens` is
// DOMINATED by cache-read tokens (measured 2026-06-21: cacheRead = 94.6% of an
// active block's totalTokens, 708.8M of 749.5M). Anthropic's 5h/weekly usage
// limits do NOT count cache-read at full weight, so summing totalTokens made
// every WORKING account read as 2x over the 5h cap within hours - the account
// the conductor was actively thinking on reported "capped" while it served. That
// false-capped signal is the root of "every measurement is going wrong"
// (Tate 2026-06-21). The honest measure: input + output + cacheCreation, plus
// cacheRead at CACHE_READ_WEIGHT (default 0 = exclude; tunable if calibration vs
// the live UI shows cache-read should carry a small weight). Doctrine:
// patterns/usage-5h-measure-must-exclude-cache-read-tokens-2026-06-21.md
const CACHE_READ_WEIGHT = process.env.CACHE_READ_WEIGHT != null ? Number(process.env.CACHE_READ_WEIGHT) : 0
function limitTokens(row) {
  if (!row) return 0
  const input = Number(row.inputTokens) || 0
  const output = Number(row.outputTokens) || 0
  const cacheCreate = Number(row.cacheCreationTokens || row.cacheCreationInputTokens) || 0
  const cacheRead = Number(row.cacheReadTokens || row.cacheReadInputTokens) || 0
  return input + output + cacheCreate + cacheRead * CACHE_READ_WEIGHT
}

// ── active_account ────────────────────────────────────────────────────────

// The account Claude Code itself records as logged-in. ~/.claude.json
// oauthAccount.emailAddress is rewritten on every `claude auth login` (INCLUDING
// a manual /login Tate types), so it is the authoritative live identity when
// current_account()'s token-match returns 'unknown' - a fresh login mints an
// opaque token (sk-...) that matches no per-account snapshot, so token-equality
// cannot name the account. Origin: 2026-06-21, a manual /login drifted the
// active_account marker and the autoswitch decision evaluated the wrong account.
function liveAccountFromClaudeConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'))
    const email = cfg && cfg.oauthAccount && cfg.oauthAccount.emailAddress
    return email ? normalizeAccount(email) : null
  } catch (e) { return null }
}

function getActiveAccount() {
  ensureDirs()
  // 2026-06-08 (attribution fix): defer to creds.current_account first. The
  // live ~/.claude/.credentials.json is the truth about which Anthropic
  // account every API call hits, regardless of what active_account.json
  // remembers. Without this deferral the dispatcher tagged every worker as
  // money@ecodia.au (the DEFAULT_ACTIVE bootstrap value) even though the live
  // creds were tate's, so ccusage attribution inverted the rate-limit picture.
  try {
    const creds = require('./creds')
    const short = creds.current_account && creds.current_account()
    if (short && short !== 'unknown') {
      const canonical = normalizeAccount(short)
      if (canonical) {
        const row = readJsonSafe(ACTIVE_ACCOUNT_FILE, null)
        if (!row || row.account !== canonical) {
          // Lazy-sync active_account.json to match live creds so
          // downstream readers (mac-dispatcher, swap_history) stay aligned.
          try { setActiveAccount(canonical, 'live-creds-sync') } catch (e) {}
        }
        return canonical
      }
    }
  } catch (e) {
    // creds module unavailable or threw - fall through to file-based read
  }
  // Marker self-heal (2026-06-21): current_account() returned 'unknown' (a manual
  // /login minted a snapshot-mismatched token). Trust Claude Code's own record of
  // the logged-in account and re-point the marker, instead of serving a stale one.
  const fromCfg = liveAccountFromClaudeConfig()
  if (fromCfg) {
    const row0 = readJsonSafe(ACTIVE_ACCOUNT_FILE, null)
    if (!row0 || row0.account !== fromCfg) {
      try { setActiveAccount(fromCfg, 'claude-config-oauthaccount-selfheal') } catch (e) {}
    }
    return fromCfg
  }
  const row = readJsonSafe(ACTIVE_ACCOUNT_FILE, null)
  if (row && row.account) return row.account
  // First run - seed the default and return.
  setActiveAccount(DEFAULT_ACTIVE, 'bootstrap')
  return DEFAULT_ACTIVE
}

function setActiveAccount(account, set_by) {
  const canonical = normalizeAccount(account)
  if (!canonical) {
    throw new Error('unknown account: ' + account + ' (accepts short "tate" or full "tate@ecodia.au"; known: ' + KNOWN_ACCOUNTS.join(',') + ')')
  }
  ensureDirs()
  const row = { account: canonical, since_ts: new Date().toISOString(), set_by: set_by || 'unknown' }
  atomicWriteJson(ACTIVE_ACCOUNT_FILE, row)
  return row
}

// ── ccusage wrapper ───────────────────────────────────────────────────────

// Returns the parsed `session` JSON from `ccusage session --json`.
// Each row: { period: <session_id>, totalTokens, inputTokens, outputTokens,
//             cacheCreationTokens, cacheReadTokens, metadata: { lastActivity: 'YYYY-MM-DD' } }
function runCcusageSession() {
  // npx -y ccusage@latest session --json (no install, uses npx cache)
  // Use a generous timeout - first run cold-installs ccusage (~30s on slow link).
  // Bare-node invocation: no cmd.exe, no npx, no shell wrapper. With shell:false
  // + stdio:'ignore' on stdin + windowsHide + CREATE_NO_WINDOW, libuv suppresses
  // console allocation entirely.
  const res = spawnSync(NODE_EXE, [CCUSAGE_CLI_JS, 'session', '--json'], {
    shell: false,
    windowsHide: true,
    creationFlags: CREATE_NO_WINDOW,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (res.status !== 0) {
    throw new Error('ccusage session failed: status=' + res.status + ' stderr=' + (res.stderr || '').slice(0, 500))
  }
  try {
    const parsed = JSON.parse(res.stdout)
    return parsed.session || []
  } catch (e) {
    throw new Error('ccusage stdout parse failed: ' + e.message)
  }
}

// Returns parsed `blocks` JSON from `ccusage blocks --json`.
// Each row: { id, startTime, endTime, isActive, isGap, tokenCounts: {...}, totalTokens }
// 5-hour rolling windows; isActive=true is the live window.
function runCcusageBlocks() {
  const res = spawnSync(NODE_EXE, [CCUSAGE_CLI_JS, 'blocks', '--json'], {
    shell: false,
    windowsHide: true,
    creationFlags: CREATE_NO_WINDOW,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (res.status !== 0) {
    throw new Error('ccusage blocks failed: status=' + res.status + ' stderr=' + (res.stderr || '').slice(0, 500))
  }
  try {
    const parsed = JSON.parse(res.stdout)
    return parsed.blocks || []
  } catch (e) {
    throw new Error('ccusage blocks parse failed: ' + e.message)
  }
}

// ── session -> account attribution ────────────────────────────────────────

// Build session_id -> account mapping from worker files. A worker file shape
// (after dispatch_worker is patched to persist) looks like:
//   { tab_id, account_active_when_spawned, session_id?, ... }
//
// Workers don't directly know their CC session_id (the JSONL stem). Heuristic:
//   - The CC session is the JSONL file with the most recent mtime in the
//     project dir at the moment of worker spawn.
//   - We attempt to bind worker.tab_id -> session_id via the existing
//     worker.session_id field if Chat B's dispatcher persisted it; otherwise
//     we attribute by timestamp-proximity (worker registered_at ~ session
//     first-message timestamp within 60s).
//
// For sessions that don't map to any worker, attribute to the active_account
// at the session's lastActivity date (best-effort; the conductor's own
// session attributes to whoever was active at that time).
function buildSessionAccountMap() {
  ensureDirs()
  const map = {}  // session_id -> account
  const workerHints = []  // [{ session_id, account, registered_ms }]

  // Walk worker rows
  try {
    for (const f of fs.readdirSync(WORKERS_DIR)) {
      if (!f.endsWith('.json')) continue
      const w = readJsonSafe(path.join(WORKERS_DIR, f), null)
      if (!w || !w.account_active_when_spawned) continue
      const account = w.account_active_when_spawned
      // Skip 'current-process' fallback - we want a real account label
      if (account === 'current-process' || !KNOWN_ACCOUNTS.includes(account)) continue

      // Direct binding if Chat B (or future patch) recorded session_id
      if (w.session_id) {
        map[w.session_id] = account
      }
      workerHints.push({
        account: account,
        registered_ms: w.registered_at ? new Date(w.registered_at).getTime() : 0,
        terminated_ms: w.terminated_at ? new Date(w.terminated_at).getTime() : Number.POSITIVE_INFINITY,
      })
    }
  } catch (e) {}

  return { map: map, workerHints: workerHints }
}

// Walk the CC projects dir, capture birthtime + mtime per session.
// Returns {sid: {birth_ms, mtime_ms}}. Used by attribution (birth) AND by
// rolling-window filters (mtime, which is more accurate than ccusage's
// date-truncated lastActivity field for "did this session see activity in
// the last 5h").
function sessionFileTimes() {
  const projectsRoot = path.join(os.homedir(), '.claude', 'projects')
  const out = {}
  try {
    for (const project of fs.readdirSync(projectsRoot)) {
      const dir = path.join(projectsRoot, project)
      let stat
      try { stat = fs.statSync(dir) } catch (e) { continue }
      if (!stat.isDirectory()) continue
      try {
        for (const f of fs.readdirSync(dir)) {
          if (!f.endsWith('.jsonl')) continue
          const session_id = f.slice(0, -6)
          const filepath = path.join(dir, f)
          try {
            const s = fs.statSync(filepath)
            out[session_id] = {
              birth_ms: (s.birthtimeMs && s.birthtimeMs > 0) ? s.birthtimeMs : s.mtimeMs,
              mtime_ms: s.mtimeMs,
            }
          } catch (e) {}
        }
      } catch (e) {}
    }
  } catch (e) {}
  return out
}

// Compat wrapper: previous callers want session_id -> birth_ms only.
function sessionStartTimes() {
  const ft = sessionFileTimes()
  const out = {}
  for (const sid of Object.keys(ft)) out[sid] = ft[sid].birth_ms
  return out
}

// Attribute every known session_id -> account.
//
// Attribution sources (in order):
//   1. Sticky prior attribution (once a session is attributed, keep it - protects
//      against active_account flips after the session was already tagged).
//   2. Direct binding from worker.session_id field (Chat B persists this).
//   3. Worker-hint timestamp proximity (worker.registered_at brackets session start).
//   4. Swap history reverse-lookup: which account was active when this session
//      was BORN (sessionStartTimes -> swap_history walk). This is the load-bearing
//      fallback for the conductor's own session and any other sessions that
//      weren't dispatcher-spawned.
//   5. Active-account NOW (last-resort guess; only valid for sessions born after
//      the active_account file's since_ts).
//   6. unknown-pre-tracking - excluded from rolling windows.
function attributeSessionsToAccounts(sessions) {
  const { map: directMap, workerHints } = buildSessionAccountMap()
  const fileTimes = sessionFileTimes()
  const startTimes = {}
  for (const sid of Object.keys(fileTimes)) startTimes[sid] = fileTimes[sid].birth_ms
  const out = {}

  // Sticky prior attribution. Once attributed to a real account, lock it -
  // active_account flips mid-session must not retroactively re-attribute.
  const prior = readJsonSafe(SESSIONS_FILE, {})
  for (const sid of Object.keys(prior)) {
    const acct = prior[sid] && prior[sid].account
    if (acct && acct !== 'unknown-pre-tracking') out[sid] = acct
  }

  // Apply direct bindings (override prior if Chat B wrote them)
  for (const sid of Object.keys(directMap)) out[sid] = directMap[sid]

  // Read swap history for source 4. swap_history.json is at COORD_ROOT/swap_history.json.
  // Entries: { ts, from_account, to_account }. Walk in reverse-chronological
  // order to find the account that was active at a given ms.
  const swapHistory = readJsonSafe(path.join(COORD_ROOT, 'swap_history.json'), []) || []
  const active = readJsonSafe(ACTIVE_ACCOUNT_FILE, null)
  const activeSinceMs = (active && active.since_ts) ? new Date(active.since_ts).getTime() : 0
  const activeAccount = active && active.account
  function accountActiveAtMs(targetMs) {
    if (!targetMs) return null
    // Walk swap history from newest to oldest. Each row swaps FROM -> TO at ts.
    // The account active AT targetMs is the TO of the most recent swap with ts <= targetMs,
    // OR if no swap has ts <= targetMs, the FROM of the earliest swap (i.e. before any swap).
    // Edge: if active_account file's since_ts <= targetMs and no later swap, return active.
    if (activeAccount && activeSinceMs && activeSinceMs <= targetMs) {
      // Check no swap has happened after activeSinceMs that moves us away
      let postSwap = null
      for (const s of swapHistory) {
        const sMs = new Date(s.ts).getTime()
        if (sMs > activeSinceMs && sMs <= targetMs) postSwap = s
      }
      if (!postSwap) return activeAccount
      return postSwap.to_account
    }
    // Otherwise walk history
    let bestTs = -Infinity
    let bestAccount = null
    for (const s of swapHistory) {
      const sMs = new Date(s.ts).getTime()
      if (sMs <= targetMs && sMs > bestTs) {
        bestTs = sMs
        bestAccount = s.to_account
      }
    }
    return bestAccount
  }

  // For unattributed sessions, infer:
  for (const row of sessions) {
    const sid = row.period
    if (out[sid]) continue

    const startMs = startTimes[sid] || 0

    // 1. worker-hint proximity (registered_ms within 60s before session start)
    let matched = null
    for (const hint of workerHints) {
      if (startMs >= hint.registered_ms - 60_000 && startMs <= hint.terminated_ms + 60_000) {
        matched = hint.account
        break
      }
    }
    if (matched) { out[sid] = matched; continue }

    // 2. swap_history reverse-lookup using session BIRTHTIME (not lastActivity
    // date-truncated). This correctly attributes the conductor's own session and
    // anything else born after we started tracking.
    if (startMs) {
      const acctAtBirth = accountActiveAtMs(startMs)
      if (acctAtBirth && KNOWN_ACCOUNTS.includes(acctAtBirth)) {
        out[sid] = acctAtBirth
        continue
      }
    }

    // 3. Active-recent fallback: if the session is still being written to (mtime
    // within the last 24h) AND we have a current active_account, attribute it
    // there. This handles the conductor's own session (born before the tracking
    // layer existed but actively in use today) and any worker tabs that lacked
    // explicit attribution. Without this, every session pre-dating the
    // active_account.json bootstrap is forever "unknown-pre-tracking" and the
    // headroom math reports 0 tokens per account - useless.
    const ftEntry = fileTimes[sid]
    const mtimeMs = (ftEntry && ftEntry.mtime_ms) || 0
    // ACTIVE_RECENT_WINDOW_MS: 24h. The "is this session still alive?" probe.
    if (activeAccount && mtimeMs && Date.now() - mtimeMs < 24 * 60 * 60 * 1000) {
      out[sid] = activeAccount
      continue
    }

    out[sid] = 'unknown-pre-tracking'
  }
  return out
}

// ── poller core ───────────────────────────────────────────────────────────

function poll() {
  ensureDirs()
  const pollTs = new Date()
  const caps = getCaps()

  const sessions = runCcusageSession()
  const attribution = attributeSessionsToAccounts(sessions)

  // Build per-session file-time map (mtime is more accurate than ccusage's
  // date-truncated lastActivity for rolling-window filters).
  const fileTimes = sessionFileTimes()

  const blocks = runCcusageBlocks()

  const accounts = {}
  for (const acct of KNOWN_ACCOUNTS) {
    accounts[acct] = {
      tokens_5h: 0,
      tokens_weekly: 0,
      sessions_5h: 0,
      sessions_weekly: 0,
      last_polled_at: pollTs.toISOString(),
    }
  }

  // Resolve effective last-activity-ms per session: prefer mtime, fall back to
  // date-truncated lastActivity string from ccusage.
  function sessionLastActivityMs(row) {
    const ft = fileTimes[row.period]
    if (ft && ft.mtime_ms) return ft.mtime_ms
    const la = row.metadata && row.metadata.lastActivity
    return la ? new Date(la + 'T00:00:00Z').getTime() : 0
  }

  // Weekly window - 7 days ending now
  const weekStartMs = Date.now() - 7 * 24 * 60 * 60 * 1000
  for (const row of sessions) {
    const acct = attribution[row.period]
    if (!acct || !KNOWN_ACCOUNTS.includes(acct)) continue
    const laMs = sessionLastActivityMs(row)
    if (laMs >= weekStartMs) {
      accounts[acct].tokens_weekly += limitTokens(row)  // exclude cache-read inflation
      accounts[acct].sessions_weekly += 1
    }
  }

  // 5h window - the active block (or now-5h fallback).
  let active5hStartMs = Date.now() - 5 * 60 * 60 * 1000
  for (const b of blocks) {
    if (b.isActive && !b.isGap) {
      active5hStartMs = new Date(b.startTime).getTime()
      break
    }
  }
  for (const row of sessions) {
    const acct = attribution[row.period]
    if (!acct || !KNOWN_ACCOUNTS.includes(acct)) continue
    const laMs = sessionLastActivityMs(row)
    if (laMs >= active5hStartMs) {
      accounts[acct].tokens_5h += limitTokens(row)  // exclude cache-read inflation
      accounts[acct].sessions_5h += 1
    }
  }

  // ── window-truth normalisation (2026-07-17 "cried wolf" fix) ────────────────
  //
  // Cache-read is ALREADY excluded above (limitTokens, CACHE_READ_WEIGHT=0), so
  // the 2026-06-21 doctrine is in place. But the per-account sums above add each
  // matched session's LIFETIME limit-relevant total (ccusage `session` reports
  // cumulative-per-session), gated only by whether the session was TOUCHED in the
  // window (mtime/date). A long-lived session active for 10 min in the last 5h
  // therefore dumps its ENTIRE multi-hour lifetime total into the 5h bucket.
  // Measured 2026-07-17: the poller read code@ 5h = 130.5M vs the TRUE 5h window
  // (ccusage `blocks` active-block limit-relevant, all accounts) of 64.9M - a
  // ~2.8x over-count that read code@ as 314% of its 41.5M budget slice, forcing
  // autoswitch + pick_account to cry wolf while live sessions kept serving.
  //
  // Fix: ccusage `blocks` gives the TRUE rolling-window token counts but no
  // per-account split; `session` gives the per-account split but lifetime totals.
  // Anchor the two: scale each account's windowed sum by
  // (true-windowed-limit-relevant / sum-of-account-windowed-sums), capped at 1 so
  // we only ever scale DOWN. This preserves the relative per-account distribution
  // (the account that dominated the window still reads highest) while pinning the
  // AGGREGATE to ground truth. Fails safe: if blocks are unreadable or the maths
  // is degenerate, the factor is 1 and behaviour is exactly as before (never
  // worse). Doctrine: patterns/usage-5h-measure-must-exclude-cache-read-tokens-
  // 2026-06-21 (extended: exclude lifetime-into-window inflation too).
  function blockLimitRelevant(b) {
    const tc = (b && b.tokenCounts) || {}
    const input = Number(tc.inputTokens) || 0
    const output = Number(tc.outputTokens) || 0
    const cacheCreate = Number(tc.cacheCreationInputTokens || tc.cacheCreationTokens) || 0
    const cacheRead = Number(tc.cacheReadInputTokens || tc.cacheReadTokens) || 0
    return input + output + cacheCreate + cacheRead * CACHE_READ_WEIGHT
  }
  function normaliseToWindowTruth(field, trueWindowedTotal) {
    if (!(trueWindowedTotal > 0)) return { factor: 1, applied: false }
    let sumAcct = 0
    for (const acct of KNOWN_ACCOUNTS) sumAcct += accounts[acct][field] || 0
    if (!(sumAcct > trueWindowedTotal)) return { factor: 1, applied: false }  // already within truth
    const factor = trueWindowedTotal / sumAcct
    for (const acct of KNOWN_ACCOUNTS) accounts[acct][field] = Math.round((accounts[acct][field] || 0) * factor)
    return { factor: factor, applied: true, sumAcct: sumAcct, trueWindowedTotal: trueWindowedTotal }
  }
  try {
    // True 5h window = the active (non-gap) block's limit-relevant tokens.
    let trueWindowed5h = 0
    for (const b of blocks) { if (b.isActive && !b.isGap) { trueWindowed5h = blockLimitRelevant(b); break } }
    // True weekly window = limit-relevant summed over every block starting in the last 7d.
    let trueWindowedWeekly = 0
    for (const b of blocks) {
      if (b.isGap) continue
      const st = b.startTime ? new Date(b.startTime).getTime() : 0
      if (st >= weekStartMs) trueWindowedWeekly += blockLimitRelevant(b)
    }
    const n5 = normaliseToWindowTruth('tokens_5h', trueWindowed5h)
    const nw = normaliseToWindowTruth('tokens_weekly', trueWindowedWeekly)
    if (n5.applied || nw.applied) {
      process.stderr.write('[usage] window-truth normalise: 5h factor=' +
        (n5.factor).toFixed(3) + ' (sum ' + Math.round((n5.sumAcct || 0) / 1e6) + 'M -> truth ' +
        Math.round(trueWindowed5h / 1e6) + 'M), weekly factor=' + (nw.factor).toFixed(3) + '\n')
    }
  } catch (e) {
    process.stderr.write('[usage] window-truth normalise skipped (fail-safe to raw sums): ' + e.message + '\n')
  }

  // Compute headroom scores
  for (const acct of KNOWN_ACCOUNTS) {
    const a = accounts[acct]
    const remaining_5h = Math.max(0, caps.cap_5h - a.tokens_5h)
    const remaining_weekly = Math.max(0, caps.cap_weekly - a.tokens_weekly)
    a.remaining_5h = remaining_5h
    a.remaining_weekly = remaining_weekly
    a.headroom_5h_fraction = remaining_5h / caps.cap_5h
    a.headroom_weekly_fraction = remaining_weekly / caps.cap_weekly
    a.headroom_score = Math.min(a.headroom_5h_fraction, a.headroom_weekly_fraction)
    a.cap_5h = caps.cap_5h
    a.cap_weekly = caps.cap_weekly
  }

  const payload = {
    polled_at: pollTs.toISOString(),
    active_account: getActiveAccount(),
    accounts: accounts,
  }
  atomicWriteJson(ACCOUNTS_FILE, payload)

  // Persist sessions attribution so future polls are sticky
  const sessionsState = {}
  for (const row of sessions) {
    sessionsState[row.period] = {
      account: attribution[row.period] || 'unknown',
      last_activity: row.metadata && row.metadata.lastActivity,
      total_tokens: Number(row.totalTokens) || 0,
    }
  }
  atomicWriteJson(SESSIONS_FILE, sessionsState)

  // Audit log
  const dateStr = pollTs.toISOString().slice(0, 10)
  const auditFile = path.join(AUDIT_DIR, dateStr + '.jsonl')
  const auditLine = JSON.stringify({
    polled_at: pollTs.toISOString(),
    sessions_seen: sessions.length,
    per_account: Object.fromEntries(KNOWN_ACCOUNTS.map(a => [a, {
      tokens_5h: accounts[a].tokens_5h,
      tokens_weekly: accounts[a].tokens_weekly,
      headroom_score: accounts[a].headroom_score,
    }])),
  }) + '\n'
  try { fs.appendFileSync(auditFile, auditLine, 'utf8') } catch (e) {}

  return payload
}

function readAccountsState() {
  ensureDirs()
  return readJsonSafe(ACCOUNTS_FILE, null)
}

// ── flaky-account tracking (Component 4) ─────────────────────────────────
//
// When dispatch_worker fails on account X after recovery attempts, we record
// the failure in flaky.json. coord.pick_account excludes accounts marked
// flaky within FLAKY_TTL_MS (10min). Self-healing - no manual reset needed.

function readFlaky() {
  ensureDirs()
  return readJsonSafe(FLAKY_FILE, {}) || {}
}

function activeFlakySet() {
  const all = readFlaky()
  const now = Date.now()
  const active = new Set()
  for (const acct of Object.keys(all)) {
    const ts = all[acct] ? new Date(all[acct].flaky_at).getTime() : 0
    if (now - ts < FLAKY_TTL_MS) active.add(acct)
  }
  return active
}

function markFlaky(account, reason) {
  const canonical = normalizeAccount(account)
  if (!canonical) throw new Error('unknown account: ' + account + ' (accepts short or full form)')
  ensureDirs()
  const all = readFlaky()
  all[canonical] = {
    flaky_at: new Date().toISOString(),
    reason: String(reason || 'unspecified').slice(0, 500),
  }
  atomicWriteJson(FLAKY_FILE, all)
  return all[canonical]
}

function clearFlaky(account) {
  const canonical = normalizeAccount(account) || account
  ensureDirs()
  const all = readFlaky()
  delete all[canonical]
  atomicWriteJson(FLAKY_FILE, all)
  return { ok: true, cleared: canonical }
}

// ── account picker ───────────────────────────────────────────────────────

// score(a) = min(remaining_5h, remaining_weekly) * 0.85 - estimated_tokens
// Excludes accounts in exclude[], accounts marked flaky within FLAKY_TTL_MS,
// and accounts with no state. Returns best-of-bad-options with negative score
// + reason flag if no candidate has positive buffered headroom.
function pickAccount(params) {
  params = params || {}
  const estimated = Math.max(0, Number(params.estimated_tokens) || 0)
  const exclude = new Set(params.exclude || [])
  const ignoreFlaky = !!params.ignore_flaky  // escape hatch for debugging
  const state = readAccountsState()
  if (!state || !state.accounts) {
    return {
      account: null,
      score: 0,
      remaining_5h: 0,
      remaining_weekly: 0,
      reason: 'no-state-poll-not-run-yet',
    }
  }

  const flakySet = ignoreFlaky ? new Set() : activeFlakySet()
  const flakyExcluded = []

  let best = null
  let bestScore = Number.NEGATIVE_INFINITY
  const candidates = []
  for (const acct of KNOWN_ACCOUNTS) {
    if (exclude.has(acct)) continue
    if (flakySet.has(acct)) { flakyExcluded.push(acct); continue }
    const a = state.accounts[acct]
    if (!a) continue
    const headroom = Math.min(a.remaining_5h, a.remaining_weekly)
    const score = headroom * BUFFER_FACTOR - estimated
    candidates.push({ account: acct, score: score, remaining_5h: a.remaining_5h, remaining_weekly: a.remaining_weekly })
    if (score > bestScore) {
      bestScore = score
      best = acct
    }
  }

  if (!best) {
    return {
      account: null,
      score: 0,
      remaining_5h: 0,
      remaining_weekly: 0,
      reason: flakyExcluded.length === KNOWN_ACCOUNTS.length
        ? 'all-accounts-flaky-within-cooldown (retry after FLAKY_TTL_MS)'
        : 'no-eligible-accounts (all excluded or no state)',
      candidates: candidates,
      flaky_excluded: flakyExcluded,
    }
  }

  const a = state.accounts[best]
  return {
    account: best,
    score: bestScore,
    remaining_5h: a.remaining_5h,
    remaining_weekly: a.remaining_weekly,
    buffer_factor: BUFFER_FACTOR,
    estimated_tokens: estimated,
    polled_at: state.polled_at,
    reason: bestScore < 0 ? 'best-account-still-insufficient (estimate exceeds buffered headroom)' : 'highest-buffered-headroom',
    candidates: candidates,
    flaky_excluded: flakyExcluded,
  }
}

// ── alerting ─────────────────────────────────────────────────────────────

// Compute alerts: returns { current_account_low, all_low, accounts_low }
function computeAlerts() {
  const state = readAccountsState()
  if (!state || !state.accounts) return { current_account_low: false, all_low: false, accounts_low: [] }
  const current = state.active_account
  const lowAccounts = []
  for (const acct of KNOWN_ACCOUNTS) {
    const a = state.accounts[acct]
    if (!a) continue
    if (a.headroom_score < HEADROOM_WARNING_FRACTION) lowAccounts.push({ account: acct, headroom_score: a.headroom_score })
  }
  // A pin on a starved account is always wrong: it silently defeats the
  // autoswitch while the whole worker fleet stalls on the capped account
  // (2026-07-17: a bare 18-day-old pin held the fleet on code@ at zero 5h
  // headroom; workers leased, never bound, and rows failed as stale leases).
  // Surface it loudly so the poller/canaries can escalate instead of the
  // fleet discovering it by starvation. Doctrine:
  // patterns/auto-switch-defeated-by-stale-disable-and-drifted-cap-2026-06-19.md
  let pinned_account_starved = null
  try {
    const fs = require('fs')
    const pinPath = require('path').join(process.env.HOME || '/Users/ecodia', '.ecodiaos/coordination/usage/account-pin')
    if (fs.existsSync(pinPath)) {
      const pinned = fs.readFileSync(pinPath, 'utf8').trim()
      const pa = state.accounts[pinned]
      if (pa && pa.headroom_score === 0) pinned_account_starved = { account: pinned, pin_path: pinPath }
    }
  } catch (_) { /* alert computation must never throw */ }
  return {
    current_account_low: !!lowAccounts.find(x => x.account === current),
    all_low: lowAccounts.length === KNOWN_ACCOUNTS.length,
    accounts_low: lowAccounts,
    threshold: HEADROOM_WARNING_FRACTION,
    pinned_account_starved,
  }
}

// ── tool handlers (MCP-callable) ─────────────────────────────────────────

async function pick_account(params, ctx) {
  return pickAccount(params || {})
}

async function get_usage_state(params, ctx) {
  const state = readAccountsState()
  const alerts = computeAlerts()
  return { state: state, alerts: alerts }
}

async function poll_now(params, ctx) {
  return poll()
}

async function get_active_account(params, ctx) {
  return { account: getActiveAccount() }
}

async function set_active_account(params, ctx) {
  if (!params || !params.account) throw new Error('account required')
  return setActiveAccount(params.account, params.set_by || (ctx && ctx.tab_id) || 'tool-call')
}

async function mark_flaky(params, ctx) {
  if (!params || !params.account) throw new Error('account required')
  const r = markFlaky(params.account, params.reason || ((ctx && ctx.tab_id) ? 'reported-by:' + ctx.tab_id : 'unspecified'))
  return { ok: true, account: params.account, flaky_at: r.flaky_at, ttl_ms: FLAKY_TTL_MS }
}

async function clear_flaky(params, ctx) {
  if (!params || !params.account) throw new Error('account required')
  return clearFlaky(params.account)
}

async function list_flaky(params, ctx) {
  const all = readFlaky()
  const now = Date.now()
  const active = []
  const expired = []
  for (const acct of Object.keys(all)) {
    const ts = new Date(all[acct].flaky_at).getTime()
    const age_ms = now - ts
    const entry = { account: acct, flaky_at: all[acct].flaky_at, reason: all[acct].reason, age_ms: age_ms }
    if (age_ms < FLAKY_TTL_MS) active.push(entry); else expired.push(entry)
  }
  return { active: active, expired: expired, ttl_ms: FLAKY_TTL_MS }
}

module.exports = {
  // MCP-callable handlers
  pick_account: pick_account,
  get_usage_state: get_usage_state,
  poll_now: poll_now,
  get_active_account: get_active_account,
  set_active_account: set_active_account,
  mark_flaky: mark_flaky,
  clear_flaky: clear_flaky,
  list_flaky: list_flaky,
  // Internal helpers (NOT exposed as tools)
  _poll: poll,
  _getActiveAccount: getActiveAccount,
  _liveAccountFromClaudeConfig: liveAccountFromClaudeConfig,
  _setActiveAccount: setActiveAccount,
  _readAccountsState: readAccountsState,
  _computeAlerts: computeAlerts,
  _pickAccount: pickAccount,
  _markFlaky: markFlaky,
  _clearFlaky: clearFlaky,
  _readFlaky: readFlaky,
  _activeFlakySet: activeFlakySet,
  _KNOWN_ACCOUNTS: KNOWN_ACCOUNTS,
  _BUFFER_FACTOR: BUFFER_FACTOR,
  _FLAKY_TTL_MS: FLAKY_TTL_MS,
  _normalizeAccount: normalizeAccount,
  _shortForm: shortForm,
}
