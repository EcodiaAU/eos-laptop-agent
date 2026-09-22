#!/usr/bin/env bash
# cron-reclaim-last-run-at.mutations - break each guard on purpose, prove the gate goes red.
#
# A gate that stays green with its guard disabled is agreeing, not working. Five
# mutations, each reverting one half of the 2026-09-23 lane S6 fix. Every one must
# turn at least one named check RED, and the BASELINE must be green first, because a
# red baseline measures nothing (see [[a-suite-that-writes-a-fixture-and-reads-a-clock]]).
#
# Run: bash tools/cron-reclaim-last-run-at.mutations.sh
set -uo pipefail
cd "$(dirname "$0")/.."
SRC=tools/scheduler.js
BAK="$(mktemp -t scheduler-mut)"
cp "$SRC" "$BAK"
restore() { cp "$BAK" "$SRC"; rm -f "$BAK"; }
trap restore EXIT

run_gate() { node tools/cron-reclaim-last-run-at.gate.js 2>&1; }

echo "=== BASELINE (must be GREEN, or nothing below measures anything) ==="
BASE="$(run_gate)"; BASE_RC=$?
echo "$BASE" | tail -2
if [ $BASE_RC -ne 0 ]; then echo "BASELINE: RED. Aborting: the mutations would prove nothing."; exit 2; fi
echo "BASELINE: GREEN"

FAILED=0
mutate() { # $1=label  $2=python replace expr file
  local label="$1"; shift
  cp "$BAK" "$SRC"
  if ! python3 - "$@" ; then echo "  MUTATION $label: anchor did not apply"; FAILED=1; return; fi
  local out rc
  out="$(run_gate)"; rc=$?
  if [ $rc -eq 0 ]; then
    echo "  NOT CAUGHT  $label   <-- the gate agreed with the bug"
    FAILED=1
  else
    echo "  CAUGHT      $label"
    echo "$out" | grep '  FAIL  ' | sed 's/^/                /'
  fi
  cp "$BAK" "$SRC"
}

echo
echo "=== MUTATIONS ==="

mutate "M1 livenessReapPass relaunch re-stamps last_run_at" <<'PY'
import io,sys
p='tools/scheduler.js'; s=io.open(p,encoding='utf-8').read()
a="""           SET status = 'active', retry_count = 0, next_run_at = $1,
               launch_retry_count = COALESCE(launch_retry_count, 0) + 1,"""
b="""           SET status = 'active', retry_count = 0, last_run_at = NOW(), next_run_at = $1,
               launch_retry_count = COALESCE(launch_retry_count, 0) + 1,"""
assert s.count(a)==1, s.count(a)
io.open(p,'w',encoding='utf-8').write(s.replace(a,b))
PY

mutate "M2 livenessReapPass defer arm re-stamps last_run_at" <<'PY'
import io
p='tools/scheduler.js'; s=io.open(p,encoding='utf-8').read()
a="""             last_run_at = CASE WHEN bound_at IS NULL THEN last_run_at ELSE NOW() END,
             last_error = $3, leased_by = NULL, leased_at = NULL, ${tabFrag} updated_at = NOW()"""
b="""             last_run_at = NOW(),
             last_error = $3, leased_by = NULL, leased_at = NULL, ${tabFrag} updated_at = NOW()"""
assert s.count(a)==1, s.count(a)
io.open(p,'w',encoding='utf-8').write(s.replace(a,b))
PY

mutate "M3 staleLeaseRecovery cron relaunch re-stamps last_run_at (the arm that FIRED on 23fddbac)" <<'PY'
import io
p='tools/scheduler.js'; s=io.open(p,encoding='utf-8').read()
a="""           SET status = 'active', retry_count = 0,
               next_run_at = $1,
               launch_retry_count = COALESCE(launch_retry_count, 0) + 1,"""
b="""           SET status = 'active', retry_count = 0, last_run_at = NOW(),
               next_run_at = $1,
               launch_retry_count = COALESCE(launch_retry_count, 0) + 1,"""
assert s.count(a)==1, s.count(a)
io.open(p,'w',encoding='utf-8').write(s.replace(a,b))
PY

mutate "M4 the CASE never advances, so a row that DID run also stops counting" <<'PY'
import io
p='tools/scheduler.js'; s=io.open(p,encoding='utf-8').read()
a="last_run_at = CASE WHEN bound_at IS NULL THEN last_run_at ELSE NOW() END"
b="last_run_at = CASE WHEN bound_at IS NULL THEN last_run_at ELSE last_run_at END"
assert s.count(a)==2, s.count(a)
io.open(p,'w',encoding='utf-8').write(s.replace(a,b))
PY

mutate "M5 markComplete stops clearing last_error" <<'PY'
import io
p='tools/scheduler.js'; s=io.open(p,encoding='utf-8').read()
a="run_count = run_count + 1, last_result = $2, last_error = NULL,"
b="run_count = run_count + 1, last_result = $2,"
assert s.count(a)==1, s.count(a)
io.open(p,'w',encoding='utf-8').write(s.replace(a,b))
PY

echo
echo "=== RESTORED, re-running baseline to prove the file is back ==="
run_gate | tail -2
if [ $FAILED -ne 0 ]; then echo "MUTATION BATTERY: FAILED (a mutation went uncaught)"; exit 1; fi
echo "MUTATION BATTERY: all mutations caught"
