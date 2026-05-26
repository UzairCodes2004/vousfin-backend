/**
 * Phase 3 — Accounting Intelligence Layer Tests
 *
 * Tests the journal generator, account resolution, subcategory normalization,
 * and Gemini-hint intelligence fix WITHOUT calling Gemini (pure unit tests).
 *
 * Run:  node __tests__/nlParser.phase3.test.js
 */

'use strict';

const { generateJournalEntries } = require('../services/nlParser/services/journalGeneratorService');
const { normalizeExtraction }    = require('../services/nlParser/services/normalizationService');
const { TRANSACTION_TYPES }      = require('../services/nlParser/constants/transactionTypes');
const { ALL_SUBCATEGORIES, SUBCATEGORY_KEYWORDS } = require('../services/nlParser/constants/subcategories');
const { EXPENSE_ACCOUNT_MAP }    = require('../services/nlParser/utils/accountMappings');
const { ACCOUNT_ALIAS_MAP }      = require('../services/nlParser/constants/chartOfAccounts');
const { mapTransactionTypeForApi } = require('../utils/nlParserPreview.helper');

let passed = 0;
let failed = 0;

function assert(condition, label, actual) {
  if (condition) {
    console.log(`  ✅  ${label}`);
    passed++;
  } else {
    console.log(`  ❌  ${label}`);
    if (actual !== undefined) console.log(`      → got: ${JSON.stringify(actual)}`);
    failed++;
  }
}

function section(title) {
  console.log(`\n${'─'.repeat(60)}\n  ${title}\n${'─'.repeat(60)}`);
}

/* ─── Helper: simulate Gemini output for a prompt ─────────────────────────
 * We bypass Gemini and directly feed normalized parsedData so we can
 * test the journal generator and intelligence fix deterministically.
 * ─────────────────────────────────────────────────────────────────────────*/
function simulateGemini(rawGeminiOutput) {
  return normalizeExtraction(rawGeminiOutput);
}

/* ═══════════════════════════════════════════════════════════════════════════
 * SECTION A: New transaction type registration
 * ═══════════════════════════════════════════════════════════════════════════ */
section('A — New transaction types registered');

const NEW_TYPES = ['accrual_expense', 'accrual_income', 'cogs_recognition', 'wht_on_rent', 'wht_on_services'];
for (const t of NEW_TYPES) {
  assert(
    Object.values(TRANSACTION_TYPES).includes(t),
    `TRANSACTION_TYPES includes '${t}'`,
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
 * SECTION B: New subcategory vocabulary
 * ═══════════════════════════════════════════════════════════════════════════ */
section('B — New subcategories in ALL_SUBCATEGORIES');

const NEW_SUBCATS = [
  'legal_fees', 'professional_services', 'audit_fees', 'training', 'cleaning',
  'security', 'travel_expense', 'accommodation', 'packaging', 'customs_duty',
  'uniforms', 'meals', 'entertainment', 'medical', 'courier', 'postage',
];
for (const s of NEW_SUBCATS) {
  assert(ALL_SUBCATEGORIES.has(s), `ALL_SUBCATEGORIES has '${s}'`);
}

section('B2 — SUBCATEGORY_KEYWORDS covers common phrases');
const kwTests = [
  ['legal', 'legal_fees'],
  ['legal fees', 'legal_fees'],
  ['professional services', 'professional_services'],
  ['training', 'training'],
  ['cleaning', 'cleaning'],
  ['courier', 'courier'],
  ['customs duty', 'customs_duty'],
  ['meals', 'meals'],
  ['hotel', 'accommodation'],
];
for (const [kw, expected] of kwTests) {
  assert(SUBCATEGORY_KEYWORDS[kw] === expected, `keyword '${kw}' → '${expected}'`, SUBCATEGORY_KEYWORDS[kw]);
}

/* ═══════════════════════════════════════════════════════════════════════════
 * SECTION C: EXPENSE_ACCOUNT_MAP new entries
 * ═══════════════════════════════════════════════════════════════════════════ */
section('C — EXPENSE_ACCOUNT_MAP new entries');

const mapTests = [
  ['legal_fees', 'Professional Fees'],
  ['professional_services', 'Professional Fees'],
  ['legal', 'Professional Fees'],
  ['training', 'Advertising'],
  ['cleaning', 'Advertising'],
  ['travel_expense', 'Company Car Expenses'],
  ['courier', 'Freight'],
  ['customs_duty', 'Freight'],
  ['packaging', 'Freight'],
  ['meals', 'Advertising'],
  ['office_chairs', 'Furniture and Fittings'],
  ['chairs', 'Furniture and Fittings'],
];
for (const [sub, expected] of mapTests) {
  assert(EXPENSE_ACCOUNT_MAP[sub] === expected, `EXPENSE_ACCOUNT_MAP['${sub}'] = '${expected}'`, EXPENSE_ACCOUNT_MAP[sub]);
}

/* ═══════════════════════════════════════════════════════════════════════════
 * SECTION D: chartOfAccounts alias coverage
 * ═══════════════════════════════════════════════════════════════════════════ */
section('D — chartOfAccounts alias coverage');

const aliasTests = [
  ['trade debtors', 'Accounts Receivable'],
  ['trade receivables', 'Accounts Receivable'],
  ['office chairs', 'Furniture and Fittings'],
  ['chairs', 'Furniture and Fittings'],
  ['professional services', 'Professional Fees'],
  ['legal fees', 'Professional Fees'],
  ['motorbike', 'Company Car'],
];
for (const [alias, expected] of aliasTests) {
  const acct = ACCOUNT_ALIAS_MAP.get(alias.toLowerCase());
  assert(acct?.name === expected, `alias '${alias}' → '${expected}'`, acct?.name);
}

/* ═══════════════════════════════════════════════════════════════════════════
 * SECTION E: normalizeSubcategory — no longer returns null for new types
 * ═══════════════════════════════════════════════════════════════════════════ */
section('E — normalizeSubcategory accepts new subcategories');

const subcatNormTests = [
  { subcategory: 'legal_fees',   expected: 'legal_fees' },
  { subcategory: 'training',     expected: 'training' },
  { subcategory: 'courier',      expected: 'courier' },
  { subcategory: 'meals',        expected: 'meals' },
  { subcategory: 'furniture',    expected: 'furniture' },   // pre-existing
  { subcategory: 'fuel',         expected: 'fuel' },        // pre-existing
  { subcategory: 'gibberish_xyz',expected: null },          // unknown → null
];
for (const { subcategory, expected } of subcatNormTests) {
  const { normalized } = simulateGemini({
    transactionType: 'expense', subcategory, amount: 1000,
    confidence: { intent: 0.9, amount: 0.9, date: 0.5, accountMapping: 0.8 },
  });
  assert(normalized.subcategory === expected, `normalizeSubcategory('${subcategory}') = ${JSON.stringify(expected)}`, normalized.subcategory);
}

/* ═══════════════════════════════════════════════════════════════════════════
 * SECTION F: The 8 test prompts — journal entry validation
 * ═══════════════════════════════════════════════════════════════════════════ */
section('F — 8 specific prompt journal entries (simulated Gemini output)');

// ── PROMPT 1: "Bought office chairs for cash" ────────────────────────────
console.log('\n  Prompt 1: "Bought office chairs for cash"');
{
  const { normalized } = simulateGemini({
    transactionType: 'asset_purchase',
    subcategory: 'furniture',
    amount: 15000,
    sourceAccount: 'Cash on Hand',
    debitAccount: 'Furniture and Fittings',
    creditAccount: 'Cash on Hand',
    confidence: { intent: 0.95, amount: 0.95, date: 0.5, accountMapping: 0.9 },
  });
  const entries = generateJournalEntries(normalized);
  const dr = entries.find(e => e.entryType === 'debit');
  const cr = entries.find(e => e.entryType === 'credit');

  assert(normalized.transactionType === 'asset_purchase', 'type = asset_purchase', normalized.transactionType);
  assert(dr?.account === 'Furniture and Fittings', 'DR = Furniture and Fittings', dr?.account);
  assert(cr?.account === 'Cash on Hand', 'CR = Cash on Hand', cr?.account);
  assert(dr?.amount === 15000, 'amount = 15000', dr?.amount);
  // Intelligence fix: Gemini's debitAccount hint used over ASSET_ACCOUNT_MAP['furniture']
  assert(mapTransactionTypeForApi('asset_purchase') === 'Asset Purchase', 'API type = Asset Purchase');
}

// ── PROMPT 2: "Purchased inventory on credit" ───────────────────────────
console.log('\n  Prompt 2: "Purchased inventory on credit"');
{
  const { normalized } = simulateGemini({
    transactionType: 'inventory_purchase',
    subcategory: 'inventory',
    amount: 50000,
    sourceAccount: 'Accounts Payable',
    creditAccount: 'Accounts Payable',
    confidence: { intent: 0.9, amount: 0.9, date: 0.5, accountMapping: 0.85 },
  });
  const entries = generateJournalEntries(normalized);
  const dr = entries.find(e => e.entryType === 'debit');
  const cr = entries.find(e => e.entryType === 'credit');

  assert(normalized.transactionType === 'inventory_purchase', 'type = inventory_purchase', normalized.transactionType);
  assert(dr?.account === 'Inventory', 'DR = Inventory', dr?.account);
  // Intelligence fix: __SOURCE__ → Gemini's creditAccount 'Accounts Payable' (not default 'Cash at Bank')
  assert(cr?.account === 'Accounts Payable', 'CR = Accounts Payable (not Cash at Bank)', cr?.account);
}

// ── PROMPT 3: "Paid monthly internet bill" ──────────────────────────────
console.log('\n  Prompt 3: "Paid monthly internet bill"');
{
  const { normalized } = simulateGemini({
    transactionType: 'expense',
    subcategory: 'internet',
    amount: 3500,
    sourceAccount: 'Cash at Bank',
    debitAccount: 'Utilities',
    creditAccount: 'Cash at Bank',
    confidence: { intent: 0.95, amount: 0.9, date: 0.5, accountMapping: 0.9 },
  });
  const entries = generateJournalEntries(normalized);
  const dr = entries.find(e => e.entryType === 'debit');
  const cr = entries.find(e => e.entryType === 'credit');

  assert(normalized.transactionType === 'expense', 'type = expense', normalized.transactionType);
  assert(normalized.subcategory === 'internet', 'subcategory = internet', normalized.subcategory);
  assert(dr?.account === 'Utilities', 'DR = Utilities (via Gemini hint or EXPENSE_ACCOUNT_MAP)', dr?.account);
  assert(cr?.account === 'Cash at Bank', 'CR = Cash at Bank', cr?.account);
}

// ── PROMPT 4: "Received advance from customer" ──────────────────────────
console.log('\n  Prompt 4: "Received advance from customer"');
{
  const { normalized } = simulateGemini({
    transactionType: 'advance_revenue',
    amount: 25000,
    sourceAccount: 'Cash at Bank',
    debitAccount: 'Cash at Bank',
    creditAccount: 'Unearned Revenue',
    confidence: { intent: 0.95, amount: 0.9, date: 0.5, accountMapping: 0.95 },
  });
  const entries = generateJournalEntries(normalized);
  const dr = entries.find(e => e.entryType === 'debit');
  const cr = entries.find(e => e.entryType === 'credit');

  assert(normalized.transactionType === 'advance_revenue', 'type = advance_revenue', normalized.transactionType);
  assert(dr?.account === 'Cash at Bank', 'DR = Cash at Bank', dr?.account);
  assert(cr?.account === 'Unearned Revenue', 'CR = Unearned Revenue', cr?.account);
  assert(mapTransactionTypeForApi('advance_revenue') === 'Advance from Customer', 'API type = Advance from Customer');
}

// ── PROMPT 5: "Paid salaries for April" ─────────────────────────────────
console.log('\n  Prompt 5: "Paid salaries for April"');
{
  const { normalized } = simulateGemini({
    transactionType: 'salary',
    subcategory: 'salary',
    amount: 120000,
    sourceAccount: 'Cash at Bank',
    debitAccount: 'Wages and Salaries',
    creditAccount: 'Cash at Bank',
    confidence: { intent: 0.95, amount: 0.9, date: 0.6, accountMapping: 0.9 },
  });
  const entries = generateJournalEntries(normalized);
  const dr = entries.find(e => e.entryType === 'debit');
  const cr = entries.find(e => e.entryType === 'credit');

  assert(normalized.transactionType === 'salary', 'type = salary', normalized.transactionType);
  assert(dr?.account === 'Wages and Salaries', 'DR = Wages and Salaries', dr?.account);
  assert(cr?.account === 'Cash at Bank', 'CR = Cash at Bank', cr?.account);
  assert(mapTransactionTypeForApi('salary') === 'Salary', 'API type = Salary');
}

// ── PROMPT 6: "Bought laptop on installments" ───────────────────────────
console.log('\n  Prompt 6: "Bought laptop on installments"');
{
  const { normalized } = simulateGemini({
    transactionType: 'asset_purchase',
    subcategory: 'laptop',
    amount: 85000,
    isInstallment: true,
    totalInstallmentAmount: 85000,
    installmentPeriodMonths: 12,
    debitAccount: 'Office Equipment',
    creditAccount: 'Loan Payable',
    confidence: { intent: 0.9, amount: 0.85, date: 0.5, accountMapping: 0.9 },
  });

  // normalizeExtraction upgrades asset_purchase + isInstallment (no sourceAccount) → financed_asset_purchase
  assert(normalized.transactionType === 'financed_asset_purchase', 'type upgraded → financed_asset_purchase', normalized.transactionType);
  assert(normalized.isInstallment === true, 'isInstallment = true', normalized.isInstallment);

  const entries = generateJournalEntries(normalized);
  const dr = entries.find(e => e.entryType === 'debit');
  const cr = entries.find(e => e.entryType === 'credit');

  assert(dr?.account === 'Office Equipment', 'DR = Office Equipment', dr?.account);
  assert(cr?.account === 'Loan Payable', 'CR = Loan Payable (not Cash)', cr?.account);
  assert(mapTransactionTypeForApi('financed_asset_purchase') === 'Asset Purchase', 'API type = Asset Purchase');
}

// ── PROMPT 7: "Recorded GST on sale" ────────────────────────────────────
console.log('\n  Prompt 7: "Recorded GST on sale"');
{
  const { normalized } = simulateGemini({
    transactionType: 'gst_inclusive_sale',
    amount: 117000,  // 100k + 17% GST
    taxRate: 17,
    sourceAccount: 'Cash at Bank',
    confidence: { intent: 0.9, amount: 0.9, date: 0.5, accountMapping: 0.85 },
  });
  const entries = generateJournalEntries(normalized);

  assert(normalized.transactionType === 'gst_inclusive_sale', 'type = gst_inclusive_sale', normalized.transactionType);
  assert(entries.length === 3, 'multi-line: 3 journal entries', entries.length);

  const dr    = entries.find(e => e.entryType === 'debit');
  const crSales = entries.find(e => e.entryType === 'credit' && e.account === 'Sales');
  const crGST   = entries.find(e => e.entryType === 'credit' && e.account === 'GST Payable');

  assert(dr?.account === 'Cash at Bank', 'DR = Cash at Bank', dr?.account);
  assert(crSales?.amount > 0, 'CR Sales component > 0', crSales?.amount);
  assert(crGST?.amount > 0, 'CR GST Payable component > 0', crGST?.amount);
  // Verify amounts balance: total DR = Sales + GST
  const totalCr = (crSales?.amount || 0) + (crGST?.amount || 0);
  assert(Math.abs(totalCr - 117000) < 1, `debits = credits = 117000 (got ${totalCr})`);
  assert(mapTransactionTypeForApi('gst_inclusive_sale') === 'GST Collection', 'API type = GST Collection');
}

// ── PROMPT 8: "Purchased fuel for company vehicle" ──────────────────────
console.log('\n  Prompt 8: "Purchased fuel for company vehicle"');
{
  const { normalized } = simulateGemini({
    transactionType: 'expense',
    subcategory: 'fuel',
    amount: 5000,
    sourceAccount: 'Cash on Hand',
    debitAccount: 'Company Car Expenses',
    creditAccount: 'Cash on Hand',
    confidence: { intent: 0.95, amount: 0.9, date: 0.5, accountMapping: 0.9 },
  });
  const entries = generateJournalEntries(normalized);
  const dr = entries.find(e => e.entryType === 'debit');
  const cr = entries.find(e => e.entryType === 'credit');

  assert(normalized.transactionType === 'expense', 'type = expense', normalized.transactionType);
  assert(normalized.subcategory === 'fuel', 'subcategory = fuel', normalized.subcategory);
  assert(dr?.account === 'Company Car Expenses', 'DR = Company Car Expenses', dr?.account);
  assert(cr?.account === 'Cash on Hand', 'CR = Cash on Hand', cr?.account);
}

/* ═══════════════════════════════════════════════════════════════════════════
 * SECTION G: Phase 3 new transaction type journal generators
 * ═══════════════════════════════════════════════════════════════════════════ */
section('G — Phase 3 new type journal generators');

// G1: accrual_expense
console.log('\n  G1: accrual_expense — DR Expense / CR Accrued Expenses');
{
  const { normalized } = simulateGemini({
    transactionType: 'accrual_expense',
    subcategory: 'electricity',
    amount: 12000,
    confidence: { intent: 0.9, amount: 0.9, date: 0.5, accountMapping: 0.85 },
  });
  const entries = generateJournalEntries(normalized);
  const dr = entries.find(e => e.entryType === 'debit');
  const cr = entries.find(e => e.entryType === 'credit');

  assert(normalized.transactionType === 'accrual_expense', 'type = accrual_expense', normalized.transactionType);
  assert(dr?.account === 'Utilities', 'DR = Utilities (via subcategory electricity)', dr?.account);
  assert(cr?.account === 'Accrued Expenses', 'CR = Accrued Expenses', cr?.account);
}

// G2: accrual_income
console.log('\n  G2: accrual_income — DR Accounts Receivable / CR Revenue');
{
  const { normalized } = simulateGemini({
    transactionType: 'accrual_income',
    subcategory: 'consulting',
    amount: 80000,
    confidence: { intent: 0.9, amount: 0.9, date: 0.5, accountMapping: 0.85 },
  });
  const entries = generateJournalEntries(normalized);
  const dr = entries.find(e => e.entryType === 'debit');
  const cr = entries.find(e => e.entryType === 'credit');

  assert(normalized.transactionType === 'accrual_income', 'type = accrual_income', normalized.transactionType);
  assert(dr?.account === 'Accounts Receivable', 'DR = Accounts Receivable', dr?.account);
  assert(cr?.account === 'Sales', 'CR = Sales (consulting → Sales)', cr?.account);
}

// G3: cogs_recognition
console.log('\n  G3: cogs_recognition — DR COGS / CR Inventory');
{
  const { normalized } = simulateGemini({
    transactionType: 'cogs_recognition',
    amount: 30000,
    confidence: { intent: 0.9, amount: 0.9, date: 0.5, accountMapping: 0.9 },
  });
  const entries = generateJournalEntries(normalized);
  const dr = entries.find(e => e.entryType === 'debit');
  const cr = entries.find(e => e.entryType === 'credit');

  assert(normalized.transactionType === 'cogs_recognition', 'type = cogs_recognition', normalized.transactionType);
  assert(dr?.account === 'Cost of Goods Sold', 'DR = Cost of Goods Sold', dr?.account);
  assert(cr?.account === 'Inventory', 'CR = Inventory', cr?.account);
}

// G4: inventory_sale WITH costAmount → 4-line GAAP journal
console.log('\n  G4: inventory_sale with costAmount → 4-line GAAP entry');
{
  const { normalized } = simulateGemini({
    transactionType: 'inventory_sale',
    amount: 50000,
    costAmount: 30000,   // Gemini extracted cost
    sourceAccount: 'Cash at Bank',
    confidence: { intent: 0.9, amount: 0.9, date: 0.5, accountMapping: 0.85 },
  });
  const entries = generateJournalEntries(normalized);

  assert(entries.length === 4, '4 journal lines for inventory_sale with cost', entries.length);
  const drSale  = entries.find(e => e.entryType === 'debit'  && e.account === 'Cash at Bank');
  const crSales = entries.find(e => e.entryType === 'credit' && e.account === 'Sales');
  const drCOGS  = entries.find(e => e.entryType === 'debit'  && e.account === 'Cost of Goods Sold');
  const crInv   = entries.find(e => e.entryType === 'credit' && e.account === 'Inventory');

  assert(drSale?.amount === 50000, 'DR Cash = 50000 (sale amount)', drSale?.amount);
  assert(crSales?.amount === 50000, 'CR Sales = 50000', crSales?.amount);
  assert(drCOGS?.amount === 30000, 'DR COGS = 30000 (cost amount)', drCOGS?.amount);
  assert(crInv?.amount === 30000, 'CR Inventory = 30000', crInv?.amount);
}

// G5: inventory_sale WITHOUT costAmount → 2-line only
console.log('\n  G5: inventory_sale without costAmount → 2-line (cost unknown)');
{
  const { normalized } = simulateGemini({
    transactionType: 'inventory_sale',
    amount: 50000,
    sourceAccount: 'Cash at Bank',
    confidence: { intent: 0.9, amount: 0.9, date: 0.5, accountMapping: 0.85 },
  });
  const entries = generateJournalEntries(normalized);

  assert(entries.length === 2, '2 journal lines when cost unknown', entries.length);
  assert(entries[0].account === 'Cash at Bank', 'DR = Cash at Bank', entries[0].account);
  assert(entries[1].account === 'Sales', 'CR = Sales', entries[1].account);
}

// G6: wht_on_rent with taxAmount → 3-line journal
console.log('\n  G6: wht_on_rent with taxAmount → 3-line journal');
{
  const { normalized } = simulateGemini({
    transactionType: 'wht_on_rent',
    amount: 50000,       // gross rent
    taxAmount: 5000,     // 10% WHT
    sourceAccount: 'Cash at Bank',
    confidence: { intent: 0.9, amount: 0.9, date: 0.5, accountMapping: 0.9 },
  });
  const entries = generateJournalEntries(normalized);

  assert(entries.length === 3, '3 journal lines for WHT on rent', entries.length);
  const drRent = entries.find(e => e.entryType === 'debit');
  const crCash = entries.find(e => e.entryType === 'credit' && e.account === 'Cash at Bank');
  const crWHT  = entries.find(e => e.entryType === 'credit' && e.account === 'WHT Payable');

  assert(drRent?.account === 'Rent', 'DR = Rent (gross 50000)', drRent?.account);
  assert(drRent?.amount === 50000, 'DR Rent amount = 50000', drRent?.amount);
  assert(crCash?.amount === 45000, 'CR Cash = 45000 (net)', crCash?.amount);
  assert(crWHT?.amount === 5000, 'CR WHT Payable = 5000', crWHT?.amount);
}

// G7: wht_on_services with taxRate → 3-line journal
console.log('\n  G7: wht_on_services with taxRate → 3-line journal');
{
  const { normalized } = simulateGemini({
    transactionType: 'wht_on_services',
    subcategory: 'professional_services',
    amount: 100000,      // gross fee
    taxRate: 8,          // 8% WHT on companies
    sourceAccount: 'Cash at Bank',
    debitAccount: 'Professional Fees',
    confidence: { intent: 0.9, amount: 0.9, date: 0.5, accountMapping: 0.9 },
  });
  const entries = generateJournalEntries(normalized);

  assert(entries.length === 3, '3 journal lines for WHT on services', entries.length);
  const drExp = entries.find(e => e.entryType === 'debit');
  const crCash = entries.find(e => e.account === 'Cash at Bank' && e.entryType === 'credit');
  const crWHT  = entries.find(e => e.account === 'WHT Payable');

  assert(drExp?.account === 'Professional Fees', 'DR = Professional Fees (Gemini hint used)', drExp?.account);
  assert(drExp?.amount === 100000, 'DR amount = 100000', drExp?.amount);
  assert(crCash?.amount === 92000, 'CR Cash = 92000 (net after 8% WHT)', crCash?.amount);
  assert(crWHT?.amount === 8000, 'CR WHT Payable = 8000 (8%)', crWHT?.amount);
}

/* ═══════════════════════════════════════════════════════════════════════════
 * SECTION H: Intelligence Fix — Gemini hint override of static fallbacks
 * ═══════════════════════════════════════════════════════════════════════════ */
section('H — Intelligence fix: Gemini account hints override static fallbacks');

// H1: Gemini says "Professional Fees" → should win over EXPENSE_ACCOUNT_MAP 'Advertising'
console.log('\n  H1: debitAccount hint overrides EXPENSE_ACCOUNT_MAP fallback');
{
  const { normalized } = simulateGemini({
    transactionType: 'expense',
    subcategory: null,    // unknown subcategory — would normally fall back to 'Advertising'
    amount: 20000,
    debitAccount: 'Professional Fees',
    creditAccount: 'Cash at Bank',
    confidence: { intent: 0.9, amount: 0.9, date: 0.5, accountMapping: 0.85 },
  });
  const entries = generateJournalEntries(normalized);
  const dr = entries.find(e => e.entryType === 'debit');

  assert(dr?.account === 'Professional Fees', 'DR = Professional Fees (Gemini override, not Advertising)', dr?.account);
}

// H2: For hardcoded template accounts (like 'Wages and Salaries'), Gemini hint does NOT override
console.log('\n  H2: hardcoded template accounts are NOT overridden by Gemini hints');
{
  const { normalized } = simulateGemini({
    transactionType: 'salary',
    amount: 80000,
    debitAccount: 'Payroll Cost',   // wrong Gemini suggestion
    creditAccount: 'Cash at Bank',
    confidence: { intent: 0.9, amount: 0.9, date: 0.5, accountMapping: 0.7 },
  });
  const entries = generateJournalEntries(normalized);
  const dr = entries.find(e => e.entryType === 'debit');

  // Template has debit = 'Wages and Salaries' (hardcoded, not __EXPENSE_ACCOUNT__),
  // so Gemini's 'Payroll Cost' should NOT override it.
  assert(dr?.account === 'Wages and Salaries', 'DR = Wages and Salaries (hardcoded template wins)', dr?.account);
}

// H3: financed_asset_purchase — creditAccount 'Company Car Loan' overrides default 'Loan Payable'
console.log('\n  H3: financed_asset_purchase — creditAccount hint selects specific liability');
{
  const { normalized } = simulateGemini({
    transactionType: 'financed_asset_purchase',
    subcategory: 'vehicle',
    amount: 2500000,
    creditAccount: 'Company Car Loan',
    confidence: { intent: 0.9, amount: 0.9, date: 0.5, accountMapping: 0.95 },
  });
  const entries = generateJournalEntries(normalized);
  const cr = entries.find(e => e.entryType === 'credit');

  // __LIABILITY_ACCOUNT__ is a placeholder → Gemini's hint wins
  assert(cr?.account === 'Company Car Loan', 'CR = Company Car Loan (Gemini hint overrides Loan Payable default)', cr?.account);
}

/* ═══════════════════════════════════════════════════════════════════════════
 * SECTION I: NL_TYPE_TO_API mapping for new types
 * ═══════════════════════════════════════════════════════════════════════════ */
section('I — mapTransactionTypeForApi new type mappings');

const apiMappings = [
  ['accrual_expense',  'Journal Entry'],
  ['accrual_income',   'Journal Entry'],
  ['cogs_recognition', 'Journal Entry'],
  ['wht_on_rent',      'WHT Payment'],
  ['wht_on_services',  'WHT Payment'],
];
for (const [nlType, expected] of apiMappings) {
  const result = mapTransactionTypeForApi(nlType);
  assert(result === expected, `mapTypeForApi('${nlType}') = '${expected}'`, result);
}

/* ═══════════════════════════════════════════════════════════════════════════
 * FINAL REPORT
 * ═══════════════════════════════════════════════════════════════════════════ */
console.log('\n' + '═'.repeat(60));
console.log(`  Phase 3 Test Results: ${passed} passed, ${failed} failed`);
console.log('═'.repeat(60));

if (failed > 0) {
  process.exit(1);
}
