"use strict";
// Pins the vendored schedule engine byte-identical across both repos so the insert
// path and the dispatcher rearm can never drift again (the exact failure that put
// three divergent parsers in the tree before 2026-06-20). Runs on the dev host
// where both repos are checked out; if the backend path is absent it skips loudly
// rather than passing silently.
const fs = require("fs");
const crypto = require("crypto");
const path = require("path");

const LOCAL = path.join(__dirname, "..", "lib", "schedule-core.js");
const BACKEND = "/Users/ecodia/.code/ecodiaos/backend/src/lib/schedule-core.js";

function sha(p) { return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"); }

const localSha = sha(LOCAL);
if (!fs.existsSync(BACKEND)) {
  console.log(`[SKIP] backend copy not present at ${BACKEND} (not the dev host). Local sha=${localSha}`);
  process.exit(0);
}
const backendSha = sha(BACKEND);
if (localSha !== backendSha) {
  console.error("[XX] schedule-core.js DRIFTED between repos:");
  console.error("     laptop-agent: " + localSha);
  console.error("     backend:      " + backendSha);
  console.error("     Re-vendor: cp " + BACKEND + " " + LOCAL);
  process.exit(1);
}
console.log("[OK] schedule-core.js byte-identical across both repos (" + localSha.slice(0, 16) + "...)");
process.exit(0);
