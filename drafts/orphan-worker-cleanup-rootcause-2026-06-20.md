<!-- verified-from:
  - cowork.js:37 hardcoded COORD_ROOT (read at /Users/ecodia/.code/eos-laptop-agent/_wt-orphan/tools/cowork.js)
  - coord.js:27 + mac-dispatcher.js:35 env-aware COORD_ROOT
  - runtime probe: cleanup_orphan_workers candidates 0 -> 664 after fix
  - live log /Users/ecodia/Library/Logs/eos-laptop-agent.out.log (no closed= line ever fired)
  - on-disk registry /Users/ecodia/.ecodiaos/coordination/workers (2017 files, 664 real candidates)
  - prune dry-run output (59 would-prune of 69 dirs)
-->

# Orphan worker cleanup: root cause, fix, safe-prune helper (2026-06-20)

## One-sentence root cause

`cowork.js` hardcoded `COORD_ROOT` to the dead Corazon Windows path `D:\.code\EcodiaOS\coordination` with no env override, so on the Mac canonical host `cleanup_orphan_workers` scanned an empty literal `D:\...\workers` folder (created by `ensureDirs` mkdirSync as one oddly named dir inside the agent cwd) and found 0 candidates every pass, while the live dispatcher wrote 2000+ real worker rows to the env-resolved `~/.ecodiaos/coordination/workers` that the sweep never read.

## Evidence (file:line)

- `tools/cowork.js:37` (pre-fix): `const COORD_ROOT = 'D:\\.code\\EcodiaOS\\coordination'` - no `process.env.COORD_ROOT` fallback.
- `tools/coord.js:27`: `const COORD_ROOT = process.env.COORD_ROOT || 'D:\\...'` - env-aware. This is where the dispatcher WRITES the registry.
- `tools/mac-dispatcher.js:35-36`: `COORD_ROOT = process.env.COORD_ROOT || path.join(os.homedir(), '.ecodiaos', 'coordination')` - the Mac dispatch path, and it re-exports `cowork.cleanup_orphan_workers` (`mac-dispatcher.js:464`) unchanged, so the sweep inherits cowork's broken constant.
- `tools/cowork.js:982` + `:1006`: `cleanup_orphan_workers` reads `WORKERS_DIR = path.join(COORD_ROOT, 'workers')` and probes `ide.tabs`. Both keyed off the broken constant.
- `tools/scheduler.js:1906-1908`: scheduler calls the sweep every `CLEANUP_ORPHAN_INTERVAL_MS` and only logs `closed=X of Y candidates` when `r.closed > 0 || r.candidates > 0`. That guard never tripped (grep of out.log: zero `closed=` lines), confirming `candidates` was always 0.
- Runtime proof: `cowork.cleanup_orphan_workers({dry_run:true})` returned `candidates: 0` before the fix and `candidates: 664` after, against the same on-disk registry.
- The literal dir `/Users/ecodia/.code/eos-laptop-agent/D:\.code\EcodiaOS\coordination/workers` exists on the Mac and contains 0 files; the real registry `/Users/ecodia/.ecodiaos/coordination/workers` contains 2017 files (2007 terminated, 664 terminated-within-7d-and-not-closed with a viewColumn tab_handle = real sweep candidates).

The brief's "closed=0 of N (leaked=N), N climbing 62 -> 70+" describes the SEPARATE worktree-dir accumulation under `_worktrees/dispatched/` (77 dirs on disk). That leak is downstream of the same blindness plus the fact that `cleanup_orphan_workers` only closes TABS, never prunes worktree dirs. Part (c) below adds the dedicated prune path for those dirs.

## A second latent bug found while testing

`cleanup_orphan_workers` resolved `ide` from cowork's module-load top-level `const ide = require('./ide')` (`cowork.js:35`), whereas `kill_worker` does a call-time `const ide = require('./ide')` (`cowork.js:897`). The top-level binding captures whatever was in the require cache at first load, so any stub installed afterward (the test harness patches `require.cache` AFTER requiring cowork) never reached the sweep - it silently probed the LIVE IDE and was untestable in isolation. Fixed by resolving `ide` at call-time inside the sweep, matching `kill_worker`.

## The fix (diff summary)

`tools/cowork.js`:
1. `:37` - `COORD_ROOT` now resolves `process.env.COORD_ROOT || (win32 ? 'D:\\...' : ~/.ecodiaos/coordination)`, identical to `coord.js` + `mac-dispatcher.js`. Sweep now reads the registry the dispatcher writes.
2. `cleanup_orphan_workers` - resolve `ide` via a call-time `require('./ide')` instead of the module-load top-level ref, so the close path honours cache patches and is uniform with `kill_worker`.

Both are minimal, behaviour-preserving on the live host, and bring the three modules into agreement.

## Test result

`test-close-path-ladder.js` extended with T4 (orphan-sweep): seeds a terminated, not-yet-closed orphan into the env-pointed `COORD_ROOT` registry plus a matching live IDE tab, asserts the sweep (a) sees the candidate, (b) closes exactly 1, (c) leaks 0, (d) issues a close request, (e) stamps `closed_tab_ok` on the registry row. Before the fix this asserts `candidates=0` / `closed=0` (sweep blind to the registry).

```
14 pass, 0 fail, 14 total
```

Run: `node test-close-path-ladder.js`

## Safe-prune helper (part c)

`tools/prune-dispatched-worktrees.js` - DRY-RUN by default. Sweeps `SCHEDULER_WORKTREE_ROOT` (`/Users/ecodia/.code/ecodiaos/_worktrees/dispatched`) and removes ONLY dirs that pass BOTH safety gates:

1. No live worker: every coord registry row whose `task_id == dir name` (the scheduler row.id) is terminated OR has a stale heartbeat (older than `LIVE_HEARTBEAT_MS` = 1h). Any live row (no `terminated_at` AND fresh heartbeat) skips the dir.
2. No uncommitted work: `git status --porcelain` in the worktree is empty. Dirty, or a git probe error, skips (fail safe).

Removal mirrors `scheduler.pruneWorktreeForRow` (`git worktree remove --force` then `worktree prune`) with an `fs.rmSync` fallback for dirs git no longer tracks.

Usage:
```
node tools/prune-dispatched-worktrees.js                  # dry-run report (default)
node tools/prune-dispatched-worktrees.js --json           # machine-readable
node tools/prune-dispatched-worktrees.js --require-registry  # also skip dirs with no registry row
node tools/prune-dispatched-worktrees.js --apply          # actually remove (conductor-gated)
```

Dry-run result on the live host right now:
```
total dirs: 69
WOULD PRUNE: 59
skipped: 10  (worker_alive=2, uncommitted_changes=4, git_probe_error=4, no_registry_gated=0)
```

The 4 `git_probe_error` dirs are "not a git repository" (git already deregistered them); the helper conservatively skips them rather than `rm -rf` a dir whose cleanliness it cannot verify - left for human inspection. The 4 uncommitted and 2 alive-worker dirs are correctly protected. The `--apply` path and both skip rules were verified in an isolated throwaway repo (clean -> pruned; live worker -> skip; uncommitted -> skip).

I did NOT run the destructive `--apply` against production (conductor-gated per brief).

## Deploy note

The cowork.js fix is on disk in the worktree, NOT deployed - the live laptop-agent daemon still runs the old code. Deploy = merge branch + restart the daemon, which is conductor-gated (brief constraint 2). Until deploy, the sweep stays blind and the prune helper is the manual broom.
