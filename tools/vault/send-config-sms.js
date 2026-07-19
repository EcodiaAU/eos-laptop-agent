'use strict'
// Sends the eosvault://config provisioning link to Tate's phone by SMS, reading the ingest
// secret from disk so it never enters the conductor transcript. The link provisions the
// phone's outbound channel (function URL + anti-spam secret) with one tap.
const fs = require('fs')
const os = require('os')
const path = require('path')
const https = require('https')

const FN = 'https://nxmtfzofemtrlezlyhcj.supabase.co/functions/v1/vault-ingest'
const secret = fs.readFileSync(path.join(os.homedir(), 'PRIVATE', 'ecodia-creds', 'vault', 'ingest-secret.txt'), 'utf8').trim()
const link = `eosvault://config?fn=${encodeURIComponent(FN)}&ingest=${encodeURIComponent(secret)}`

// comms MCP endpoint + bearer from the workspace .mcp.json (not printed).
const mcp = JSON.parse(fs.readFileSync('/Users/ecodia/.code/ecodiaos/.mcp.json', 'utf8'))
const comms = mcp.mcpServers ? mcp.mcpServers['ecodia-comms'] : mcp['ecodia-comms']
const url = comms.url
const auth = comms.headers.Authorization

const channel = process.argv[2] || 'email'
const params = channel === 'sms'
  ? { name: 'send_sms', arguments: { to: '+61404247153', body: `EcodiaOS vault: tap to provision your phone channel.\n${link}` } }
  : { name: 'gmail_send', arguments: { to: 'tate@ecodia.au', subject: 'EcodiaOS vault: provision your phone (tap on phone)', body: `Open this on your iPhone and tap it to provision the vault channel on build 10:\n\n${link}\n\nThis carries the anti-spam ingest token (low sensitivity, rotated before any real credential).` } }
const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params })

const u = new URL(url)
const req = https.request({ hostname: u.hostname, path: u.pathname, method: 'POST', headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', 'authorization': auth, 'content-length': Buffer.byteLength(body) } }, (res) => {
  let raw = ''; res.on('data', c => raw += c); res.on('end', () => {
    console.log('HTTP', res.statusCode)
    console.log(raw.slice(0, 600))
  })
})
req.on('error', e => { console.error('ERR', e.message); process.exit(1) })
req.write(body); req.end()
