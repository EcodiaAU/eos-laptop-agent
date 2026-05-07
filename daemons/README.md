# GKG capture daemon (Corazon)

Phase 1 Corazon-half of the GUI Knowledge Graph (GKG). Spec: `~/ecodiaos/docs/gkg-spec-v0.1.md` §3.1 + §4.

## Files

| File | Purpose |
|---|---|
| `gkg-capture.ahk` | The daemon. AutoHotkey v2. Hooks foreground/keyboard/mouse, redacts sensitive input, periodically screenshots, batches to NDJSON, HMAC-signs and POSTs to `/api/gkg/ingest`. |
| `gkg-allowlist.json` | Generous default allowlist. App in scope iff `process_name` matches `native_processes` or window title/URL contains a `browser_urls` substring. |
| `.env.example` | Template for the HMAC secret env file. Copy to `.env` and fill in `GKG_DAEMON_HMAC_SECRET` from `kv_store.gkg.daemon_hmac_secret`. |
| `.env` | NOT in git. Holds the HMAC shared secret. |
| `install-gkg-capture.ps1` | Registers a Windows Scheduled Task to auto-start the daemon at logon and starts it immediately. |

## Install (Corazon)

1. Pull the repo so this dir lands at `D:\.code\eos-laptop-agent\daemons\`.
2. Install AutoHotkey v2 from https://www.autohotkey.com/v2 if not already present.
3. Probe the HMAC secret on the VPS:

       ssh ecodia-vps "psql -t -c \"SELECT value FROM kv_store WHERE key='gkg.daemon_hmac_secret'\""

   (Or use the Supabase MCP `db_query` tool from EcodiaOS.)

4. `Copy-Item .env.example .env`, replace `REPLACE_ME_WITH_KV_STORE_VALUE` with the secret.
5. Run the install script:

       cd D:\.code\eos-laptop-agent\daemons
       powershell -ExecutionPolicy Bypass -File .\install-gkg-capture.ps1

6. Verify the AutoHotkey tray icon is visible. Right-click → Pause Capture / Resume Capture.

## Smoke run (60s)

After install, do normal work for ~60s in any allowlisted app (e.g. open `developer.apple.com` in Chrome). Then on the VPS:

```sql
SELECT count(*) AS events,
       count(DISTINCT session_id) AS sessions,
       max(redacted_count) AS max_redacted,
       max(ingested_at) AS latest
FROM gkg_events
WHERE ingested_at > now() - interval '5 minutes';
```

Acceptance: events > 30, sessions = 1, latest within last 30s.

## Verify encryption

`payload_ciphertext` should be base64, not plaintext JSON. Spot-check:

```sql
SELECT event_type, length(payload_ciphertext) AS cipher_len, payload_iv, payload_auth_tag
FROM gkg_events ORDER BY ingested_at DESC LIMIT 3;
```

`payload_iv` = base64-encoded 12 bytes (length 16). `payload_auth_tag` = base64-encoded 16 bytes (length 24). `payload_ciphertext` = base64 of AES-256-GCM ciphertext (variable length).

## Privacy posture

- **Allowlist gate:** events outside the allowlist are dropped at capture (one `allowlist_skip` ping per app per minute for visibility).
- **Sensitive-context redaction:** when window title contains a `redaction_field_patterns` substring (`password`, `pin`, `secret`, `token`, `api_key`, `2fa`, `verification`, `cvv`, `ssn`, `tax id`, `tfn`, `ein`), key payloads are NOT captured; only an `input_redacted` event is emitted with `redaction_reason`.
- **VPS-side encryption at rest:** the VPS encrypts payloads with AES-256-GCM (`kv_store.gkg.tate_payload_key`). The daemon is HMAC-only; it does not see the encryption key.
- **Tray pause toggle:** capture is gated by an in-process `g_paused` flag wired to two tray menu items. Default = Resumed.

## Known v1 limitations

- UIA per-element capture is window-level only. Phase 1.5 will add per-element name + role + automation_id at click time using `UIAutomationCore.dll` via AHK COM.
- Chrome URL is not extracted from the window title (Chrome doesn't put URL there). The VPS-side classifier uses `process_name` and host substrings via the page title for app-bucket assignment in Phase 1; Phase 1.5 will add a UIA address-bar scrape.
- Screenshot capture uses `powershell` shell-out per frame (~150ms). Acceptable for 5s cadence; bump to a persistent GDI+ helper in Phase 2 if cost matters.

## Status

Phase 1 ship: status_board row `04599f46-b09f-4958-8129-01bf8e693109`. Authored by `fork_mov5fcpf_fb840a` 2026-05-07.
