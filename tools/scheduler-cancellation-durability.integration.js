// scheduler-cancellation-durability.integration.js
//
// Integration probe for the cancellation-durability guard (re-landed
// 2026-06-21 against current main after the original PR #4 went conflicting).
//
// Run with: node tools/scheduler-cancellation-durability.integration.js
// Requires DATABASE_URL pointing at the live Supabase Postgres (read from
// ../.env, or SCHEDULER_ENV_PATH override).
//
// What it proves (the discriminating probe per
// verify-deployed-state-against-narrated-state): the archived_at/last_status
// guard now appended to every status='active' re-arm UPDATE in scheduler.js
// EXCLUDES a cancelled or archived row, so a re-arm BY ID can no longer
// resurrect it, while a clean active row is still matched (positive control).
// It also confirms schedule_cancel now flips status to 'cancelled', so a
// cancelled row leaves the active/running/dispatching set the recovery
// branches act on.
//
// Tests on the real os_scheduled_tasks table using temp rows that are
// deleted unconditionally in a finally block.

'use strict'

const path = require('path')
require('dotenv').config({
  path: process.env.SCHEDULER_ENV_PATH || path.join(__dirname, '..', '.env'),
})

const { Pool } = require('pg')

// The exact guard fragment appended to every status='active' re-arm UPDATE
// (markFailed cron-defer + retryable, dispatchOne capped + no-IDE defer,
// markComplete cron re-arm, and the three staleLeaseRecovery branches). Keep
// this string byte-identical to the SQL in tools/scheduler.js so the probe
// tests the shipped predicate, not a paraphrase.
const REARM_GUARD =
  "archived_at IS NULL AND (last_status IS NULL OR last_status NOT IN ('paused', 'cancelled'))"

let passed = 0
let failed = 0
function assert(cond, label) {
  if (cond) {
    console.log('  PASS:', label)
    passed++
  } else {
    console.log('  FAIL:', label)
    failed++
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL env var is required (set it or SCHEDULER_ENV_PATH)')
  }
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 2,
    ...(process.env.DATABASE_URL.includes('localhost') ? {} : { ssl: { rejectUnauthorized: false } }),
  })

  const stamp = Date.now()
  const tag = 'INTEGRATION-cancel-durability-' + stamp
  let idArchived = null // A: cancelled + archived, status='active'
  let idCancelled = null // B: cancelled, archived_at NULL, status='active'
  let idClean = null // C: clean active (positive control)

  try {
    // Insert three temp rows. All status='active'.
    const ins = async (name, lastStatus, archived) => {
      const r = await pool.query(
        `INSERT INTO os_scheduled_tasks
           (type, name, prompt, cron_expression, next_run_at, status, last_status, archived_at, priority)
         VALUES ('cron', $1, 'integration probe row', '0 * * * *', NOW(), 'active', $2, $3, 9)
         RETURNING id`,
        [name, lastStatus, archived]
      )
      return r.rows[0].id
    }
    idArchived = await ins(tag + '-A-archived', 'cancelled', new Date().toISOString())
    idCancelled = await ins(tag + '-B-cancelled', 'cancelled', null)
    idClean = await ins(tag + '-C-clean', null, null)

    const ids = [idArchived, idCancelled, idClean]

    // 1. SELECT with the shipped guard predicate. Only the clean row C must match.
    const sel = await pool.query(
      `SELECT id FROM os_scheduled_tasks WHERE id = ANY($1::uuid[]) AND ${REARM_GUARD}`,
      [ids]
    )
    const matched = new Set(sel.rows.map((r) => r.id))
    assert(!matched.has(idArchived), 'guard SELECT EXCLUDES cancelled+archived row (A)')
    assert(!matched.has(idCancelled), 'guard SELECT EXCLUDES cancelled row, archived_at NULL (B)')
    assert(matched.has(idClean), 'guard SELECT INCLUDES clean active row (C, positive control)')

    // 2. Simulate the real re-arm UPDATE BY ID + guard (mirrors markComplete /
    //    markFailed / staleLeaseRecovery). A cancelled/archived row must report
    //    0 rows affected; the clean control must report 1.
    const rearm = async (id) => {
      const r = await pool.query(
        `UPDATE os_scheduled_tasks
         SET status = 'active', next_run_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND ${REARM_GUARD}`,
        [id]
      )
      return r.rowCount
    }
    assert((await rearm(idArchived)) === 0, 're-arm UPDATE affects 0 rows for cancelled+archived (A)')
    assert((await rearm(idCancelled)) === 0, 're-arm UPDATE affects 0 rows for cancelled (B)')
    assert((await rearm(idClean)) === 1, 're-arm UPDATE affects 1 row for clean active (C)')

    // 3. Confirm the cancelled rows were NOT mutated by the re-arm attempt:
    //    their status/last_status are untouched.
    const after = await pool.query(
      `SELECT id, status, last_status, archived_at FROM os_scheduled_tasks WHERE id = ANY($1::uuid[])`,
      [[idArchived, idCancelled]]
    )
    for (const row of after.rows) {
      assert(row.last_status === 'cancelled', 'cancelled row ' + row.id.slice(0, 8) + ' still last_status=cancelled after re-arm attempt')
    }

    // 4. schedule_cancel must flip status to 'cancelled' (not only archived_at +
    //    last_status), so the row leaves the active/running/dispatching set the
    //    recovery branches act on. Insert a fresh active row, run the real
    //    schedule_cancel handler, and re-read.
    const scheduler = require('./scheduler')
    scheduler._setPool(pool)
    const cancelTarget = await ins(tag + '-D-cancel-target', null, null)
    ids.push(cancelTarget)
    await scheduler.schedule_cancel({ id: cancelTarget })
    const cancelled = await pool.query(
      `SELECT status, last_status, archived_at FROM os_scheduled_tasks WHERE id = $1`,
      [cancelTarget]
    )
    const cr = cancelled.rows[0]
    assert(cr.status === 'cancelled', "schedule_cancel sets status='cancelled' (leaves the active set)")
    assert(cr.last_status === 'cancelled', "schedule_cancel keeps last_status='cancelled'")
    assert(cr.archived_at !== null, 'schedule_cancel keeps archived_at set')
    ids.push(cancelTarget)
  } finally {
    // Unconditional cleanup of temp rows.
    for (const id of [idArchived, idCancelled, idClean]) {
      if (id) {
        try {
          await pool.query('DELETE FROM os_scheduled_tasks WHERE id = $1', [id])
        } catch (e) {
          console.error('cleanup error for ' + id + ': ' + e.message)
        }
      }
    }
    // The schedule_cancel target row (tagged) - sweep any row carrying this tag.
    try {
      await pool.query('DELETE FROM os_scheduled_tasks WHERE name LIKE $1', [tag + '%'])
    } catch (e) {
      console.error('tag cleanup error: ' + e.message)
    }
    await pool.end()
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed')
  if (failed > 0) process.exit(1)
}

main().catch((e) => {
  console.error('INTEGRATION ERROR:', e.message)
  process.exit(1)
})
