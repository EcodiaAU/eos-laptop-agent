'use strict'
// Standalone test for tab-title-match (no framework; run: node tools/test-tab-title-match.js).
// Grounded in the REAL candidate set that failed close_my_tab for the
// bookkeeping-xero-sync worker (task 721c05e0) on 2026-06-22, where the
// auto-titler renamed [EOS-W-a986a437] -> "Reconcile Xero push back…".

const { computeFingerprint, pickByFingerprint } = require('./tab-title-match')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')) }
}

// The actual live candidate set echoed by the real no_match (vc1).
function realCandidates() {
  return [
    { label: 'ESPS' },
    { label: 'Glovebox ui' },
    { label: 'what.... do the code@ ac…' },
    { label: 'autonomy-bootstrap-direc…' },
    { label: 'autonomy-bootstrap-direc…' },
    { label: '[EOS-W-8e16db9b]\n<dispat…' },
    { label: '[EOS-W-7aeaf8f4]\n<dispat…' },
    { label: 'Reconcile Xero push back…' },   // <- the worker's own auto-titled tab
    { label: '[EOS-W-e0b2fd61]\n<dispat…' },
    { label: '[EOS-W-de9957ca]\n<dispat…' },
    { label: '[EOS-W-a521abb4]\n<dispat…' },
    { label: '[EOS-W-0effa5ea]\n<dispat…' },
    { label: '[EOS-W-4a7e7d0e]\n<dispat…' },
    { label: '[EOS-W-def1b159]\n<dispat…' },
    { label: 'Review bootstrap directi…' },
  ]
}

// Representative of brief_body the dispatcher fingerprints (conservative excerpt;
// the live brief is a strict superset of these tokens).
const XERO_BRIEF = `You are EcodiaOS. Cron: bookkeeping-xero-sync.
Reconcile the Xero PUSH backlog and keep staged_transactions sync state truthful.
Push BankTransactions and ManualJournals via the Director Loan account. Probe the
push backlog directly from staged_transactions. Mint a client_credentials token.`

const GLOVEBOX_BRIEF = `You are EcodiaOS. Glovebox ui polish: fix the offline basemap
tiles and the turn-by-turn navigation corridor rendering on the Android surface.`

// ---- Test 1: the real failure case now resolves to the right tab ----
{
  const fp = computeFingerprint(XERO_BRIEF)
  const r = pickByFingerprint(realCandidates(), fp, '[EOS-W-a986a437]')
  ok('xero fingerprint picks the auto-titled xero tab',
     r.match && r.match.label === 'Reconcile Xero push back…', JSON.stringify(r))
}

// ---- Test 2: a DIFFERENT worker's sentinel is never fuzzy-closed ----
{
  // Even with a fingerprint that shares the wrapper word "dispat", the still-
  // sentinelled other-worker tabs must be excluded (they carry [EOS-W-...]).
  const fp = computeFingerprint('dispatched worker reconcile xero push backlog')
  const r = pickByFingerprint(realCandidates(), fp, '[EOS-W-a986a437]')
  ok('never selects a tab bearing a different sentinel',
     !r.match || !/^\[EOS-W-/.test(r.match.label), JSON.stringify(r))
}

// ---- Test 3: ambiguity refuses (two identical xero auto-titles) ----
{
  const cands = realCandidates()
  cands.push({ label: 'Reconcile Xero push back…' }) // a second xero worker
  const fp = computeFingerprint(XERO_BRIEF)
  const r = pickByFingerprint(cands, fp, '[EOS-W-a986a437]')
  ok('two identical xero titles -> ambiguous refuse (no wrong-close)',
     r.match === null && /ambiguous/.test(r.reason), JSON.stringify(r))
}

// ---- Test 4: a glovebox worker does NOT match the xero tab ----
{
  const fp = computeFingerprint(GLOVEBOX_BRIEF)
  const r = pickByFingerprint(realCandidates(), fp, '[EOS-W-zzzzzzzz]')
  // It may legitimately match "Glovebox ui"; the safety property is that it
  // NEVER matches the xero tab with a glovebox fingerprint.
  ok('glovebox fingerprint never closes the xero tab',
     !r.match || r.match.label !== 'Reconcile Xero push back…', JSON.stringify(r))
}

// ---- Test 5: no fingerprint -> null (legacy workers, pre-fix) ----
{
  const r = pickByFingerprint(realCandidates(), null, '[EOS-W-a986a437]')
  ok('absent fingerprint -> no match (graceful legacy behaviour)',
     r.match === null && r.reason === 'no_fingerprint', JSON.stringify(r))
}

// ---- Test 6: unrelated tabs only -> null (no spurious close) ----
{
  const fp = computeFingerprint(XERO_BRIEF)
  const r = pickByFingerprint(
    [{ label: 'ESPS' }, { label: 'Glovebox ui' }, { label: 'Review bootstrap directi…' }],
    fp, '[EOS-W-a986a437]')
  ok('no xero tab present -> refuse (no false positive)',
     r.match === null, JSON.stringify(r))
}

// ---- Test 7: prefix tolerance on truncated final token ("back" <- "backlog") ----
{
  const fp = computeFingerprint('reconcile xero push backlog staged transactions')
  const r = pickByFingerprint([{ label: 'Reconcile Xero push back…' }], fp, '[EOS-W-a986a437]')
  ok('truncated final token matches by prefix',
     r.match && r.match.label === 'Reconcile Xero push back…', JSON.stringify(r))
}

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
