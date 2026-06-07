// Load .env early so SCHEDULER_ENABLED + DATABASE_URL + AGENT_TOKEN are
// available before any tool is required. Tolerant fallback when dotenv or
// the file is missing - env may still be set by the launch shell or PM2.
try {
  require('dotenv').config({ path: require('path').join(__dirname, '.env') })
} catch (_e) {
  // dotenv missing or file absent - env still functional via parent env
}

const express = require('express')
const cors = require('cors')
const os = require('os')
const fs = require('fs')
const path = require('path')

const app = express()
const PORT = process.env.AGENT_PORT || 7456
const TOKEN = process.env.AGENT_TOKEN || ''

app.use(cors())
app.use(express.json({ limit: '50mb' }))

function auth(req, res, next) {
  if (!TOKEN) return next()
  const header = req.headers.authorization || ''
  if (header === `Bearer ${TOKEN}`) return next()
  res.status(401).json({ error: 'Unauthorized' })
}

const tools = {}
const toolDir = path.join(__dirname, 'tools')
for (const file of fs.readdirSync(toolDir)) {
  if (!file.endsWith('.js')) continue
  // Skip *.test.js, *.spec.js and similar harness files - they call process.exit()
  // at the end of a run, which would kill the server during autoload.
  if (/\.(test|spec|bench)\.js$/.test(file)) continue
  const mod = require(path.join(toolDir, file))
  const moduleName = path.basename(file, '.js')
  for (const [name, fn] of Object.entries(mod)) {
    tools[`${moduleName}.${name}`] = fn
  }
}

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    platform: os.platform(),
    arch: os.arch(),
    memory: {
      total: os.totalmem(),
      free: os.freemem(),
      usedPercent: Math.round((1 - os.freemem() / os.totalmem()) * 100),
    },
    hostname: os.hostname(),
  })
})

app.get('/api/info', auth, (_req, res) => {
  res.json({
    platform: os.platform(),
    arch: os.arch(),
    release: os.release(),
    hostname: os.hostname(),
    cpus: os.cpus().length,
    cpuModel: os.cpus()[0]?.model,
    memory: { total: os.totalmem(), free: os.freemem() },
    uptime: os.uptime(),
    homeDir: os.homedir(),
    tmpDir: os.tmpdir(),
    nodeVersion: process.version,
    user: os.userInfo().username,
    networkInterfaces: Object.fromEntries(
      Object.entries(os.networkInterfaces()).map(([name, addrs]) => [
        name,
        addrs.filter(a => !a.internal).map(a => ({ address: a.address, family: a.family })),
      ]).filter(([, addrs]) => addrs.length > 0)
    ),
    tools: Object.keys(tools),
  })
})

app.post('/api/tool', auth, async (req, res) => {
  const { tool, params = {} } = req.body
  if (!tool) return res.status(400).json({ error: 'Missing tool name' })

  const fn = tools[tool]
  if (!fn) return res.status(404).json({ error: `Unknown tool: ${tool}`, available: Object.keys(tools) })

  // Thread ctx into tool handlers that accept it (coord.* family). Falls back
  // gracefully for tools that ignore the second arg.
  const ctx = {
    tab_id: req.headers['x-tab-id'] || (params && params.tab_id),
    tab_credential: req.headers['x-tab-credential'] || (params && params.tab_credential),
  }

  try {
    const result = await fn(params, ctx)
    // 2026-06-01: ANY successful tool call from a registered worker tab
    // bumps that worker's last_heartbeat_at. This stops the sweep loop from
    // killing workers mid-task during long-running tool calls (Read, Bash,
    // db_execute) where the model wouldn't naturally call coord.heartbeat
    // between every step. Non-worker tabs are a no-op. Skip the coord.*
    // family to avoid double-write on the explicit heartbeat path.
    if (ctx.tab_id && !String(tool).startsWith('coord.')) {
      try {
        const coord = require('./tools/coord')
        if (typeof coord._touchHeartbeatForTab === 'function') {
          coord._touchHeartbeatForTab(ctx.tab_id)
        }
      } catch (e) {}
    }
    res.json({ ok: true, result })
  } catch (err) {
    res.status(500).json({ error: err.message, tool })
  }
})

// Coord substrate: register-worker REST + /api/mcp/coord JSON-RPC shim
try {
  require('./routes/comms').mount(app, auth)
  require('./routes/mcpCoord').mount(app, auth)
  console.log('Coord routes mounted: /api/comms/register-worker + /api/mcp/coord')
} catch (e) {
  console.error('Coord routes failed to mount:', e.message)
}

// Cowork REST surface: POST /api/cowork/dispatch-worker.
// Wrapped defensively so a syntax error or missing dep in routes/cowork.js
// never takes down the laptop-agent startup. The observer_signal.py self-heal
// hook depends on this endpoint; failing-closed is the right posture.
try {
  require('./routes/cowork').mount(app, auth)
  console.log('Cowork route mounted: /api/cowork/dispatch-worker')
} catch (e) {
  console.error('Cowork route failed to mount:', e.message)
}

// Phase 8: manual CC chat dispatch with cred rotation.
//
// POST /api/scheduler/manual_chat  { "brief": "...", "preferred_account": "tate"? }
// Picks the healthiest account, atomically rotates ~/.claude/.credentials.json,
// then dispatches a new CC chat tab via cowork.dispatch_worker. Returns
// { ok, account, tab_id }. Use this instead of the IDE keybind when you want
// cred rotation to happen automatically before the new chat reads its tokens.
app.post('/api/scheduler/manual_chat', auth, async (req, res) => {
  try {
    const creds = require('./tools/creds')
    const cowork = require('./tools/cowork')
    const brief = (req.body && req.body.brief) || 'New manual chat (no brief provided).'
    const preferred = req.body && req.body.preferred_account
    const ide = (req.body && req.body.ide) || 'stable'
    const taskId = (req.body && req.body.task_id) || ('manual-' + Date.now())

    const account = await creds.pick_healthiest_account({
      preferred: preferred || null,
      required_headroom_minutes: 15,
    })
    await creds.rotate_to(account)
    const result = await cowork.dispatch_worker({ brief, task_id: taskId, ide, account })
    res.json({ ok: true, account, tab_id: result && result.tab_id, task_id: taskId })
  } catch (err) {
    res.status(500).json({ error: err.message || String(err), name: err.name || 'Error' })
  }
})

app.use((_req, res) => res.status(404).json({ error: 'Not found' }))

app.listen(PORT, () => {
  console.log(`EcodiaOS Laptop Agent running on :${PORT}`)
  console.log(`Tools loaded: ${Object.keys(tools).join(', ')}`)
  console.log(`Auth: ${TOKEN ? 'enabled' : 'DISABLED (set AGENT_TOKEN)'}`)

  // Autonomy substrate scheduler (Phase 3). Off by default - requires explicit
  // SCHEDULER_ENABLED=true + DATABASE_URL. Do NOT flip on until: (a) agent
  // restart picks up signal_bound; (b) code.json + money.json are seeded;
  // (c) Tate explicitly enables.
  if (process.env.SCHEDULER_ENABLED === 'true') {
    try {
      const scheduler = require('./tools/scheduler')
      // 2026-06-08 Mac-day-1: scheduler.js default dispatcher is cowork.js,
      // which is Windows-AHK-coupled. Inject mac-dispatcher when platform=darwin.
      if (process.platform === 'darwin') {
        const macDispatcher = require('./tools/mac-dispatcher')
        scheduler._setDispatcher(macDispatcher)
        console.log('Scheduler dispatcher: mac-dispatcher (darwin)')
      }
      scheduler.start()
      console.log('Scheduler started (autonomy substrate Phase 3)')
    } catch (e) {
      console.error('Scheduler failed to start:', e.message)
    }
  }
})
