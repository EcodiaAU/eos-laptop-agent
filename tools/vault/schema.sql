-- tools/vault/schema.sql - the LOCAL vault store (SQLite on the Mac, vault.db).
-- Seeds are Secure-Enclave-wrapped ciphertext; the SE key is non-extractable and
-- lives ONLY in the Secure Enclave. NO seed material and NO key material ever
-- touches Postgres / kv_store / any Supabase project (red-team T3 invariant,
-- CI-enforced by a key-fingerprint canary). Only ciphertext lives here.
-- Design spec: backend/docs/security/2fa-credential-vault-architecture-2026-07-17.md

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Enrolled seeds. service is the normalized lookup key (UNIQUE => resolveService
-- can never get a duplicate; the app-layer default-DENY is belt to this brace).
CREATE TABLE IF NOT EXISTS vault_seed (
  seed_id             TEXT PRIMARY KEY,           -- uuid
  service             TEXT NOT NULL UNIQUE,        -- normalized (github, google-tate, bank-australia)
  tier                TEXT NOT NULL CHECK (tier IN ('OPEN','GATED','EXCLUDED')),
  backend             TEXT NOT NULL CHECK (backend IN ('totp','email_otp','sms_otp','backup_code','push_to_code')),
  registered_origin   TEXT,                        -- e.g. https://github.com (daemon verifies live tab against this)
  registered_account  TEXT,                        -- e.g. code@ecodia.au (daemon verifies visible account hint)
  seed_ciphertext     BLOB,                        -- SE-wrapped otpauth secret (NULL for non-TOTP backends)
  algorithm           TEXT DEFAULT 'sha1',
  digits              INTEGER DEFAULT 6,
  period              INTEGER DEFAULT 30,
  enrolled_at         TEXT NOT NULL DEFAULT (datetime('now')),
  enrolled_under_presence INTEGER NOT NULL DEFAULT 0,  -- 1 = captured under live human presence (required for GATED)
  is_secondary        INTEGER NOT NULL DEFAULT 0   -- the >=2-resolvers-per-account rule: a spare TOTP seed
);

-- Tier is WRITE-ONCE and immutable (red-team T4): block any UPDATE that changes it.
CREATE TRIGGER IF NOT EXISTS vault_seed_tier_immutable
BEFORE UPDATE OF tier ON vault_seed
FOR EACH ROW WHEN OLD.tier <> NEW.tier
BEGIN
  SELECT RAISE(ABORT, 'tier is immutable: re-enroll out-of-band to change it');
END;

-- Backup codes (durable secrets, two-phase lease/burn). Never handed to the
-- conductor; the daemon fills the next unused code and only marks it consumed on
-- confirmed login (red-team T1/T5 backup-code findings).
CREATE TABLE IF NOT EXISTS vault_backup_code (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  seed_id       TEXT NOT NULL REFERENCES vault_seed(seed_id) ON DELETE CASCADE,
  code_ciphertext BLOB NOT NULL,                  -- SE-wrapped
  state         TEXT NOT NULL DEFAULT 'unused' CHECK (state IN ('unused','leased','consumed')),
  leased_at     TEXT,
  consumed_at   TEXT
);

-- Per-service resolve budget + fail-closed freeze counters (red-team T1 volume).
CREATE TABLE IF NOT EXISTS vault_budget (
  service            TEXT PRIMARY KEY,
  window_start       TEXT NOT NULL DEFAULT (datetime('now')),
  resolves_in_window INTEGER NOT NULL DEFAULT 0,
  consecutive_fails  INTEGER NOT NULL DEFAULT 0,
  frozen             INTEGER NOT NULL DEFAULT 0,   -- 1 = auto-frozen fail-closed, needs manual clear
  frozen_reason      TEXT
);

-- GATED out-of-band approval challenges (red-team T2). One outstanding at a time
-- (concurrency cap enforced app-side). nonce is echoed by the approval app; it is
-- NEVER sent over a conductor-readable transport.
CREATE TABLE IF NOT EXISTS vault_challenge (
  challenge_id  TEXT PRIMARY KEY,                 -- uuid
  service       TEXT NOT NULL,
  nonce         TEXT NOT NULL,                     -- per-challenge random, single-use
  action_summary TEXT NOT NULL,                    -- daemon-attested: what Tate approves
  state         TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','approved','declined','expired')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at    TEXT NOT NULL,
  approved_by   TEXT                               -- 'tate' | 'helen' (secondary approver)
);

-- Append-only audit: every resolve, fill, approval, backup-code burn (red-team
-- audit finding). No secret values, ever.
CREATE TABLE IF NOT EXISTS vault_audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL DEFAULT (datetime('now')),
  service     TEXT,
  tier        TEXT,
  backend     TEXT,
  event       TEXT NOT NULL,                       -- resolve|fill|deny|approval_request|approved|declined|freeze|backup_lease|backup_consume
  detail      TEXT
);
