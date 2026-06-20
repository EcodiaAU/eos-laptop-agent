"use strict";
// Verifies the THREE schedule parsers agree on weekly. The insert-side parsers
// (backend src/routes/mcp/cowork.js _parseCronSchedule and
// mcp-servers/scheduler/index.js parseSchedule+computeNextRun) compute the first
// next_run_at with manual AEST->UTC math; the laptop-agent rearm translates the
// alias to a cron string and resolves it with cron-parser at Brisbane tz. All
// three must land on the SAME UTC instant or a weekly cron drifts after the first
// fire. This test pins that equivalence.
const assert = require("assert");
const cronParser = require("cron-parser");
const { parseSchedule } = require("./scheduler.js");
const TZ = "Australia/Brisbane";

// Verbatim copy of the insert-side manual math (cowork.js / mcp-servers). If this
// copy matches the cron-parser oracle, the real insert code (identical math) does.
function insertWeeklyNext(humanSched, fromMs) {
  const m = humanSched.match(/^weekly\s+(mon|tue|wed|thu|fri|sat|sun)[a-z]*\s+(\d{1,2}):(\d{2})$/i);
  if (!m) return null;
  const DOW = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  const dow = DOW[m[1].toLowerCase()];
  let utcHour = parseInt(m[2]) - 10;
  let utcDow = dow;
  if (utcHour < 0) { utcHour += 24; utcDow = (dow + 6) % 7; }
  const next = new Date(fromMs);
  next.setUTCHours(utcHour, parseInt(m[3]), 0, 0);
  const delta = (utcDow - next.getUTCDay() + 7) % 7;
  next.setUTCDate(next.getUTCDate() + delta);
  if (next <= new Date(fromMs)) next.setUTCDate(next.getUTCDate() + 7);
  return next;
}

function laptopWeeklyNext(humanSched, fromMs) {
  const cron = parseSchedule(humanSched);
  const it = cronParser.CronExpressionParser.parse(cron, { tz: TZ, currentDate: new Date(fromMs) });
  return it.next().toDate();
}

// A few reference "now" points across the week.
const NOWS = [
  Date.UTC(2026, 5, 20, 2, 0, 0),   // Sat 12:00 AEST
  Date.UTC(2026, 5, 22, 23, 30, 0), // Tue 09:30 AEST
  Date.UTC(2026, 5, 18, 14, 0, 0),  // Fri 00:00 AEST
];
const CASES = ["weekly mon 09:17", "weekly sun 14:30", "weekly fri 00:30", "weekly wed 23:45", "weekly monday 06:00"];

let fails = 0;
for (const sched of CASES) {
  // cron string is well-formed (5 fields)
  const cron = parseSchedule(sched);
  assert.match(cron, /^\d{1,2} \d{1,2} \* \* [0-6]$/, `bad cron for ${sched}: ${cron}`);
  for (const now of NOWS) {
    const a = insertWeeklyNext(sched, now);
    const b = laptopWeeklyNext(sched, now);
    const same = a && b && a.getTime() === b.getTime();
    // also assert the laptop instant really is the right weekday+time in Brisbane
    const bris = new Date(b.toLocaleString("en-US", { timeZone: TZ }));
    const wantDow = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }[sched.split(/\s+/)[1].slice(0, 3).toLowerCase()];
    const [, , hhmm] = sched.split(/\s+/);
    const wantH = parseInt(hhmm.split(":")[0]);
    const dowOK = bris.getDay() === wantDow;
    const hourOK = bris.getHours() === wantH;
    const ok = same && dowOK && hourOK && b > new Date(now);
    if (!ok) fails++;
    console.log(`  [${ok ? "OK" : "XX"}] ${sched} @${new Date(now).toISOString()} -> insert=${a && a.toISOString()} laptop=${b.toISOString()} brisDow=${bris.getDay()}/${wantDow} brisH=${bris.getHours()}/${wantH}`);
  }
}
// daily + interval still parse (no regression)
assert.strictEqual(parseSchedule("daily 09:00"), "0 9 * * *");
assert.strictEqual(parseSchedule("every 30m"), "*/30 * * * *");
assert.strictEqual(parseSchedule("every 2h"), "0 */2 * * *");
console.log(`\nweekly-equivalence: ${CASES.length * NOWS.length - fails}/${CASES.length * NOWS.length} passed; daily/interval regression OK`);
process.exit(fails ? 1 : 0);
