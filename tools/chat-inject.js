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
  const active = tabs.find((t) => t.isActive)
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

  // PREFERRED PATH (2026-08-21): deliver by Claude Code SESSION id via the
  // extension's own bridge primitive (/ide/chat/send_message). It selects the
  // target chat by session, so it works for ANY tab position. The old path
  // selected the tab with workbench.action.openEditorAtIndex<N> - but that command
  // only exists for N=1..9, so a chat past the 9th tab was NEVER selected and the
  // paste misfired into whatever tab was active (the wrong-chat bug Tate hit with
  // many tabs open). And the post-select focus-verify had been removed, so nothing
  // caught it. chat_send_message needs no index and no paste. It still focuses the
  // tab (extension behaviour) so we keep the inject lock. Proven 4/4 session->tab.
  // Doctrine: coord-deliver-by-session-not-editor-index-2026-08-21.
  const hasPos0 = opts.viewColumn != null && opts.index != null
  if (opts.session) {
    const lock = await injectLock.acquire({ who: 'chat-inject-session', timeoutMs: opts.lockTimeoutMs || 9000 })
    if (!lock.ok) return { ok: false, reason: 'inject_lock_' + (lock.reason || 'busy'), held_by: lock.held_by }
    try {
      let r
      try { r = await ide.chat_send_message({ session: opts.session, prompt: String(text || ''), submit: opts.submitOnly !== true }) }
      catch (e) { r = { ok: false, error: e.message } }
      const ot = (r && r.opened_tab) || {}
      // Success = the bridge opened a tab for this session and (unless submitOnly)
      // the submit command fired. Guard against a wrong-tab open: if the bridge
      // reports an opened_tab whose label contradicts a non-generic target label,
      // treat as failure and fall through to the position-based chain.
      const labelOk = !opts.label || GENERIC_LABEL_RE.test(String(opts.label).trim()) || !ot.label || ot.label === opts.label
      const submitOk = opts.submitOnly === true || r.submit_command_ok !== false
      if (r && r.ok && r.open_command_ok !== false && labelOk && submitOk) {
        return { ok: true, label: ot.label || opts.label || null, viewColumn: ot.viewColumn, index: ot.index, via: 'chat_send_message', session: opts.session }
      }
      // session delivery did not confirm; fall back to the GUI chain if we have a
      // position, else report the failure (message stays in the durable inbox).
      if (!hasPos0) return { ok: false, reason: 'chat_send_message_unconfirmed', detail: r }
    } finally {
      injectLock.release(lock.token)
    }
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
    // This GUI-paste chain is now the FALLBACK only (anonymous label-only tabs);
    // session-addressed / worker / anchored targets deliver via chat_send_message
    // above. Two fixes vs the historical chain:
    //   (a) INDEX BUG: the numbered workbench.action.openEditorAtIndex<N> command
    //       only exists for N=1..9, so a tab past the 9th was never selected and
    //       the paste misfired into the active tab (the wrong-chat bug). Use the
    //       numbered command for index<9 and the GENERIC openEditorAtIndex with an
    //       index arg for index>=9, which handles any position.
    //   (b) VERIFY-GATE: after selecting, read back the active tab and only paste
    //       if it IS the target (for a non-generic label). A mismatch aborts to the
    //       inbox rather than blind-pasting into the wrong chat. The 2026-08-03
    //       "verify aborts every away inject" concern applied to the OLD verify that
    //       gated on foreground focus; here the primary path is session delivery, so
    //       gating the rare fallback on label match is the safe choice (queue beats
    //       misroute). Doctrine: coord-deliver-by-session-not-editor-index-2026-08-21.
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
    await ide.command({ cmd: 'claude-vscode.focus' }).catch(() => {})
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
