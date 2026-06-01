// scheduler-a2-integration.js - integration matrix for A2 CRUD tools.
//
// Run with: node tools/scheduler-a2-integration.js
// Requires DATABASE_URL pointing at the live Supabase Postgres.
//
// Tests on real os_scheduled_tasks table using a temp test row that is
// cleaned up unconditionally in a finally block.

'use strict'

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })

const scheduler = require('../tools/scheduler')
const { Pool } = require('pg')

let passed = 0
let failed = 0
function assert(cond, label) {
  if (cond) {
    console.log('  PASS:', label)
    passed++
  } else {
    console.error('  FAIL:', label)
    failed++
  }
}

async function leaseSees(pool, taskId) {
  // Mimic leaseDueRows WHERE clause without the UPDATE, returns true if the
  // row would be picked up on this poll.
  const r = await pool.query(
    `SELECT id FROM os_scheduled_tasks
     WHERE id = $1
       AND status = 'active'
       AND archived_at IS NULL
       AND (last_status IS NULL OR last_status NOT IN ('paused', 'cancelled'))
       AND (next_run_at IS NULL OR next_run_at <= NOW())
       AND (chain_after IS NULL OR next_run_at IS NOT NULL)`,
    [taskId]
  )
  return r.rowCount > 0
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL required'); process.exit(2)
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })

  const testName = 'a2-integration-' + Date.now()
  let testId = null
  let chainId = null

  try {
    console.log('1. INSERT via schedule_delayed (delay 1h - far enough that NOW() doesn\'t leak)')
    const insertRes = await scheduler.schedule_delayed({
      name: testName,
      prompt: 'A2 integration test row - safe to ignore',
      delay: 'in 1h',
      preferred_account: 'tate',
      priority_class: 'low',
    })
    assert(insertRes.ok === true, 'schedule_delayed returns ok=true')
    assert(typeof insertRes.id === 'string', 'schedule_delayed returns string id')
    assert(typeof insertRes.next_fire_at_utc === 'string', 'next_fire_at_utc present')
    assert(typeof insertRes.next_fire_at_aest === 'string', 'next_fire_at_aest present')
    testId = insertRes.id

    console.log('\n2. leaseDueRows: row not due yet (1h out)')
    assert((await leaseSees(pool, testId)) === false, 'lease does not see future-dated row')

    console.log('\n3. schedule_run_now: bring forward')
    const runNowRes = await scheduler.schedule_run_now({ id: testId })
    assert(runNowRes.ok === true, 'schedule_run_now returns ok=true')
    assert(typeof runNowRes.next_fire_at_utc === 'string', 'run_now returns next_fire_at_utc')
    assert((await leaseSees(pool, testId)) === true, 'lease NOW sees the row after run_now')

    console.log('\n4. schedule_pause: lease must stop seeing it')
    const pauseRes = await scheduler.schedule_pause({ id: testId })
    assert(pauseRes.ok === true, 'schedule_pause returns ok=true')
    assert(typeof pauseRes.paused_at_utc === 'string', 'pause returns paused_at_utc')
    assert((await leaseSees(pool, testId)) === false, 'lease does NOT see paused row')

    console.log('\n5. schedule_run_now on paused row: should be rejected')
    const runNowPausedRes = await scheduler.schedule_run_now({ id: testId })
    assert(runNowPausedRes.ok === false, 'run_now on paused row rejected')
    assert(/paused/.test(runNowPausedRes.error || ''), 'rejection mentions paused')

    console.log('\n6. schedule_resume: should clear paused state')
    const resumeRes = await scheduler.schedule_resume({ id: testId })
    assert(resumeRes.ok === true, 'schedule_resume returns ok=true')
    assert(typeof resumeRes.next_fire_at_utc === 'string', 'resume returns next_fire_at_utc')
    assert((await leaseSees(pool, testId)) === true, 'lease sees row again after resume')

    console.log('\n7. Resume from non-paused row: should reject')
    const resumeAgainRes = await scheduler.schedule_resume({ id: testId })
    assert(resumeAgainRes.ok === false, 'second resume rejected (not paused)')

    console.log('\n8. schedule_cancel: archived_at set, last_status=cancelled')
    const cancelRes = await scheduler.schedule_cancel({ id: testId })
    assert(cancelRes.ok === true, 'schedule_cancel returns ok=true')
    assert(typeof cancelRes.cancelled_at_utc === 'string', 'cancel returns cancelled_at_utc')
    assert(typeof cancelRes.cancelled_at_aest === 'string', 'cancel returns cancelled_at_aest')
    assert((await leaseSees(pool, testId)) === false, 'lease does NOT see cancelled row')

    console.log('\n9. schedule_pause on cancelled row: should be rejected')
    const pauseCancelledRes = await scheduler.schedule_pause({ id: testId })
    assert(pauseCancelledRes.ok === false, 'pause on cancelled rejected')

    console.log('\n10. resolve by name (not id)')
    const cancelByName = await scheduler.schedule_cancel({ name: testName })
    // Already cancelled - idempotent (sets archived_at again to NOW()).
    assert(cancelByName.ok === true, 'cancel by name on already-cancelled row is idempotent ok=true')
    assert(cancelByName.id === testId, 'cancel by name resolves to same id')

    console.log('\n11. schedule_chain: create chain child after a parent task')
    // Create a parent row directly (active, far-future so it does not actually fire during the test)
    const parentInsert = await scheduler.schedule_delayed({
      name: testName + '-parent',
      prompt: 'chain parent',
      delay: 'in 24h',
      priority_class: 'low',
    })
    const parentId = parentInsert.id
    const chainName = testName + '-child'
    const chainRes = await scheduler.schedule_chain({
      after_task_id: parentId,
      name: chainName,
      prompt: 'A2 chain integration child',
      priority_class: 'low',
    })
    assert(chainRes.ok === true, 'schedule_chain returns ok=true')
    chainId = chainRes.id
    assert(chainRes.chain_after === parentId, 'chain row references parent via chain_after')
    assert((await leaseSees(pool, chainId)) === false, 'chain row not leased before parent completes (next_run_at is NULL)')

    console.log('\n12. Simulate parent completion: markComplete should wake the chain child')
    const parentRowRes = await pool.query(`SELECT * FROM os_scheduled_tasks WHERE id = $1`, [parentId])
    await scheduler.markComplete(parentRowRes.rows[0], { status: 'success', result_summary: 'chain parent done' })
    assert((await leaseSees(pool, chainId)) === true, 'chain child IS leasable after parent markComplete')

    console.log('\n13. schedule_chain to unknown parent: returns ok:false')
    const badChainRes = await scheduler.schedule_chain({
      after_task_id: '00000000-0000-0000-0000-000000000000',
      name: testName + '-bad-chain',
      prompt: 'bad',
    })
    assert(badChainRes.ok === false, 'chain to missing parent rejected')

    console.log('\n14. schedule_cancel of nonexistent id: ok:false')
    const missingRes = await scheduler.schedule_cancel({ id: '00000000-0000-0000-0000-000000000000' })
    assert(missingRes.ok === false, 'cancel of missing id returns ok:false')

    // Cleanup
    console.log('\nCleanup: deleting test rows')
    await pool.query(`DELETE FROM os_scheduled_tasks WHERE id = ANY($1)`, [[testId, parentId, chainId]])

    console.log(`\nResults: ${passed} passed, ${failed} failed`)
    process.exit(failed === 0 ? 0 : 1)
  } catch (e) {
    console.error('\nFATAL:', e.message)
    console.error(e.stack)
    // Try cleanup
    try {
      if (testId || chainId) {
        await pool.query(`DELETE FROM os_scheduled_tasks WHERE name LIKE $1`, [testName + '%'])
      }
    } catch (cleanupErr) {
      console.error('cleanup error:', cleanupErr.message)
    }
    process.exit(2)
  } finally {
    await pool.end().catch(() => {})
  }
}

main()
