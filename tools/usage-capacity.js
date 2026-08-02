'use strict'
// tools/usage-capacity.js - answers ONE question: is there room to run a heavy job now,
// and if not, when.
//
// Everything else built on the 2026-08-02 measurement answers "should the fleet SWITCH".
// This answers "should this work START", which is a different question and the one a human
// or a scheduler actually asks before kicking off something expensive. Until now the only
// way to ask it was to eyeball `node tools/usage-real.js` and do the arithmetic yourself.
//
// It deliberately does NOT decide anything about austerity. Driving the austerity level
// from capacity signals is a standing veto (tried 2026-07-20, reversed within minutes):
// token capacity means capacity for Tate's development, not licence for the cron fleet to
// spend it. This tool reports; it never throttles.
//
// Usage:
//   node tools/usage-capacity.js                 # can the LIVE account take a normal job
//   node tools/usage-capacity.js --points 8      # need ~8 percentage points of 5h headroom
//   node tools/usage-capacity.js --json          # machine-readable
//   node tools/usage-capacity.js --selftest
//
// Sizing note: utilization is integer percent and one point is roughly 415k limit-relevant
// tokens at the confirmed 41.5M 5h cap. So --points 5 means "about 2M tokens of room".

const cfg = require('./usage-config')

// Headroom kept in reserve so a job does not finish by capping the account it ran on.
const RESERVE_POINTS = Number(process.env.CAPACITY_RESERVE_POINTS) || 10
const DEFAULT_POINTS = 5

function assess(state, opts) {
  opts = opts || {}
  const needPoints = typeof opts.points === 'number' ? opts.points : DEFAULT_POINTS
  const nowMs = opts.nowMs || Date.now()
  const liveEmail = (state && state.active_account) || null
  const accounts = (state && state.accounts) || {}

  const rows = []
  for (const [email, row] of Object.entries(accounts)) {
    const u5 = row.utilization_5h_effective
    const u7 = row.utilization_7d_effective
    const measured = typeof u5 === 'number' && typeof u7 === 'number'
    // Points of room on the tighter of the two windows, minus the reserve.
    const room = measured ? Math.floor(Math.min(1 - u5, 1 - u7) * 100) - RESERVE_POINTS : null
    rows.push({
      account: email,
      live: email === liveEmail,
      measured,
      stale: !!row.excluded_as_target,
      age_s: row.effective_age_s == null ? null : row.effective_age_s,
      utilization_5h: measured ? Math.round(u5 * 100) : null,
      utilization_7d: measured ? Math.round(u7 * 100) : null,
      room_points: room,
      fits: measured && room >= needPoints,
      resets_at_5h: (row.real && row.real.resets_at_5h) || null,
      resets_at_7d: (row.real && row.real.resets_at_7d) || null,
    })
  }

  const live = rows.find(r => r.live) || null
  const fitting = rows.filter(r => r.fits && !r.stale).sort((a, b) => b.room_points - a.room_points)

  // Prefer staying put. Switching costs a real OAuth re-login and disturbs in-flight work,
  // so it is only worth recommending when the live account genuinely cannot take the job.
  if (live && live.fits) {
    return {
      verdict: 'go', run_on: live.account, need_points: needPoints,
      reason: 'the live account has ' + live.room_points + ' points of room after a ' + RESERVE_POINTS + '-point reserve',
      accounts: rows,
    }
  }
  if (fitting.length) {
    return {
      verdict: 'switch_first', run_on: fitting[0].account, need_points: needPoints,
      reason: (live ? 'the live account has ' + (live.measured ? live.room_points + ' points' : 'no usable reading') : 'no live account identified') +
              '; ' + fitting[0].account + ' has ' + fitting[0].room_points,
      command: 'bash eos-laptop-agent/scripts/account-switch.sh ' + fitting[0].account.split('@')[0],
      accounts: rows,
    }
  }

  // Nobody fits: say WHEN, because "no" without a time is not an answer anyone can act on.
  const resets = []
  for (const r of rows) {
    for (const iso of [r.resets_at_5h, r.resets_at_7d]) {
      const t = iso ? Date.parse(iso) : NaN
      if (isFinite(t) && t > nowMs) resets.push({ account: r.account, at: t, iso })
    }
  }
  resets.sort((a, b) => a.at - b.at)
  const soonest = resets[0] || null
  const anyMeasured = rows.some(r => r.measured)
  return {
    verdict: anyMeasured ? 'wait' : 'unknown',
    run_on: null,
    need_points: needPoints,
    reason: anyMeasured
      ? 'no account has ' + needPoints + ' points of room after the ' + RESERVE_POINTS + '-point reserve'
      : 'no account has a usable reading; the probe may be down (check the poller heartbeat)',
    wait_until: soonest ? soonest.iso : null,
    wait_account: soonest ? soonest.account : null,
    accounts: rows,
  }
}

function aest(iso) {
  if (!iso) return 'unknown'
  const t = new Date(iso)
  return t.toLocaleString('en-AU', { timeZone: 'Australia/Brisbane', weekday: 'short', hour: 'numeric', minute: '2-digit' })
}

function render(a) {
  const lines = []
  for (const r of a.accounts) {
    lines.push('  ' + (r.live ? '* ' : '  ') + r.account.split('@')[0].padEnd(6) +
      (r.measured ? ('5h ' + String(r.utilization_5h).padStart(3) + '%  7d ' + String(r.utilization_7d).padStart(3) + '%  room ' + String(r.room_points).padStart(3) + 'pt')
                  : 'no usable reading') +
      (r.stale ? '  [stale]' : ''))
  }
  const head = {
    go: 'GO. Run it on ' + (a.run_on || '').split('@')[0] + '.',
    switch_first: 'SWITCH FIRST, then run on ' + (a.run_on || '').split('@')[0] + '.',
    wait: 'WAIT. ' + (a.wait_until ? ('Soonest room is ' + (a.wait_account || '').split('@')[0] + ' at ' + aest(a.wait_until) + '.') : 'No reset time known.'),
    unknown: 'UNKNOWN. The measurement is not answering.',
  }[a.verdict]
  return [head, '  ' + a.reason, ''].concat(lines).concat(a.command ? ['', '  ' + a.command] : []).join('\n')
}

function selftest() {
  let failed = 0
  const ok = (c, n) => { console.log((c ? '  PASS: ' : '  FAIL: ') + n); if (!c) failed++ }
  const A = (u5, u7, extra) => Object.assign({ utilization_5h_effective: u5, utilization_7d_effective: u7 }, extra || {})
  const now = Date.parse('2026-08-02T08:00:00Z')

  let r = assess({ active_account: 'tate@ecodia.au', accounts: {
    'tate@ecodia.au': A(0.50, 0.55), 'code@ecodia.au': A(0.00, 0.20),
  } }, { nowMs: now })
  ok(r.verdict === 'go' && r.run_on === 'tate@ecodia.au', 'a comfortable live account means GO, without recommending a switch')

  r = assess({ active_account: 'tate@ecodia.au', accounts: {
    'tate@ecodia.au': A(0.95, 0.55), 'code@ecodia.au': A(0.00, 0.20),
  } }, { nowMs: now })
  ok(r.verdict === 'switch_first' && r.run_on === 'code@ecodia.au', 'a full live account with a healthy alternate means SWITCH FIRST')
  ok(/account-switch\.sh code/.test(r.command || ''), 'and it hands back the exact command')

  // The live 2026-08-02 shape: both alternates capped, live account fine.
  r = assess({ active_account: 'tate@ecodia.au', accounts: {
    'tate@ecodia.au': A(0.53, 0.56), 'code@ecodia.au': A(1.0, 0.20), 'money@ecodia.au': A(0.0, 1.0),
  } }, { nowMs: now })
  ok(r.verdict === 'go', 'capped alternates do not block a job the live account can take')

  r = assess({ active_account: 'tate@ecodia.au', accounts: {
    'tate@ecodia.au': A(0.95, 0.55, { real: { resets_at_5h: '2026-08-02T11:40:00Z' } }),
    'money@ecodia.au': A(0.0, 1.0, { real: { resets_at_7d: '2026-08-03T11:00:00Z' } }),
  } }, { nowMs: now })
  ok(r.verdict === 'wait', 'nobody with room means WAIT')
  ok(r.wait_until === '2026-08-02T11:40:00Z', 'and it names the SOONEST reset, not just any reset')

  r = assess({ active_account: 'tate@ecodia.au', accounts: { 'tate@ecodia.au': {} } }, { nowMs: now })
  ok(r.verdict === 'unknown', 'no usable reading is UNKNOWN, never a confident go')

  r = assess({ active_account: 'tate@ecodia.au', accounts: {
    'tate@ecodia.au': A(0.95, 0.55), 'code@ecodia.au': A(0.0, 0.2, { excluded_as_target: true }),
  } }, { nowMs: now })
  ok(r.verdict === 'wait', 'an account we cannot currently measure is not offered as somewhere to run')

  // The reserve is the point: 88% used leaves 12 raw points, which is under the 10-point
  // reserve plus a 5-point job, so it must not read as room.
  r = assess({ active_account: 'tate@ecodia.au', accounts: { 'tate@ecodia.au': A(0.88, 0.10) } }, { nowMs: now })
  ok(r.verdict !== 'go', 'the reserve stops a job that would finish by capping the account it ran on')

  console.log(failed ? '\nSELFTEST FAILED (' + failed + ')' : '\nSELFTEST PASSED')
  process.exitCode = failed ? 1 : 0
}

module.exports = { assess, _render: render, RESERVE_POINTS }

if (require.main === module) {
  if (process.argv.includes('--selftest')) { selftest() }
  else {
    const i = process.argv.indexOf('--points')
    const points = i > -1 ? Number(process.argv[i + 1]) : undefined
    const state = require('./usage')._readAccountsState() || {}
    const a = assess(state, { points })
    console.log(process.argv.includes('--json') ? JSON.stringify(a, null, 1) : render(a))
    process.exitCode = a.verdict === 'go' ? 0 : a.verdict === 'switch_first' ? 3 : 1
  }
}
