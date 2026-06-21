"use strict";
// Proves the live dispatcher rearm (scheduler.js computeNextRunAt) is wired to the
// shared engine, so insert-time and rearm-time agree by construction, and that the
// interval-over-23h bug is dead in the LIVE path ("every 168h" now steps 7 days,
// not daily). Companion to backend/src/lib/schedule-core.test.js (engine) and
// schedule-core-identity.test.js (cross-repo byte-identity).
const assert = require("assert");
const sched = require("./scheduler.js");
const core = require("../lib/schedule-core");
const TZ = "Australia/Brisbane";
let fails = 0;
const ok = (name, cond) => { if (!cond) { fails++; console.log(`  [XX] ${name}`); } else console.log(`  [OK] ${name}`); };

const from = new Date("2026-06-20T02:00:00.000Z");
const SCHEDULES = ["every 30m", "every 4h", "every 72h", "every 168h", "daily 09:00", "weekly mon 09:17", "0 9 * * 1", "0 */6 * * *"];

// computeNextRunAt (live rearm) must equal the shared engine for every form.
for (const expr of SCHEDULES) {
  const row = { type: "cron", cron_expression: expr, tz: TZ };
  const live = sched.computeNextRunAt(row, from);
  const want = core.nextRun(expr, from, TZ).toISOString();
  ok(`rearm == engine for "${expr}"`, live === want);
}

// The headline fix: every 168h steps a true 7 days each rearm, in the LIVE path.
let t = new Date("2026-06-20T00:00:00.000Z");
const gaps = [];
for (let i = 0; i < 3; i++) {
  const next = new Date(sched.computeNextRunAt({ type: "cron", cron_expression: "every 168h", tz: TZ }, t));
  gaps.push(Math.round((next - t) / 86400000));
  t = new Date(next.getTime() + 1000);
}
ok("every 168h rearms at 7-day gaps (was daily)", gaps.every((g) => g === 7));

// Anomaly detector + reentry guard read the shared engine without throwing.
ok("runCountAnomalyForRow period for every 168h = 7d", (() => {
  const a = sched.runCountAnomalyForRow({ type: "cron", cron_expression: "every 168h", tz: TZ, created_at: new Date(from.getTime() - 86400000).toISOString(), run_count: 1 }, from);
  return a && a.periodMs === 168 * 3600000;
})());
ok("cronAlreadyRanThisPeriod returns boolean for interval", typeof sched.cronAlreadyRanThisPeriod({ type: "cron", cron_expression: "every 168h", tz: TZ, last_run_at: new Date(from.getTime() - 1000).toISOString() }, from) === "boolean");

console.log(`\nschedule-rearm-wiring: ${fails ? fails + " FAILED" : "all passed"}`);
process.exit(fails ? 1 : 0);
