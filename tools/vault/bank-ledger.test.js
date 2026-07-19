'use strict'
const assert = require('assert')
const { createLedger } = require('./bank-ledger.js')

// Start from a known balance (the "you already have the starting balance somewhere" point).
const L = createLedger({ startingBalance: 1000.00 })

// First scrape: a window of recent transactions.
let r = L.applyScrape([
  { date: '2026-07-18', description: 'Coles', amount: -42.10 },
  { date: '2026-07-18', description: 'Salary', amount: 2500.00 },
  { date: '2026-07-17', description: 'Coffee', amount: -5.50 },
])
assert.strictEqual(r.added, 3, 'first scrape adds all 3')
assert.strictEqual(r.runningBalance, 3452.40, 'balance carried from starting + txns')

// Second scrape OVERLAPS the first (banks show the same recent rows) and adds one new row.
// The overlap must NOT double-count - this is the whole point of the ledger.
r = L.applyScrape([
  { date: '2026-07-19', description: 'Rent', amount: -800.00 },   // new
  { date: '2026-07-18', description: 'Coles', amount: -42.10 },   // already have
  { date: '2026-07-18', description: 'Salary', amount: 2500.00 }, // already have
  { date: '2026-07-17', description: 'Coffee', amount: -5.50 },   // already have
])
assert.strictEqual(r.added, 1, 'overlapping re-scrape adds only the genuinely new row')
assert.strictEqual(r.skipped, 3, 'the 3 overlapping rows are skipped, not double-counted')
assert.strictEqual(r.runningBalance, 2652.40, 'balance moved by exactly the new -800 rent')

// A GENUINE second identical charge on the same day must still be captured (two $5.50
// coffees on the 17th). The ledger keeps the second occurrence because the scrape shows
// two, but a later re-scrape still showing two adds nothing.
r = L.applyScrape([
  { date: '2026-07-17', description: 'Coffee', amount: -5.50 },
  { date: '2026-07-17', description: 'Coffee', amount: -5.50 },
])
assert.strictEqual(r.added, 1, 'the genuine second identical coffee is captured')
r = L.applyScrape([
  { date: '2026-07-17', description: 'Coffee', amount: -5.50 },
  { date: '2026-07-17', description: 'Coffee', amount: -5.50 },
])
assert.strictEqual(r.added, 0, 're-scraping the same two coffees adds nothing')
assert.strictEqual(L.runningBalance(), 2646.90, 'balance now reflects exactly two coffees')

// Reconciliation: our carried balance vs what the bank actually shows.
let rec = L.reconcile(2646.90)
assert.strictEqual(rec.match, true, 'carried balance matches the scraped balance')
assert.strictEqual(rec.diff, 0, 'no drift')

// If a transaction was ever missed, reconciliation catches it (the bank shows less than
// we carry) instead of silently reporting a wrong balance.
rec = L.reconcile(2600.00)
assert.strictEqual(rec.match, false, 'a 46.90 drift is flagged, not hidden')
assert.strictEqual(rec.diff, -46.90, 'drift is quantified so I know how much is unexplained')

console.log('bank-ledger: 11/11 assertions passed - dedup idempotent, genuine dup kept, drift caught')
