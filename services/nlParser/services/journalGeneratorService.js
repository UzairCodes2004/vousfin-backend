/**
 * @module journalGeneratorService
 * @description Generates double-entry journal entries from normalized transaction data.
 *
 * Phase 2 additions:
 *  - financed_asset_purchase: Debit Asset / Credit Liability (not Cash)
 *  - payroll_with_tax: multi-line (wages / cash / tax payable)
 *  - gst_inclusive_sale: multi-line (cash / revenue / GST payable)
 *  - advance_revenue: Debit Cash / Credit Unearned Revenue
 *  - prepaid_expense: Debit Prepaid Expenses / Credit Cash
 *  - depreciation: Debit Depreciation Expense / Credit Accumulated Depreciation
 *  - wht_payment: Debit WHT Payable / Credit Cash
 *
 * Phase 3 — Accounting Intelligence Layer:
 *  - INTELLIGENCE FIX: Gemini's explicit debitAccount/creditAccount hints override
 *    static template resolutions for placeholder-resolved fields (__EXPENSE_ACCOUNT__,
 *    __ASSET_ACCOUNT__, __REVENUE_ACCOUNT__, __LIABILITY_ACCOUNT__). This prevents the
 *    static template from silently overriding more specific AI suggestions.
 *  - inventory_sale: now generates 4-line GAAP entry (sale + COGS) when costAmount available
 *  - accrual_expense: DR Expense / CR Accrued Expenses
 *  - accrual_income: DR Accounts Receivable / CR Revenue
 *  - cogs_recognition: DR Cost of Goods Sold / CR Inventory
 *  - wht_on_rent: multi-line DR Rent / CR Cash(net) + CR WHT Payable
 *  - wht_on_services: multi-line DR Expense / CR Cash(net) + CR WHT Payable
 *
 * Multi-line entries are returned as arrays with more than 2 items.
 * The transaction service derives the primary debitAccountId/creditAccountId
 * from journalLines[0] and journalLines[1] for backward compatibility.
 */

const {
  JOURNAL_TEMPLATES,
  EXPENSE_ACCOUNT_MAP,
  REVENUE_ACCOUNT_MAP,
  ASSET_ACCOUNT_MAP,
  LIABILITY_ACCOUNT_MAP,
} = require('../utils/accountMappings');
const { TRANSACTION_TYPES } = require('../constants/transactionTypes');
const {
  resolveTaxAmounts,
  getTaxPayableAccount,
  getTaxReceivableAccount,
  resolveInventoryAdjustmentAccounts,
} = require('../utils/taxCalculator');

/**
 * Generate journal entries for a normalized transaction.
 * Returns an array of { account, entryType, amount } objects.
 * For complex (multi-line) transactions, returns more than 2 entries.
 *
 * @param {object} parsedData - Normalized parsed transaction data.
 * @returns {Array<{ account: string, entryType: string, amount: number }>}
 */
function generateJournalEntries(parsedData) {
  const { transactionType, amount } = parsedData;

  if (!transactionType || !amount || amount <= 0) {
    return [];
  }

  // Dispatch to specialized generators for complex types
  switch (transactionType) {
    case TRANSACTION_TYPES.PAYROLL_WITH_TAX:
      return generatePayrollEntries(parsedData);
    case TRANSACTION_TYPES.GST_INCLUSIVE_SALE:
      return generateGSTSaleEntries(parsedData);
    case TRANSACTION_TYPES.DEPRECIATION:
      return generateDepreciationEntries(parsedData);
    case TRANSACTION_TYPES.INVENTORY_SALE:
      return generateInventorySaleEntries(parsedData);
    case TRANSACTION_TYPES.WHT_ON_RENT:
      return generateWHTRentEntries(parsedData);
    case TRANSACTION_TYPES.WHT_ON_SERVICES:
      return generateWHTServicesEntries(parsedData);
    // ── Phase 3 Step 4 ──────────────────────────────────────────────────────
    case TRANSACTION_TYPES.GST_EXCLUSIVE_PURCHASE:
      return generateGSTExclusivePurchaseEntries(parsedData);
    case TRANSACTION_TYPES.GST_EXCLUSIVE_SALE:
      return generateGSTExclusiveSaleEntries(parsedData);
    case TRANSACTION_TYPES.SALES_RETURN:
      return generateSalesReturnEntries(parsedData);
    case TRANSACTION_TYPES.PURCHASE_RETURN:
      return generatePurchaseReturnEntries(parsedData);
    case TRANSACTION_TYPES.INVENTORY_ADJUSTMENT:
      return generateInventoryAdjustmentEntries(parsedData);
    case TRANSACTION_TYPES.PAYROLL_PAYABLE:
      return generatePayrollPayableEntries(parsedData);
    case TRANSACTION_TYPES.PAYROLL_PAYMENT:
      return generatePayrollPaymentEntries(parsedData);
    case TRANSACTION_TYPES.TAX_PAYABLE_PAYMENT:
      return generateTaxPayablePaymentEntries(parsedData);
    default:
      return generateStandardEntries(parsedData);
  }
}

/* ── Standard 2-line journal (most transaction types) ───────────────────── */

/**
 * Returns true when a template field is a runtime placeholder (e.g., __EXPENSE_ACCOUNT__).
 * Gemini's explicit account hints override placeholder-resolved values — they must NOT
 * override hardcoded template accounts like 'Accounts Payable' or 'Inventory'.
 */
function isPlaceholder(templateField) {
  return typeof templateField === 'string'
    && templateField.startsWith('__')
    && templateField.endsWith('__');
}

function generateStandardEntries(parsedData) {
  const { transactionType, amount } = parsedData;

  const template = JOURNAL_TEMPLATES[transactionType];
  if (!template) {
    return buildFallbackEntries(parsedData);
  }

  let debitAccount  = resolveDebitAccount(template, parsedData);
  let creditAccount = resolveCreditAccount(template, parsedData);

  // ── INTELLIGENCE FIX: Gemini's explicit DR/CR hints override static placeholder results ──
  // When Gemini confidently suggests a specific account (e.g., "Professional Fees" instead
  // of our static fallback "Advertising"), use Gemini's suggestion for placeholder fields.
  // Hardcoded template accounts (e.g., 'Accounts Payable', 'Wages and Salaries') are NOT overridden.
  if (parsedData.debitAccount && isPlaceholder(template.debit)) {
    debitAccount = parsedData.debitAccount;
  }
  if (parsedData.creditAccount && isPlaceholder(template.credit)) {
    creditAccount = parsedData.creditAccount;
  }

  if (!debitAccount || !creditAccount) {
    return buildFallbackEntries(parsedData);
  }

  return [
    { account: debitAccount,  entryType: 'debit',  amount },
    { account: creditAccount, entryType: 'credit', amount },
  ];
}

/* ── Payroll with tax withholding (multi-line) ──────────────────────────── */

/**
 * Payroll entry (proper GAAP multi-line):
 *   Dr Wages and Salaries  = grossAmount
 *   Cr Cash at Bank        = netAmount (gross - taxAmount)
 *   Cr WHT Payable         = taxAmount
 *
 * If taxAmount cannot be determined from parsedData, falls back to 2-line:
 *   Dr Wages and Salaries / Cr Cash at Bank (full gross)
 *
 * taxAmount is derived from parsedData.taxAmount (AI-extracted) or
 * parsedData.taxRate (percentage of amount).
 */
function generatePayrollEntries(parsedData) {
  const { amount, sourceAccount, taxAmount: explicitTax, taxRate } = parsedData;
  const cashAccount = sourceAccount || 'Cash at Bank';

  // Determine tax amount
  let taxAmount = 0;
  if (explicitTax && explicitTax > 0) {
    taxAmount = Math.round(explicitTax * 100) / 100;
  } else if (taxRate && taxRate > 0) {
    taxAmount = Math.round((amount * taxRate / 100) * 100) / 100;
  }

  if (taxAmount > 0 && taxAmount < amount) {
    const netPay = Math.round((amount - taxAmount) * 100) / 100;
    return [
      { account: 'Wages and Salaries', entryType: 'debit',  amount },
      { account: cashAccount,          entryType: 'credit', amount: netPay },
      { account: 'WHT Payable',        entryType: 'credit', amount: taxAmount },
    ];
  }

  // Fallback: no tax breakdown available — simple 2-line
  return [
    { account: 'Wages and Salaries', entryType: 'debit',  amount },
    { account: cashAccount,          entryType: 'credit', amount },
  ];
}

/* ── GST-inclusive sale (multi-line) ────────────────────────────────────── */

/**
 * GST-inclusive sale (proper GAAP multi-line):
 *   Dr Cash at Bank (or A/R) = total amount (inclusive of GST)
 *   Cr Sales                 = exclusive amount (total / 1 + gstRate)
 *   Cr GST Payable           = GST component
 *
 * Default GST rate: 17% (Pakistan standard rate). Override via parsedData.taxRate.
 * If no rate can be inferred, falls back to 2-line with full amount to Sales.
 */
function generateGSTSaleEntries(parsedData) {
  const { amount, sourceAccount, subcategory, taxRate, taxAmount: explicitTax } = parsedData;
  const debitAccount   = sourceAccount || 'Cash at Bank';
  const revenueAccount = REVENUE_ACCOUNT_MAP[subcategory] || 'Sales';

  // Determine GST amount
  let gstAmount = 0;
  if (explicitTax && explicitTax > 0) {
    gstAmount = Math.round(explicitTax * 100) / 100;
  } else if (taxRate && taxRate > 0) {
    // taxRate is the GST percentage (e.g., 17 for 17%)
    // Reverse-calculate: GST = amount - (amount / (1 + rate/100))
    const rateDecimal = taxRate / 100;
    gstAmount = Math.round((amount - amount / (1 + rateDecimal)) * 100) / 100;
  } else {
    // Default to Pakistan standard GST rate (17%)
    const defaultRate = 0.17;
    gstAmount = Math.round((amount - amount / (1 + defaultRate)) * 100) / 100;
  }

  if (gstAmount > 0 && gstAmount < amount) {
    const exclusiveAmount = Math.round((amount - gstAmount) * 100) / 100;
    return [
      { account: debitAccount,   entryType: 'debit',  amount },
      { account: revenueAccount, entryType: 'credit', amount: exclusiveAmount },
      { account: 'GST Payable',  entryType: 'credit', amount: gstAmount },
    ];
  }

  // Fallback: cannot split GST — simplified 2-line entry, flag for review
  return [
    { account: debitAccount,   entryType: 'debit',  amount },
    { account: revenueAccount, entryType: 'credit', amount },
  ];
}

/* ── Depreciation (always 2-line, non-cash) ─────────────────────────────── */

function generateDepreciationEntries(parsedData) {
  const { amount } = parsedData;
  return [
    { account: 'Depreciation Expense',   entryType: 'debit',  amount },
    { account: 'Accumulated Depreciation', entryType: 'credit', amount },
  ];
}

/* ── Account resolution helpers ─────────────────────────────────────────── */

function resolveDebitAccount(template, parsedData) {
  const { subcategory, sourceAccount, taxType } = parsedData;
  let account = template.debit;

  if (account === '__EXPENSE_ACCOUNT__') {
    account = resolveExpenseAccount(subcategory);
  } else if (account === '__ASSET_ACCOUNT__') {
    account = resolveAssetAccount(subcategory);
  } else if (account === '__REVENUE_ACCOUNT__') {
    account = resolveRevenueAccount(subcategory);
  } else if (account === '__LIABILITY_ACCOUNT__') {
    account = resolveLiabilityAccount(subcategory);
  } else if (account === '__TAX_PAYABLE__') {
    // Resolves to the correct payable account based on tax type
    account = getTaxPayableAccount(taxType) || template.defaultDebit || 'GST Payable';
  } else if (account === '__EXPENSE_OR_INVENTORY__') {
    // For gst_exclusive_purchase: use inventory for inventory purchases, expense otherwise
    account = resolveExpenseOrInventoryAccount(subcategory, parsedData);
  } else if (account === '__SOURCE__') {
    account = sourceAccount || template.defaultDebit || 'Cash at Bank';
  } else if (account === '__DESTINATION__') {
    account = template.defaultDebit || 'Cash at Bank';
  } else if (account === '__ADJUSTMENT_DEBIT__') {
    account = sourceAccount || 'Advertising';
  }

  return account || null;
}

/**
 * Resolve debit account for gst_exclusive_purchase.
 * Prefers inventory for inventory-type purchases, otherwise uses expense account.
 */
function resolveExpenseOrInventoryAccount(subcategory, parsedData) {
  // If subcategory maps to an asset/inventory type, use asset map
  if (subcategory) {
    const assetAccount = ASSET_ACCOUNT_MAP[subcategory];
    if (assetAccount) return assetAccount;
  }
  // If Gemini provided explicit debitAccount
  if (parsedData.debitAccount) return parsedData.debitAccount;
  // Otherwise fall back to expense
  return resolveExpenseAccount(subcategory) || 'Inventory';
}

function resolveCreditAccount(template, parsedData) {
  const { subcategory, sourceAccount } = parsedData;
  let account = template.credit;

  if (account === '__SOURCE__') {
    account = sourceAccount || template.defaultCredit || 'Cash at Bank';
  } else if (account === '__EXPENSE_ACCOUNT__') {
    account = resolveExpenseAccount(subcategory);
  } else if (account === '__REVENUE_ACCOUNT__') {
    account = resolveRevenueAccount(subcategory);
  } else if (account === '__ASSET_ACCOUNT__') {
    account = resolveAssetAccount(subcategory);
  } else if (account === '__LIABILITY_ACCOUNT__') {
    account = resolveLiabilityAccount(subcategory);
  } else if (account === '__ADJUSTMENT_CREDIT__') {
    account = sourceAccount || 'Cash at Bank';
  }

  return account || null;
}

function resolveExpenseAccount(subcategory) {
  if (!subcategory) return 'Advertising';  // neutral expense fallback (not utility-specific)
  const sub = extractLeafSubcategory(subcategory);
  return EXPENSE_ACCOUNT_MAP[sub] || 'Advertising';
}

function resolveRevenueAccount(subcategory) {
  if (!subcategory) return 'Sales';
  const sub = extractLeafSubcategory(subcategory);
  return REVENUE_ACCOUNT_MAP[sub] || 'Sales';
}

function resolveAssetAccount(subcategory) {
  if (!subcategory) return 'Office Equipment';
  const sub = extractLeafSubcategory(subcategory);
  return ASSET_ACCOUNT_MAP[sub] || 'Office Equipment';
}

function resolveLiabilityAccount(subcategory) {
  if (!subcategory) return 'Loan Payable';
  const sub = extractLeafSubcategory(subcategory);
  return LIABILITY_ACCOUNT_MAP[sub] || 'Loan Payable';
}

/** Handle "parent:child" subcategory format — use leaf only */
function extractLeafSubcategory(subcategory) {
  if (!subcategory) return null;
  return subcategory.includes(':')
    ? subcategory.split(':').pop().trim()
    : subcategory;
}

/* ── Inventory sale — GAAP double-entry (sale + COGS) ───────────────────── */

/**
 * Inventory sale journal (GAAP-compliant):
 *   Entry 1 — Record the sale:
 *     Dr Cash at Bank (or A/R)   = sale amount
 *     Cr Sales                   = sale amount
 *   Entry 2 — Recognize the cost (only when costAmount is available):
 *     Dr Cost of Goods Sold      = cost amount
 *     Cr Inventory               = cost amount
 *
 * If parsedData.costAmount is not provided, only the sale entry is generated
 * and a review flag is added so the user knows to record COGS separately.
 */
function generateInventorySaleEntries(parsedData) {
  const { amount, sourceAccount, costAmount } = parsedData;
  const debitAccount = sourceAccount || 'Cash at Bank';

  const entries = [
    { account: debitAccount, entryType: 'debit',  amount },
    { account: 'Sales',      entryType: 'credit', amount },
  ];

  // Attach COGS entry only when cost is known
  const cost = typeof costAmount === 'number' && costAmount > 0 ? costAmount : null;
  if (cost) {
    entries.push({ account: 'Cost of Goods Sold', entryType: 'debit',  amount: cost });
    entries.push({ account: 'Inventory',           entryType: 'credit', amount: cost });
  }
  // When cost is absent: the 2-line sale entry is returned and the caller
  // should set requiresReview = true with reason "COGS entry needed".

  return entries;
}

/* ── WHT on Rent (multi-line) ───────────────────────────────────────────── */

/**
 * Rent payment with Withholding Tax deducted at source:
 *   Dr Rent                = grossAmount
 *   Cr Cash at Bank        = grossAmount − taxAmount  (net paid to landlord)
 *   Cr WHT Payable         = taxAmount               (held back, remitted to FBR)
 *
 * Pakistan WHT rate on rent: 15% for non-filers, 10% for filers (varies).
 * If taxAmount cannot be determined, falls back to 2-line:
 *   Dr Rent / Cr Cash at Bank (full gross)
 */
function generateWHTRentEntries(parsedData) {
  const { amount, sourceAccount, taxAmount: explicitTax, taxRate } = parsedData;
  const cashAccount = sourceAccount || 'Cash at Bank';

  let whtAmount = 0;
  if (explicitTax && explicitTax > 0) {
    whtAmount = Math.round(explicitTax * 100) / 100;
  } else if (taxRate && taxRate > 0) {
    whtAmount = Math.round((amount * taxRate / 100) * 100) / 100;
  }

  if (whtAmount > 0 && whtAmount < amount) {
    const netPay = Math.round((amount - whtAmount) * 100) / 100;
    return [
      { account: 'Rent',        entryType: 'debit',  amount },
      { account: cashAccount,   entryType: 'credit', amount: netPay },
      { account: 'WHT Payable', entryType: 'credit', amount: whtAmount },
    ];
  }

  // Fallback: no WHT breakdown — simple 2-line
  return [
    { account: 'Rent',      entryType: 'debit',  amount },
    { account: cashAccount, entryType: 'credit', amount },
  ];
}

/* ── WHT on Services (multi-line) ───────────────────────────────────────── */

/**
 * Service fee payment with Withholding Tax deducted at source:
 *   Dr Expense Account     = grossAmount    (e.g., Professional Fees, Legal Fees)
 *   Cr Cash at Bank        = grossAmount − taxAmount  (net paid to vendor)
 *   Cr WHT Payable         = taxAmount               (held back, remitted to FBR)
 *
 * Pakistan WHT rate on services: typically 8% for companies, 10% for individuals.
 * If taxAmount cannot be determined, falls back to 2-line.
 */
function generateWHTServicesEntries(parsedData) {
  const { amount, sourceAccount, subcategory, taxAmount: explicitTax, taxRate, debitAccount: geminiDebit } = parsedData;
  const cashAccount = sourceAccount || 'Cash at Bank';
  // Prefer Gemini's specific account suggestion; fall back to subcategory map; then 'Professional Fees'
  const expenseAccount = geminiDebit || resolveExpenseAccount(subcategory) || 'Professional Fees';

  let whtAmount = 0;
  if (explicitTax && explicitTax > 0) {
    whtAmount = Math.round(explicitTax * 100) / 100;
  } else if (taxRate && taxRate > 0) {
    whtAmount = Math.round((amount * taxRate / 100) * 100) / 100;
  }

  if (whtAmount > 0 && whtAmount < amount) {
    const netPay = Math.round((amount - whtAmount) * 100) / 100;
    return [
      { account: expenseAccount, entryType: 'debit',  amount },
      { account: cashAccount,    entryType: 'credit', amount: netPay },
      { account: 'WHT Payable',  entryType: 'credit', amount: whtAmount },
    ];
  }

  // Fallback: no WHT breakdown — simple 2-line
  return [
    { account: expenseAccount, entryType: 'debit',  amount },
    { account: cashAccount,    entryType: 'credit', amount },
  ];
}

/* ═══════════════════════════════════════════════════════════════════════════
 * Phase 3 Step 4 — Tax + Liability + Inventory generators
 * ═══════════════════════════════════════════════════════════════════════════ */

/* ── GST-Exclusive Purchase (input tax) ──────────────────────────────────── */
/**
 * Purchase where stated amount is NET (before tax) — "plus GST", "+ 17% GST".
 *
 * Standard (input-tax-claiming, GST-registered business):
 *   Dr Inventory/Expense  = netAmount
 *   Dr GST Receivable     = taxAmount  (input tax credit)
 *   Cr Cash/AP            = grossAmount
 *
 * Fallback (no tax breakdown — e.g., Gemini did not extract taxAmount):
 *   Dr Inventory/Expense  = amount
 *   Cr Cash/AP            = amount
 *
 * The input-tax receivable can be offset against GST Payable (output tax) when
 * the business files its GST return.
 */
function generateGSTExclusivePurchaseEntries(parsedData) {
  const { sourceAccount, subcategory } = parsedData;
  const creditAccount = sourceAccount || 'Accounts Payable';
  const debitAccount  = resolveExpenseOrInventoryAccount(subcategory, parsedData);

  const { netAmount, taxAmount, grossAmount } = resolveTaxAmounts(parsedData, 'exclusive');
  const inputTaxAccount = getTaxReceivableAccount(parsedData.taxType);

  if (taxAmount > 0 && netAmount > 0) {
    return [
      { account: debitAccount,    entryType: 'debit',  amount: netAmount  },
      { account: inputTaxAccount, entryType: 'debit',  amount: taxAmount  },
      { account: creditAccount,   entryType: 'credit', amount: grossAmount },
    ];
  }

  // Fallback: tax unknown — include GST in cost (non-registered businesses)
  const amt = parsedData.amount;
  return [
    { account: debitAccount,  entryType: 'debit',  amount: amt },
    { account: creditAccount, entryType: 'credit', amount: amt },
  ];
}

/* ── GST-Exclusive Sale (output tax) ─────────────────────────────────────── */
/**
 * Sale where stated amount is NET — "plus GST", "excluding tax".
 *
 *   Dr Cash/AR            = grossAmount  (customer pays tax-inclusive)
 *   Cr Sales              = netAmount    (revenue is the net amount)
 *   Cr GST Payable        = taxAmount    (output tax collected)
 *
 * Fallback (no tax rate/amount):
 *   Dr Cash / Cr Sales = amount
 */
function generateGSTExclusiveSaleEntries(parsedData) {
  const { sourceAccount, subcategory } = parsedData;
  const debitAccount    = sourceAccount || 'Cash at Bank';
  const revenueAccount  = resolveRevenueAccount(subcategory);
  const outputTaxAccount = getTaxPayableAccount(parsedData.taxType);

  const { netAmount, taxAmount, grossAmount } = resolveTaxAmounts(parsedData, 'exclusive');

  if (taxAmount > 0 && netAmount > 0) {
    return [
      { account: debitAccount,     entryType: 'debit',  amount: grossAmount },
      { account: revenueAccount,   entryType: 'credit', amount: netAmount   },
      { account: outputTaxAccount, entryType: 'credit', amount: taxAmount   },
    ];
  }

  // Fallback
  const amt = parsedData.amount;
  return [
    { account: debitAccount,   entryType: 'debit',  amount: amt },
    { account: revenueAccount, entryType: 'credit', amount: amt },
  ];
}

/* ── Sales Return ────────────────────────────────────────────────────────── */
/**
 * Customer returns goods — reverses the original sale.
 *
 * Primary reversal:
 *   Dr Sales Returns            = amount
 *   Cr Cash or Accounts Receivable = amount
 *
 * When costAmount is known (perpetual inventory — reverse the COGS entry):
 *   Dr Inventory               = costAmount
 *   Cr Cost of Goods Sold      = costAmount
 */
function generateSalesReturnEntries(parsedData) {
  const { amount, sourceAccount, costAmount } = parsedData;
  const creditAccount = sourceAccount || 'Cash at Bank';

  const entries = [
    { account: 'Sales Returns', entryType: 'debit',  amount },
    { account: creditAccount,   entryType: 'credit', amount },
  ];

  // Reverse COGS only when cost is available (perpetual inventory)
  if (costAmount && costAmount > 0) {
    entries.push({ account: 'Inventory',          entryType: 'debit',  amount: costAmount });
    entries.push({ account: 'Cost of Goods Sold', entryType: 'credit', amount: costAmount });
  }

  return entries;
}

/* ── Purchase Return ─────────────────────────────────────────────────────── */
/**
 * Business returns goods to supplier — reverses original purchase.
 *
 *   Dr Cash or Accounts Payable = amount
 *   Cr Inventory                = amount
 *
 * When input tax was originally claimed, also reverse it:
 *   Dr GST Payable              = taxAmount  (reduce the input credit)
 *   Cr GST Receivable           = taxAmount
 * (simplified — only if taxAmount is known)
 */
function generatePurchaseReturnEntries(parsedData) {
  const { amount, sourceAccount, taxAmount } = parsedData;
  const debitAccount = sourceAccount || 'Accounts Payable';

  const entries = [
    { account: debitAccount, entryType: 'debit',  amount },
    { account: 'Inventory',  entryType: 'credit', amount },
  ];

  // Reverse input tax if it was claimed on the original purchase
  if (taxAmount && taxAmount > 0) {
    const inputTaxAccount  = getTaxReceivableAccount(parsedData.taxType);
    const outputTaxAccount = getTaxPayableAccount(parsedData.taxType);
    entries.push({ account: outputTaxAccount, entryType: 'debit',  amount: taxAmount });
    entries.push({ account: inputTaxAccount,  entryType: 'credit', amount: taxAmount });
  }

  return entries;
}

/* ── Inventory Adjustment ────────────────────────────────────────────────── */
/**
 * Stock count discrepancy, damage, expiry, or manual correction.
 *
 * Write-down (default — loss, damage, shrinkage):
 *   Dr Inventory Write-Off = amount
 *   Cr Inventory           = amount
 *
 * Write-up (gain — found stock, revaluation upward):
 *   Dr Inventory           = amount
 *   Cr Other Revenue       = amount
 */
function generateInventoryAdjustmentEntries(parsedData) {
  const { amount, adjustmentType } = parsedData;
  const { debitAccount, creditAccount } = resolveInventoryAdjustmentAccounts(adjustmentType);

  return [
    { account: debitAccount,  entryType: 'debit',  amount },
    { account: creditAccount, entryType: 'credit', amount },
  ];
}

/* ── Payroll Payable (accrual — no cash yet) ─────────────────────────────── */
/**
 * Record payroll liability BEFORE paying employees.
 * The business owes employees their net wages + owes FBR the withheld tax.
 *
 * Full multi-line (when taxAmount and optionally eobi are known):
 *   Dr Wages and Salaries    = grossAmount
 *   Cr Wages Payable         = netPay           (gross - tax - eobi)
 *   Cr WHT Payable           = taxAmount
 *   Cr EOBI Payable          = eobi (if > 0)
 *
 * Fallback (no deductions available):
 *   Dr Wages and Salaries    = amount
 *   Cr Wages Payable         = amount
 */
function generatePayrollPayableEntries(parsedData) {
  const { amount, taxAmount: explicit, taxRate, eobi } = parsedData;

  let taxAmount = 0;
  if (explicit && explicit > 0) {
    taxAmount = r2(explicit);
  } else if (taxRate && taxRate > 0) {
    taxAmount = r2(amount * taxRate / 100);
  }

  const eobi2 = (eobi && eobi > 0) ? r2(eobi) : 0;

  if (taxAmount > 0 && taxAmount < amount) {
    const netPay = r2(amount - taxAmount - eobi2);
    const entries = [
      { account: 'Wages and Salaries', entryType: 'debit',  amount },
      { account: 'Wages Payable',      entryType: 'credit', amount: netPay },
      { account: 'WHT Payable',        entryType: 'credit', amount: taxAmount },
    ];
    if (eobi2 > 0) {
      entries.push({ account: 'EOBI Payable', entryType: 'credit', amount: eobi2 });
    }
    return entries;
  }

  // Fallback: record full amount as wages payable
  return [
    { account: 'Wages and Salaries', entryType: 'debit',  amount },
    { account: 'Wages Payable',      entryType: 'credit', amount },
  ];
}

/* ── Payroll Payment (settle wages payable) ──────────────────────────────── */
/**
 * Pay previously recorded wages payable.
 *   Dr Wages Payable   = amount
 *   Cr Cash at Bank    = amount
 */
function generatePayrollPaymentEntries(parsedData) {
  const { amount, sourceAccount } = parsedData;
  const cashAccount = sourceAccount || 'Cash at Bank';

  return [
    { account: 'Wages Payable', entryType: 'debit',  amount },
    { account: cashAccount,     entryType: 'credit', amount },
  ];
}

/* ── Tax Payable Payment (pay GST / WHT / SRB to authority) ─────────────── */
/**
 * Pay a tax liability to FBR, SRB, PRA, etc.
 * The specific payable account is resolved from parsedData.taxType.
 *
 *   Dr GST Payable / WHT Payable / SRB Payable = amount
 *   Cr Cash at Bank                             = amount
 */
function generateTaxPayablePaymentEntries(parsedData) {
  const { amount, sourceAccount, taxType } = parsedData;
  const cashAccount   = sourceAccount || 'Cash at Bank';
  const taxPayAccount = getTaxPayableAccount(taxType) || 'GST Payable';

  return [
    { account: taxPayAccount, entryType: 'debit',  amount },
    { account: cashAccount,   entryType: 'credit', amount },
  ];
}

/* ── Internal: round to 2dp ──────────────────────────────────────────────── */
function r2(n) { return Math.round((n || 0) * 100) / 100; }

/* ── Fallback when template is unavailable ──────────────────────────────── */

function buildFallbackEntries(parsedData) {
  const { amount, sourceAccount } = parsedData;
  if (!amount || amount <= 0) return [];
  // Use Advertising as the fallback debit — it is a neutral expense account
  // and less misleading than Utilities for unrecognised transaction types.
  return [
    { account: 'Advertising',                  entryType: 'debit',  amount },
    { account: sourceAccount || 'Cash at Bank', entryType: 'credit', amount },
  ];
}

module.exports = { generateJournalEntries };
