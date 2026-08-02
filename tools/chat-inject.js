'use strict'

/**
 * chat-inject.js - land a text as a NEW turn in an EXISTING Claude Code chat tab,
 * from INSIDE the laptop-agent process.
 *
 * This is the coord-local twin of backend/imessage-agent/inject-turn.js. That
 * module drives the SAME position-addressed focus-based chain but reaches the
 * ide.* / applescript.* tools over HTTP (it runs in the separate imessage-agent
 * process). coord.js runs INSIDE the laptop-agent, where those tool modules are
 * local requires - so this module calls them directly (no self-HTTP hop, no
 * cross-repo require, no token).
 *
 * The chain is the exact one the Mac dispatcher uses to SUBMIT a freshly-opened
 * tab, minus the open (the target tab is already living):
 *
 *   1. ide.clipboard_write({text})           (focusless; sets the OS clipboard)
 *   2. ide.command focus<Nth>EditorGroup     (focusless; raise the tab's group)
 *   3. ide.command openEditorAtIndex<K>       (focusless; make the tab active, 1-based)
 *   4. ide.command claude-vscode.focus        (focus that chat's input box)
 *   5. applescript.activate_app VS Code       (gentle Apple-Events activate)
 *   6. settle                                 (let populate/focus land)
 *   7. applescript Cmd+V                       (paste the text into the input)
 *   8. settle
 *   9. applescript Return                      (submit -> the tab takes a turn)
 *
 * Focusless up to step 5; steps 5-9 are focus-stealing (VS Code comes forward
 * and the target tab is selected). That is why chat-to-chat push is a night /
 * away-mode capability by default (see coord.js COORD_CHAT_INJECT gating).
 *
 * Tab resolution is done against LIVE bridge tabs at call time (match by label),
 * NOT a stored index, so it survives Tate reordering / closing tabs. Duplicated
 * / generic labels are AMBIGUOUS and refuse rather than guess (guessing once
 * misfired a submit into the wrong "Claude Code" tab).
 *
 * Faithful port of inject-turn.js (incident-hardened): ambiguity guard, drift
 * re-resolve, submitOnly mode. Keep the two in lockstep when either changes.
 */

const ide = require('./ide')
const applescript = require('./applescript')

const CC_VIEW_TYPE = 'mainThreadWebview-claudeVSCodePanel'

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function focusGroupCmd(viewColumn) {
  switch (viewColumn) {
    case 1:
      return 'workbench.action.focusFirstEditorGroup'
    case 2:
      return 'workbench.action.focusSecondEditorGroup'
    case 3:
      return 'workbench.action.focusThirdEditorGroup'
    case 4:
      return 'workbench.action.focusFourthEditorGroup'
    case 5:
      return 'workbench.action.focusFifthEditorGroup'
    default:
      return null
  }
}

/**
 * listChatTabs() -> [{label, viewColumn, index, isActive, viewType}] for every
 * open CC chat panel, across editor groups, flattened. Index is 0-based WITHIN
 * its editor group (matches VS Code's openEditorAtIndex semantics, which are
 * per-active-group). Throws if the bridge is unreachable.
 */
async function listChatTabs() {
  const res = await ide.tabs({})
  const groups = (res && res.groups) || (res && res.result && res.result.groups) || []
  const tabs = []
  for (const g of groups) {
    const viewColumn = g.viewColumn
    const gtabs = g.tabs || []
    gtabs.forEach((t, i) => {
      const vt = t.viewType || (t.input && t.input.viewType) || null
      if (vt !== CC_VIEW_TYPE) return
      tabs.push({
        label: t.label,
        viewColumn: viewColumn != null ? viewColumn : 1,
        index: typeof t.index === 'number' ? t.index : i,
        isActive: t.isActive === true || t.active === true,
        viewType: vt,
      })
    })
  }
  return tabs
}

/**
 * resolveTabByLabel(label) -> {tab, ambiguous}. Re-reads fresh so indices are
 * current. A UNIQUE exact-label match resolves; a duplicated label (e.g. the
 * generic "Claude Code") is AMBIGUOUS - the caller must trust the position it
 * was handed rather than guess, because guessing the wrong same-named tab
 * silently misfires into an unrelated chat.
 */
async function resolveTabByLabel(label) {
  const tabs = await listChatTabs()
  const exact = tabs.filter((t) => t.label === label)
  if (exact.length === 1) return { tab: exact[0], ambiguous: false }
  if (exact.length > 1) return { tab: null, ambiguous: true }
  const pref = tabs.filter((t) => label && (t.label || '').startsWith(String(label).slice(0, 20)))
  if (pref.length === 1) return { tab: pref[0], ambiguous: false }
  if (pref.length > 1) return { tab: null, ambiguous: true }
  return { tab: null, ambiguous: false }
}

/**
 * injectTurn({label?, viewColumn, index, text, settleMs?, submitOnly?}) -> {ok, ...}
 *
 * Prefer passing `label`: the target tab is re-resolved against live bridge
 * state immediately before firing so a shifted index does not misfire into the
 * wrong chat. viewColumn/index are used as a fallback when label is omitted or
 * unresolvable.
 */
async function injectTurn(opts) {
  opts = opts || {}
  const text = opts.text
  if (opts.submitOnly !== true && (!text || !String(text).trim())) {
    return { ok: false, reason: 'empty_text' }
  }

  let viewColumn = opts.viewColumn
  let index = opts.index
  let resolvedLabel = opts.label || null

  // Drift-guard: re-resolve position from the LIVE tab list by label so a tab
  // Tate reordered since classification still gets the right turn. Only a
  // UNIQUE label match overrides the provided position; a duplicated/ambiguous
  // label falls back to the position we were handed.
  const hasPosition = opts.viewColumn != null && opts.index != null
  if (opts.label) {
    let r = { tab: null, ambiguous: false }
    try {
      r = await resolveTabByLabel(opts.label)
    } catch (e) {
      if (!hasPosition) return { ok: false, reason: 'bridge_unreachable', error: e.message }
    }
    if (r.tab) {
      viewColumn = r.tab.viewColumn
      index = r.tab.index
      resolvedLabel = r.tab.label
    } else if (!hasPosition) {
      return { ok: false, reason: r.ambiguous ? 'ambiguous_label_no_position' : 'target_tab_gone', label: opts.label }
    }
    // else: ambiguous/re-titled label but we have a trusted position -> use it.
  }
  if (viewColumn == null || index == null) {
    return { ok: false, reason: 'no_target_position' }
  }

  const settleMs = opts.settleMs || 1200
  const submitOnly = opts.submitOnly === true
  const steps = []

  try {
    // 1. Clipboard (focusless). Skipped in submitOnly mode.
    if (!submitOnly) {
      await ide.clipboard_write({ text: String(text) })
      steps.push('clipboard')
    }

    // 2. Raise the editor group.
    const fg = focusGroupCmd(viewColumn)
    if (fg) {
      await ide.command({ cmd: fg }).catch(() => {})
      steps.push('focus_group')
      await sleep(150)
    }

    // 3. Activate the tab by index (1-based over the active group).
    if (index >= 0 && index < 40) {
      await ide.command({ cmd: 'workbench.action.openEditorAtIndex' + (index + 1) }).catch(() => {})
      steps.push('open_at_index')
      await sleep(150)
    }

    // 4. Focus the CC chat input.
    await ide.command({ cmd: 'claude-vscode.focus' }).catch(() => {})
    steps.push('cc_focus')

    // 5. Bring VS Code forward (Apple Events activate; gentle).
    await applescript.activate_app({ app: 'Visual Studio Code' }).catch(() => {})
    steps.push('activate')

    // 6. Settle for populate/focus to land.
    await sleep(settleMs)

    // 7. Paste (Cmd+V). Skipped in submitOnly mode.
    if (!submitOnly) {
      const pasteRes = await applescript.keystroke({ key: 'v', cmd: true })
      steps.push('paste')
      if (pasteRes && pasteRes.ok === false) {
        return { ok: false, reason: 'paste_keystroke_failed', steps, detail: pasteRes }
      }
      await sleep(350)
    }

    // 8. Submit (Return = key code 36; a bare 'return' string types the word).
    const submitRes = await applescript.keystroke({ key: 36 })
    steps.push('submit')
    if (submitRes && submitRes.ok === false) {
      return { ok: false, reason: 'submit_keystroke_failed', steps, detail: submitRes }
    }

    return { ok: true, label: resolvedLabel, viewColumn, index, steps }
  } catch (e) {
    return { ok: false, reason: 'inject_threw', error: e.message, steps }
  }
}

module.exports = { injectTurn, listChatTabs, resolveTabByLabel, CC_VIEW_TYPE }
