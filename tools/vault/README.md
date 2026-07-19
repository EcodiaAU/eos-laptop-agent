# EcodiaOS 2FA + credential vault daemon

The non-LLM vault that clears second-factor challenges unattended without a
prompt-injected or mistaken conductor ever leaking a seed or clearing a crown-jewel
login alone. Design spec + threat model (red-teamed 2026-07-17):
`ecodiaos/backend/docs/security/2fa-credential-vault-architecture-2026-07-17.md`.

## Core principle

The daemon FILLS a code into the verified login tab and returns only `{status}`. It
NEVER returns a code, seed, or backup-code set to the conductor. Same zero-knowledge
model as `cdp.nativeFill({credKey}) -> ***REDACTED***`, extended to the second factor.

## Module map (all built + tested, 74 tests green)

| File | Role | Tests |
|---|---|---|
| `totp.js` | RFC 6238 TOTP/HOTP + otpauth parsing. Pure, zero-dep. | 9 (RFC SHA1/256/512 vectors) |
| `registry.js` | service->seed resolution, immutable tier, default-DENY, single choke point | 10 (T4 escalation defences) |
| `submit-2fa.js` | the one conductor-facing primitive: resolve+budget+tier-gate+verify+generate+FILL | 8 |
| `budget.js` | OPEN-tier per-service+global budgets, fail-closed freeze, circuit breaker, single-flight | 8 |
| `backup-codes.js` | two-phase lease/confirm (drain-bug-proof) + low-water alarm | 8 |
| `otp-reader.js` | channel-bound email/SMS: allowlist + watermark + daemon-login correlation | 11 |
| `keystore.js` | seal/open. software AES-256-GCM (dev) + Secure Enclave interface (prod) | 6 (incl full E2E) |
| `seed-store.js` | SQLite (node:sqlite) persistence; enroll/loadRegistry/loadSeed/audit; secrets sealed at rest | 7 |
| `vault-daemon.js` | loopback HTTP service composing all of the above; fail-safe (denies without a real verifier) | 5 (real HTTP E2E) |
| `schema.sql` | local SQLite store; seeds = SE ciphertext, tier immutable at DB layer | probed live |
| `integration.test.js` | real budget composed into submit_2fa, fail-closed | 2 |

Run: `node --test tools/vault/*.test.js`

The daemon RUNS today in software mode: `createDaemon({store, budget, fill, verifyTab}).listen(port)` serves
`POST /enroll`, `POST /submit_2fa` (returns `{status}` only, never a code), `GET /health`, loopback-only.
Production swaps the software keystore for the Secure Enclave backend and injects the real `fill`
(cdp.nativeFill) + `verifyTab` (live-tab origin+account read). Without a real verifier it DENIES, never
blind-fills.

## Tiers (Tate 2026-07-17)

- OPEN (free, budgeted): all dev + code@ accounts. github, google-code, vercel, stripe, xero, canva, bitbucket, apple-dev.
- GATED (out-of-band approval per use): google-tate (SSO, password never seen), bank-australia (LOGIN-ONLY, no money movement).
- EXCLUDED (no seed, ever): tate@ Apple ID, government / ID.

## What remains (needs a device / live account / Tate present, correctly supervised)

1. **Secure Enclave key provisioning** - drop-in for `keystore.js` software backend. Surfaces a Touch ID / keychain prompt, so run under supervision. The `secureEnclaveBackend` refuses until provisioned (fails safe).
2. **Real seedStore / fillFn / verifyTab** - `loadSeed` opens SE ciphertext; `fill` = `cdp.nativeFill` into the live tab; `verifyTab` checks live-tab origin+account vs the registered row.
3. **Daemon HTTP service** wrapping `submit2fa`, exposed to the conductor as `submit_2fa(service, cdp_session_ref)`.
4. **launchd KeepAlive supervision** + SE auto-unlock + conductor-visible liveness endpoint; prove a cold-reboot recovers 2FA end-to-end.
5. **Live-account CDP re-login test** - force a real re-login and watch the daemon clear the prompt.
6. **GATED tier (Phase 6, LAST)**: the approval app (dispatched: `cowork.vault-approval-app-scaffold`) + per-challenge nonce validation KDF-bound to the GATED key + concurrency-cap-1 + habituation caps. Secondary approver: Helen Donohoe (Android).

Build tracker: status_board `entity_ref=vault-2fa-build-2026-07-17`.
