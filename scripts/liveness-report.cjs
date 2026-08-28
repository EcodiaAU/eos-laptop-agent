require('dotenv').config({ path: require('path').join(__dirname,'..','.env') })
const { Pool } = require('pg')
const L = require('../tools/worker-liveness.js')
;(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 30000 })
  const r = await pool.query("SELECT id,name,type,leased_at,dispatched_tab_id FROM os_scheduled_tasks WHERE status='running' AND archived_at IS NULL ORDER BY leased_at")
  const v = L.probeRows(r.rows, {})
  const c = {}; for (const x of v) c[x.verdict] = (c[x.verdict] || 0) + 1
  console.log('running rows:', r.rows.length, 'counts', JSON.stringify(c))
  for (const x of v) console.log(' ', x.verdict.padEnd(8), String(x.name).slice(0,50).padEnd(51), JSON.stringify(x.evidence))
  await pool.end()
})().catch(e => { console.error('ERR', e.message); process.exit(1) })
