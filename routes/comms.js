// routes/comms.js - POST /api/comms/register-worker
//
// The dispatcher (cowork.dispatch_worker) calls this BEFORE pasting the brief
// into the spawned tab. Registration is synchronous and conductor-side, not
// worker-side bootstrap-curl - workers don't have to do anything to register.

const coord = require('../tools/coord')

function mount(app, auth) {
  app.post('/api/comms/register-worker', auth, (req, res) => {
    try {
      const { tab_id, task_id, tab_credential, parent_conductor_tab_id, account_active_when_spawned } = req.body || {}
      if (!tab_id || !tab_credential) {
        return res.status(400).json({ error: 'tab_id + tab_credential required' })
      }
      const row = coord._registerWorkerInternal({
        tab_id: tab_id,
        task_id: task_id,
        tab_credential: tab_credential,
        parent_conductor_tab_id: parent_conductor_tab_id,
        account_active_when_spawned: account_active_when_spawned,
      })
      return res.json({
        ok: true,
        tab_id: row.tab_id,
        registered_at: row.registered_at,
        inbox: 'chat.' + row.tab_id + '.inbox',
      })
    } catch (e) {
      return res.status(500).json({ error: e.message })
    }
  })
}

module.exports = { mount }
