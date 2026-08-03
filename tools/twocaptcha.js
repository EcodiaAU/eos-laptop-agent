'use strict'
// tools/twocaptcha.js - solve an hCaptcha via 2Captcha (HUMAN solvers), same shape as
// tools/capsolver.js. 2Captcha's newer JSON API mirrors CapSolver's createTask/getTaskResult.
// Chosen 2026-08-03 because CapSolver flatly refused Anthropic's hCaptcha ("we don't support
// this service"); human solvers handle configs the AI solvers decline. Key from
// TWOCAPTCHA_API_KEY / kv creds.twocaptcha_api_key. Never logged.
// Docs: https://2captcha.com/api-docs/hcaptcha
const https = require('https')
const BASE = 'https://api.2captcha.com'
function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const u = new URL(BASE + path)
    const req = https.request({ hostname: u.hostname, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => {
      let b = ''; res.on('data', c => b += c)
      res.on('end', () => { try { resolve(JSON.parse(b)) } catch (e) { reject(new Error('2captcha bad json: ' + b.slice(0, 200))) } })
    })
    req.on('error', reject); req.write(data); req.end()
  })
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
// opts: { websiteURL, websiteKey, isInvisible?, rqdata?, userAgent?, apiKey?, timeoutMs? }
async function solveHCaptcha(opts) {
  const apiKey = opts.apiKey || process.env.TWOCAPTCHA_API_KEY
  if (!apiKey) throw new Error('TWOCAPTCHA_API_KEY not set (kv creds.twocaptcha_api_key)')
  if (!opts.websiteURL || !opts.websiteKey) throw new Error('websiteURL and websiteKey required')
  const task = { type: 'HCaptchaTaskProxyless', websiteURL: opts.websiteURL, websiteKey: opts.websiteKey }
  if (opts.isInvisible) task.isInvisible = true
  if (opts.userAgent) task.userAgent = opts.userAgent
  if (opts.rqdata) task.enterprisePayload = { rqdata: opts.rqdata }
  const created = await post('/createTask', { clientKey: apiKey, task })
  if (created.errorId) throw new Error('2captcha createTask: ' + (created.errorCode || '') + ' ' + (created.errorDescription || ''))
  const taskId = created.taskId
  if (!taskId) throw new Error('2captcha createTask returned no taskId')
  const deadline = Date.now() + (opts.timeoutMs || 180000)
  while (Date.now() < deadline) {
    await sleep(5000)
    const r = await post('/getTaskResult', { clientKey: apiKey, taskId })
    if (r.errorId) throw new Error('2captcha getTaskResult: ' + (r.errorCode || '') + ' ' + (r.errorDescription || ''))
    if (r.status === 'ready') {
      const sol = r.solution || {}
      const token = sol.gRecaptchaResponse || sol.token
      if (!token) throw new Error('2captcha ready but no token in solution')
      return { token, userAgent: sol.userAgent || null }
    }
  }
  throw new Error('2captcha solve timed out')
}
async function balance(apiKey) {
  const key = apiKey || process.env.TWOCAPTCHA_API_KEY
  if (!key) throw new Error('TWOCAPTCHA_API_KEY not set')
  const r = await post('/getBalance', { clientKey: key })
  if (r.errorId) throw new Error('2captcha getBalance: ' + (r.errorCode || '') + ' ' + (r.errorDescription || ''))
  return typeof r.balance === 'number' ? r.balance : null
}
module.exports = { solveHCaptcha, balance }
