// routes/comms.js - POST /api/comms/register-worker
//
// The dispatcher (cowork.dispatch_worker) calls this BEFORE pasting the brief
// into the spawned tab. Registration is synchronous and conductor-side, not
// worker-side bootstrap-curl - workers don't have to do anything to register.

const coord = require('../tools/coord')

function mount(app, auth) {
  app.post('/api/comms/register-worker', auth, (req, res) => {
    try {
      const { tab_id, task_id, tab_credential, parent_conductor_tab_id, parent_session, account_active_when_spawned, lane_name } = req.body || {}
      if (!tab_id || !tab_credential) {
        return res.status(400).json({ error: 'tab_id + tab_credential required' })
      }
      const row = coord._registerWorkerInternal({
        tab_id: tab_id,
        task_id: task_id,
        tab_credential: tab_credential,
        parent_conductor_tab_id: parent_conductor_tab_id,
        parent_session: parent_session,
        account_active_when_spawned: account_active_when_spawned,
        // 2026-08-29. The os_scheduled_tasks row name this worker came from.
        // inboxTopicFor derives a LANE-keyed mailbox from it that survives this
        // tab's death, so the next pass of the same job inherits the inbox.
        lane_name: lane_name,
      })
      return res.json({
        ok: true,
        tab_id: row.tab_id,
        registered_at: row.registered_at,
        // Report the topic the RESOLVER will actually use, not a hardcoded
        // per-tab guess. This line previously built the address by hand, so
        // after the lane fix it would have told every worker the wrong inbox
        // while the resolver quietly used another: the caller-and-callee
        // disagreement that is worse than either address alone.
        inbox: coord._inboxTopicFor({ tab_id: row.tab_id, lane_name: row.lane_name }),
      })
    } catch (e) {
      return res.status(500).json({ error: e.message })
    }
  })
}

module.exports = { mount }
