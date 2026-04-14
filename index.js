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

  try {
    const result = await fn(params)
    res.json({ ok: true, result })
  } catch (err) {
    res.status(500).json({ error: err.message, tool })
  }
})

app.use((_req, res) => res.status(404).json({ error: 'Not found' }))

app.listen(PORT, () => {
  console.log(`EcodiaOS Laptop Agent running on :${PORT}`)
  console.log(`Tools loaded: ${Object.keys(tools).join(', ')}`)
  console.log(`Auth: ${TOKEN ? 'enabled' : 'DISABLED (set AGENT_TOKEN)'}`)
})
