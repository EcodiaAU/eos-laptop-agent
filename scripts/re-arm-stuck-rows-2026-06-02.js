// One-shot: re-arm rows the 2026-06-02 submit-key bug left stuck.
//
// Inventory at run time (verified before re-arm):
//   status='failed'   x20  cron rows from 2026-05-27 retry storm
//   status='orphaned' x20  cron + delayed, scheduler-26500 family from 2026-05-29/30
//   status='running'  x2   today's dispatches whose workers never heartbeat
//
// Policy:
//   - cron rows: compute the NEXT natural fire from NOW (cron-parser + tz), set
//     status='active', retry_count=0, leased_*=NULL. Drains over the cron's
//     own cadence, no stampede.
//   - one-shot 'delayed' rows whose run_at is in the past: archive (window missed,
//     business should not retry hours/days later autonomously).
//   - one-shot 'delayed' rows whose run_at is still future: just clear lease/status.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
const { Pool } = require('pg')
const cronParser = require('cron-parser')

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

// Mirrors scheduler.js parseSchedule(): DB stores friendly aliases for many
// cron rows (e.g. "every 4h", "daily 20:00") - cron-parser only accepts raw
// cron expressions. Translate before parsing.
function translateSchedule(s) {
  if (!s || typeof s !== 'string') return s
  const v = s.trim()
  const every = v.match(/^every\s+(\d+)\s*([mh])\s*$/i)
  if (every) {
    const n = parseInt(every[1], 10)
    const unit = every[2].toLowerCase()
    if (unit === 'h') return `0 */${n} * * *`
    return `*/${n} * * * *`
  }
  const daily = v.match(/^daily\s+(\d{1,2}):(\d{2})\s*$/i)
  if (daily) return `${parseInt(daily[2], 10)} ${parseInt(daily[1], 10)} * * *`
  return v
}

async function main() {
  const due = await pool.query(`
    SELECT id, name, type, status, cron_expression, run_at, tz, retry_count, leased_by
    FROM os_scheduled_tasks
    WHERE archived_at IS NULL
      AND status IN ('failed', 'orphaned', 'running', 'dispatching')
    ORDER BY status, name
  `)
  console.log(`found ${due.rows.length} stuck rows`)

  let rearmed = 0, archived = 0, skipped = 0
  const now = new Date()

  for (const row of due.rows) {
    try {
      if (row.type === 'cron' && row.cron_expression) {
        const tz = row.tz || 'Australia/Brisbane'
        let nextRunAt
        try {
          const cronExpr = translateSchedule(row.cron_expression)
          const iv = cronParser.CronExpressionParser.parse(cronExpr, { tz })
          nextRunAt = iv.next().toDate()
        } catch (e) {
          // unparseable cron - skip, leave for manual review
          console.log(`SKIP ${row.id} ${row.name} - cron parse failed: ${e.message}`)
          skipped++
          continue
        }
        await pool.query(`
          UPDATE os_scheduled_tasks
          SET status = 'active', retry_count = 0, leased_by = NULL, leased_at = NULL,
              next_run_at = $1, last_error = $2, updated_at = NOW()
          WHERE id = $3
        `, [nextRunAt.toISOString(), 'rearmed 2026-06-02 post-submit-key-fix from ' + row.status, row.id])
        console.log(`REARM cron ${row.name.slice(0,50)} -> ${nextRunAt.toISOString()}`)
        rearmed++
      } else if (row.type === 'delayed' || row.type === 'chained') {
        const ranInPast = row.run_at && new Date(row.run_at) < now
        if (ranInPast) {
          await pool.query(`
            UPDATE os_scheduled_tasks
            SET archived_at = NOW(), last_status = 'cancelled',
                last_error = 'window missed during submit-key bug 2026-06-02 - archived', updated_at = NOW()
            WHERE id = $1
          `, [row.id])
          console.log(`ARCHIVE delayed ${row.name.slice(0,50)} (window passed)`)
          archived++
        } else {
          await pool.query(`
            UPDATE os_scheduled_tasks
            SET status = 'active', retry_count = 0, leased_by = NULL, leased_at = NULL,
                last_error = 'cleared post-submit-key-fix 2026-06-02', updated_at = NOW()
            WHERE id = $1
          `, [row.id])
          console.log(`REARM delayed (future) ${row.name.slice(0,50)}`)
          rearmed++
        }
      } else {
        console.log(`SKIP ${row.id} unknown type=${row.type}`)
        skipped++
      }
    } catch (e) {
      console.log(`ERR ${row.id}: ${e.message}`)
      skipped++
    }
  }

  console.log(`\nDONE: rearmed=${rearmed} archived=${archived} skipped=${skipped}`)
  await pool.end()
}

main().catch(e => { console.error('fatal:', e); process.exit(1) })
