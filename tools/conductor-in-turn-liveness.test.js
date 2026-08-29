'use strict'

// Regression test for the in_turn TTL that called a LONG turn a CRASHED one and
// so injected conductor wakes into a busy tab, where Claude Code queued them and
// nothing ever ran (status_board c9839c67, lane W1, 2026-08-29).
//
// THE DEFECT. IN_TURN_TTL_MS was a fixed 10 minutes and loadConductorRegistration
// silently flipped in_turn to false once in_turn_set_at aged past it. The escape
// exists so a CRASHED turn cannot wedge the wake shut forever, but a wall-clock
// guess cannot tell a crashed turn from a long one. Measured 2026-08-29: a
// conductor set in_turn at 10:06:06.763Z and was still writing assistant records
// at 10:24, one arc of 18-plus minutes. The TTL expired at 10:16:06 and coord
// injected two wakes into that busy tab. Both reported inject_reported_ok:true
// and both were QUEUED (attachment type queued_command at 10:20:47.250Z and
// 10:21:51.005Z); a queued command starts no turn, so both wakes were lost and
// last_seen_at never moved off 10:08:45.054Z.
//
// THE FIX UNDER TEST. The TTL is now only the OUTER gate. What actually clears
// in_turn is transcript mtime, the same unforgeable signal worker-liveness.js
// reaps a silent lane holder on: the harness appends on every turn with no
// cooperation from the model, so it cannot be withheld while a turn runs nor
// emitted after it stops. A turn of ANY length that is still writing keeps
// in_turn set, which is what closes the defect for good rather than moving it to
// a different turn length.
//
// Every assertion below is PAIRED with a control that differs only in the
// variable under test, because a check that cannot fail is not a check. The two
// that matter most: the silent-transcript arm (proves the crash escape still
// fires, so the fix is not merely "never clear") and the no-transcript arm
// (proves an unidentifiable conductor behaves byte-identically to before).
// Doctrine: patterns/running-is-not-liveness-transcript-mtime-is-2026-08-27.md
//
// Run: node tools/conductor-in-turn-liveness.test.js

const fs = require('fs')
const os = require('os')
const path = require('path')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'w1-in-turn-'))
const COORD_ROOT = path.join(TMP, 'coord')
const PROJECTS = path.join(TMP, 'projects')
const WORKSPACE = '/Users/ecodia/.code/ecodiaos/backend'
const PROJECT_DIR = path.join(PROJECTS, '-Users-ecodia--code-ecodiaos-backend')

process.env.COORD_ROOT = COORD_ROOT
process.env.EOS_TRANSCRIPTS_DIR = PROJECTS
fs.mkdirSync(path.join(COORD_ROOT, 'conductors'), { recursive: true })
fs.mkdirSync(PROJECT_DIR, { recursive: true })

const coord = require('./coord.js')

const MIN = 60 * 1000
let fails = 0
function ok(label, cond, detail) {
  if (cond) { console.log('  PASS  ' + label) }
  else { fails++; console.log('  FAIL  ' + label + (detail ? '  :: ' + detail : '')) }
}

// The dispatched-worker boot envelope exactly as it appears in the raw jsonl,
// where the attribute quotes arrive JSON-escaped.
const WORKER_LINE = JSON.stringify({ type: 'user', message: { role: 'user',
  content: 'x <dispatched role="worker" tab_id="tab_17880046372_9c133159"/> y' } }) + '\n'
const CONDUCTOR_LINE = JSON.stringify({ type: 'user', message: { role: 'user',
  content: 'ordinary interactive turn, no dispatch envelope' } }) + '\n'

function writeTranscript(name, line, ageMs) {
  const p = path.join(PROJECT_DIR, name)
  fs.writeFileSync(p, line)
  const t = new Date(Date.now() - (ageMs || 0))
  fs.utimesSync(p, t, t)
  return p
}
function clearTranscripts() {
  for (const f of fs.readdirSync(PROJECT_DIR)) fs.unlinkSync(path.join(PROJECT_DIR, f))
}
function writeConductor(row) {
  const full = Object.assign({
    tab_id: 'conductor', ide: 'stable', title_match: 'Studio',
    workspace_root: WORKSPACE, registered_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString()
  }, row)
  fs.writeFileSync(path.join(COORD_ROOT, 'conductors', 'current.json'),
    JSON.stringify(full, null, 2))
  return full
}
const agoIso = (ms) => new Date(Date.now() - ms).toISOString()

console.log('\n== the defect: a LONG turn past the TTL must NOT be cleared ==')

clearTranscripts()
let tp = writeTranscript('conductor.jsonl', CONDUCTOR_LINE, 5 * 1000)
writeConductor({ in_turn: true, in_turn_set_at: agoIso(18 * MIN), transcript_path: tp })
let r = coord._loadConductorRegistration()
ok('18min turn, transcript written 5s ago -> in_turn STAYS true (this is the bug, fixed)',
  r.in_turn === true, JSON.stringify({ in_turn: r.in_turn }))

clearTranscripts()
tp = writeTranscript('conductor.jsonl', CONDUCTOR_LINE, 10 * MIN)
writeConductor({ in_turn: true, in_turn_set_at: agoIso(18 * MIN), transcript_path: tp })
r = coord._loadConductorRegistration()
ok('CONTROL same 18min turn but transcript SILENT 10min -> cleared, so the crash escape still fires',
  r.in_turn === false && r.in_turn_set_at === null, JSON.stringify({ in_turn: r.in_turn }))

console.log('\n== the outer gate is still the TTL ==')

clearTranscripts()
tp = writeTranscript('conductor.jsonl', CONDUCTOR_LINE, 10 * MIN)
writeConductor({ in_turn: true, in_turn_set_at: agoIso(1 * MIN), transcript_path: tp })
r = coord._loadConductorRegistration()
ok('1min turn + silent transcript -> untouched, silence alone never clears inside the TTL',
  r.in_turn === true, JSON.stringify({ in_turn: r.in_turn }))

console.log('\n== fails toward the status quo when the conductor cannot be identified ==')

clearTranscripts()
writeConductor({ in_turn: true, in_turn_set_at: agoIso(18 * MIN) })  // no transcript_path
r = coord._loadConductorRegistration()
ok('no transcript_path -> cleared exactly as before this change',
  r.in_turn === false && r.in_turn_set_at === null, JSON.stringify({ in_turn: r.in_turn }))

clearTranscripts()
writeConductor({ in_turn: true, in_turn_set_at: agoIso(18 * MIN),
  transcript_path: path.join(PROJECT_DIR, 'does-not-exist.jsonl') })
r = coord._loadConductorRegistration()
ok('CONTROL transcript_path points at a missing file (stat throws) -> cleared, not crashed',
  r.in_turn === false, JSON.stringify({ in_turn: r.in_turn }))

console.log('\n== resolveConductorTranscript picks the conductor out of a shared project dir ==')

ok('workspace_root maps to the Claude Code project dir name',
  coord._conductorProjectDir(WORKSPACE) === PROJECT_DIR,
  coord._conductorProjectDir(WORKSPACE))

clearTranscripts()
writeTranscript('the-conductor.jsonl', CONDUCTOR_LINE, 1000)
writeTranscript('worker-a.jsonl', WORKER_LINE, 1000)
writeTranscript('worker-b.jsonl', WORKER_LINE, 500)
let got = coord._resolveConductorTranscript({ workspace_root: WORKSPACE })
ok('two dispatched workers writing in the same window are excluded by their boot envelope',
  got === path.join(PROJECT_DIR, 'the-conductor.jsonl'), String(got))

clearTranscripts()
writeTranscript('the-conductor.jsonl', CONDUCTOR_LINE, 1000)
writeTranscript('other-interactive-tab.jsonl', CONDUCTOR_LINE, 1000)
got = coord._resolveConductorTranscript({ workspace_root: WORKSPACE })
ok('CONTROL two interactive tabs in the window -> null, ambiguity is refused not guessed',
  got === null, String(got))

clearTranscripts()
writeTranscript('worker-a.jsonl', WORKER_LINE, 1000)
got = coord._resolveConductorTranscript({ workspace_root: WORKSPACE })
ok('CONTROL only a worker is writing -> null, a worker is never mistaken for the conductor',
  got === null, String(got))

clearTranscripts()
writeTranscript('the-conductor.jsonl', CONDUCTOR_LINE, 60 * 1000)
got = coord._resolveConductorTranscript({ workspace_root: WORKSPACE })
ok('CONTROL conductor wrote 60s ago, outside the 5s turn-start window -> null',
  got === null, String(got))

ok('CONTROL unknown workspace_root -> null, never throws',
  coord._resolveConductorTranscript({ workspace_root: '/no/such/place' }) === null)
ok('CONTROL missing workspace_root -> null, never throws',
  coord._resolveConductorTranscript({}) === null)

console.log('\n== conductorNewestTurnMs reads mtime, and only mtime ==')
clearTranscripts()
tp = writeTranscript('conductor.jsonl', CONDUCTOR_LINE, 42 * 1000)
const ms = coord._conductorNewestTurnMs({ transcript_path: tp })
ok('returns the transcript mtime within a second of the value set',
  ms != null && Math.abs((Date.now() - ms) - 42000) < 1500, String(Date.now() - ms))
ok('CONTROL no path -> null (not 0, which would read as the epoch and mean "silent forever")',
  coord._conductorNewestTurnMs({}) === null)

try { fs.rmSync(TMP, { recursive: true, force: true }) } catch (e) {}
console.log('\n' + (fails === 0 ? 'ALL PASS' : fails + ' FAILURE(S)'))
process.exit(fails === 0 ? 0 : 1)
