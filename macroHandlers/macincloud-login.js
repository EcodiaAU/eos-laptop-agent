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
    'macincloud-login is a Phase 1 stub and is PERMANENTLY STUB-ONLY per 17:11 AEST 29 Apr 2026 doctrine. Do not re-author. See ~/ecodiaos/patterns/macros-record-mode-and-auto-author-from-runs.md.'
  );
}

module.exports = {
  name: 'macincloud-login',
  description: 'macincloud-login - PERMANENTLY STUB-ONLY per 17:11 AEST 29 Apr 2026 doctrine.',
  // run() retained as alias for any caller that uses the brief-template contract
  async run() { return handle(); },
  handle,
};