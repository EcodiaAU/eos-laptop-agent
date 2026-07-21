// Unit test for the 2026-07-21 conductor-exemption in sweepStaleWorkers.
// A row bearing the registered conductor's tab_id, with a stale heartbeat, must
// NOT be marked terminated / unlinked by the stale-worker sweep - a registered
// conductor is never a stale worker. A genuine stale worker row alongside it IS
// marked, proving the guard is targeted, not a blanket skip.
// Run: node tools/coord-conductor-exempt.test.js
const fs = require('fs')
const os = require('os')
const path = require('path')

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-cond-'))
process.env.COORD_ROOT = tmpRoot
process.env.COORD_DISABLE_SWEEP = '1'

const WORKERS_DIR = path.join(tmpRoot, 'workers')
const CONDUCTORS_DIR = path.join(tmpRoot, 'conductors')
fs.mkdirSync(WORKERS_DIR, { recursive: true })
fs.mkdirSync(CONDUCTORS_DIR, { recursive: true })

const nowMs = Date.now()
const iso = (ms) => new Date(ms).toISOString()
const staleIso = iso(nowMs - 2 * 60 * 60 * 1000)  // 2h stale, past the 60min threshold
const write = (tab, obj) => fs.writeFileSync(path.join(WORKERS_DIR, tab + '.json'), JSON.stringify(obj, null, 2))

// Register a conductor with tab_id "conductor".
fs.writeFileSync(path.join(CONDUCTORS_DIR, 'current.json'), JSON.stringify({
  tab_id: 'conductor', ide: 'stable', title_match: '', registered_at: iso(nowMs), last_seen_at: iso(nowMs),
}, null, 2))

// A worker row carrying the conductor's tab_id, stale heartbeat -> MUST be skipped.
write('conductor', { tab_id: 'conductor', terminated_at: null, last_heartbeat_at: staleIso })
// A genuine stale worker -> MUST be marked terminated.
write('tab_real_worker', { tab_id: 'tab_real_worker', terminated_at: null, last_heartbeat_at: staleIso })

const coord = require('./coord.js')
const res = coord._sweepStaleWorkers()

let fails = 0
const assert = (cond, msg) => { if (cond) { console.log('  PASS: ' + msg) } else { console.log('  FAIL: ' + msg); fails++ } }

const read = (tab) => JSON.parse(fs.readFileSync(path.join(WORKERS_DIR, tab + '.json'), 'utf8'))
console.log('sweep result:', JSON.stringify(res))
assert(read('conductor').terminated_at == null, 'conductor-tab_id worker row is NOT marked terminated (exempted)')
assert(read('tab_real_worker').terminated_at != null, 'genuine stale worker IS marked terminated (guard is targeted)')
assert(res.marked === 1, 'exactly 1 marked - only the real worker, not the conductor (got ' + res.marked + ')')

try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch (e) {}
if (fails === 0) { console.log('ALL TESTS PASSED') } else { console.log(fails + ' TEST(S) FAILED'); process.exit(1) }
