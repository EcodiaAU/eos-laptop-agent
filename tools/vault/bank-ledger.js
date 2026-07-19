'use strict'
// tools/vault/bank-ledger.js - the brain of bank monitoring. The phone scrapes the
// recent transactions (an overlapping window each time) plus the shown balance. This
// ledger holds a starting balance and DEDUPS incoming transactions so re-scraping the
// same recent rows never double-counts, carries the running balance forward from the
// transaction stream, and RECONCILES that running balance against the phone-scraped
// balance so any drift (a missed or duplicated row) is caught, not silently wrong.
// Pure logic, no I/O beyond an injected store; unit-tested.
const crypto = require('crypto')

// A transaction: { date:'YYYY-MM-DD', description, amount (signed number: debit -, credit +) }.
// Fingerprint keys a row for dedup. Two genuinely-identical rows on one day (same
// date+desc+amount) are distinguished by an occurrence index so both are kept once
// each across overlapping scrapes, but a re-scrape of the same window adds nothing.
function fingerprint(t) {
  return crypto.createHash('sha256').update([t.date, (t.description || '').trim().toLowerCase(), Number(t.amount).toFixed(2)].join('|')).digest('hex').slice(0, 16)
}

function createLedger(opts) {
  opts = opts || {}
  const startingBalance = Number(opts.startingBalance || 0)
  // state: ordered transactions + a per-fingerprint count (how many of this exact row we have accepted)
  let txns = (opts.transactions || []).slice()
  const counts = new Map()
  for (const t of txns) counts.set(fingerprint(t), (counts.get(fingerprint(t)) || 0) + 1)

  function runningBalance() {
    return Number((startingBalance + txns.reduce((s, t) => s + Number(t.amount), 0)).toFixed(2))
  }

  // applyScrape(scraped) - scraped is the window of recent transactions from one read.
  // Count how many of each fingerprint the scrape shows; accept only the NEW occurrences
  // beyond what we already hold. This makes overlapping windows idempotent while still
  // capturing a genuine second identical charge.
  function applyScrape(scraped) {
    const perFp = new Map()
    let added = 0, skipped = 0
    for (const t of scraped) {
      const fp = fingerprint(t)
      const seenThisScrape = (perFp.get(fp) || 0) + 1
      perFp.set(fp, seenThisScrape)
      const alreadyHave = counts.get(fp) || 0
      if (seenThisScrape > alreadyHave) {      // this occurrence is new
        txns.push({ date: t.date, description: t.description, amount: Number(t.amount) })
        counts.set(fp, seenThisScrape)
        added++
      } else skipped++
    }
    return { added, skipped, runningBalance: runningBalance(), total: txns.length }
  }

  // reconcile(scrapedBalance) - does our carried balance match what the bank shows?
  function reconcile(scrapedBalance) {
    const rb = runningBalance(), sb = Number(scrapedBalance)
    const diff = Number((sb - rb).toFixed(2))
    return { match: Math.abs(diff) < 0.005, runningBalance: rb, scrapedBalance: sb, diff }
  }

  function snapshot() { return { startingBalance, count: txns.length, runningBalance: runningBalance(), transactions: txns } }
  return { applyScrape, reconcile, runningBalance, snapshot }
}

module.exports = { createLedger, fingerprint }
