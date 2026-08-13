'use strict'
// Offline unit test for the Phase 1 BA phone-vault -> staged_transactions normaliser.
// No DB: exercises parseBaBody + baDirectionSign + looksLikeBaBody against a fixture blob
// shaped exactly like the live BA online-banking body (the ba-feed-20260813 read).
const assert = require('assert')
const { parseBaBody, baDirectionSign, looksLikeBaBody, isBankResult } = require('./vault-pull.js')

// A trimmed multi-account body: header noise + two accounts, covering every sign case.
const BLOB = [
  'Welcome Tate Jayden Donohoe',
  'Tate Everyday',
  'Acc 12566110',
  'Avail. $0.92',
  'DateDescriptionAmount',
  '13/08/2026Transfer to SAV 12579148 to Ecodia Pty Ltd --$814.00',        // OUT (transfer, double dash)
  '13/08/2026VISA-COLES 4435 BUDDINA AU#4451(Ref.081301642243) Apple Pay-$46.31', // OUT (card, single dash)
  '12/08/2026Osko Payment From T J DONOHOE$809.00',                        // IN (credit, no dash)
  '12/08/2026Received from SAV 12579148 Transfer from T J Donohoe -$1.97', // IN (credit, misleading single dash)
  '10/08/2026Insufficient funds #51 - APPLE.COM/BILL$0.00',               // DECLINE (amount 0)
  'Commercial Access',
  'Acc 12579148',
  'DateDescriptionAmount',
  '13/08/2026Osko Payment To C DONOHOE +61-407444189 Ref#995396403-$75.00', // OUT (osko to; +61 phone stays in desc)
  '30/07/2026Transfer to SAV 12566110 to T J Donohoe --$2,700.00',          // OUT (comma amount)
  '12/08/2026Insufficient funds #51 - XERO AU INV-546$0.00',               // DECLINE
  '12/08/2026Insufficient funds #51 - XERO AU INV-546$0.00',               // DECLINE (genuine same-day duplicate)
  'Bank Australia Limited | ABN 21 087 651 607',
].join('\n')

const { rows, unmapped } = parseBaBody(BLOB)
assert.strictEqual(unmapped.length, 0, 'all account numbers mapped')

const p = rows.filter(r => r.source_account === 'ba_personal')
const e = rows.filter(r => r.source_account === 'ba_ecodia')
assert.strictEqual(p.length, 5, 'ba_personal: 5 rows')
assert.strictEqual(e.length, 4, 'ba_ecodia: 4 rows')

// signs derived from wording, not dash count
const find = (arr, sub) => arr.find(r => r.descr.includes(sub))
assert.strictEqual(find(p, 'Transfer to SAV 12579148').cents, -81400, 'transfer-to = OUT')
assert.strictEqual(find(p, 'VISA-COLES').cents, -4631, 'VISA card = OUT')
assert.strictEqual(find(p, 'Osko Payment From').cents, 80900, 'osko-from = IN')
assert.strictEqual(find(p, 'Received from SAV 12579148').cents, 197, 'received-from = IN despite single-dash scrape')
assert.strictEqual(find(p, 'APPLE.COM/BILL').cents, 0, 'insufficient-funds decline = 0')
assert.strictEqual(find(p, 'APPLE.COM/BILL').isDecline, true, 'decline flagged')
assert.strictEqual(find(e, 'Osko Payment To').cents, -7500, 'osko-to = OUT, +61 phone kept in desc')
assert.ok(find(e, 'Osko Payment To').descr.includes('+61-407444189'), 'phone number retained in description')
assert.strictEqual(find(e, 'Transfer to SAV 12566110').cents, -270000, 'comma amount 2,700.00 -> -270000')

// two identical XERO declines both captured (count-topup will insert both)
const xero = e.filter(r => r.descr.includes('XERO AU INV-546'))
assert.strictEqual(xero.length, 2, 'genuine same-day duplicate declines both parsed')

// classifier direct checks
assert.strictEqual(baDirectionSign('Transfer to SAV x', '--'), -1)
assert.strictEqual(baDirectionSign('Received from SAV x', '-'), 1, 'wording overrides single dash')
assert.strictEqual(baDirectionSign('Osko Payment From y', ''), 1)
assert.strictEqual(baDirectionSign('VISA-MERCHANT', '-'), -1)
assert.strictEqual(baDirectionSign('Unknown mystery row', '--'), -1, 'unknown double-dash -> OUT fallback')
assert.strictEqual(baDirectionSign('Unknown mystery row', ''), 1, 'unknown no-dash -> IN fallback')

// bank-body detection
assert.ok(looksLikeBaBody(BLOB), 'BA body recognised')
assert.ok(!looksLikeBaBody('some unrelated scraped otp field'), 'non-BA blob rejected')
assert.ok(isBankResult({ service: 'Bank+Australia', value: BLOB }), 'bank result via service+value')
assert.ok(!isBankResult({ kind: 'field', service: 'GitHub', value: 'otp 123456' }), 'non-bank field not a bank result')

console.log('vault-pull normalise unit: 21/21 - wording-derived signs, comma amounts, declines, duplicates, bank detection')
process.exit(0)
