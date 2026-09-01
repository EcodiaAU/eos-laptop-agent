#!/usr/bin/env node
/**
 * Every dispatched brief must tell the worker to attribute its sends.
 *
 * Lane E2, 2026-09-01, red-team item 1. The outbound ledger's `origin` column
 * defaults to "unknown" unless the caller passes it, and that default decides
 * real behaviour: a cron- or worker-originated cold message to a client is
 * staged as a DRAFT for the daily comms pass instead of being fired at them
 * now. "unknown" opts out of that batching.
 *
 * The fix the brief for this lane asked for was ECODIAOS_SEND_ORIGIN=cron in
 * "the env the mac-dispatcher hands a worker tab". THERE IS NO SUCH ENV. This
 * dispatcher spawns no child: it drives the IDE bridge to open a Claude Code
 * tab and sends a Return keystroke, so the tab inherits the IDE's environment
 * and nothing here reaches it. resolveOrigin reads process.env in whichever
 * process evaluates it, which on this Mac is the stdio MCP server sharing the
 * IDE env with the conductor's own tabs, where a hardcoded "cron" would be a
 * lie about half the traffic.
 *
 * The brief is the one channel that does reach a dispatched tab, so that is
 * where the attribution travels. This test is what stops it being quietly
 * dropped later.
 *
 * Run:  node tools/brief-send-origin.test.js
 */
const { _composeBrief: composeBrief } = require('./mac-dispatcher.js')

let pass = 0, fail = 0
const ok = (name, cond) => {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}`) }
}

const base = {
  tab_id: 'tab_test_1', task_id: 'task-test-1', tab_credential: 'cred-1',
  conductor_inbox: 'chat.conductor.inbox',
}

console.log('\nsend-origin block reaches every dispatched brief:')
{
  const inline = composeBrief({ ...base, brief_storage: 'inline', brief_body: 'do the thing' })
  ok('an inline brief carries the origin instruction', /SEND ORIGIN/.test(inline))
  ok('and names the exact value to pass', inline.includes('origin:"cron"'))
  ok('and names both send tools', inline.includes('gmail_send') && inline.includes('gmail_reply'))
  ok('and says what the default costs, so it does not read as boilerplate',
    inline.includes('unknown') && /draft/i.test(inline))
  ok('and gives the escape hatch for a human-backed send', inline.includes('batch:false'))
  ok('the task body is still there', inline.includes('do the thing'))

  // The file-storage path is the one a long brief takes, and it is the easy one
  // to miss because the body is not inlined.
  const filed = composeBrief({
    ...base, brief_storage: 'file', brief_file_path: '/tmp/brief.md', brief_body: 'do the thing',
  })
  ok('a FILE-stored brief carries it too', /SEND ORIGIN/.test(filed))
  ok('and still points at the file', filed.includes('/tmp/brief.md'))

  // Ordering: the worker reads top-down and the task block is where attention
  // lands, so the instruction must sit immediately before it, not in a footer.
  ok('the block sits immediately before YOUR TASK, not buried in a footer',
    inline.indexOf('SEND ORIGIN') < inline.indexOf('YOUR TASK') &&
    inline.indexOf('YOUR TASK') - inline.indexOf('SEND ORIGIN') < 800)
}

console.log('\nCONTROLS: the rest of the envelope is untouched:')
{
  const b = composeBrief({ ...base, brief_storage: 'inline', brief_body: 'x' })
  // composeBrief owns the identity + plumbing envelope; the signal_bound
  // INSTRUCTION is contributed by the caller's task body, so assert on what
  // this function actually guarantees rather than on the whole dispatch.
  ok('the coord calling convention is still spelled out', b.includes('tab_credential') && b.includes('mcp__coord__'))
  ok('the stand-down check survives', b.includes('stand_down'))
  ok('close_my_tab is still the final act', b.includes('close_my_tab'))
  ok('verify_paste is still first', b.includes('verify_paste'))
}

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
