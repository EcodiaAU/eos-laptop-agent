'use strict'
// tools/capsolver.js - solve an hCaptcha via CapSolver and return the token.
//
// WHY: as of 2026-08-03 the Claude OAuth authorize page (claude.ai/oauth/authorize) throws
// an hCaptcha challenge after the Authorize click, which the automated switch drive cannot
// solve, so account-switch-browser.js exhausts. CapSolver solves the hCaptcha on its own
// clean infra and returns a token we inject into the page. Doctrine:
// patterns/claude-oauth-authorize-is-hcaptcha-gated-headless-switch-blocked-2026-08-03.md
//
// Key: read from kv creds.capsolver_api_key (never hard-coded, never logged). Set
// CAPSOLVER_API_KEY in the environment for the switch process, or pass apiKey explicitly.
//
// API (https://docs.capsolver.com):
//   POST /createTask     { clientKey, task:{ type:'HCaptchaTaskProxyLess', websiteURL,
//                          websiteKey, isInvisible?, enterprisePayload?:{rqdata,...}, userAgent? } }
//     -> { errorId, taskId }
//   POST /getTaskResult  { clientKey, taskId } -> { status:'ready'|'processing',
//                          solution:{ gRecaptchaResponse, userAgent, respKey } }
const https = require('https')

const BASE = 'https://api.capsolver.com'

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const u = new URL(BASE + path)
    const req = https.request({ hostname: u.hostname, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => {
      let b = ''
      res.on('data', c => b += c)
      res.on('end', () => { try { resolve(JSON.parse(b)) } catch (e) { reject(new Error('capsolver bad json: ' + b.slice(0, 200))) } })
    })
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// Solve an hCaptcha. Returns { token, userAgent } or throws.
//   opts: { websiteURL, websiteKey, isInvisible?, rqdata?, userAgent?, apiKey?, timeoutMs? }
async function solveHCaptcha(opts) {
  const apiKey = opts.apiKey || process.env.CAPSOLVER_API_KEY
  if (!apiKey) throw new Error('CAPSOLVER_API_KEY not set (kv creds.capsolver_api_key)')
  if (!opts.websiteURL || !opts.websiteKey) throw new Error('websiteURL and websiteKey required')

  const task = { type: 'HCaptchaTaskProxyLess', websiteURL: opts.websiteURL, websiteKey: opts.websiteKey }
  if (opts.isInvisible) task.isInvisible = true
  if (opts.userAgent) task.userAgent = opts.userAgent
  if (opts.rqdata) task.enterprisePayload = { rqdata: opts.rqdata }  // hCaptcha Enterprise

  const created = await post('/createTask', { clientKey: apiKey, task })
  if (created.errorId) throw new Error('capsolver createTask: ' + (created.errorCode || '') + ' ' + (created.errorDescription || ''))
  const taskId = created.taskId
  if (!taskId) throw new Error('capsolver createTask returned no taskId')

  const deadline = Date.now() + (opts.timeoutMs || 120000)
  while (Date.now() < deadline) {
    await sleep(3000)
    const r = await post('/getTaskResult', { clientKey: apiKey, taskId })
    if (r.errorId) throw new Error('capsolver getTaskResult: ' + (r.errorCode || '') + ' ' + (r.errorDescription || ''))
    if (r.status === 'ready') {
      const sol = r.solution || {}
      const token = sol.gRecaptchaResponse || sol.token || sol.respKey
      if (!token) throw new Error('capsolver ready but no token in solution')
      return { token, userAgent: sol.userAgent || null }
    }
    // status === 'processing' -> keep polling
  }
  throw new Error('capsolver solve timed out')
}

// Read the account balance (a cheap liveness + funding check). Returns a number.
async function balance(apiKey) {
  const key = apiKey || process.env.CAPSOLVER_API_KEY
  if (!key) throw new Error('CAPSOLVER_API_KEY not set')
  const r = await post('/getBalance', { clientKey: key })
  if (r.errorId) throw new Error('capsolver getBalance: ' + (r.errorCode || '') + ' ' + (r.errorDescription || ''))
  return typeof r.balance === 'number' ? r.balance : null
}

module.exports = { solveHCaptcha, balance }
