'use strict'
// Hands-on routing test. Usage: node tools/route-test.js "<label-substring>" "<marker>"
// Selects the target chat with the FIXED selection chain (generic openEditorAtIndex
// arg for any index) and PASTES a marker into its composer WITHOUT pressing Return.
// So nothing takes a turn - Tate just sees which chat's input box shows the marker.
// Also prints what the bridge THINKS the active tab is after selecting, so we can
// see bridge-view vs reality.
process.env.COORD_DISABLE_SWEEP = '1'
const ide = require('./ide')
const applescript = require('./applescript')
const ci = require('./chat-inject')
const sleep = ms => new Promise(r => setTimeout(r, ms))

function focusGroupCmd(vc) {
  return ({1:'focusFirstEditorGroup',2:'focusSecondEditorGroup',3:'focusThirdEditorGroup',4:'focusFourthEditorGroup',5:'focusFifthEditorGroup'}[vc]) ? 'workbench.action.' + ({1:'focusFirstEditorGroup',2:'focusSecondEditorGroup',3:'focusThirdEditorGroup',4:'focusFourthEditorGroup',5:'focusFifthEditorGroup'}[vc]) : null
}

;(async () => {
  const needle = (process.argv[2] || '').toLowerCase()
  const marker = process.argv[3] || ('[ROUTE-TEST ' + Date.now().toString(36) + ']')
  const tabs = await ci.listChatTabs()
  console.log('LIVE TABS:')
  tabs.forEach(t => console.log('   idx' + t.index, t.isActive ? '[bridge-ACTIVE]' : '              ', JSON.stringify((t.label || '').slice(0, 34))))
  const target = tabs.find(t => (t.label || '').toLowerCase().includes(needle))
  if (!target) { console.log('\nNO TAB matches ' + JSON.stringify(needle)); process.exit(1) }
  console.log('\nTARGET: idx' + target.index + ' ' + JSON.stringify(target.label.slice(0, 34)))
  console.log('MARKER: ' + marker + '  (pasting, NOT submitting)')

  // FIXED selection chain
  const fg = focusGroupCmd(target.viewColumn)
  if (fg) { await ide.command({ cmd: fg }).catch(() => {}); await sleep(150) }
  if (target.index < 9) await ide.command({ cmd: 'workbench.action.openEditorAtIndex' + (target.index + 1) }).catch(() => {})
  else await ide.command({ cmd: 'workbench.action.openEditorAtIndex', args: [target.index] }).catch(() => {})
  await sleep(200)
  await ide.command({ cmd: 'claude-vscode.focus' }).catch(() => {})
  await applescript.activate_app({ app: 'Visual Studio Code' }).catch(() => {})
  await sleep(900)

  // what does the bridge think is active now?
  const after = (await ci.listChatTabs()).find(t => t.isActive)
  console.log('\nAFTER SELECT, bridge says active = idx' + (after ? after.index : '?') + ' ' + JSON.stringify(((after && after.label) || '').slice(0, 34)))
  console.log('  bridge-active === target?', after && after.label === target.label ? 'YES' : 'NO (bridge/selection mismatch!)')

  // paste marker (NO submit)
  await ide.clipboard_write({ text: marker })
  await sleep(150)
  await applescript.keystroke({ key: 'v', cmd: true })
  const doSubmit = process.argv[4] === 'submit'
  if (doSubmit) {
    await sleep(300)
    // re-read active RIGHT BEFORE Return to catch a select->submit race
    const justBefore = (await ci.listChatTabs()).find(t => t.isActive)
    console.log('  just before Return, bridge active = idx' + (justBefore ? justBefore.index : '?') + ' ' + JSON.stringify(((justBefore && justBefore.label) || '').slice(0, 30)))
    await applescript.keystroke({ key: 36 })
    console.log('\nSUBMITTED (pressed Return). >>> Tate: which chat did "' + marker + '" actually SEND in? <<<')
  } else {
    console.log('\nPASTED (no submit). >>> Tate: which chat has "' + marker + '" in its input box? <<<')
  }
  process.exit(0)
})().catch(e => { console.error('ERR', e.message); process.exit(1) })
