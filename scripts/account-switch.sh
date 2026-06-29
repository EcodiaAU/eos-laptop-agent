#!/usr/bin/env bash
# shell-lint-ok
# account-switch.sh <tate|code|money> - one-command FOCUSLESS Claude account switch.
#
# Ties the two halves together so the account-cap-autoswitch cron runs ONE command:
#   1. backend/scripts/account-login.sh <target>  (CLI half: starts claude auth login,
#      prints OAUTH_URL + CODE_FILE, waits for the code, then seeds + verifies).
#   2. eos-laptop-agent/scripts/account-switch-browser.js <target>  (browser half:
#      drives the claude.ai OAuth consent FOCUSLESSLY via Emulation.setFocusEmulation
#      - never raises a window / steals focus - and writes the auth code to CODE_FILE).
#
# Per-account login method (Tate 2026-06-22): code@ = Google SSO, money@ = magic-link.
# tate@ is DISABLED (subscription paused 2026-06-22) via ACCOUNTS_DISABLED.
set -uo pipefail
T="${1:?usage: account-switch.sh <tate|code|money>}"

# 2026-06-29 ACCOUNT PIN (universal override). account-switch.sh re-logs in via
# `claude auth login`, which writes the Keychain DIRECTLY - it bypasses
# creds.rotate_to, so the rotate_to pin does not cover it. Honour the same pin file
# here so the operator override holds across BOTH switch mechanisms. Set: write the
# short account name to <COORD_ROOT>/usage/account-pin. Clear: delete it.
PIN_FILE="${COORD_ROOT:-$HOME/.ecodiaos/coordination}/usage/account-pin"
if [ -f "$PIN_FILE" ]; then
  PIN=$(tr -d '[:space:]' < "$PIN_FILE" | cut -d@ -f1)
  if [ -n "$PIN" ] && [ "$PIN" != "$T" ]; then
    echo "REFUSED: live account is PINNED to '$PIN' (account-pin present); not switching to '$T'. Delete $PIN_FILE to allow."
    exit 5
  fi
fi

OUT="/tmp/acct-login-$T.out"
rm -f "$OUT" "/tmp/eos-acct-code-$T.txt"

nohup bash /Users/ecodia/.code/ecodiaos/backend/scripts/account-login.sh "$T" > "$OUT" 2>&1 &
# wait for the OAuth URL (account-login.sh prints it then blocks for CODE_FILE)
for _ in $(seq 1 60); do grep -q '^OAUTH_URL=' "$OUT" 2>/dev/null && break; sleep 0.5; done
grep -q '^OAUTH_URL=' "$OUT" 2>/dev/null || { echo "FAILED: no OAUTH_URL from account-login.sh"; cat "$OUT"; exit 4; }

OAUTH_URL=$(grep '^OAUTH_URL=' "$OUT" | head -1 | sed 's/^OAUTH_URL=//')
CODE_FILE=$(grep '^CODE_FILE=' "$OUT" | head -1 | sed 's/^CODE_FILE=//')

OAUTH_URL="$OAUTH_URL" CODE_FILE="$CODE_FILE" \
  node /Users/ecodia/.code/eos-laptop-agent/scripts/account-switch-browser.js "$T"

# wait for the CLI half to seed + verify
for _ in $(seq 1 60); do grep -qE 'DONE:|FAILED:|TIMEOUT:' "$OUT" 2>/dev/null && break; sleep 1; done
echo "--- account-login.sh result ---"
grep -E 'LOGIN_OK|SEED_OK|CURRENT_ACCOUNT|DONE:|FAILED|TIMEOUT' "$OUT" | tail -4
