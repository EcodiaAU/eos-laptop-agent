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
const injectLock = require('./inject-lock')

const CC_VIEW_TYPE = 'mainThreadWebview-claudeVSCodePanel'
const GENERIC_LABEL_RE = /^(claude code|new chat|cursor|chat|untitled)?$/i

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
    // groupActive: is THIS editor group the focused one? VS Code marks isActive on
    // the active tab of EVERY group (per-group), and marks exactly one GROUP as
    // active. The truly-focused tab is the active tab of the active group, so we
    // carry groupActive to disambiguate (see verifyActiveIsTarget).
    const groupActive = g.isActive === true
    const gtabs = g.tabs || []
    gtabs.forEach((t, i) => {
      const vt = t.viewType || (t.input && t.input.viewType) || null
      if (vt !== CC_VIEW_TYPE) return
      tabs.push({
        label: t.label,
        viewColumn: viewColumn != null ? viewColumn : 1,
        index: typeof t.index === 'number' ? t.index : i,
        isActive: t.isActive === true || t.active === true,
        groupActive,
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
 * verifyActiveIsTarget(label, viewColumn, index) -> {ok, active_label}. Reads the
 * LIVE active CC tab and confirms it is the intended target. This is the guard
 * that makes a misroute impossible: after we select a tab, we do NOT trust that
 * the select took - we read back which tab is actually active and only paste if
 * it is the one we meant. A non-generic label is the strong key (survives an
 * index shift); a generic/absent label falls back to the exact (viewColumn,index)
 * position. Any mismatch means focus is on the wrong chat - the caller aborts
 * rather than blind-pasting into it.
 */
async function verifyActiveIsTarget(label, viewColumn, index) {
  let tabs
  try { tabs = await listChatTabs() } catch (e) { return { ok: false, active_label: null, reason: 'bridge_unreachable' } }
  // The focused tab is the active tab OF THE ACTIVE GROUP. With >1 editor group
  // each group carries its own active tab, so a bare find(isActive) can return a
  // BACKGROUND group's active tab and read a false "active" - the bridge-active-
  // vs-reality split. Prefer (isActive && groupActive); fall back to plain
  // isActive only if the bridge did not mark group focus (older bridge).
  const active = tabs.find((t) => t.isActive && t.groupActive) || tabs.find((t) => t.isActive)
  if (!active) return { ok: false, active_label: null, reason: 'no_active_tab' }
  const generic = GENERIC_LABEL_RE.test(String(label || '').trim())
  if (!generic) {
    return { ok: active.label === label, active_label: active.label }
  }
  return { ok: active.viewColumn === viewColumn && active.index === index, active_label: active.label }
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

  // NOTE (2026-08-21): the extension's ide.chat_send_message primitive was tried
  // as a session-addressed delivery path. It reports opened_tab + submit_command_ok
  // but does NOT actually land a turn (transcript-verified: 0 turns delivered; its
  // opened_tab is an echo, via:"active_fallback"). It is NOT used for delivery.
  // The real, transcript-PROVEN delivery is the position chain below, with the ONE
  // fix that matters: select the tab with the GENERIC workbench.action.
  // openEditorAtIndex + an index ARG (works at ANY index), not the numbered
  // openEditorAtIndex<N> (which only exists for N=1..9, so a chat past the 9th tab
  // was never selected and the paste misfired into the active tab - the wrong-chat
  // bug). Plus verify-active-is-target before pasting. Doctrine:
  // coord-deliver-by-session-not-editor-index-2026-08-21.
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

  // Cross-process mutex so a coord push and a routed text (or a worker inject)
  // cannot fight over the one focus/clipboard. This is the sound half of the
  // 2026-08-03 hardening and it stays. If we cannot get the lock, we do NOT
  // inject - the caller keeps the message in the durable inbox.
  const lock = await injectLock.acquire({ who: 'chat-inject', timeoutMs: opts.lockTimeoutMs || 9000 })
  if (!lock.ok) {
    return { ok: false, reason: 'inject_lock_' + (lock.reason || 'busy'), held_by: lock.held_by }
  }

  try {
    // 1. Clipboard (focusless). Skipped in submitOnly mode. Set once.
    if (!submitOnly) {
      await ide.clipboard_write({ text: String(text) })
      steps.push('clipboard')
    }

    // 2. Select the target tab, focus its input, bring VS Code forward, settle.
    // This position chain is THE delivery path (transcript-proven). Two fixes vs
    // the historical chain:
    //   (a) INDEX BUG: the numbered workbench.action.openEditorAtIndex<N> command
    //       only exists for N=1..9, so a tab past the 9th was never selected and
    //       the paste misfired into the active tab (the wrong-chat bug). Use the
    //       numbered command for index<9 and the GENERIC openEditorAtIndex with an
    //       index arg for index>=9, which selects any position (verified: it makes
    //       a tab at index 9 the active tab).
    //   (b) VERIFY-GATE: after selecting, read back the active tab and only paste
    //       if it IS the target (for a non-generic label). A mismatch aborts to the
    //       inbox rather than blind-pasting into the wrong chat (proven: a wrong
    //       target aborts and pastes nothing). This restores the verify the
    //       2026-08-03 change removed; delivery is now transcript-verified so a
    //       false green cannot hide. Doctrine: coord-deliver-by-session-not-editor-index-2026-08-21.
    const fg = focusGroupCmd(viewColumn)
    if (fg) { await ide.command({ cmd: fg }).catch(() => {}); await sleep(150) }
    if (index >= 0 && index < 9) {
      await ide.command({ cmd: 'workbench.action.openEditorAtIndex' + (index + 1) }).catch(() => {})
      await sleep(150)
    } else if (index >= 9 && index < 200) {
      // generic command, index arg (proven to accept an arg on this bridge)
      await ide.command({ cmd: 'workbench.action.openEditorAtIndex', args: [index] }).catch(() => {})
      await sleep(150)
    }
    // Focus the ACTIVE editor group (the tab openEditorAtIndex just selected), NOT
    // the global claude-vscode.focus. claude-vscode.focus focuses a FIXED Claude
    // view (its siblings are primaryEditor.open / editor.openLast), so after we
    // select tab N by index it yanks focus to that one fixed chat - every paste
    // then lands in the SAME wrong chat (proven 2026-08-22: 6 route-test markers
    // all piled into one input box). focusActiveEditorGroup keeps focus on the
    // just-selected target. (The dispatcher keeps claude-vscode.focus because a
    // freshly-opened tab IS the primary/last Claude editor - they coincide there.)
    await ide.command({ cmd: 'workbench.action.focusActiveEditorGroup' }).catch(() => {})
    steps.push('select')
    await applescript.activate_app({ app: 'Visual Studio Code' }).catch(() => {})
    steps.push('activate')
    await sleep(settleMs)

    // 2b. VERIFY the selected tab is the target before pasting (non-generic label
    // only; a generic/absent label cannot be verified and falls through - those
    // should be delivered by session, not reach here). Abort-to-inbox on mismatch.
    if (!GENERIC_LABEL_RE.test(String(resolvedLabel || '').trim())) {
      const v = await verifyActiveIsTarget(resolvedLabel, viewColumn, index)
      if (!v.ok) {
        return { ok: false, reason: 'target_not_focused_after_select', steps, target: resolvedLabel, active_label: v.active_label }
      }
      steps.push('verified')
    }

    // 3. Paste (Cmd+V). Skipped in submitOnly mode.
    if (!submitOnly) {
      const pasteRes = await applescript.keystroke({ key: 'v', cmd: true })
      steps.push('paste')
      if (pasteRes && pasteRes.ok === false) {
        return { ok: false, reason: 'paste_keystroke_failed', steps, detail: pasteRes }
      }
      await sleep(300)
    }

    // 4. Submit (Return = key code 36).
    const submitRes = await applescript.keystroke({ key: 36 })
    steps.push('submit')
    if (submitRes && submitRes.ok === false) {
      return { ok: false, reason: 'submit_keystroke_failed', steps, detail: submitRes }
    }

    return { ok: true, label: resolvedLabel, viewColumn, index, steps }
  } catch (e) {
    return { ok: false, reason: 'inject_threw', error: e.message, steps }
  } finally {
    injectLock.release(lock.token)
  }
}

module.exports = { injectTurn, listChatTabs, resolveTabByLabel, verifyActiveIsTarget, CC_VIEW_TYPE }
