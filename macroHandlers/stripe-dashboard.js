// Phase 1 stub - retracted 29 Apr 2026 per Option A reconciliation.
// Reason: original handler used hardcoded coordinates that were never
// observed against a live screenshot. Per
// ~/ecodiaos/patterns/macros-record-mode-and-auto-author-from-runs.md,
// Phase 1 macros must come from Tate-recorded observation passes, not
// from imagination. This stub is dispatchable but throws on invocation
// to make the gap explicit instead of silently clicking wrong pixels.
//
// Retracted by fork_mojquxhy_2a5b93, 29 Apr 2026.

async function handle() {
  throw new Error(
    'stripe-dashboard is a Phase 1 stub. Run record-mode against the live UI with Tate present (or have Tate execute the flow once with the screen recorder running) to capture real selectors/coords. See ~/ecodiaos/patterns/macros-record-mode-and-auto-author-from-runs.md.'
  );
}

module.exports = {
  name: 'stripe-dashboard',
  description: 'Stripe Dashboard - STUB. Requires Phase 2 record-mode pass before dispatch.',
  // run() retained as alias for any caller that uses the brief-template contract
  async run() { return handle(); },
  handle,
};