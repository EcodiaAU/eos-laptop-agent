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
