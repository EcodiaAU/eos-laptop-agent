'use strict'

// Both dispatchers' composeBrief must hand a worker an address that names ITS
// dispatching chat, never the shared `chat.conductor.inbox` slot.
//
// This is the braces to coord.message_chat's belt. The rewrite in message_chat
// catches a worker that calls `to:"conductor"`; this catches the worker that
// copies the literal address out of its own brief header, which is what
// tab_1787806439688_403f2ce5 did on 2026-08-28 before landing its report in a
// stranger's chat.
//
// Run: COORD_DISABLE_SWEEP=1 node tools/brief-conductor-attr.test.js

process.env.COORD_DISABLE_SWEEP = '1'
const os = require('os')
const path = require('path')
const fs = require('fs')

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-attr-test-'))
process.env.COORD_ROOT = tmpRoot
fs.mkdirSync(path.join(tmpRoot, 'chat-tabs'), { recursive: true })
fs.mkdirSync(path.join(tmpRoot, 'briefs'), { recursive: true })

const PARENT = 'dbf03de2-f9cb-4f9b-a6d5-181da825d40b'
const EXPECTED = 'conductor="chat.session:' + PARENT + '.inbox"'

let passed = 0, failed = 0
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ok   ' + name) }
  else { failed++; console.log('  FAIL ' + name + (extra ? '  ' + JSON.stringify(String(extra).slice(0, 300)) : '')) }
}

const base = {
  tab_id: 'tab_test', task_id: 'task_test', tab_credential: 'cred_test',
  parent_conductor_tab_id: 'conductor',
  brief_body: 'do the thing', brief_size_bytes: 12, brief_storage: 'inline', brief_file_path: null,
}

for (const [modName, modPath] of [['mac-dispatcher', './mac-dispatcher'], ['cowork', './cowork']]) {
  const mod = require(modPath)
  const compose = mod._composeBrief
  if (typeof compose !== 'function') {
    ok(modName + ' exposes _composeBrief for this assertion', false, 'not exported')
    continue
  }
  const withParent = compose(Object.assign({}, base, { parent_session: PARENT }))
  ok(modName + ': brief names the dispatching chat, not the shared slot',
    withParent.indexOf(EXPECTED) !== -1, withParent.slice(0, 400))
  ok(modName + ': brief does NOT carry the singleton address when a parent is known',
    withParent.indexOf('conductor="chat.conductor.inbox"') === -1, withParent.slice(0, 400))

  // No parent recorded: the singleton is the honest fallback (durable inbox,
  // surfaced at the right chat's next turn), so it is expected here.
  const noParent = compose(Object.assign({}, base, { parent_session: null }))
  ok(modName + ': with no recorded parent it falls back to the durable conductor inbox',
    noParent.indexOf('conductor="chat.conductor.inbox"') !== -1, noParent.slice(0, 400))
}

console.log('\n' + passed + ' passed, ' + failed + ' failed')
try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch (e) {}
process.exit(failed ? 1 : 0)
