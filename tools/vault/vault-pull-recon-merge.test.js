'use strict'
// vault-pull-recon-merge.test.js - unit test for mergeReconPages, the build-29 no-clobber recon
// writer. The build-29 flow lands TWO producers into one requestId's recon file during a single
// pull: (a) per-capture `navDom` pages from each bank-csv message (BA's POST-Search /accounts/history/
// view, carrying the account picker + export button - the RICH page), consumed FIRST, and (b) the
// session-end kind:'bank-dom-recon' flush of the page-LOAD pages (balances + history-preload - the
// THIN history twin), consumed LAST. The old bank-dom-recon branch did writeFileSync (overwrite),
// so the late flush ERASED the rich navDom pages. This proves the merge instead keeps the richest
// dump per URL regardless of arrival order, and accumulates distinct URLs. No DB, no real recon dir.
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { mergeReconPages } = require('./vault-pull.js')

function tmpDir() {
  const d = path.join(os.tmpdir(), 'recon-merge-test-' + process.pid + '-' + process.hrtime.bigint().toString(36))
  fs.mkdirSync(d, { recursive: true })
  return d
}
function readFile(dir, requestId) {
  const f = path.join(dir, `bank-dom-recon-${requestId}.json`)
  return JSON.parse(fs.readFileSync(f, 'utf8'))
}

// The page-LOAD /accounts/history/ (thin: search form, NO picker/export) vs the POST-Search
// /accounts/history/ (rich: same URL, MORE elements incl. the account picker + export button).
const HISTORY = 'https://digital.bankaust.com.au/accounts/history/'
const BALANCES = 'https://digital.bankaust.com.au/accounts/balances/'
const historyThin = { url: HISTORY, title: 'History', elCount: 3, els: [{ id: 'TransactionPeriod' }, { id: 'TransactionTypeId' }, { id: 'qs-submit' }] }
const historyRich = { url: HISTORY, title: 'History', elCount: 12, els: [{ id: 'TransactionPeriod' }, { id: 'TransactionTypeId' }, { id: 'qs-submit' }, { id: 'AccountId', text: 'Select account' }, { id: 'ExportCsv', text: 'Export CSV' }, { id: 'a1' }, { id: 'a2' }, { id: 'a3' }, { id: 'a4' }, { id: 'a5' }, { id: 'a6' }, { id: 'a7' }] }
const balances = { url: BALANCES, title: 'Balances', elCount: 5, els: [{ id: 'b1' }, { id: 'b2' }, { id: 'b3' }, { id: 'b4' }, { id: 'b5' }] }

function main() {
  const RID = 'test-recon'

  // -------- 1. navDom lands first (per-capture, rich post-Search page), then the flush lands the
  //            THIN page-load history twin + balances. The rich history page MUST survive. --------
  {
    const dir = tmpDir()
    mergeReconPages(RID, historyRich, dir)                        // bank-csv navDom (single page object)
    let m = mergeReconPages(RID, [historyThin, balances], dir)    // bank-dom-recon flush (array)
    assert.strictEqual(m.pages, 2, 'two distinct URLs merged (history + balances)')
    const out = readFile(dir, RID)
    const h = out.find(p => p.url === HISTORY)
    assert.ok(h, 'history page present')
    assert.strictEqual(h.els.length, 12, 'RICH post-Search history survived the later thin flush (no clobber)')
    assert.ok(h.els.some(e => e.id === 'ExportCsv'), 'the export button element is preserved')
    assert.ok(h.els.some(e => e.id === 'AccountId'), 'the account picker element is preserved')
    fs.rmSync(dir, { recursive: true, force: true })
  }

  // -------- 2. reverse order: thin flush first, rich navDom second - rich still wins. --------
  {
    const dir = tmpDir()
    mergeReconPages(RID, [historyThin, balances], dir)
    mergeReconPages(RID, historyRich, dir)
    const out = readFile(dir, RID)
    const h = out.find(p => p.url === HISTORY)
    assert.strictEqual(h.els.length, 12, 'richest-per-URL holds regardless of arrival order')
    assert.strictEqual(out.length, 2, 'still exactly two URLs')
    fs.rmSync(dir, { recursive: true, force: true })
  }

  // -------- 3. login-page / malformed / urlless entries are dropped, never persisted. --------
  {
    const dir = tmpDir()
    const m = mergeReconPages(RID, [{ skip: 'loginpage', url: 'x' }, { title: 'no url' }, null, historyRich], dir)
    assert.strictEqual(m.pages, 1, 'only the real page kept; skip/malformed dropped')
    const out = readFile(dir, RID)
    assert.strictEqual(out[0].url, HISTORY, 'the surviving page is the history page')
    fs.rmSync(dir, { recursive: true, force: true })
  }

  // -------- 4. elCount fallback when a dump carries no els array (defensive). --------
  {
    const dir = tmpDir()
    mergeReconPages(RID, { url: HISTORY, elCount: 3 }, dir)
    mergeReconPages(RID, { url: HISTORY, elCount: 12 }, dir)
    const out = readFile(dir, RID)
    assert.strictEqual(out[0].elCount, 12, 'richest by elCount when els absent')
    fs.rmSync(dir, { recursive: true, force: true })
  }

  // -------- 5. first write with no prior file creates it cleanly (no crash on missing file). --------
  {
    const dir = tmpDir()
    const m = mergeReconPages('brand-new', balances, dir)
    assert.strictEqual(m.pages, 1, 'first-ever write creates the file')
    fs.rmSync(dir, { recursive: true, force: true })
  }

  console.log('vault-pull recon-merge unit: all assertions passed - no-clobber, richest-per-URL, order-independent, skip/malformed dropped, first-write safe')
}

main()
