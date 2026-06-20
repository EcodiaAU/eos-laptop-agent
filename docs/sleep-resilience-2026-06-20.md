# Scheduler sleep-resilience (wake-aware recovery)

2026-06-20. Fixes the fleet-wide stuck-running recurrence (EcodiaOS status_board
row `8ec234ed`): on 2026-06-18 and again 2026-06-19, ~11 recurring crons entered
`status=running`/`dispatching` and sat stuck 16-26h before a morning sweep
re-leased them. Inbound email triage, finance polls, telemetry and app-store
watch all went dark overnight.

## Verified root cause (live evidence, not hypothesis)

The agent runs on a Mac **laptop**. `pmset -g log` for the incident window shows:

```
2026-06-19 01:21:34 +1000 Sleep  'Low Power Sleep':TCPKeepAlive=inactive Using Batt (Charge:1%) 33253 secs
2026-06-19 10:35:47 +1000 Wake   Wake from Hibernate [CDNVA] : due to acattach Using AC (Charge:1%)
```

The host drained to 1% battery and **hibernated for ~9.2h** (TCPKeepAlive
inactive = full freeze), waking only when AC was reattached. The same
`Wake from Hibernate ... Using Batt (Charge:1%)` repeated the next night. The
launchd plist `au.ecodia.laptop-agent.plist` has **no `caffeinate`** wrapper, and
its `KeepAlive` only restarts the process on **exit**, not when the OS freezes it.

While the host sleeps the Node event loop stops, so every `setInterval` in
`scheduler.start()` (dispatch, completion, **stale-lease recovery**, cap observer,
orphan cleanup) stops ticking. Crons leased into `running`/`dispatching` just
before the freeze cannot be reconciled until the agent gets sustained runtime
again. One-shot `cowork.*` tasks completed fine overnight only because they ran
in the brief awake windows before the deep hibernate. This is a host-availability
fault, not a logic bug in `staleLeaseRecovery` itself.

## Fix (additive, never removes a recovery)

We cannot stop a laptop hibernating from inside the process (critical-battery
hibernate ignores `caffeinate`). We make the agent reconcile as fast as possible
whenever it *does* get runtime, and make the stall observable:

1. **Recover on start.** `start()` now runs `staleLeaseRecovery()` immediately
   (after `startupCleanup`, which only closes tabs), so a boot / KeepAlive
   restart / first-runtime-after-wake reconciles stuck leases without waiting up
   to `STALE_LEASE_INTERVAL_MS`.
2. **Wake detection.** `detectWakeStall(prev, now, interval, factor)` is a pure
   helper that flags an inter-tick gap `> interval * factor` (default 3x) as a
   frozen-then-resumed loop. `staleTick()` (the extracted stale-lease interval
   body) uses it: on a detected gap it logs `WAKE-STALL` and runs the catch-up
   recovery on the first resumed tick.
3. **Surfacing.** `recordWakeStall()` writes an `observer_signals` row (deduped
   per host-hour) so a silent nightly sleep-stall becomes a visible signal on the
   conductor's next turn, instead of accumulating unseen.

Deliberately **unchanged**: `ORPHAN_TIMEOUT_MS` (6h) and `STALE_DISPATCHING_MS`
(15min) and the coord-liveness gate. Those guard against the thundering-herd /
double-dispatch the prior fixes were built for; this change is purely the
resilience layer on top.

## The real prevention is host-side (Tate-gated residual)

The software layer shortens recovery but cannot prevent the freeze. The durable
prevention is keeping the host awake/charged. Recommended residual, applied during
a supervised window (it requires a laptop-agent reload, which is conductor-gated):

- Keep the Mac on AC power overnight, and/or
- Wrap the agent in `caffeinate -s` (caveat: still yields to critical-battery
  hibernate), and/or set `pmset` to disable idle sleep while on AC.

## Test

`tools/scheduler.wake-stall.test.js` (bare-Node, injection seams). Fails pre-fix
(new exports absent, exit 2); post-fix asserts a sleep-sized gap records exactly
one wake-stall signal and recovery still runs on every tick. Existing
`scheduler.branch3` and `scheduler-next-run-at-recompute` tests still pass.
