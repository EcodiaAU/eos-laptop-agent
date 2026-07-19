'use strict'
// tools/vault/vault-approval.js - the approval + wake + fallback state machine.
//
// The problem Tate named: I fire an approval request, then go to sleep. He approves HOURS
// later. If nothing re-awakens me, the task dies and I never even know he approved. And if
// he can't get to it in time, someone else (his mum Helen) must be able to approve.
//
// So every request:
//   1. records a pending approval with an urgency-based primary deadline,
//   2. notifies the primary approver (Tate),
//   3. arms a ONE-SHOT escalation timer at the deadline (fallback -> Helen),
// and when ANY approver approves (the phone posts the signed result, the puller calls
// approve()), it arms a ONE-SHOT WAKE that re-opens the conductor with the task's
// continuation, so I resume the instant the approval lands instead of stalling.
//
// Wake + escalation are one-shot os_scheduled_tasks rows (next_run_at = run_at, per the
// direct-insert trap). Notifications are injected so the state machine is deterministically
// testable; the CLI wires real SMS.
const lib = require('/Users/ecodia/.code/ecodiaos/backend/continuity/lib.cjs')

const URGENCY_MIN = { quick: 15, normal: 120, low: 720 }   // primary window, minutes
const APPROVAL_TOOL = '/Users/ecodia/.code/eos-laptop-agent/tools/vault/vault-approval.js'

function deadlineFrom(now, urgency) {
  const mins = URGENCY_MIN[urgency] || URGENCY_MIN.normal
  return new Date(now.getTime() + mins * 60_000)
}

// Arm a one-shot scheduled task the Mac laptop-agent will lease + open as a fresh CC tab.
async function armTask(db, name, prompt, whenIso, priority) {
  await db`INSERT INTO os_scheduled_tasks (type, name, prompt, run_at, next_run_at, status, max_runs, session_mode, priority)
           VALUES ('delayed', ${name}, ${prompt}, ${whenIso}, ${whenIso}, 'active', 1, 'inherit_fork', ${priority || 3})`
}

async function request(db, { service, action, urgency = 'normal', continuation }, notify, now = new Date()) {
  if (!service || !action || !continuation) throw new Error('request needs {service, action, continuation}')
  const primary = deadlineFrom(now, urgency)
  const row = (await db`INSERT INTO public.vault_approvals (service, action, urgency, continuation, primary_deadline)
                        VALUES (${service}, ${action}, ${urgency}, ${continuation}, ${primary.toISOString()}) RETURNING id`)[0]
  await notify('tate', `Approval needed: ${action} for ${service} (${urgency}). Open Friend to approve. ref ${row.id.slice(0, 8)}`)
  // arm the escalation-to-Helen timer at the primary deadline
  await armTask(db, `cowork.vault-escalate.${row.id}`,
    `A vault approval may be overdue. Run: node ${APPROVAL_TOOL} escalate ${row.id}  then follow its output (it notifies the fallback approver Helen only if still pending).`,
    primary.toISOString(), 2)
  return { id: row.id, primary_deadline: primary.toISOString() }
}

// Called by the puller when a signed approval result lands. Marks approved + arms the WAKE.
async function approve(db, requestId, by = 'tate', now = new Date()) {
  const rows = await db`SELECT id, service, action, continuation, status FROM public.vault_approvals WHERE id = ${requestId}`
  if (!rows.length) throw new Error('no such approval ' + requestId)
  const a = rows[0]
  if (a.status === 'approved') return { id: a.id, already: true }
  await db`UPDATE public.vault_approvals SET status='approved', approver=${by}, resolved_at=now() WHERE id=${requestId}`
  // WAKE: re-open the conductor ~1 min from now with the task's continuation, so I resume.
  const wakeAt = new Date(now.getTime() + 60_000).toISOString()
  const PULL_TOOL = APPROVAL_TOOL.replace('vault-approval.js', 'vault-pull.js')
  await armTask(db, `cowork.vault-wake.${a.id}`,
    `A vault approval you were waiting on was APPROVED by ${by} (${a.action} for ${a.service}). First run: node ${PULL_TOOL}  to apply the signed data the phone returned. Then CONTINUE this task:\n\n${a.continuation}`,
    wakeAt, 1)
  return { id: a.id, approved_by: by, wake_at: wakeAt }
}

// Fired by the escalation timer at the primary deadline. Only acts if still pending.
async function escalate(db, requestId, notify, now = new Date()) {
  const rows = await db`SELECT id, service, action, urgency, status FROM public.vault_approvals WHERE id = ${requestId}`
  if (!rows.length) throw new Error('no such approval ' + requestId)
  const a = rows[0]
  if (a.status !== 'pending') return { id: a.id, noop: a.status }   // already approved/expired
  const fb = deadlineFrom(now, a.urgency)
  await db`UPDATE public.vault_approvals SET status='escalated', fallback_deadline=${fb.toISOString()} WHERE id=${requestId}`
  await notify('helen', `Ecodia needs an approval Tate hasn't actioned: ${a.action} for ${a.service}. Open Friend to approve for him. ref ${a.id.slice(0, 8)}`)
  await armTask(db, `cowork.vault-expire.${a.id}`,
    `A vault approval escalated to the fallback approver may now be expired. Run: node ${APPROVAL_TOOL} expire ${a.id}  and follow its output.`,
    fb.toISOString(), 2)
  return { id: a.id, escalated_to: 'helen', fallback_deadline: fb.toISOString() }
}

// Fired by the fallback timer. If still unresolved, expire + tell Tate it lapsed.
async function expire(db, requestId, notify) {
  const rows = await db`SELECT id, service, action, status FROM public.vault_approvals WHERE id = ${requestId}`
  if (!rows.length) throw new Error('no such approval ' + requestId)
  const a = rows[0]
  if (a.status === 'approved') return { id: a.id, noop: 'approved' }
  await db`UPDATE public.vault_approvals SET status='expired', resolved_at=now() WHERE id=${requestId}`
  await notify('tate', `Approval lapsed unactioned: ${a.action} for ${a.service}. I did NOT proceed. ref ${a.id.slice(0, 8)}`)
  return { id: a.id, expired: true }
}

module.exports = { request, approve, escalate, expire, deadlineFrom, armTask }

if (require.main === module) {
  const [cmd, a1, a2] = process.argv.slice(2)
  const db = lib.db()
  // The reliable SMS path is the ecodia-comms MCP (send_sms / sms_tate), which the CC tab
  // running this task holds. So we EMIT the notification for the tab to send rather than
  // silently no-op through a missing CLI. Never a silent swallow.
  const PHONE = { helen: '+61416117941', tate: '+61404247153' }
  const smsNotify = async (target, msg) => {
    console.log(`\n>>> SEND SMS via ecodia-comms send_sms to ${PHONE[target] || target}:\n${msg}\n`)
  }
  ;(async () => {
    if (cmd === 'escalate') console.log(JSON.stringify(await escalate(db, a1, smsNotify), null, 2))
    else if (cmd === 'expire') console.log(JSON.stringify(await expire(db, a1, smsNotify), null, 2))
    else if (cmd === 'approve') console.log(JSON.stringify(await approve(db, a1, a2 || 'tate'), null, 2))
    else console.log('usage: vault-approval.js escalate <id> | expire <id> | approve <id> [by]')
    process.exit(0)
  })().catch(e => { console.error('ERR', e.message); process.exit(1) })
}
