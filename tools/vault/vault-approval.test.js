'use strict'
// Deterministic state-machine proof with injected notify. Exercises request->approve->wake
// and request->escalate(Helen)->expire. Cleans up every vault_approvals row + armed task.
const assert = require('assert')
const { request, approve, escalate, expire } = require('./vault-approval.js')
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
    const r1 = await request(db, { service: 'bank', action: 'read statement', urgency: 'quick', continuation: 'Pull the bank statement and update the ledger, then SMS Tate the balance.' }, notify)
    ids.push(r1.id)
    let row = (await db`SELECT status, primary_deadline FROM public.vault_approvals WHERE id=${r1.id}`)[0]
    assert.strictEqual(row.status, 'pending', 'request creates a pending approval')
    assert.ok(notes.find(n => n.target === 'tate'), 'primary approver (Tate) was notified')
    const esc = await armedTask(r1.id, 'escalate')
    assert.ok(esc, 'an escalation timer was armed at the deadline')
    // approve it (as if the phone posted the signed result)
    const ap = await approve(db, r1.id, 'tate')
    assert.ok(ap.wake_at, 'approval arms a wake')
    row = (await db`SELECT status, approver FROM public.vault_approvals WHERE id=${r1.id}`)[0]
    assert.strictEqual(row.status, 'approved', 'approval marks approved')
    const wake = await armedTask(r1.id, 'wake')
    assert.ok(wake, 'a wake task was armed')
    assert.ok(wake.prompt.includes('update the ledger'), 'the wake carries the task continuation so I resume it')
    assert.ok(wake.prompt.includes('--pull'), 'the wake tells me to pull the returned data first')

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
    const r3 = await request(db, { service: 'x', action: 'y', urgency: 'quick', continuation: 'z' }, notify)
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
