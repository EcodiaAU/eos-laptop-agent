'use strict'
// Deterministic state-machine proof with injected notify. Exercises request->approve->wake
// and request->escalate(Helen)->expire. Cleans up every vault_approvals row + armed task.
const assert = require('assert')
const { request, approve, escalate, expire, markHandled } = require('./vault-approval.js')
const lib = require('/Users/ecodia/.code/ecodiaos/backend/continuity/lib.cjs')
const db = lib.db()

const notes = []
const notify = async (target, msg) => { notes.push({ target, msg }) }

async function armedTask(id, kind) {
  const r = await db`SELECT name, prompt, run_at FROM os_scheduled_tasks WHERE name = ${'cowork.vault-' + kind + '.' + id}`
  return r[0]
}

;(async () => {
  const ids = []
  try {
    // ---- Path 1: request -> approve -> wake ----
    // replyTo a scratch topic so approve()'s inject does NOT paste into the live conductor.
    const r1 = await request(db, { service: 'bank', action: 'read statement', urgency: 'quick', continuation: 'Pull the bank statement and update the ledger, then SMS Tate the balance.', replyTo: 'chat.vault-test.inbox' }, notify)
    ids.push(r1.id)
    let row = (await db`SELECT status, primary_deadline, reply_to FROM public.vault_approvals WHERE id=${r1.id}`)[0]
    assert.strictEqual(row.status, 'pending', 'request creates a pending approval')
    assert.strictEqual(row.reply_to, 'chat.vault-test.inbox', 'request records where to reply (the requesting session)')
    assert.ok(notes.find(n => n.target === 'tate'), 'primary approver (Tate) was notified')
    const esc = await armedTask(r1.id, 'escalate')
    assert.ok(esc, 'an escalation timer was armed at the deadline')
    // approve it (as if the phone posted the signed result)
    const ap = await approve(db, r1.id, 'tate')
    assert.ok(ap.wake_at, 'approval arms a deadman wake')
    assert.strictEqual(typeof ap.injected, 'boolean', 'approve reports whether it injected into the running session')
    row = (await db`SELECT status, approver FROM public.vault_approvals WHERE id=${r1.id}`)[0]
    assert.strictEqual(row.status, 'approved', 'approval marks approved')
    const wake = await armedTask(r1.id, 'wake')
    assert.ok(wake, 'a deadman wake task was armed')
    assert.ok(wake.prompt.includes('update the ledger'), 'the wake carries the task continuation so I resume it')
    assert.ok(wake.prompt.includes('HANDLED'), 'the deadman first checks whether the live session already handled it')
    // the live session marks it handled -> the deadman wake stands down (is cancelled)
    await markHandled(db, r1.id)
    const handledRow = (await db`SELECT handled_in_session FROM public.vault_approvals WHERE id=${r1.id}`)[0]
    assert.strictEqual(handledRow.handled_in_session, true, 'markHandled sets the flag')
    const wakeAfter = (await db`SELECT status FROM os_scheduled_tasks WHERE name=${'cowork.vault-wake.' + r1.id}`)[0]
    assert.strictEqual(wakeAfter.status, 'cancelled', 'the deadman wake is cancelled once the live session handled it')

    // ---- Path 2: request -> escalate(Helen) -> expire ----
    const r2 = await request(db, { service: 'tate-google', action: 'SSO login', urgency: 'normal', continuation: 'Finish the SSO login flow.' }, notify)
    ids.push(r2.id)
    notes.length = 0
    const es = await escalate(db, r2.id, notify)
    assert.strictEqual(es.escalated_to, 'helen', 'unactioned request escalates to the fallback approver')
    assert.ok(notes.find(n => n.target === 'helen'), 'Helen was notified on escalation')
    row = (await db`SELECT status, fallback_deadline FROM public.vault_approvals WHERE id=${r2.id}`)[0]
    assert.strictEqual(row.status, 'escalated', 'status is escalated')
    assert.ok(row.fallback_deadline, 'a fallback deadline was set')
    assert.ok(await armedTask(r2.id, 'expire'), 'an expire timer was armed')
    // nobody approves -> expire
    notes.length = 0
    const ex = await expire(db, r2.id, notify)
    assert.strictEqual(ex.expired, true, 'lapsed request expires')
    assert.ok(notes.find(n => n.target === 'tate' && /did NOT proceed|lapsed/.test(n.msg)), 'Tate told it lapsed and I did NOT proceed')

    // ---- Guard: escalate must NOT fire if already approved ----
    const r3 = await request(db, { service: 'x', action: 'y', urgency: 'quick', continuation: 'z', replyTo: 'chat.vault-test.inbox' }, notify)
    ids.push(r3.id)
    await approve(db, r3.id, 'tate')
    const noop = await escalate(db, r3.id, notify)
    assert.strictEqual(noop.noop, 'approved', 'escalation is a noop once already approved (no double-notify Helen)')

    console.log('vault-approval: 15/15 - request notifies+arms escalation, approve arms wake w/ continuation, escalate->Helen, expire, approved-guard')
  } finally {
    for (const id of ids) {
      await db`DELETE FROM public.vault_approvals WHERE id = ${id}`
      await db`DELETE FROM os_scheduled_tasks WHERE name LIKE ${'cowork.vault-%.' + id}`
    }
  }
  process.exit(0)
})().catch(e => { console.error('FAIL', e.message); process.exit(1) })
