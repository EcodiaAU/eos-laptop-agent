// routes/mcpCoord.js - JSON-RPC 2.0 MCP shim at POST /api/mcp/coord
//
// 8 coord.* tools exposed via the standard MCP protocol so Claude Code can
// wire them in as a connector via .mcp.json. Auth = laptop-agent's existing
// Bearer (AGENT_TOKEN). Per-call identity threaded via:
//   - X-Tab-Id / X-Tab-Credential headers (preferred)
//   - or params.tab_id / params.tab_credential (fallback)
// Tab cred validation is best-effort in v1: requests for inbox operations
// resolve the topic from ctx.tab_id, mismatched-cred calls still go through
// but will only operate on the topic for the asserted tab_id. (No cross-tab
// inbox theft because each topic is unique to tab_id.)

const coord = require('../tools/coord')
const usage = require('../tools/usage')

const PROTOCOL_VERSION = '2025-03-26'
const SERVER_INFO = Object.freeze({ name: 'EcodiaOS Coord', version: '1.1.0' })

const RPC_ERR = Object.freeze({
  PARSE_ERROR: { code: -32700, message: 'Parse error' },
  INVALID_REQUEST: { code: -32600, message: 'Invalid Request' },
  METHOD_NOT_FOUND: { code: -32601, message: 'Method not found' },
  INVALID_PARAMS: { code: -32602, message: 'Invalid params' },
  INTERNAL_ERROR: { code: -32603, message: 'Internal error' },
  UNAUTHENTICATED: { code: -32001, message: 'Unauthenticated' },
})

const TOOLS = Object.freeze([
  {
    name: 'coord.send_message',
    description: 'Send a message to an inbox topic. to = "chat.<tab_id>.inbox" | "chat.conductor.inbox" | etc. body = arbitrary JSON object. Returns {message_id, created_at}.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Inbox topic, e.g. "chat.conductor.inbox"' },
        body: { type: 'object', description: 'Arbitrary JSON message body' },
        task_id: { type: 'string', description: 'Optional task correlation id' },
        in_reply_to: { type: 'string', description: 'Optional id of message this replies to' },
      },
      required: ['to', 'body'],
      additionalProperties: true,
    },
  },
  {
    name: 'coord.read_inbox',
    description: 'Read unread messages from your inbox (resolves from your tab_id). Returns {topic, count, messages[]}. Marks returned messages as seen.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Override topic; defaults to your tab_id inbox' },
        since: { type: 'string', format: 'date-time' },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
      },
      additionalProperties: true,
    },
  },
  {
    name: 'coord.wait_for_inbox',
    description: 'Long-poll for the next inbox message. Holds up to {timeout} seconds (default 300, max 600). Returns {trigger_message, also_unread[<=20], more_unread, hold_duration_ms, timed_out}.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string' },
        timeout: { type: 'integer', minimum: 1, maximum: 600, default: 300 },
      },
      additionalProperties: true,
    },
  },
  {
    name: 'coord.ack_message',
    description: 'Acknowledge a message you actioned. id = message_id. action_summary = optional human-readable note (max 2000 chars).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        action_summary: { type: 'string', maxLength: 2000 },
      },
      required: ['id'],
      additionalProperties: true,
    },
  },
  {
    name: 'coord.list_workers',
    description: 'List currently-registered worker tabs. include_dead=false (default) hides workers with stale heartbeats or terminated_at set.',
    inputSchema: {
      type: 'object',
      properties: {
        include_dead: { type: 'boolean', default: false },
      },
      additionalProperties: true,
    },
  },
  {
    name: 'coord.heartbeat',
    description: 'Update your last_heartbeat_at. Call at the start and end of every turn. status = optional one-line summary of what you are doing. in_critical_section = optional bool (mid-write that should not be interrupted).',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', maxLength: 500 },
        in_critical_section: { type: 'boolean' },
      },
      additionalProperties: true,
    },
  },
  {
    name: 'coord.report_progress',
    description: 'Sugar for sending a progress message to chat.conductor.inbox. body = {type:"progress", task_id, summary}.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        summary: { type: 'string' },
      },
      required: ['summary'],
      additionalProperties: true,
    },
  },
  {
    name: 'coord.signal_done',
    description: 'Sugar for signalling task completion to chat.conductor.inbox. If terminate=true, marks your worker row terminated_at. result_pointer can name a file path or status_board row id holding the full output.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        result_summary: { type: 'string' },
        result_pointer: { type: 'string' },
        terminate: { type: 'boolean', default: false },
      },
      additionalProperties: true,
    },
  },
  {
    name: 'coord.pick_account',
    description: 'Select the highest-headroom Claude Max account for the next dispatch. Score: min(remaining_5h, remaining_weekly) * 0.85 - estimated_tokens. Returns {account, score, remaining_5h, remaining_weekly, reason, candidates[]}.',
    inputSchema: {
      type: 'object',
      properties: {
        estimated_tokens: { type: 'integer', minimum: 0, description: 'Optional estimate of tokens this dispatch will consume. Defaults to 0.' },
        exclude: { type: 'array', items: { type: 'string' }, description: 'Optional account labels to exclude (e.g. flaky / known-failing).' },
      },
      additionalProperties: true,
    },
  },
  {
    name: 'coord.get_usage_state',
    description: 'Read the latest poll snapshot: per-account 5h tokens, weekly tokens, headroom score, alerts (current-account-low, all-low, threshold). State is updated every ~5min by the usage-poller cron.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
  },
  {
    name: 'coord.poll_now',
    description: 'Force an immediate usage poll (runs ccusage + rebuilds account state). Normally called only on-demand; the cron runs every 5min. Returns the same shape as get_usage_state.state.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
  },
  {
    name: 'coord.get_active_account',
    description: 'Read the account currently loaded in ~/.claude/.credentials.json. Updated by cowork.swap_creds; the conductor reads at turn-start.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
  },
  {
    name: 'coord.set_active_account',
    description: 'Manually set the active account label (e.g. after Tate performs a manual cred swap). cowork.swap_creds calls this internally. Bootstrap: Tate runs this once with the account whose creds are currently in .credentials.json.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'tate@ecodia.au | code@ecodia.au | money@ecodia.au' },
        set_by: { type: 'string', description: 'Optional caller label for audit (e.g. "bootstrap-by-tate", "swap-creds-cron").' },
      },
      required: ['account'],
      additionalProperties: true,
    },
  },
  {
    name: 'coord.mark_flaky',
    description: 'Mark an account as flaky after a dispatch failure. Excluded from pick_account for FLAKY_TTL_MS (10min). dispatch_worker calls this after its recovery state machine exhausts attempts on an account. Self-heals on TTL.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string' },
        reason: { type: 'string', maxLength: 500 },
      },
      required: ['account'],
      additionalProperties: true,
    },
  },
  {
    name: 'coord.clear_flaky',
    description: 'Manually clear a flaky-account marker (escape hatch; otherwise auto-expires after 10min).',
    inputSchema: {
      type: 'object',
      properties: { account: { type: 'string' } },
      required: ['account'],
      additionalProperties: true,
    },
  },
  {
    name: 'coord.list_flaky',
    description: 'List currently-flaky accounts + expired entries for audit. Returns {active[], expired[], ttl_ms}.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
  },
])

const TOOL_NAMES = new Set(TOOLS.map(t => t.name))

function rpcError(id, err, data) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code: err.code, message: err.message, ...(data ? { data: data } : {}) } }
}
function rpcResult(id, result) {
  return { jsonrpc: '2.0', id: id ?? null, result: result }
}

function extractCtx(req, params) {
  return {
    tab_id: req.headers['x-tab-id'] || (params && params.tab_id),
    tab_credential: req.headers['x-tab-credential'] || (params && params.tab_credential),
  }
}

// Tool names are "coord.X"; we route to either coord.js (messaging primitives)
// or usage.js (account-balancing primitives) based on a whitelist.
const USAGE_TOOLS = new Set([
  'pick_account',
  'get_usage_state',
  'poll_now',
  'get_active_account',
  'set_active_account',
  'mark_flaky',
  'clear_flaky',
  'list_flaky',
])

async function callTool(toolName, params, ctx) {
  const short = toolName.replace(/^coord\./, '')
  let handler = null
  if (USAGE_TOOLS.has(short)) {
    handler = usage[short]
  } else {
    handler = coord[short]
  }
  if (typeof handler !== 'function' || short.startsWith('_')) {
    return { isError: true, body: { error: 'unknown tool: ' + toolName } }
  }
  try {
    const result = await Promise.resolve(handler(params || {}, ctx))
    return { isError: false, body: result }
  } catch (e) {
    return { isError: true, body: { error: e.message, tool: toolName } }
  }
}

async function handleSingle(req, env) {
  const id = env.id
  const method = env.method
  const params = env.params || {}
  const isNotification = id === undefined

  try {
    if (method === 'initialize') {
      return rpcResult(id ?? null, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false }, prompts: { listChanged: false }, resources: { listChanged: false } },
        serverInfo: SERVER_INFO,
      })
    }
    if (method === 'notifications/initialized' || method === 'initialized') return null
    if (method === 'ping') return rpcResult(id ?? null, {})
    if (method === 'tools/list') return rpcResult(id ?? null, { tools: TOOLS })
    if (method === 'prompts/list') return rpcResult(id ?? null, { prompts: [] })
    if (method === 'resources/list') return rpcResult(id ?? null, { resources: [] })

    if (method === 'tools/call') {
      const name = params.name
      const args = params.arguments || {}
      if (typeof name !== 'string') return rpcError(id, RPC_ERR.INVALID_PARAMS, { reason: 'name required' })
      if (!TOOL_NAMES.has(name)) return rpcError(id, RPC_ERR.METHOD_NOT_FOUND, { tool: name })
      const ctx = extractCtx(req, args)
      const out = await callTool(name, args, ctx)
      return rpcResult(id ?? null, {
        content: [{ type: 'text', text: JSON.stringify(out.body) }],
        isError: out.isError,
        _meta: { http_status: out.isError ? 500 : 200 },
      })
    }

    if (isNotification) return null
    return rpcError(id ?? null, RPC_ERR.METHOD_NOT_FOUND, { method: method })
  } catch (e) {
    if (isNotification) return null
    return rpcError(id ?? null, RPC_ERR.INTERNAL_ERROR, { error: e.message })
  }
}

function mount(app, auth) {
  // Long-poll-safe: never let Express time out on wait_for_inbox.
  app.post('/api/mcp/coord', auth, async (req, res) => {
    try {
      req.setTimeout(620 * 1000)  // 620s > 600s max wait timeout
      res.setTimeout(620 * 1000)
    } catch (e) {}

    const body = req.body
    if (body == null || typeof body !== 'object') {
      return res.status(400).json(rpcError(null, RPC_ERR.INVALID_REQUEST, { reason: 'body must be JSON' }))
    }

    if (Array.isArray(body)) {
      if (body.length === 0) return res.status(400).json(rpcError(null, RPC_ERR.INVALID_REQUEST, { reason: 'empty batch' }))
      const out = []
      for (const env of body) {
        if (!env || env.jsonrpc !== '2.0' || typeof env.method !== 'string') {
          out.push(rpcError(env?.id ?? null, RPC_ERR.INVALID_REQUEST))
          continue
        }
        const r = await handleSingle(req, env)
        if (r !== null) out.push(r)
      }
      if (out.length === 0) return res.status(204).end()
      return res.json(out)
    }

    if (body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
      return res.status(400).json(rpcError(body.id ?? null, RPC_ERR.INVALID_REQUEST, { received: { jsonrpc: body.jsonrpc, method: body.method } }))
    }
    const r = await handleSingle(req, body)
    if (r === null) return res.status(204).end()
    return res.json(r)
  })

  // Also expose a GET probe so curl / browser can verify the route is alive
  app.get('/api/mcp/coord/info', (_req, res) => {
    res.json({ ok: true, server: SERVER_INFO, protocolVersion: PROTOCOL_VERSION, tools: TOOLS.map(t => t.name) })
  })
}

module.exports = { mount, TOOLS, SERVER_INFO, PROTOCOL_VERSION }
