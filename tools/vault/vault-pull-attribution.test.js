// vault-pull-attribution.test.js - unit test for resolveBankCsvAccount, the bank-feed multi-capture
// attribution logic. BA names every export StatementCsv.csv and the CSV body has no account column,
// so a captured CSV is attributed from (1) an explicit valid account tag, else (2) the on-screen
// account number in the hash-bound pageContext, and NEVER guessed when ambiguous. A wrong tag would
// silently corrupt world-model cash truth, so every unresolved case must return null.
const crypto = require('crypto')
const { resolveBankCsvAccount, BA_ACCOUNT_MAP, BA_CSV_ACCOUNTS } = require('./vault-pull.js')

let pass = 0, fail = 0
function eq(got, want, label) {
  if (got === want) { pass++ }
  else { fail++; console.error(`  FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')
// A realistic statement-page context: BA shows the account number somewhere in the page text.
const page = (num) => `Bank Australia\nTransactions\nAccount ${num}\nEffective Date Entered Date Description Amount Balance\n01/08/2026 01/08/2026 Osko Payment $50.00 $1,234.00`

// 1. explicit valid tag wins (legacy per-account link)
eq(resolveBankCsvAccount({ account: 'ba_ecodia' }).account, 'ba_ecodia', 'valid tag -> account')
eq(resolveBankCsvAccount({ account: 'ba_ecodia' }).via, 'tag', 'valid tag -> via=tag')

// 2. every known account number resolves to its source_account via pageContext
for (const [num, acct] of Object.entries(BA_ACCOUNT_MAP)) {
  const ctx = page(num)
  const r = resolveBankCsvAccount({ account: '', pageContext: ctx, pageContextSha256: sha(ctx) })
  eq(r.account, acct, `pageContext ${num} -> ${acct}`)
}

// 3. ambiguous: two known numbers on the page -> null (never guess)
{
  const ctx = `${page('12566110')}\nInternal transfer to ${'12566111'}`
  const r = resolveBankCsvAccount({ account: '', pageContext: ctx, pageContextSha256: sha(ctx) })
  eq(r.account, null, 'two account numbers -> null')
}

// 4. no known number on the page -> null
{
  const ctx = 'Bank Australia\nWelcome\nNothing account-identifying here'
  eq(resolveBankCsvAccount({ account: '', pageContext: ctx, pageContextSha256: sha(ctx) }).account, null, 'no number -> null')
}

// 5. pageContext hash mismatch -> null (integrity: the text was altered vs what the phone signed)
{
  const ctx = page('12579148')
  const r = resolveBankCsvAccount({ account: '', pageContext: ctx, pageContextSha256: sha('DIFFERENT') })
  eq(r.account, null, 'hash mismatch -> null')
  eq(r.via, 'pageContext hash mismatch', 'hash mismatch -> via')
}

// 6. no tag and no pageContext -> null
eq(resolveBankCsvAccount({ account: '' }).account, null, 'nothing -> null')

// 7. an INVALID tag falls through to pageContext resolution (does not short-circuit)
{
  const ctx = page('12566111')
  const r = resolveBankCsvAccount({ account: 'ba_bogus', pageContext: ctx, pageContextSha256: sha(ctx) })
  eq(r.account, 'ba_personal_savings', 'invalid tag falls through to pageContext')
}

// 8. pageContext with NO sha still resolves (sha is optional; presence-only signature already gated)
{
  const ctx = page('12579151')
  eq(resolveBankCsvAccount({ account: '', pageContext: ctx }).account, 'ba_ecodia_savings', 'pageContext without sha still resolves')
}

// 9. every resolved account is a member of BA_CSV_ACCOUNTS (import will accept it)
for (const num of Object.keys(BA_ACCOUNT_MAP)) {
  const ctx = page(num)
  const r = resolveBankCsvAccount({ account: '', pageContext: ctx, pageContextSha256: sha(ctx) })
  eq(BA_CSV_ACCOUNTS.includes(r.account), true, `${r.account} is importable`)
}

if (fail === 0) console.log(`vault-pull attribution unit: ${pass}/${pass} - tag precedence, per-account resolve, ambiguity->null, hash integrity, invalid-tag fallthrough`)
else { console.error(`vault-pull attribution unit: ${fail} FAILED (${pass} passed)`); process.exit(1) }
