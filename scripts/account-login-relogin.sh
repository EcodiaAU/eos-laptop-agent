#!/usr/bin/env bash
# account-login-relogin.sh - COPY of ecodiaos backend/scripts/account-login.sh (2026-10-30) whose
# only change is that the wait for the auth code is EOS_LOGIN_CODE_WAIT_SECS (default 720, the
# original 12 minutes). The relogin guard's phone-handshake mode points switch-run at this copy via
# ACCOUNT_LOGIN_SH, because Tate needs longer than 12 minutes to open a link on his phone and text
# the code back. The original lives in the conductor's shared tree and was left untouched. Keep the
# two in step if the original changes (diff them; everything but the wait loop should match).
# account-login.sh - the codified Claude-account switch macro (Mac canonical).
#
# Switches the LIVE Mac Keychain identity (the entry the Claude Code VS Code
# extension + the laptop-agent read) to a target account by driving the real
# `claude auth login` OAuth flow, then snapshots the now-live creds into
# ~/PRIVATE/ecodia-creds/<acct>.json via creds.seed_from_live.
#
# This script does the MECHANICAL half (start the CLI login, surface the OAuth
# URL, feed back the auth code, seed the snapshot, verify). The BROWSER half
# (authorize the OAuth consent as the target account on claude.ai, read the
# emailed magic-link / paste-code) is driven by the caller (the conductor, or an
# auto-switch cron worker) over CDP + the gmail connector, per doctrine
# patterns/account-switch-via-cli-login-and-cdp-2026-06-19.md.
#
# Per-account login method comes from the accounts registry
# (eos-laptop-agent/tools/accounts-registry.js), not from a comment here. The comment
# that used to live at this spot had drifted: it described code@ as magic-link when it is
# Google SSO, and the METHOD= line below hardcoded `[ "$ACCT" = tate ]`, so it announced
# the wrong method for two of the three accounts. Nothing consumed it, which is exactly
# why nobody noticed.
#
# Usage:
#   account-login.sh <tate|code|money>
# Contract:
#   - Prints `OAUTH_URL=<url>` once the login flow is up.
#   - Prints `CODE_FILE=<path>`; the caller writes the auth code there.
#   - Blocks up to 5 min for that file, feeds it, then seeds + verifies.
# Exit 0 = switched + snapshot seeded; non-zero = failure (see stderr).
set -uo pipefail

ACCT="${1:-}"
case "$ACCT" in
  tate)  EMAIL=tate@ecodia.au ;;
  code)  EMAIL=code@ecodia.au ;;
  money) EMAIL=money@ecodia.au ;;
  *) echo "usage: account-login.sh <tate|code|money>" >&2; exit 2 ;;
esac

BIN="$(ls -d "$HOME"/.vscode/extensions/anthropic.claude-code-*/resources/native-binary/claude 2>/dev/null | sort -V | tail -1)"
[ -x "$BIN" ] || { echo "claude native binary not found under VS Code extension" >&2; exit 3; }

# Per-invocation paths when the caller provides a private dir (switch-run.js does), so
# two runs can never share a FIFO or race for the same code file. Fixed /tmp names are
# kept as the fallback for a human running this by hand.
WORKDIR="${EOS_SWITCH_TMPDIR:-/tmp}"
WORK="$WORKDIR/eos-acct-login-$ACCT"
FIFO="$WORK.fifo"; FEED="$WORK.feed"; OUT="$WORK.out"
CODE_FILE="$WORKDIR/eos-acct-code-$ACCT.txt"
rm -f "$FIFO" "$FEED" "$CODE_FILE"; : > "$OUT"
mkfifo "$FIFO"; : > "$FEED"

# tail -f keeps the FIFO writer open so the CLI prints the URL immediately and
# waits for stdin; we stream the auth code in by appending to FEED.
( tail -f "$FEED" ) > "$FIFO" &
FEEDER=$!
"$BIN" auth login --claudeai --email "$EMAIL" < "$FIFO" >> "$OUT" 2>&1 &
CLI=$!

# REAP THE WHOLE TREE, not just the feeder (2026-08-02). The old cleanup killed $FEEDER
# and left $CLI running on every failure exit (4/5/6). One such orphan - a
# `claude auth login --email money@ecodia.au` started on 19 July - was still alive on
# 2 August holding a PKCE verifier for a flow nobody was completing, and would happily
# have consumed a paste code meant for a later switch. Kill the CLI, then the feeder,
# then remove the FIFO.
cleanup() {
  if [ -n "${CLI:-}" ]; then kill "$CLI" 2>/dev/null; fi
  if [ -n "${FEEDER:-}" ]; then kill "$FEEDER" 2>/dev/null; fi
  rm -f "$FIFO" "$FEED"
}
trap cleanup EXIT INT TERM

# Surface the OAuth URL.
for _ in $(seq 1 40); do grep -q "oauth/authorize" "$OUT" && break; sleep 0.5; done
URL="$(grep -oE 'https://claude.com/cai/oauth/authorize[^ ]+' "$OUT" | tail -1)"
[ -n "$URL" ] || { echo "FAILED: no OAuth URL surfaced; CLI output:" >&2; cat "$OUT" >&2; exit 4; }
echo "OAUTH_URL=$URL"
echo "CODE_FILE=$CODE_FILE"
METHOD="$(node -e "try{const r=require('$HOME/.code/eos-laptop-agent/tools/accounts-registry');const a=r.get('$ACCT');process.stdout.write((a&&a.login_method)||'unknown')}catch(e){process.stdout.write('unknown')}" 2>/dev/null)"
echo "ACCT=$ACCT EMAIL=$EMAIL METHOD=$METHOD"

# Wait for the caller to drop the auth code (up to 12 min). 5 min was too tight:
# it orphaned the CLI twice on 2026-06-21 when the browser-half (React form +
# magic-link round-trip + OAuth Authorize button discovery) ran long, leaving a
# claude-auth-login child waiting on a dead FIFO with the code-verifier trapped.
WAIT_SECS="${EOS_LOGIN_CODE_WAIT_SECS:-720}"
for _ in $(seq 1 $((WAIT_SECS * 2))); do [ -s "$CODE_FILE" ] && break; sleep 0.5; done
[ -s "$CODE_FILE" ] || { echo "TIMEOUT: no auth code written to $CODE_FILE within ${WAIT_SECS}s" >&2; exit 5; }

# Feed the code with EXACTLY one trailing newline. The CLI reads stdin line by
# line, so a CODE_FILE the caller wrote without a trailing newline would never
# submit and the login would hang to TIMEOUT (observed 2026-06-20 auto-switch).
# Command substitution strips any trailing newlines; printf re-adds exactly one.
printf '%s\n' "$(cat "$CODE_FILE")" >> "$FEED"
# 60s, not 20s, and then ASK THE CLI rather than trusting the absence of a string. The
# banner can be slow or reworded by a vendor update; `auth status` is the CLI's own answer
# and it is what tells a genuinely-failed login apart from a missed grep. Calling a
# successful switch a failure is worse than waiting: the caller would then try another
# account while this one is already live.
for _ in $(seq 1 120); do grep -q "Login successful" "$OUT" && break; sleep 0.5; done
if ! grep -q "Login successful" "$OUT"; then
  if "$BIN" auth status 2>&1 | grep -qi "$EMAIL"; then
    echo "LOGIN_OK_VIA_STATUS: no banner, but auth status reports $EMAIL"
  else
    echo "FAILED: CLI did not report Login successful:" >&2; tail -5 "$OUT" >&2; exit 6
  fi
fi
echo "LOGIN_OK"

# Seed the snapshot from the now-live Keychain + verify the switch.
node -e "
const c=require('$HOME/.code/eos-laptop-agent/tools/creds');
try{ const s=c.seed_from_live({account:'$ACCT'}); console.log('SEED_OK '+JSON.stringify(s)); }
catch(e){ console.log('SEED_ERR '+e.message); process.exitCode=7; }
// Keep the coord active_account label truthful (seed_from_live does not; only rotate_to did).
try{ require('$HOME/.code/eos-laptop-agent/tools/usage')._setActiveAccount('$EMAIL','account-login.sh:$ACCT'); console.log('LABEL_SET=$EMAIL'); }catch(e){ console.log('LABEL_SET_ERR '+e.message); }
console.log('CURRENT_ACCOUNT='+c.current_account());
"
rm -f "$CODE_FILE"
echo "DONE: switched live identity to $ACCT and seeded snapshot."
