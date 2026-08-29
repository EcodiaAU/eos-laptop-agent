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
        // The bridge's stable per-tab id (ttab_...), minted and reconciled by
        // ide-bridge.assignStableTabIds so it survives a retitle AND a reorder.
        // It is the only handle in this object that a recurring cron cannot
        // collide: label, index and any fingerprint of the brief are identical
        // across two fires of one scheduled row. null on a pre-2026-08-23 bridge.
        tabId: t.tabId || null,
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

  // NOTE (2026-08-21, MECHANISM ADDED 2026-08-29): the extension's
  // ide.chat_send_message primitive was tried as a session-addressed delivery
  // path. It reports opened_tab + submit_command_ok but does NOT actually land a
  // turn (transcript-verified: 0 turns delivered; its opened_tab is an echo,
  // via:"active_fallback"). It is NOT used for delivery.
  //
  // WHY, so pass N+1 stops re-deriving it. Re-probed live 2026-08-29 (lane N1,
  // worker 60565ca7) against the CURRENT bridge and the CURRENT extension, and
  // the answer is not a bridge defect: THERE IS NO SUBMIT PRIMITIVE TO CALL.
  //   - GET /ide/commands enumerated 3497 registered commands. Every claude-vscode.*
  //     entry opens, focuses, blurs, or inserts an @-mention. Not one sends a
  //     message into an existing session. Identical in 2.1.241 and 2.1.251.
  //   - editor.open(session, prompt) PREFILLS the input and stops there; a
  //     corpus-wide marker grep after a live call found zero user-role turns.
  //   - workbench.action.chat.openSessionWithPrompt.claude-code is contributed by
  //     VS Code's BUILT-IN copilot extension, not by Anthropic's. It addresses
  //     claude-code:/<sessionId> and drives Copilot's own Claude runtime, a
  //     different surface from these webview tabs. Called correctly it hung past
  //     2 minutes and delivered nothing.
  //   - The vscode://anthropic.claude-code/open?session=&prompt= URI handler is
  //     literally executeCommand("claude-vscode.primaryEditor.open", session,
  //     prompt), so it inherits the same behaviour.
  // Each chat tab is a claude child process rendered in the ANTHROPIC extension's
  // webview; our bridge shares the extension host but cannot postMessage into
  // another extension's webview iframe, which is why workbench.action.chat.submit
  // (Copilot's surface) leaves submit_command_ok false. The keystroke below is not
  // a shortcut anyone took, it is the only submit that exists.
  // Doctrine: coord-no-api-submit-primitive-2026-08-29.
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

    // 2. Bring VS Code forward, THEN select the target tab. Order is load-bearing
    // (3 fixes vs the historical chain, all 2026-08-22 proven by step-by-step diag):
    //   (a) ACTIVATE FIRST: applescript.activate_app ("tell VS Code to activate")
    //       RESETS the active editor to the FIRST tab. The old chain selected the
    //       target and THEN activated, so activate undid the select and every paste
    //       landed in the first tab (Tate: "zapping to the first tab"). Activate
    //       BEFORE selecting so the select is the LAST focus action and the target
    //       stays focused (diag: activate->idx0, then select->target, paste lands
    //       on target).
    //   (b) INDEX BUG: numbered workbench.action.openEditorAtIndex<N> only exists
    //       for N=1..9. Use it for index<9 and the GENERIC openEditorAtIndex with an
    //       index arg for index>=9 (selects any position).
    //   (c) focusActiveEditorGroup (the just-selected tab), NOT global
    //       claude-vscode.focus - that focuses a FIXED Claude view and would land
    //       paste in one fixed chat.
    // Then VERIFY-GATE: read back the active tab and only paste if it IS the target
    // (non-generic label); a mismatch aborts to the inbox instead of misrouting.
    // Doctrine: coord-deliver-by-session-not-editor-index-2026-08-21.
    await applescript.activate_app({ app: 'Visual Studio Code' }).catch(() => {})
    steps.push('activate')
    await sleep(400)
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
    await ide.command({ cmd: 'workbench.action.focusActiveEditorGroup' }).catch(() => {})
    steps.push('select')
    await sleep(settleMs)

    // 2b. VERIFY the selected tab is the target before pasting (non-generic label
    // only; a generic/absent label cannot be verified and falls through - those
    // should be delivered by session, not reach here). Abort-to-inbox on mismatch.
    if (!GENERIC_LABEL_RE.test(String(resolvedLabel || '').trim())) {
      // RE-RESOLVE AND RETRY ON MISMATCH (2026-08-29, lane W1). The guard below
      // is unchanged and still absolute: nothing pastes until the active tab IS
      // the target. What changed is that a mismatch is no longer terminal on the
      // first try, because on this fleet the commonest cause is not a wrong
      // target, it is TAB CHURN between resolve and select. The scheduler opens
      // worker tabs continuously, a freshly-opened Claude Code tab is titled
      // "Claude Code" until its first turn names it, and its arrival shifts every
      // index after it.
      //
      // MEASURED 2026-08-29, two injects at the same target 90s apart: the first
      // refused with active_label "Claude Code" (a tab that did not exist in the
      // list 20s later), the second landed on its first attempt, steps
      // clipboard/activate/select/verified/paste/submit. Same target, same code,
      // different moment. A single-shot select therefore refuses for reasons that
      // have nothing to do with correctness, and a refused wake is a wake that
      // did not happen.
      //
      // Each retry re-reads the LIVE tab list rather than reusing the stale
      // position, so it corrects for the shift instead of retrying into it.
      let verified = false
      let lastActive = null
      for (let attempt = 0; attempt < 3 && !verified; attempt++) {
        if (attempt > 0) {
          let rr = { tab: null, ambiguous: false }
          try { rr = await resolveTabByLabel(resolvedLabel) } catch (e) { rr = { tab: null, ambiguous: false } }
          if (!rr.tab) {
            // The target is genuinely gone or ambiguous now. Refuse; do not fall
            // back to the stale position, which is how a paste lands in whatever
            // took that index.
            return { ok: false, reason: rr.ambiguous ? 'ambiguous_label_on_retry' : 'target_tab_gone_on_retry', steps, target: resolvedLabel, attempts: attempt + 1 }
          }
          viewColumn = rr.tab.viewColumn
          index = rr.tab.index
          const fg2 = focusGroupCmd(viewColumn)
          if (fg2) { await ide.command({ cmd: fg2 }).catch(() => {}); await sleep(150) }
          if (index >= 0 && index < 9) {
            await ide.command({ cmd: 'workbench.action.openEditorAtIndex' + (index + 1) }).catch(() => {})
          } else if (index >= 9 && index < 200) {
            await ide.command({ cmd: 'workbench.action.openEditorAtIndex', args: [index] }).catch(() => {})
          }
          await sleep(150)
          await ide.command({ cmd: 'workbench.action.focusActiveEditorGroup' }).catch(() => {})
          steps.push('reselect')
          await sleep(settleMs)
        }
        const v = await verifyActiveIsTarget(resolvedLabel, viewColumn, index)
        lastActive = v.active_label
        if (v.ok) { verified = true }
      }
      if (!verified) {
        return { ok: false, reason: 'target_not_focused_after_select', steps, target: resolvedLabel, active_label: lastActive, attempts: 3 }
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
