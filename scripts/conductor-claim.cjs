#!/usr/bin/env node
// conductor-claim.cjs - the conductor half of the conductor-versus-worker interlock.
//
// Call this the moment you (the conductor) start doing work you have armed a row
// for. It stamps your tab id on the row; dispatchOne's step-0a interlock then
// refuses to open a tab for it and settles the row terminal naming you.
//
//   node scripts/conductor-claim.cjs <row-id|row-name> [--tab conductor] [--release]
//
// THE MIRROR HALF, and it is the part that is easy to get backwards. A claim is
// REFUSED on a row already in 'running' or 'dispatching'. Once a tab exists the
// WORKER is the incumbent and the conductor is the duplicate, so the conductor is
// the one that backs off. Before a tab exists the conductor is the incumbent and
// the claim stands. Same incumbent-wins rule the lease-side lane defer uses.
//
// A claim means you own delivery. There is no heartbeat on a claim and therefore
// no liveness reaper that can free it: if you claim and then walk away, the work
// does not happen and the row says who owed it.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
const { Pool } = require('pg')

const args = process.argv.slice(2)
const target = args.find(a => !a.startsWith('--'))
const tabIdx = args.indexOf('--tab')
const tab = tabIdx >= 0 ? args[tabIdx + 1] : (process.env.COORD_CONDUCTOR_TAB_ID || 'conductor')
const release = args.includes('--release')

if (!target) {
  console.error('usage: conductor-claim.cjs <row-id|row-name> [--tab <tab_id>] [--release]')
  process.exit(2)
}

const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target)
const where = isUuid ? 't.id = $1::uuid' : 't.name = $1'

;(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 30000, max: 1 })
  try {
    if (release) {
      const r = await pool.query(
        `UPDATE os_scheduled_tasks t
            SET claimed_by_tab_id = NULL, claimed_at = NULL, updated_at = NOW()
          WHERE ${where} AND t.claimed_by_tab_id IS NOT NULL
        RETURNING t.id, t.name`, [target])
      if (!r.rowCount) { console.log('no claim to release on ' + target); process.exit(0) }
      for (const row of r.rows) console.log('released claim on ' + row.id + ' (' + row.name + ')')
      process.exit(0)
    }

    // Refuse on a row that already has a live tab. Reported, not silent: a
    // conductor that thinks it claimed a row and did not is the same duplicate
    // arc in the other direction.
    const pre = await pool.query(
      `SELECT t.id, t.name, t.status, t.dispatched_tab_id, t.claimed_by_tab_id
         FROM os_scheduled_tasks t WHERE ${where} AND t.archived_at IS NULL`, [target])
    if (!pre.rowCount) { console.error('REFUSED: no live row matches ' + target); process.exit(1) }
    if (pre.rowCount > 1) {
      console.error('REFUSED: ' + pre.rowCount + ' live rows match ' + target + '; address it by id')
      process.exit(1)
    }
    const row = pre.rows[0]
    if (row.status === 'running' || row.status === 'dispatching') {
      console.error('REFUSED: ' + row.id + ' (' + row.name + ') is ' + row.status +
        (row.dispatched_tab_id ? ' in tab ' + row.dispatched_tab_id : '') +
        '. A tab already holds this work, so the WORKER is the incumbent and you are the duplicate. ' +
        'Stand it down (coord.send_message type stand_down) or kill_worker it; do not claim over it.')
      process.exit(1)
    }

    const r = await pool.query(
      `UPDATE os_scheduled_tasks t
          SET claimed_by_tab_id = $1, claimed_at = NOW(), updated_at = NOW()
        WHERE t.id = $2::uuid
          AND t.status NOT IN ('running', 'dispatching')
      RETURNING t.id, t.name, t.status, t.claimed_by_tab_id, t.claimed_at`, [tab, row.id])
    if (!r.rowCount) {
      console.error('REFUSED: ' + row.id + ' changed status under the claim (raced a dispatch); re-read it')
      process.exit(1)
    }
    const c = r.rows[0]
    console.log('claimed ' + c.id + ' (' + c.name + ') [status ' + c.status + '] by ' +
      c.claimed_by_tab_id + ' at ' + new Date(c.claimed_at).toISOString())
    console.log('no worker tab will be opened for this row. You own delivery.')
  } finally {
    await pool.end()
  }
})().catch(e => { console.error('ERR', e.message); process.exit(1) })
