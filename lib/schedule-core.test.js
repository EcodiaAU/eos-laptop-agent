"use strict";
// Unit tests for the shared schedule engine, vendored byte-identical from the
// backend. The headline regression cases are the intervals over 23h that the old
// "every Nh -> 0 */N * * *" translation silently broke; the 2026-06-23 additions
// are the "monthly on day N at HH:MM" form and the full raw-cron passthrough that
// schedule_cron previously could not express (BAS quarterly etc).
const assert = require("assert");
const S = require("./schedule-core");
const TZ = "Australia/Brisbane";
let fails = 0;
function check(name, cond) {
  if (!cond) { fails++; console.log(`  [XX] ${name}`); } else { console.log(`  [OK] ${name}`); }
}

// ── classify: existing forms (regression) ──
check("every 30m -> interval 1800000", JSON.stringify(S.classify("every 30m")) === JSON.stringify({ kind: "interval", ms: 1800000 }));
check("every 2h -> interval 7200000", JSON.stringify(S.classify("every 2h")) === JSON.stringify({ kind: "interval", ms: 7200000 }));
check("every 168h -> interval (NOT cron)", S.classify("every 168h").kind === "interval" && S.classify("every 168h").ms === 168 * 3600000);
check("every 720h -> interval", S.classify("every 720h").ms === 720 * 3600000);
check("daily 09:00 -> cron 0 9 * * *", S.classify("daily 09:00").cron === "0 9 * * *");
check("weekly mon 09:17 -> cron 17 9 * * 1", S.classify("weekly mon 09:17").cron === "17 9 * * 1");
check("weekly sunday 14:30 -> cron 30 14 * * 0", S.classify("weekly sunday 14:30").cron === "30 14 * * 0");
check("garbage -> null", S.classify("not a schedule") === null);
check("empty -> null", S.classify("") === null && S.classify(null) === null);
check("daily 25:00 -> null (bad hour)", S.classify("daily 25:00") === null);

// ── classify: full raw cron (5/6-field) passthrough ──
check("raw 5-field cron passthrough", S.classify("0 6 * * 1,3,5").cron === "0 6 * * 1,3,5");
check("raw cron with dom/month (BAS quarterly)", S.classify("0 9 28 1,4,7,10 *").kind === "cron" && S.classify("0 9 28 1,4,7,10 *").cron === "0 9 28 1,4,7,10 *");
check("raw cron 1st of month 14:30", S.classify("30 14 1 * *").cron === "30 14 1 * *");
check("raw 6-field cron passthrough", S.classify("0 0 9 28 1,4,7,10 *").kind === "cron");
check("raw cron with step/range", S.classify("*/15 9-17 * * 1-5").cron === "*/15 9-17 * * 1-5");

// ── classify: "monthly on day N at HH:MM" (new form) ──
check("monthly on day 28 at 09:00 -> cron 0 9 28 * *", S.classify("monthly on day 28 at 09:00").cron === "0 9 28 * *");
check("monthly on day 1 at 14:30 -> cron 30 14 1 * *", S.classify("monthly on day 1 at 14:30").cron === "30 14 1 * *");
check("monthly day 15 09:05 (no on/at) -> cron 5 9 15 * *", S.classify("monthly day 15 09:05").cron === "5 9 15 * *");
check("monthly on day 31 at 23:59 -> cron 59 23 31 * *", S.classify("monthly on day 31 at 23:59").cron === "59 23 31 * *");
check("MONTHLY ON DAY 5 AT 08:00 (case-insensitive)", S.classify("MONTHLY ON DAY 5 AT 08:00").cron === "0 8 5 * *");
check("monthly is a cron kind", S.classify("monthly on day 28 at 09:00").kind === "cron");
// negatives
check("monthly day 0 -> null (bad dom)", S.classify("monthly on day 0 at 09:00") === null);
check("monthly day 32 -> null (bad dom)", S.classify("monthly on day 32 at 09:00") === null);
check("monthly day 28 25:00 -> null (bad hour)", S.classify("monthly on day 28 at 25:00") === null);
check("monthly day 28 09:60 -> null (bad minute)", S.classify("monthly on day 28 at 09:60") === null);
check("monthly missing time -> null", S.classify("monthly on day 28") === null);

// ── interval nextRun: the bug that was silently broken for >23h ──
const t0 = new Date("2026-06-20T00:00:00.000Z");
check("every 30m next = +30m", S.nextRun("every 30m", t0).getTime() === t0.getTime() + 1800000);
check("every 168h next = +7d (was daily!)", S.nextRun("every 168h", t0).getTime() === t0.getTime() + 168 * 3600000);
check("every 720h next = +30d", S.nextRun("every 720h", t0).getTime() === t0.getTime() + 720 * 3600000);
check("interval periodMs exact", S.periodMs("every 168h") === 168 * 3600000);

// ── cron nextRun via cron-parser at Brisbane tz ──
const dailyNext = S.nextRun("daily 09:00", new Date("2026-06-20T02:00:00.000Z"), TZ); // 12:00 AEST -> next 09:00 AEST tomorrow
check("daily 09:00 lands 09:00 Brisbane", new Date(dailyNext.toLocaleString("en-US", { timeZone: TZ })).getHours() === 9);
const wkNext = S.nextRun("weekly mon 09:17", new Date("2026-06-20T02:00:00.000Z"), TZ);
const wkBris = new Date(wkNext.toLocaleString("en-US", { timeZone: TZ }));
check("weekly mon lands Monday 09:17 Brisbane", wkBris.getDay() === 1 && wkBris.getHours() === 9 && wkBris.getMinutes() === 17);
check("raw cron 0 9 * * 1 == weekly mon 09:00", S.nextRun("0 9 * * 1", t0, TZ).getTime() === S.nextRun("weekly mon 09:00", t0, TZ).getTime());

// ── new-form nextRun lands on the right wall-clock in AEST ──
// "monthly on day 28 at 09:00" from 2026-06-23 -> 2026-06-28 09:00 Brisbane.
const monNext = S.nextRun("monthly on day 28 at 09:00", new Date("2026-06-23T00:00:00.000Z"), TZ);
const monBris = new Date(monNext.toLocaleString("en-US", { timeZone: TZ }));
check("monthly day 28 lands the 28th 09:00 Brisbane", monBris.getDate() === 28 && monBris.getHours() === 9 && monBris.getMinutes() === 0);
check("monthly day 28 09:00 == raw cron 0 9 28 * *", S.nextRun("monthly on day 28 at 09:00", t0, TZ).getTime() === S.nextRun("0 9 28 * *", t0, TZ).getTime());
// BAS quarterly raw cron from 2026-06-23 -> next is 2026-07-28 09:00 Brisbane (Jul is in 1,4,7,10).
const basNext = S.nextRun("0 9 28 1,4,7,10 *", new Date("2026-06-23T00:00:00.000Z"), TZ);
const basBris = new Date(basNext.toLocaleString("en-US", { timeZone: TZ }));
check("BAS quarterly lands Jul 28 09:00 Brisbane", basBris.getMonth() === 6 && basBris.getDate() === 28 && basBris.getHours() === 9);

// ── cron periodMs ──
check("daily periodMs = 24h", S.periodMs("daily 09:00", TZ) === 24 * 3600000);
check("0 */2 * * * periodMs = 2h", S.periodMs("0 */2 * * *", TZ) === 2 * 3600000);

// ── prevRun (reentry guard) ──
check("interval prev = -period", S.prevRun("every 30m", t0).getTime() === t0.getTime() - 1800000);
check("cron prev <= from", S.prevRun("daily 09:00", new Date("2026-06-20T02:00:00.000Z"), TZ) < new Date("2026-06-20T02:00:00.000Z"));
check("monthly prevRun <= from", S.prevRun("monthly on day 28 at 09:00", new Date("2026-06-23T00:00:00.000Z"), TZ) < new Date("2026-06-23T00:00:00.000Z"));

// ── isValid surface ──
check("isValid monthly true", S.isValid("monthly on day 28 at 09:00") === true);
check("isValid BAS cron true", S.isValid("0 9 28 1,4,7,10 *") === true);
check("isValid garbage false", S.isValid("nope") === false);

console.log(`\nschedule-core: ${fails ? fails + " FAILED" : "all passed"}`);
process.exit(fails ? 1 : 0);
