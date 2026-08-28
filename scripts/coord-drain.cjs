// coord-drain.cjs - BOOTSTRAP AND DIAGNOSTIC ONLY.
//
// The canonical sweep is the hourly in-process pass in scheduler.start(). Run
// this script out-of-process and you get a SPLIT BRAIN: it marks messages seen on
// disk, but the running laptop-agent holds its own hydrated copy of the store and
// will keep serving them until it restarts (observed 2026-08-28: disk said 138
// unseen while the live process said 149). Use it to drain a backlog before the
// agent has the tool loaded, or to inspect state; otherwise call
// coord-retire.sweep through /api/tool so one process owns the mutation.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
const retire = require('../tools/coord-retire.js')
;(async () => {
  const mode = process.argv[2] || 'status'
  if (mode === 'status') console.log(JSON.stringify(await retire.status({}), null, 1))
  if (mode === 'dry')    console.log(JSON.stringify(await retire.sweep({ dry_run: true }), null, 1))
  if (mode === 'sweep')  console.log(JSON.stringify(await retire.sweep({}), null, 1))
  if (mode === 'digest') console.log(JSON.stringify(await retire.digest({ older_than_days: 7 }), null, 1))
  process.exit(0)
})().catch(e => { console.error('ERR', e.message); process.exit(1) })
