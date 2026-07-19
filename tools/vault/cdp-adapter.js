'use strict'
// tools/vault/cdp-adapter.js - the REAL fill + tab-verify seams for the daemon.
// Everything above this file is pure/testable; this is the one place that touches a
// live browser. It gives createDaemon its two injected deps:
//   readTab(ref)  -> { origin, accountHint }  (feeds verify-tab's matcher)
//   fill(ref,code) -> types the code into the live 2FA input via the native setter
// The daemon (not the conductor) owns this surface, so cdp_session_ref is a
// daemon-VERIFIED binding rather than a conductor claim (red-team T4).
const http = require('http')
const path = require('path')
const WebSocket = require(path.join('/Users/ecodia/.code/ecodiaos/backend', 'node_modules', 'ws'))

const PORT = process.env.CDP_PORT || '9222'

function httpJson(p) {
  return new Promise((res, rej) => { http.get({ host: '127.0.0.1', port: PORT, path: p }, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => { try { res(JSON.parse(b)) } catch (e) { rej(e) } }) }).on('error', rej) })
}

// cdp_session_ref is a URL substring identifying the tab the daemon should act on.
async function withPage(ref, fn) {
  const list = await httpJson('/json/list')
  const page = list.find(t => t.type === 'page' && (t.url || '').includes(ref) && t.webSocketDebuggerUrl)
  if (!page) throw new Error('no CDP page matching ref ' + ref)
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false })
  let id = 0; const pending = {}
  const send = (m, p) => new Promise((res, rej) => { const mid = ++id; pending[mid] = { res, rej }; ws.send(JSON.stringify({ id: mid, method: m, params: p })) })
  ws.on('message', m => { const d = JSON.parse(m); if (d.id && pending[d.id]) { d.error ? pending[d.id].rej(new Error(d.error.message)) : pending[d.id].res(d.result); delete pending[d.id] } })
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej) })
  await send('Runtime.enable', {})
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.text || ''))
    return r.result.value
  }
  try { return await fn({ evaluate, url: page.url, send }) } finally { ws.close() }
}

// Read the live tab's origin + the signed-in account hint. The account hint is what
// separates code@ from tate@ on a shared origin, so read the identity the PAGE
// asserts, not one the conductor supplies.
const READ_TAB = `(() => {
  const meta = (n) => { const e = document.querySelector('meta[name="'+n+'"]'); return e ? (e.getAttribute('content')||'') : ''; };
  let hint = meta('user-login') || meta('octolytics-actor-login') || '';
  if (!hint) {
    const b = document.body ? document.body.innerText : '';
    const m = b.match(/Signed in as\\s+@?([A-Za-z0-9_.@-]+)/i) || b.match(/@([A-Za-z0-9_-]{3,})/);
    hint = m ? m[1] : '';
  }
  return { origin: location.origin, accountHint: hint, title: document.title };
})()`

async function readTab(ref) {
  return withPage(ref, async (p) => p.evaluate(READ_TAB))
}

// Fill the 2FA code into the live input via the native setter (so React/SPA inputs
// register a real change), then optionally submit. The code is passed in from the
// daemon and never logged.
function makeFill(opts) {
  opts = opts || {}
  const selectors = opts.selectors || ['#otp', '[name=otp]', '#app_otp', '[name=app_otp]', 'input[autocomplete="one-time-code"]', '#sudo_otp', '[name=sudo_otp]']
  const submitRe = opts.submitRe || 'verify|continue|submit|sign in'
  return async function fill(ref, code) {
    return withPage(ref, async (p) => {
      const expr = `(() => {
        const sels = ${JSON.stringify(selectors)};
        let el = null;
        for (const s of sels) { const e = document.querySelector(s); if (e && (e.offsetWidth||e.offsetHeight)) { el = e; break } }
        if (!el) return { ok:false, error:'no visible 2fa input' };
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
        el.focus(); setter.call(el, ${JSON.stringify(code)});
        el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}));
        const btn = [...document.querySelectorAll('button,input[type=submit]')]
          .find(b => new RegExp(${JSON.stringify(submitRe)},'i').test((b.innerText||b.value||'')) && !b.disabled && (b.offsetWidth||b.offsetHeight));
        if (btn) btn.click();
        return { ok:true, filledLength: el.value.length, submitted: !!btn, selector: el.id ? ('#'+el.id) : el.name };
      })()`
      return p.evaluate(expr)
    })
  }
}

module.exports = { readTab, makeFill, withPage }
