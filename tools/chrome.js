// chrome.js - high-level Chrome GUI orchestration on top of input.* + screenshot.
//
// Doctrine: ~/ecodiaos/patterns/drive-chrome-via-input-tools-not-browser-tools.md.
// This module DOES NOT spawn or kill Chrome. It DOES NOT use puppeteer or CDP.
// It uses input.* (SendKeys-based) and screenshot.* (OS-level) only.
//
// switchProfile is currently a STUB. The implementation requires real avatar +
// profile-menu coordinates from a Tate-recorded observation pass against live
// Chrome on Corazon (~/ecodiaos/patterns/macros-record-mode-and-auto-author-from-runs.md
// Phase 1 observation rule). Calling switchProfile before that pass throws
// with a clear pointer to the doctrine.

const input = require('./input');
const screenshot = require('./screenshot');

// Profile registry. Maps app slug -> Chrome profile metadata.
// Keep in code for now; future enhancement: read from kv_store via a backend RPC.
// Source: ~/ecodiaos/docs/secrets/corazon.md profile mapping.
const PROFILE_REGISTRY = {
  'ecodia-internal': { profileDir: 'Default',   displayName: 'ecodia.au' },
  'coexist':         { profileDir: 'Profile 1', displayName: 'Tate' },
  // Future entries: ordit, roam, etc. Each gets its own profile when login state diverges.
};

// resolveProfileForApp - lookup helper.
// Returns { profileDir, displayName } or the ecodia-internal default if unknown app.
function resolveProfileForApp(p) {
  const { app } = p || {};
  if (!app) return PROFILE_REGISTRY['ecodia-internal'];
  return PROFILE_REGISTRY[app] || PROFILE_REGISTRY['ecodia-internal'];
}

// listProfiles - returns the full registry for inspection.
function listProfiles() {
  return Object.entries(PROFILE_REGISTRY).map(([app, meta]) => ({ app, ...meta }));
}

// switchProfile - STUB. Phase 2 calibration required.
async function switchProfile(p) {
  const { profileDir, displayName, app } = p || {};
  // Resolve target profile from any of the accepted forms so error messages are clear.
  let target = null;
  if (profileDir || displayName) {
    target = { profileDir, displayName };
  } else if (app) {
    target = resolveProfileForApp({ app });
  }

  throw new Error(
    `chrome.switchProfile is a Phase 1 stub. Target=${JSON.stringify(target)}. ` +
    `Implementation requires Tate-recorded observation pass on Corazon to ` +
    `capture: (1) Chrome avatar button coords on Tate's display geometry, ` +
    `(2) profile menu entry coords for each named profile in PROFILE_REGISTRY. ` +
    `Once captured, this stub becomes the input.click sequence: avatar -> menu -> profile entry. ` +
    `See ~/ecodiaos/patterns/macros-record-mode-and-auto-author-from-runs.md Phase 1 observation rule. ` +
    `See ~/ecodiaos/drafts/pm2-chrome-profile-per-call-spec-2026-04-29.md for the full spec.`
  );
}

// detectCurrentProfile - reads Chrome's local Profile state to report which profile
// is currently focused. Read-only, doctrine-aligned (no GUI manipulation).
// Implementation: read User Data\Local State JSON via filesystem.readFile,
// extract last_used profile. Returns { profileDir, displayName } from registry
// or { profileDir: '<unknown>', displayName: null } if not in registry.
async function detectCurrentProfile() {
  const fs = require('fs').promises;
  const path = require('path');
  const localAppData = process.env.LOCALAPPDATA || 'C:\\Users\\Tate\\AppData\\Local';
  const localStatePath = path.join(localAppData, 'Google', 'Chrome', 'User Data', 'Local State');
  try {
    const raw = await fs.readFile(localStatePath, 'utf8');
    const state = JSON.parse(raw);
    const lastUsed = state?.profile?.last_used || 'Default';
    const match = Object.entries(PROFILE_REGISTRY).find(([_, m]) => m.profileDir === lastUsed);
    return match
      ? { profileDir: lastUsed, displayName: match[1].displayName, app: match[0] }
      : { profileDir: lastUsed, displayName: null, app: null };
  } catch (err) {
    return { error: 'cannot_read_local_state', detail: err.message };
  }
}

module.exports = {
  switchProfile,
  resolveProfileForApp,
  listProfiles,
  detectCurrentProfile,
};
