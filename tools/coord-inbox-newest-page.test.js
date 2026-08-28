'use strict'

// Unit test for the 2026-08-28 inbox-paging fix.
//
// readInboxForTopic used to sort ascending and slice the HEAD, so a topic with an
// unseen backlog served its OLDEST messages on every call. Live on 2026-08-28 the
// conductor inbox held 5,836 unseen going back to 2026-07-20: every read_inbox and
// peek_inbox returned July worker reports, and a signal_done written minutes ago sat
// roughly 117 pages out of reach. The channel returned 200 the whole time, so the
// conductor read as healthy while being blind to every worker completion for 39 days.
//
// Proves: a small page over a large backlog contains the NEWEST messages, the freshest
// message is always present, output stays ascending, and `since` still filters.
//
// Run: COORD_DISABLE_SWEEP=1 node tools/coord-inbox-newest-page.test.js

process.env.COORD_DISABLE_SWEEP = '1'
const os = require('os')
const path = require('path')
const fs = require('fs')
const assert = require('assert')

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-inbox-page-test-'))
process.env.COORD_ROOT = tmpRoot
fs.mkdirSync(path.join(tmpRoot, 'messages'), { recursive: true })

const coord = require('./coord.js')

const TOPIC = 'chat.conductor.inbox'
const N = 500          // backlog depth
const PAGE = 15        // what a caller actually asks for

async function main () {
  // Seed N messages, oldest first, one per simulated minute.
  const base = Date.parse('2026-07-20T00:00:00.000Z')
  for (let i = 0; i < N; i++) {
    await coord.send_message({
      to: TOPIC,
      body: { type: 'done', task_id: 'task-' + i, seq: i },
    }, {})
  }

  // Backdate on disk so created_at spans 39 days, then reload the index.
  const dir = path.join(tmpRoot, 'messages')
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'))
  const rows = files.map(f => {
    const p = path.join(dir, f)
    return { p, m: JSON.parse(fs.readFileSync(p, 'utf8')) }
  }).filter(r => (r.m.to === TOPIC || r.m.to_topic === TOPIC))
  rows.sort((a, b) => (a.m.body.seq - b.m.body.seq))
  assert.strictEqual(rows.length, N, 'seeded ' + rows.length + ' of ' + N)
  rows.forEach((r, i) => {
    r.m.created_at = new Date(base + i * 60000).toISOString()
    fs.writeFileSync(r.p, JSON.stringify(r.m))
  })

  // Fresh process-level load so the in-memory index picks up the backdated rows.
  delete require.cache[require.resolve('./coord.js')]
  const coord2 = require('./coord.js')

  const res = await coord2.peek_inbox({ topic: TOPIC, limit: PAGE }, {})
  const seqs = res.messages.map(m => m.body.seq)

  assert.strictEqual(res.messages.length, PAGE, 'page size: got ' + res.messages.length)

  // 1. The page is the NEWEST slice, not the oldest.
  const expected = []
  for (let i = N - PAGE; i < N; i++) expected.push(i)
  assert.deepStrictEqual(seqs, expected,
    'expected newest ' + PAGE + ' (' + expected[0] + '..' + expected[expected.length - 1] +
    '), got ' + seqs[0] + '..' + seqs[seqs.length - 1])

  // 2. The freshest message is reachable in one call. This is the regression that mattered.
  assert.ok(seqs.includes(N - 1), 'newest message must be on the first page')
  assert.ok(!seqs.includes(0), 'oldest message must NOT be on the first page')

  // 3. Output stays ascending for callers that read in order.
  const asc = seqs.slice().sort((a, b) => a - b)
  assert.deepStrictEqual(seqs, asc, 'page must be ascending by created_at')

  // 4. `since` still filters, and still returns the newest page within the window.
  const cutoff = new Date(base + (N - 100) * 60000).toISOString()
  const res2 = await coord2.peek_inbox({ topic: TOPIC, limit: PAGE, since: cutoff }, {})
  const seqs2 = res2.messages.map(m => m.body.seq)
  assert.ok(seqs2.every(s => s > N - 100), 'since must exclude older than cutoff, got ' + seqs2[0])
  assert.ok(seqs2.includes(N - 1), 'since page must still reach the newest message')

  console.log('PASS coord-inbox-newest-page: page=' + seqs[0] + '..' + seqs[seqs.length - 1] +
              ' of ' + N + ' backlog; newest reachable; ascending; since honoured')
}

main().then(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
  process.exit(0)
}).catch(e => {
  console.error('FAIL', e && e.message)
  fs.rmSync(tmpRoot, { recursive: true, force: true })
  process.exit(1)
})
