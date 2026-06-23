"use strict";
// ─────────────────────────────────────────────────────────────────────────────
// SINGLE SOURCE OF TRUTH for EcodiaOS schedule semantics.
//
// This file is vendored BYTE-IDENTICAL into both repositories:
//   - ecodiaos-backend/src/lib/schedule-core.js   (the insert path)
//   - eos-laptop-agent/lib/schedule-core.js        (the dispatcher rearm path)
// A checksum test in each repo pins them identical, so the two can never drift.
// Before 2026-06-20 there were THREE separate schedule parsers and intervals over
// 23h were silently mis-fired: "every Nh" was faked into "0 */N * * *", which
// cron-parser collapses to daily-at-00:00 (so "every 168h" actually ran daily).
// Doctrine: patterns/scheduler-one-schedule-engine-2026-06-20.md
//
// Grammar (times/days are LOCAL to tz; default Australia/Brisbane, UTC+10 no DST):
//   "every <N>m" / "every <N>h"   -> interval, ANY N (pure ms math, never cron)
//   "daily HH:MM"                 -> cron  "M H * * *"
//   "weekly <mon-sun> HH:MM"      -> cron  "M H * * D"
//   "monthly on day <N> at HH:MM" -> cron  "M H N * *"  (once a month, day N)
//   a raw 5/6-field cron string   -> cron, passthrough (lists/steps/ranges/dom/month)
//
// Intervals are wall-clock-agnostic (next = from + period). Cron is evaluated by
// cron-parser against the row tz. Both repos depend on cron-parser; using a shared
// library for cron evaluation is not drift, re-implementing the parser was.
// ─────────────────────────────────────────────────────────────────────────────

const { CronExpressionParser } = require("cron-parser");

const DEFAULT_TZ = "Australia/Brisbane";
const DOW = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

// expr -> { kind:'interval', ms } | { kind:'cron', cron } | null
function classify(expr) {
  const s = String(expr == null ? "" : expr).trim();
  if (!s) return null;
  const every = s.match(/^every\s+(\d+)\s*([mh])$/i);
  if (every) {
    const n = parseInt(every[1], 10);
    if (!(n > 0)) return null;
    const ms = every[2].toLowerCase() === "h" ? n * 3600000 : n * 60000;
    return { kind: "interval", ms };
  }
  const daily = s.match(/^daily\s+(\d{1,2}):(\d{2})$/i);
  if (daily) {
    const h = parseInt(daily[1], 10), m = parseInt(daily[2], 10);
    if (h > 23 || m > 59) return null;
    return { kind: "cron", cron: `${m} ${h} * * *` };
  }
  const weekly = s.match(/^weekly\s+(mon|tue|wed|thu|fri|sat|sun)[a-z]*\s+(\d{1,2}):(\d{2})$/i);
  if (weekly) {
    const h = parseInt(weekly[2], 10), m = parseInt(weekly[3], 10);
    if (h > 23 || m > 59) return null;
    return { kind: "cron", cron: `${m} ${h} * * ${DOW[weekly[1].toLowerCase()]}` };
  }
  // "monthly on day N at HH:MM" -> cron "M H N * *". Fires once a month on
  // day-of-month N at the given local time. The "on" and "at" words are optional
  // ("monthly day 28 09:00" is accepted). A day greater than a given month's
  // length is skipped by cron-parser per standard cron dom semantics (day 31
  // fires only in 31-day months); for fixed-month cadences like quarterly BAS,
  // use a raw cron with an explicit month list ("0 9 28 1,4,7,10 *").
  const monthly = s.match(/^monthly(?:\s+on)?\s+day\s+(\d{1,2})(?:\s+at)?\s+(\d{1,2}):(\d{2})$/i);
  if (monthly) {
    const dom = parseInt(monthly[1], 10), h = parseInt(monthly[2], 10), m = parseInt(monthly[3], 10);
    if (dom < 1 || dom > 31 || h > 23 || m > 59) return null;
    return { kind: "cron", cron: `${m} ${h} ${dom} * *` };
  }
  // Raw cron: 5 or 6 whitespace-separated fields of cron-legal characters.
  if (/^[\d*/,\-]+(\s+[\d*/,\-]+){4,5}$/.test(s)) return { kind: "cron", cron: s };
  return null;
}

function _cron(cron, fromDate, tz) {
  return CronExpressionParser.parse(cron, { tz: tz || DEFAULT_TZ, currentDate: fromDate });
}

// Next fire strictly after fromDate. Date | null (null = unparseable).
function nextRun(expr, fromDate, tz) {
  const c = classify(expr);
  if (!c) return null;
  const from = fromDate instanceof Date ? fromDate : new Date(fromDate || Date.now());
  if (c.kind === "interval") return new Date(from.getTime() + c.ms);
  try { return _cron(c.cron, from, tz).next().toDate(); } catch (_e) { return null; }
}

// Most recent fire at/before fromDate. Date | null. Used by the reentry guard.
function prevRun(expr, fromDate, tz) {
  const c = classify(expr);
  if (!c) return null;
  const from = fromDate instanceof Date ? fromDate : new Date(fromDate || Date.now());
  if (c.kind === "interval") return new Date(from.getTime() - c.ms);
  try { return _cron(c.cron, from, tz).prev().toDate(); } catch (_e) { return null; }
}

// Gap between two consecutive fires in ms. number | null. Used by the anomaly detector.
function periodMs(expr, tz) {
  const c = classify(expr);
  if (!c) return null;
  if (c.kind === "interval") return c.ms;
  try {
    const it = _cron(c.cron, new Date(), tz);
    const a = it.next().toDate().getTime();
    const b = it.next().toDate().getTime();
    return b - a > 0 ? b - a : null;
  } catch (_e) { return null; }
}

// True if expr is a schedule this engine understands.
function isValid(expr) { return classify(expr) != null; }

module.exports = { classify, nextRun, prevRun, periodMs, isValid, DEFAULT_TZ };
