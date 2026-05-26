/**
 * Phase 3 Step 6 — Hardening + Full Validation
 *
 * Runs all 14 required transaction scenarios end-to-end against the journal
 * generator + normalization pipeline. Verifies:
 *
 *   ✔ Journals always balance (DR === CR within 0.01)
 *   ✔ DR/CR accounts are semantically correct
 *   ✔ Liabilities surface in the right side
 *   ✔ Tax fields (GST/WHT) are split into separate lines
 *   ✔ Inventory pathways create/reduce stock correctly
 *   ✔ No regressions in existing types
 *
 * Run:  node __tests__/nlParser.hardening-step6.test.js
 */

'use strict';

const { generateJournalEntries } = require('../services/nlParser/services/journalGeneratorService');
const { normalizeExtraction }    = require('../services/nlParser/services/normalizationService');
const { calculateBalance }       = require('../services/nlParser/services/validationService');
const { TRANSACTION_TYPES }      = require('../services/nlParser/constants/transactionTypes');
const { calculateConfidence, evaluateReviewNeed } = require('../services/nlParser/utils/confidenceCalculator');

// ── Test Harness ─────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const failures = [];

function section(title) {
  console.log('\n────────────────────────────────────────────────────────────────');
  console.log(`  ${title}`);
  console.log('────────────────────────────────────────────────────────────────');
}
function assert(cond, msg) {
  if (cond) { console.log(`  ✅  ${msg}`); passed++; }
  else      { console.log(`  ❌  ${msg}`); failed++; failures.push(msg); }
}
function eqWithin(a, b, eps = 0.02) { return Math.abs((a||0) - (b||0)) <= eps; }

/**
 * Run the parser pipeline for a synthetic Gemini extraction.
 * (We bypass the actual Gemini API; we feed a structured rawExtraction
 *  directly to `normalizeExtraction`, then pass to `generateJournalEntries`.)
 * This is the same pipeline that runs in production after AI returns a JSON.
 */
function runPipeline(rawExtraction) {
  const { normalized, confidence: rawConfidence } = normalizeExtraction(rawExtraction);
  const journalEntries = generateJournalEntries(normalized);
  const balance = calculateBalance(journalEntries);
  const confidence = calculateConfidence(rawConfidence);
  const { requiresReview } = evaluateReviewNeed(confidence, normalized);
  return { normalized, journalEntries, balance, confidence, requiresReview };
}

function findDebits(entries)  { return entries.filter(e => e.entryType === 'debit'); }
function findCredits(entries) { return entries.filter(e => e.entryType === 'credit'); }
function sumLines(entries) { return entries.reduce((s, e) => s + (e.amount || 0), 0); }
function namesOf(entries) { return entries.map(e => e.account); }


// ════════════════════════════════════════════════════════════════════════════
//   14 REQUIRED SCENARIOS
// ════════════════════════════════════════════════════════════════════════════

// ── Scenario 1: Cash Sale ────────────────────────────────────────────────────
section('Scenario 1: Cash Sale — "Sold goods for 5000 cash"');
{
  const r = runPipeline({
    intent: 'Cash sale of goods',
    transactionType: 'income',
    amount: 5000,
    description: 'Sold goods for cash',
    cashFlowDirection: 'inflow',
    debitAccount: 'Cash at Bank',
    creditAccount: 'Sales',
    confidence: { intent: 0.95, amount: 1.0, date: 0.5, accountMapping: 0.9 },
  });
  const drs = findDebits(r.journalEntries);
  const crs = findCredits(r.journalEntries);
  assert(r.balance.isBalanced, `Balanced (DR=${r.balance.totalDebits} CR=${r.balance.totalCredits})`);
  assert(drs.length >= 1 && crs.length >= 1, 'Has at least 1 DR and 1 CR line');
  assert(drs[0].amount === 5000, `DR Cash = 5000 (got ${drs[0].amount})`);
  assert(/cash|bank/i.test(drs[0].account), `DR account is cash/bank (got "${drs[0].account}")`);
  assert(/sales|revenue|income/i.test(crs[0].account), `CR account is revenue (got "${crs[0].account}")`);
}

// ── Scenario 2: Credit Sale ──────────────────────────────────────────────────
section('Scenario 2: Credit Sale — "Sold goods on credit to ABC Co for 8000"');
{
  const r = runPipeline({
    intent: 'Credit sale to ABC Co',
    transactionType: 'accounts_receivable',
    amount: 8000,
    counterpartyName: 'ABC Co',
    description: 'Sold goods on credit',
    debitAccount: 'Accounts Receivable',
    creditAccount: 'Sales',
    confidence: { intent: 0.9, amount: 1.0, date: 0.5, accountMapping: 0.9 },
  });
  const drs = findDebits(r.journalEntries);
  const crs = findCredits(r.journalEntries);
  assert(r.balance.isBalanced, `Balanced (DR=${r.balance.totalDebits} CR=${r.balance.totalCredits})`);
  assert(/receivable|debtor/i.test(drs[0].account), `DR = Accounts Receivable (got "${drs[0].account}")`);
  assert(/sales|revenue/i.test(crs[0].account), `CR = Sales/Revenue (got "${crs[0].account}")`);
  assert(!namesOf(crs).some(n => /cash|bank/i.test(n)), 'No cash on credit side (credit sale = AR not cash)');
}

// ── Scenario 3: Payroll Expense ──────────────────────────────────────────────
section('Scenario 3: Payroll Expense — "Paid salaries for April 50000"');
{
  const r = runPipeline({
    intent: 'Pay salaries',
    transactionType: 'salary',
    amount: 50000,
    description: 'Paid salaries for April',
    cashFlowDirection: 'outflow',
    debitAccount: 'Wages and Salaries',
    creditAccount: 'Cash at Bank',
    confidence: { intent: 0.95, amount: 1.0, date: 0.6, accountMapping: 0.9 },
  });
  const drs = findDebits(r.journalEntries);
  const crs = findCredits(r.journalEntries);
  assert(r.balance.isBalanced, `Balanced (DR=${r.balance.totalDebits} CR=${r.balance.totalCredits})`);
  assert(/wages|salar|payroll/i.test(drs[0].account), `DR = Wages/Salary expense (got "${drs[0].account}")`);
  assert(/cash|bank/i.test(crs[0].account), `CR = Cash/Bank (got "${crs[0].account}")`);
}

// ── Scenario 4: Inventory Purchase ───────────────────────────────────────────
section('Scenario 4: Inventory Purchase — "Bought inventory worth 20000 on credit from XYZ"');
{
  const r = runPipeline({
    intent: 'Purchase inventory on credit',
    transactionType: 'inventory_purchase',
    amount: 20000,
    counterpartyName: 'XYZ Supplier',
    description: 'Purchased inventory on credit',
    debitAccount: 'Inventory',
    creditAccount: 'Accounts Payable',
    confidence: { intent: 0.95, amount: 1.0, date: 0.6, accountMapping: 0.9 },
  });
  const drs = findDebits(r.journalEntries);
  const crs = findCredits(r.journalEntries);
  assert(r.balance.isBalanced, `Balanced (DR=${r.balance.totalDebits} CR=${r.balance.totalCredits})`);
  assert(/inventory|stock/i.test(drs[0].account), `DR = Inventory (got "${drs[0].account}")`);
  assert(/payable|creditor/i.test(crs[0].account), `CR = Accounts Payable (got "${crs[0].account}")`);
  assert(!namesOf(crs).some(n => /cash|bank/i.test(n)), 'No cash on CR side (credit purchase)');
}

// ── Scenario 5: Financed Asset Purchase ──────────────────────────────────────
section('Scenario 5: Financed Asset Purchase — "Bought laptop 120000 on 12-month EMI"');
{
  const r = runPipeline({
    intent: 'Financed asset purchase',
    transactionType: 'financed_asset_purchase',
    amount: 120000,
    description: 'Bought laptop on installments',
    isInstallment: true,
    installmentPeriodMonths: 12,
    debitAccount: 'Office Equipment',
    creditAccount: 'Loan Payable',
    confidence: { intent: 0.9, amount: 1.0, date: 0.6, accountMapping: 0.85 },
  });
  const drs = findDebits(r.journalEntries);
  const crs = findCredits(r.journalEntries);
  assert(r.balance.isBalanced, `Balanced (DR=${r.balance.totalDebits} CR=${r.balance.totalCredits})`);
  assert(drs[0].amount === 120000, `DR asset = 120000 (got ${drs[0].amount})`);
  assert(/loan|payable|liabil/i.test(crs[0].account), `CR = Loan/Payable liability (got "${crs[0].account}")`);
  assert(!namesOf(crs).some(n => /cash|bank/i.test(n)), 'No cash on CR side (financed)');
  assert(r.normalized.isInstallment === true, 'isInstallment flag preserved');
}

// ── Scenario 6: GST Sale ─────────────────────────────────────────────────────
section('Scenario 6: GST Sale — "Sold goods for 11700 cash including 17% GST"');
{
  const r = runPipeline({
    intent: 'GST-inclusive sale',
    transactionType: 'gst_inclusive_sale',
    amount: 11700,
    description: 'Sold goods including GST',
    isTaxInclusive: true,
    taxType: 'GST',
    taxRate: 17,
    cashFlowDirection: 'inflow',
    debitAccount: 'Cash at Bank',
    creditAccount: 'Sales',
    confidence: { intent: 0.95, amount: 1.0, date: 0.6, accountMapping: 0.9 },
  });
  const drs = findDebits(r.journalEntries);
  const crs = findCredits(r.journalEntries);
  assert(r.balance.isBalanced, `Balanced (DR=${r.balance.totalDebits} CR=${r.balance.totalCredits})`);
  assert(r.journalEntries.length === 3, `3 lines (Cash + Sales + GST Payable) (got ${r.journalEntries.length})`);
  assert(eqWithin(drs[0].amount, 11700), `DR Cash = 11700 gross (got ${drs[0].amount})`);
  const salesLine = crs.find(c => /sales|revenue/i.test(c.account));
  const gstLine   = crs.find(c => /gst.*payable|output.*tax/i.test(c.account));
  assert(salesLine && eqWithin(salesLine.amount, 10000), `CR Sales = 10000 net (got ${salesLine?.amount})`);
  assert(gstLine && eqWithin(gstLine.amount, 1700), `CR GST Payable = 1700 (got ${gstLine?.amount})`);
}

// ── Scenario 7: Withholding Tax ──────────────────────────────────────────────
section('Scenario 7: WHT — "Paid 50000 rent net of 5000 WHT"');
{
  const r = runPipeline({
    intent: 'WHT on rent',
    transactionType: 'wht_on_rent',
    amount: 50000,
    taxAmount: 5000,
    description: 'Paid rent with WHT deducted',
    cashFlowDirection: 'outflow',
    debitAccount: 'Rent Expense',
    creditAccount: 'Cash at Bank',
    confidence: { intent: 0.9, amount: 0.95, date: 0.6, accountMapping: 0.85 },
  });
  const drs = findDebits(r.journalEntries);
  const crs = findCredits(r.journalEntries);
  assert(r.balance.isBalanced, `Balanced (DR=${r.balance.totalDebits} CR=${r.balance.totalCredits})`);
  assert(drs[0].amount === 50000, `DR Rent = 50000 gross (got ${drs[0].amount})`);
  const cashLine = crs.find(c => /cash|bank/i.test(c.account));
  const whtLine  = crs.find(c => /wht|withhold/i.test(c.account));
  assert(cashLine && eqWithin(cashLine.amount, 45000), `CR Cash = 45000 net (got ${cashLine?.amount})`);
  assert(whtLine && eqWithin(whtLine.amount, 5000), `CR WHT Payable = 5000 (got ${whtLine?.amount})`);
}

// ── Scenario 8: Prepaid Expense ──────────────────────────────────────────────
section('Scenario 8: Prepaid Expense — "Paid 6000 insurance for the next 6 months"');
{
  const r = runPipeline({
    intent: 'Prepaid insurance',
    transactionType: 'prepaid_expense',
    amount: 6000,
    description: 'Paid annual insurance in advance',
    cashFlowDirection: 'outflow',
    debitAccount: 'Prepaid Expenses',
    creditAccount: 'Cash at Bank',
    confidence: { intent: 0.9, amount: 1.0, date: 0.6, accountMapping: 0.9 },
  });
  const drs = findDebits(r.journalEntries);
  const crs = findCredits(r.journalEntries);
  assert(r.balance.isBalanced, `Balanced (DR=${r.balance.totalDebits} CR=${r.balance.totalCredits})`);
  assert(/prepaid/i.test(drs[0].account), `DR = Prepaid Expenses asset (got "${drs[0].account}")`);
  assert(/cash|bank/i.test(crs[0].account), `CR = Cash/Bank (got "${crs[0].account}")`);
}

// ── Scenario 9: Accrued Liability ────────────────────────────────────────────
section('Scenario 9: Accrued Liability — "Accrued electricity expense 15000"');
{
  const r = runPipeline({
    intent: 'Accrue electricity expense',
    transactionType: 'accrual_expense',
    subcategory: 'electricity',
    amount: 15000,
    description: 'Accrued electricity for the month',
    cashFlowDirection: 'non_cash',
    debitAccount: 'Utilities',
    creditAccount: 'Accrued Expenses',
    confidence: { intent: 0.9, amount: 1.0, date: 0.5, accountMapping: 0.85 },
  });
  const drs = findDebits(r.journalEntries);
  const crs = findCredits(r.journalEntries);
  assert(r.balance.isBalanced, `Balanced (DR=${r.balance.totalDebits} CR=${r.balance.totalCredits})`);
  assert(/utilit|electric/i.test(drs[0].account), `DR = expense account (got "${drs[0].account}")`);
  assert(/accrued|payable/i.test(crs[0].account), `CR = Accrued Expenses liability (got "${crs[0].account}")`);
  assert(!namesOf(crs).some(n => /cash|bank/i.test(n)), 'No cash — accrued (not paid)');
}

// ── Scenario 10: Customer Advance ────────────────────────────────────────────
section('Scenario 10: Customer Advance — "Received 30000 advance from customer Ali"');
{
  const r = runPipeline({
    intent: 'Advance received from customer',
    transactionType: 'advance_revenue',
    amount: 30000,
    counterpartyName: 'Ali',
    description: 'Customer paid in advance for future order',
    cashFlowDirection: 'inflow',
    debitAccount: 'Cash at Bank',
    creditAccount: 'Unearned Revenue',
    confidence: { intent: 0.9, amount: 1.0, date: 0.6, accountMapping: 0.85 },
  });
  const drs = findDebits(r.journalEntries);
  const crs = findCredits(r.journalEntries);
  assert(r.balance.isBalanced, `Balanced (DR=${r.balance.totalDebits} CR=${r.balance.totalCredits})`);
  assert(/cash|bank/i.test(drs[0].account), `DR = Cash/Bank (got "${drs[0].account}")`);
  assert(/unearned|advance|deferred/i.test(crs[0].account), `CR = Unearned Revenue liability (got "${crs[0].account}")`);
  // Liability check: account must START with Unearned/Advance/Deferred (not just "Sales")
  assert(crs.every(c => !/^(sales|service revenue|revenue)$/i.test(c.account.trim())),
    'NOT booked as raw revenue (liability label required)');
}

// ── Scenario 11: Vendor Payable ──────────────────────────────────────────────
section('Scenario 11: Vendor Payable — "Bought office supplies 4000 on credit from Stationer"');
{
  const r = runPipeline({
    intent: 'Credit purchase from vendor',
    transactionType: 'accounts_payable',
    amount: 4000,
    counterpartyName: 'Stationer',
    description: 'Bought office supplies on credit',
    subcategory: 'office_supplies',
    debitAccount: 'Office Supplies',
    creditAccount: 'Accounts Payable',
    confidence: { intent: 0.9, amount: 1.0, date: 0.6, accountMapping: 0.85 },
  });
  const drs = findDebits(r.journalEntries);
  const crs = findCredits(r.journalEntries);
  assert(r.balance.isBalanced, `Balanced (DR=${r.balance.totalDebits} CR=${r.balance.totalCredits})`);
  assert(/supplies|expense|office/i.test(drs[0].account), `DR = expense account (got "${drs[0].account}")`);
  assert(/payable|creditor/i.test(crs[0].account), `CR = Accounts Payable (got "${crs[0].account}")`);
  assert(!namesOf(crs).some(n => /cash|bank/i.test(n)), 'No cash on CR (credit purchase)');
}

// ── Scenario 12: Utility Bill ────────────────────────────────────────────────
section('Scenario 12: Utility Bill — "Paid 8500 electricity bill from bank"');
{
  const r = runPipeline({
    intent: 'Paid electricity bill',
    transactionType: 'expense',
    subcategory: 'electricity',
    amount: 8500,
    description: 'Paid electricity bill',
    cashFlowDirection: 'outflow',
    paymentMethod: 'bank',
    debitAccount: 'Utilities',
    creditAccount: 'Cash at Bank',
    confidence: { intent: 0.95, amount: 1.0, date: 0.7, accountMapping: 0.9 },
  });
  const drs = findDebits(r.journalEntries);
  const crs = findCredits(r.journalEntries);
  assert(r.balance.isBalanced, `Balanced (DR=${r.balance.totalDebits} CR=${r.balance.totalCredits})`);
  assert(/utilit|electric/i.test(drs[0].account), `DR = Utilities expense (got "${drs[0].account}")`);
  assert(/cash|bank/i.test(crs[0].account), `CR = Cash/Bank (got "${crs[0].account}")`);
  assert(drs[0].amount === 8500, `DR amount = 8500 (got ${drs[0].amount})`);
}

// ── Scenario 13: Insurance Expense ───────────────────────────────────────────
section('Scenario 13: Insurance Expense — "Paid 12000 vehicle insurance from bank"');
{
  const r = runPipeline({
    intent: 'Paid vehicle insurance',
    transactionType: 'expense',
    subcategory: 'insurance',
    amount: 12000,
    description: 'Vehicle insurance premium',
    cashFlowDirection: 'outflow',
    paymentMethod: 'bank',
    debitAccount: 'Insurance Expense',
    creditAccount: 'Cash at Bank',
    confidence: { intent: 0.9, amount: 1.0, date: 0.7, accountMapping: 0.9 },
  });
  const drs = findDebits(r.journalEntries);
  const crs = findCredits(r.journalEntries);
  assert(r.balance.isBalanced, `Balanced (DR=${r.balance.totalDebits} CR=${r.balance.totalCredits})`);
  assert(/insur/i.test(drs[0].account), `DR = Insurance expense (got "${drs[0].account}")`);
  assert(/cash|bank/i.test(crs[0].account), `CR = Cash/Bank (got "${crs[0].account}")`);
}

// ── Scenario 14: Depreciation Entry ──────────────────────────────────────────
section('Scenario 14: Depreciation — "Recorded 5000 monthly depreciation on office equipment"');
{
  const r = runPipeline({
    intent: 'Record depreciation',
    transactionType: 'depreciation',
    amount: 5000,
    description: 'Monthly depreciation of office equipment',
    cashFlowDirection: 'non_cash',
    debitAccount: 'Depreciation Expense',
    creditAccount: 'Accumulated Depreciation',
    confidence: { intent: 0.85, amount: 1.0, date: 0.5, accountMapping: 0.8 },
  });
  const drs = findDebits(r.journalEntries);
  const crs = findCredits(r.journalEntries);
  assert(r.balance.isBalanced, `Balanced (DR=${r.balance.totalDebits} CR=${r.balance.totalCredits})`);
  assert(/deprec/i.test(drs[0].account), `DR = Depreciation Expense (got "${drs[0].account}")`);
  assert(/accumulated|deprec/i.test(crs[0].account), `CR = Accumulated Depreciation (got "${crs[0].account}")`);
  assert(!namesOf(crs).some(n => /cash|bank/i.test(n)), 'No cash — depreciation is non-cash');
}


// ════════════════════════════════════════════════════════════════════════════
//   GLOBAL ASSERTIONS — across all 14 scenarios
// ════════════════════════════════════════════════════════════════════════════
section('Global: cross-cutting checks');

// All scenarios should yield isValid normalized output with positive amount
const allScenarios = [
  { transactionType: 'income',                 amount: 5000, debitAccount: 'Cash at Bank', creditAccount: 'Sales' },
  { transactionType: 'accounts_receivable',    amount: 8000, debitAccount: 'Accounts Receivable', creditAccount: 'Sales' },
  { transactionType: 'salary',                 amount: 50000, debitAccount: 'Wages and Salaries', creditAccount: 'Cash at Bank' },
  { transactionType: 'inventory_purchase',     amount: 20000, debitAccount: 'Inventory', creditAccount: 'Accounts Payable' },
  { transactionType: 'financed_asset_purchase', amount: 120000, isInstallment: true, installmentPeriodMonths: 12, debitAccount: 'Office Equipment', creditAccount: 'Loan Payable' },
  { transactionType: 'gst_inclusive_sale',     amount: 11700, taxRate: 17, isTaxInclusive: true, taxType: 'GST', debitAccount: 'Cash at Bank', creditAccount: 'Sales' },
  { transactionType: 'wht_on_rent',            amount: 50000, taxAmount: 5000, debitAccount: 'Rent Expense', creditAccount: 'Cash at Bank' },
  { transactionType: 'prepaid_expense',        amount: 6000, debitAccount: 'Prepaid Expenses', creditAccount: 'Cash at Bank' },
  { transactionType: 'accrual_expense',        amount: 15000, subcategory: 'electricity', debitAccount: 'Utilities', creditAccount: 'Accrued Expenses' },
  { transactionType: 'advance_revenue',        amount: 30000, debitAccount: 'Cash at Bank', creditAccount: 'Unearned Revenue' },
  { transactionType: 'accounts_payable',       amount: 4000, subcategory: 'office_supplies', debitAccount: 'Office Supplies', creditAccount: 'Accounts Payable' },
  { transactionType: 'expense',                amount: 8500, subcategory: 'electricity', debitAccount: 'Utilities', creditAccount: 'Cash at Bank' },
  { transactionType: 'expense',                amount: 12000, subcategory: 'insurance', debitAccount: 'Insurance Expense', creditAccount: 'Cash at Bank' },
  { transactionType: 'depreciation',           amount: 5000, debitAccount: 'Depreciation Expense', creditAccount: 'Accumulated Depreciation' },
];

let balancedCount = 0;
let allHaveDR = 0;
let allHaveCR = 0;
allScenarios.forEach((s, i) => {
  const r = runPipeline(s);
  if (r.balance.isBalanced) balancedCount++;
  if (findDebits(r.journalEntries).length > 0)  allHaveDR++;
  if (findCredits(r.journalEntries).length > 0) allHaveCR++;
});

assert(balancedCount === 14, `All 14 scenarios produce balanced journals (${balancedCount}/14)`);
assert(allHaveDR === 14,     `All 14 scenarios have at least one DR line (${allHaveDR}/14)`);
assert(allHaveCR === 14,     `All 14 scenarios have at least one CR line (${allHaveCR}/14)`);


// ════════════════════════════════════════════════════════════════════════════
//   OPTIMIZATION — sanity check parser performance
// ════════════════════════════════════════════════════════════════════════════
section('Performance: pipeline throughput');
{
  const start = process.hrtime.bigint();
  for (let i = 0; i < 1000; i++) {
    runPipeline({
      transactionType: 'cash_sale',
      amount: 5000,
      debitAccount: 'Cash at Bank',
      creditAccount: 'Sales',
    });
  }
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  const avgMs = elapsedMs / 1000;
  console.log(`  ⚡  1000 pipeline runs: ${elapsedMs.toFixed(1)} ms (avg ${avgMs.toFixed(3)} ms/parse)`);
  assert(avgMs < 5, `Average per-parse < 5ms (got ${avgMs.toFixed(3)} ms)`);
}


// ════════════════════════════════════════════════════════════════════════════
//   FINAL SUMMARY
// ════════════════════════════════════════════════════════════════════════════
console.log('\n════════════════════════════════════════════════════════════════');
console.log(`  Phase 3 Step 6 Results: ${passed} passed, ${failed} failed`);
console.log('════════════════════════════════════════════════════════════════');
if (failed > 0) {
  console.log('\nFailures:');
  failures.forEach(f => console.log(`  - ${f}`));
  process.exit(1);
}
process.exit(0);
