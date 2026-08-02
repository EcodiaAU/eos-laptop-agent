#!/usr/bin/env bash
# shell-lint-ok
# account-switch.sh <tate|code|money> - THE one sanctioned way to change the live Claude
# account on this machine. Every caller (crons, real-limit-watch, the poller, doctrine,
# muscle memory) points at this name, so the name stays even though the body is now a
# one-line handoff.
#
# The work lives in scripts/switch-run.js (effects) and tools/switch-core.js (judgement).
# What used to be in this file, and why it moved on 2026-08-02:
#
#   * The pin check was duplicated here AND in creds.rotate_to, with two different
#     parsers. One chokepoint owns it now, so a pin cannot be honoured by one path and
#     invisible to the other.
#   * This script ended in `grep -E '...' "$OUT" | tail -4`, so its exit status described
#     the grep rather than the switch. real-limit-watch did not read it either way, and
#     logged every attempt as switch_launched. switch-run.js emits one machine-readable
#     SWITCH_RESULT= line plus a real exit code:
#       0 verified   2 usage   3 in progress   4 no-op (pinned/disabled/already there)
#       5 failed after retries
#   * There was no lock, so the 5-minute poller and the 60-second cap watch could drive
#     two concurrent logins into one machine-wide Keychain.
#   * Nothing reconciled a crash between "claude auth login rewrote the Keychain" and
#     "the labels were updated": a machine on a new account that every local file still
#     described as the old one, with no history row and nothing that noticed.
#
# Login method per account now comes from the accounts registry rather than a comment
# here that had drifted (it claimed tate@ was disabled; tate@ is live and was the live
# account when this was rewritten).
#
# Flags: --dry (preflight only, no side effects), --pin-target (never fall through to
# another account; used by the switch matrix).
exec node /Users/ecodia/.code/eos-laptop-agent/scripts/switch-run.js "$@"
