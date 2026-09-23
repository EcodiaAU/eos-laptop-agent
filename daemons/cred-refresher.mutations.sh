#!/usr/bin/env bash
# shell-lint-ok: the grep -E alternations below are simple literal alternations over
# this suite's own fixed output lines, and each was verified to return hits on this
# BSD grep before the battery ran.
# Mutation battery for the E6 postJson pass. Each mutation breaks exactly ONE guard
# on purpose and re-runs the suite. A mutation that leaves the suite green means the
# case agrees with the code rather than testing it.
set -u
cd "$(dirname "$0")/.." || exit 1
SRC=daemons/cred-refresher.js
BAK=/tmp/crf-mutation-backup.js
cp "$SRC" "$BAK"
restore() { cp "$BAK" "$SRC"; }
trap restore EXIT

report() {
  timeout 300 node daemons/cred-refresher.test.js 2>&1 \
    | grep -E -e '^fail ' -e '^ALL TESTS' -e 'test\(s\) FAILED' | sed 's/^/    /'
}

# UNDECLARED-GREEN GATE (G17 pass, 2026-09-23). The header rule above says a mutation
# that leaves the suite green means the case agrees with the code rather than testing it.
# That rule was PROSE and nothing counted it, so M7 and M9 sat green through an entire
# pass before anyone noticed. It is now mechanical: a green mutation is only acceptable if
# its own label declares it, with the reason, as EXPECTED GREEN. The battery exits 1
# otherwise, so a fix that quietly subsumes a guard cannot ride out as a clean run.
UNDECLARED_GREEN=0

run() {
  echo ""
  echo "MUTATION: $1"
  out=$(report)
  printf '%s\n' "$out"
  if printf '%s' "$out" | grep -q 'ALL TESTS PASSED'; then
    if printf '%s' "$1" | grep -q 'EXPECTED GREEN'; then
      echo "    (green, and its own label declares it: the guard this breaks is bounded elsewhere)"
    else
      echo "    *** UNDECLARED GREEN: this mutation broke a guard and not one case noticed."
      echo "    *** Either write the case that catches it, or add EXPECTED GREEN plus the"
      echo "    *** reason to this mutation's label so the next reader is not told a lie."
      UNDECLARED_GREEN=$((UNDECLARED_GREEN + 1))
    fi
  fi
  restore
}

echo "### BASELINE (unmutated) ###"
report

python3 - <<'EOF'
import io; p='daemons/cred-refresher.js'; s=io.open(p,encoding='utf-8').read()
old="      timeout: OAUTH_REQUEST_TIMEOUT_MS,\n"
assert s.count(old)==1, 'M1 anchor %d' % s.count(old)
io.open(p,'w',encoding='utf-8').write(s.replace(old,""))
EOF
run "M1  G16: options.timeout deleted (connect phase unbounded again)"

python3 - <<'EOF'
import io; p='daemons/cred-refresher.js'; s=io.open(p,encoding='utf-8').read()
old="      timeout: OAUTH_REQUEST_TIMEOUT_MS,\n"
assert s.count(old)==1
io.open(p,'w',encoding='utf-8').write(s.replace(old,"      timeout: 99000,\n"))
EOF
run "M2  G16: option present but names a different limit than the message"

python3 - <<'EOF'
import io; p='daemons/cred-refresher.js'; s=io.open(p,encoding='utf-8').read()
old="""    req.setTimeout(OAUTH_REQUEST_TIMEOUT_MS, () => {
      req.destroy(Object.assign(new Error('OAuth request timed out after ' + OAUTH_REQUEST_TIMEOUT_MS + 'ms'), { code: 'ETIMEDOUT' }))
    })"""
assert s.count(old)==1, 'M3 anchor'
io.open(p,'w',encoding='utf-8').write(s.replace(old,"    // handler removed by mutation M3"))
EOF
# M3 IS EXPECTED GREEN SINCE G17, and that is a finding rather than a defect in the
# cases. The G17 deadline destroys the request at the limit on its own, so deleting the
# idle handler no longer leaves anything unbounded: every case still settles with
# ETIMEDOUT and the same message. Before G17 this mutation made the suite HANG and burn
# the full `timeout 300`; a fast green run here is the observable proof of the
# redundancy. The live mutation for the destroy ACTION is now M11. The handler is kept
# in the daemon anyway, because case 21 leans on options.timeout and belt-and-braces on
# a credential path is cheap.
run "M3  G16: the timeout HANDLER deleted, option kept (EXPECTED GREEN since G17: the deadline destroys it)"

python3 - <<'EOF'
import io; p='daemons/cred-refresher.js'; s=io.open(p,encoding='utf-8').read()
old="""  if (_passInFlight) {
    console.log('[cred-refresher] a pass is already running - skipping this entry')
    return
  }"""
assert s.count(old)==1, 'M4 anchor'
io.open(p,'w',encoding='utf-8').write(s.replace(old,"  // re-entry check removed by mutation M4"))
EOF
run "M4  G15a: the in-flight check deleted (two passes spend one refresh_token)"

python3 - <<'EOF'
import io; p='daemons/cred-refresher.js'; s=io.open(p,encoding='utf-8').read()
old="    _passInFlight = false\n"
assert s.count(old)==1, 'M5 anchor %d' % s.count(old)
io.open(p,'w',encoding='utf-8').write(s.replace(old,"    // flag never cleared by mutation M5\n"))
EOF
run "M5  G15a: the flag is never cleared (the guard wedges the daemon permanently)"

python3 - <<'EOF'
import io; p='daemons/cred-refresher.js'; s=io.open(p,encoding='utf-8').read()
old="    if (!_recheckTimer) {"
assert s.count(old)==1, 'M6 anchor'
io.open(p,'w',encoding='utf-8').write(s.replace(old,"    if (true) {"))
EOF
run "M6  G15b: the single-chain handle bypassed (one chain armed per entry)"

# ── M7 to M10, added by the verification pass, 2026-09-23 ─────────────────────
# M7 and M9 both left the 23-case suite GREEN when they were first run, which is
# what earned cases 24 and 25. They are kept here because a mutation that is now
# caught is the only proof that the case catching it is doing work.

python3 - <<'EOF'
import io; p='daemons/cred-refresher.js'; s=io.open(p,encoding='utf-8').read()
old="""  } finally {
    // finally, not a tail assignment: refresh_account is wrapped per account, and a
    // throw from readLiveCredentials itself would otherwise leave the flag stuck true
    // and wedge every later pass for the life of the process.
    _passInFlight = false
  }"""
assert s.count(old)==1, 'M7 anchor %d' % s.count(old)
io.open(p,'w',encoding='utf-8').write(s.replace(old,"""  } catch (e) { throw e }
  _passInFlight = false"""))
EOF
run "M7  G15a: finally downgraded to a TAIL assignment (a throw wedges the flag true forever)"

python3 - <<'EOF'
import io; p='daemons/cred-refresher.js'; s=io.open(p,encoding='utf-8').read()
old="    if (!_recheckTimer) {"
assert s.count(old)==1, 'M8 anchor'
io.open(p,'w',encoding='utf-8').write(s.replace(old,"    if (_recheckTimer) {"))
EOF
run "M8  G15b: the single-chain test INVERTED (the first entry arms no chain at all)"

python3 - <<'EOF'
import io; p='daemons/cred-refresher.js'; s=io.open(p,encoding='utf-8').read()
flag="""  if (_passInFlight) {
    console.log('[cred-refresher] a pass is already running - skipping this entry')
    return
  }
"""
assert s.count(flag)==1, 'M9 flag anchor'
sw="  if (switchInFlight()) {"
assert s.count(sw)==1, 'M9 switch anchor'
io.open(p,'w',encoding='utf-8').write(s.replace(flag,"").replace(sw, flag + sw))
EOF
run "M9  G15 ORDER: _passInFlight checked BEFORE switchInFlight (section 12.8's removed behaviour)"

python3 - <<'EOF'
import io; p='daemons/cred-refresher.js'; s=io.open(p,encoding='utf-8').read()
old="    const live = readLiveCredentials()\n"
assert s.count(old)==1, 'M10 anchor %d' % s.count(old)
io.open(p,'w',encoding='utf-8').write(s.replace(old,"    if (true) return\n"+old))
EOF
run "M10 the pass returns before the account loop (does nothing, clears the flag, looks healthy)"

# ── M11, added by the G17 pass, 2026-09-23 ────────────────────────────────────
# The whole-request deadline. Without it the connect bound and the idle bound compose
# additively and one request can take connect_time plus OAUTH_REQUEST_TIMEOUT_MS. Case 26
# is the only case that can see this: 19 and 20 connect instantly and 21 never connects.

python3 - <<'EOF'
import io; p='daemons/cred-refresher.js'; s=io.open(p,encoding='utf-8').read()
old="""    deadline = setTimeout(() => {
      deadline = null
      req.destroy(Object.assign(new Error('OAuth request timed out after ' + OAUTH_REQUEST_TIMEOUT_MS + 'ms'), { code: 'ETIMEDOUT' }))
    }, OAUTH_REQUEST_TIMEOUT_MS)"""
assert s.count(old)==1, 'M11 anchor %d' % s.count(old)
io.open(p,'w',encoding='utf-8').write(s.replace(old,"    // whole-request deadline removed by mutation M11"))
EOF
run "M11 G17: the whole-request DEADLINE deleted (connect and idle compose additively again)"

# -- M12 and M13, added by the G17 verification pass, 2026-09-23 --------------
# 14.6 left the leak path unmutated on the reasoning that it had no cheap observable
# consequence. A Timeout-handle delta across a successful refresh is that observable,
# and it is three lines. Case 27 is the only case that can see M12; case 28 the only
# one that can see M13.

python3 - <<'EOF'
import io; p='daemons/cred-refresher.js'; s=io.open(p,encoding='utf-8').read()
old="    const settleOk   = (v) => { clearDeadline(); resolve(v) }"
assert s.count(old)==1, 'M12 anchor %d' % s.count(old)
io.open(p,'w',encoding='utf-8').write(s.replace(old,"    const settleOk   = (v) => { resolve(v) }"))
EOF
run "M12 G17: clearDeadline dropped from the SUCCESS settle path only (a timer outlives every successful refresh)"

python3 - <<'EOF'
import io; p='daemons/cred-refresher.js'; s=io.open(p,encoding='utf-8').read()
timer="""    deadline = setTimeout(() => {
      deadline = null
      req.destroy(Object.assign(new Error('OAuth request timed out after ' + OAUTH_REQUEST_TIMEOUT_MS + 'ms'), { code: 'ETIMEDOUT' }))
    }, OAUTH_REQUEST_TIMEOUT_MS)
"""
assert s.count(timer)==1, 'M13 timer anchor %d' % s.count(timer)
s=s.replace(timer,"")
reqline="    const req = transport.request(options, (res) => {"
# defaultKvWriter has the same line, and postJson is the LAST of the two request sites.
assert s.count(reqline)==2, 'M13 req anchors %d' % s.count(reqline)
i=s.rfind(reqline)
io.open(p,'w',encoding='utf-8').write(s[:i]+timer+s[i:])
EOF
run "M13 G17 ORDER: the deadline armed BEFORE const req (a TDZ ReferenceError from inside the timer)"

echo ""
echo "### RESTORED ###"
git diff --stat -- daemons/cred-refresher.js
echo "(no diff line above means the tree is back to the shipped code)"

echo ""
if [ "$UNDECLARED_GREEN" -gt 0 ]; then
  echo "### $UNDECLARED_GREEN UNDECLARED GREEN MUTATION(S) ###"
  echo "The suite agrees with the code on those guards rather than testing them."
  exit 1
fi
echo "### every green mutation declared itself ###"
