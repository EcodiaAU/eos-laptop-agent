// Unit test for sweepStaleWorkers worker-.json GC (2026-06-29 disk-leak fix).
// Verifies: terminated+closed_tab_ok -> purged immediately; terminated older
// than retention -> purged; terminated but recent + not-closed -> kept; active
// (no terminated_at) -> kept. Run: node tools/coord-worker-gc.test.js
const fs = require('fs')
const os = require('os')
const path = require('path')

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-gc-'))
process.env.COORD_ROOT = tmpRoot
process.env.COORD_DISABLE_SWEEP = '1'  // do not let the timer race the assertions

const coord = require('./coord.js')
const WORKERS_DIR = path.join(tmpRoot, 'workers')
fs.mkdirSync(WORKERS_DIR, { recursive: true })

const nowMs = Date.now()
const iso = (ms) => new Date(ms).toISOString()
const write = (tab, obj) => fs.writeFileSync(path.join(WORKERS_DIR, tab + '.json'), JSON.stringify(obj, null, 2))

// Cases
write('tab_closed_recent', { tab_id: 'tab_closed_recent', terminated_at: iso(nowMs - 60_000), closed_tab_ok: true })       // purge (closed)
write('tab_old_unclosed', { tab_id: 'tab_old_unclosed', terminated_at: iso(nowMs - 26 * 3600_000) })                       // purge (age backstop > 24h)
write('tab_recent_unclosed', { tab_id: 'tab_recent_unclosed', terminated_at: iso(nowMs - 60_000) })                        // keep (recent, not closed)
write('tab_active', { tab_id: 'tab_active', terminated_at: null, last_heartbeat_at: iso(nowMs) })                          // keep (active)

// Rebuild the in-memory Map from the files we just wrote (module loaded before
// they existed). registerWorkerInternal is not exported, so re-require fresh.
delete require.cache[require.resolve('./coord.js')]
const coord2 = require('./coord.js')
const res = coord2._sweepStaleWorkers()

let fails = 0
const assert = (cond, msg) => { if (cond) { console.log('  PASS: ' + msg) } else { console.log('  FAIL: ' + msg); fails++ } }

const exists = (tab) => fs.existsSync(path.join(WORKERS_DIR, tab + '.json'))
console.log('sweep result:', JSON.stringify(res))
assert(!exists('tab_closed_recent'), 'closed_tab_ok terminated row is purged from disk')
assert(!exists('tab_old_unclosed'), 'terminated row older than 24h retention is purged')
assert(exists('tab_recent_unclosed'), 'recent terminated-but-unclosed row is KEPT (retention window)')
assert(exists('tab_active'), 'active (null terminated_at) row is KEPT')
assert(res.purged === 2, 'purged count is exactly 2 (got ' + res.purged + ')')

try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch (e) {}
if (fails === 0) { console.log('ALL TESTS PASSED') } else { console.log(fails + ' TEST(S) FAILED'); process.exit(1) }
