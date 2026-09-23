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

run() {
  echo ""
  echo "MUTATION: $1"
  report
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
run "M3  G16: the timeout HANDLER deleted, option kept (nothing destroys the request)"

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

echo ""
echo "### RESTORED ###"
git diff --stat -- daemons/cred-refresher.js
echo "(no diff line above means the tree is back to the shipped code)"
