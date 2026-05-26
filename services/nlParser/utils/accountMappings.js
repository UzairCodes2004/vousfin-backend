/**
 * @module accountMappings
 * @description Maps NLP transaction types and subcategories to their corresponding
 * debit and credit accounts for journal entry generation.
 *
 * CRITICAL: All account names here MUST exactly match the accountName values in
 * config/constants.js DEFAULT_ACCOUNTS. If they don't, the accountRepository
 * fuzzy matcher will fail to resolve them to real MongoDB IDs.
 *
 * Account name reference (from DEFAULT_ACCOUNTS):
 *   Assets:     Cash at Bank (1010), Cash on Hand (1020), Accounts Receivable (1110),
 *               Prepaid Expenses (1120), Inventory (1150), Furniture and Fittings (1210),
 *               Office Equipment (1220), Company Car (1230), Accumulated Depreciation (1250)
 *   Liabilities: Accounts Payable (2110), GST Payable (2120), WHT Payable (2125),
 *               Director's Loan (2130), Wages Payable (2140), PAYG Withholding Payable (2150),
 *               Superannuation Payable (2160), Unearned Revenue (2170),
 *               Company Car Loan (2210), Equipment Loan (2220), Loan Payable (2230)
 *   Equity:     Capital / Investment (3110), Distributions / Drawings (3120)
 *   Revenue:    Sales (4110), Other Revenue (4120), Interest Income (4130)
 *   COGS:       Cost of Goods Sold (5110)
 *   Expenses:   Rent (6110), Bank Fees (6120), Company Car Expenses (6130),
 *               Website Hosting (6140), Utilities (6150), Advertising (6160),
 *               Freight (6170), Wages and Salaries (6180), Superannuation (6190),
 *               Depreciation Expense (6230), Interest Expense (6240)
 */

const { TRANSACTION_TYPES } = require('../constants/transactionTypes');

/* ── Journal Entry Templates ────────────────────────────────────────────────
 * Placeholders resolved at runtime by journalGeneratorService:
 *   __EXPENSE_ACCOUNT__   → resolved from subcategory via EXPENSE_ACCOUNT_MAP
 *   __ASSET_ACCOUNT__     → resolved from subcategory via ASSET_ACCOUNT_MAP
 *   __REVENUE_ACCOUNT__   → resolved from subcategory via REVENUE_ACCOUNT_MAP
 *   __LIABILITY_ACCOUNT__ → resolved from subcategory via LIABILITY_ACCOUNT_MAP
 *   __SOURCE__            → replaced with parsedData.sourceAccount (payment method)
 *   __DESTINATION__       → transfer destination (defaults to Cash at Bank)
 *   __ADJUSTMENT_DEBIT__  → context-resolved for adjustments
 *   __ADJUSTMENT_CREDIT__ → context-resolved for adjustments
 * ─────────────────────────────────────────────────────────────────────────── */
const JOURNAL_TEMPLATES = Object.freeze({
  // ── Core types ─────────────────────────────────────────────────────────────
  [TRANSACTION_TYPES.EXPENSE]: {
    debit:         '__EXPENSE_ACCOUNT__',
    credit:        '__SOURCE__',
    defaultCredit: 'Cash on Hand',
  },
  [TRANSACTION_TYPES.INCOME]: {
    debit:        '__SOURCE__',
    credit:       '__REVENUE_ACCOUNT__',
    defaultDebit: 'Cash at Bank',
  },
  [TRANSACTION_TYPES.ASSET_PURCHASE]: {
    debit:         '__ASSET_ACCOUNT__',
    credit:        '__SOURCE__',
    defaultCredit: 'Cash at Bank',
  },
  [TRANSACTION_TYPES.INVENTORY_PURCHASE]: {
    debit:         'Inventory',
    credit:        '__SOURCE__',
    defaultCredit: 'Cash at Bank',
  },
  [TRANSACTION_TYPES.INVENTORY_SALE]: {
    debit:        '__SOURCE__',
    credit:       'Sales',
    defaultDebit: 'Cash at Bank',
  },
  [TRANSACTION_TYPES.OWNER_INVESTMENT]: {
    debit:        '__SOURCE__',
    credit:       'Capital / Investment',  // DB canonical (3110)
    defaultDebit: 'Cash at Bank',
  },
  [TRANSACTION_TYPES.OWNER_WITHDRAWAL]: {
    debit:         'Distributions / Drawings',  // DB canonical (3120)
    credit:        '__SOURCE__',
    defaultCredit: 'Cash at Bank',
  },
  [TRANSACTION_TYPES.LOAN_RECEIVED]: {
    debit:        '__SOURCE__',
    credit:       'Loan Payable',
    defaultDebit: 'Cash at Bank',
  },
  [TRANSACTION_TYPES.LOAN_PAYMENT]: {
    debit:         'Loan Payable',
    credit:        '__SOURCE__',
    defaultCredit: 'Cash at Bank',
  },
  [TRANSACTION_TYPES.LIABILITY_PAYMENT]: {
    debit:         'Accounts Payable',
    credit:        '__SOURCE__',
    defaultCredit: 'Cash at Bank',
  },
  [TRANSACTION_TYPES.TRANSFER]: {
    debit:         '__DESTINATION__',
    credit:        '__SOURCE__',
    defaultDebit:  'Cash at Bank',
    defaultCredit: 'Cash at Bank',
  },
  [TRANSACTION_TYPES.REFUND]: {
    debit:         '__SOURCE__',
    credit:        '__EXPENSE_ACCOUNT__',
    defaultDebit:  'Cash at Bank',
    defaultCredit: 'Advertising',  // neutral expense fallback; resolveExpenseAccount handles specifics
  },
  [TRANSACTION_TYPES.SALARY]: {
    debit:         'Wages and Salaries',
    credit:        '__SOURCE__',
    defaultCredit: 'Cash at Bank',
  },
  [TRANSACTION_TYPES.TAX]: {
    debit:         'WHT Payable',
    credit:        '__SOURCE__',
    defaultCredit: 'Cash at Bank',
  },
  [TRANSACTION_TYPES.ACCOUNTS_RECEIVABLE]: {
    debit:         'Accounts Receivable',
    credit:        '__REVENUE_ACCOUNT__',
    defaultCredit: 'Sales',
  },
  [TRANSACTION_TYPES.ACCOUNTS_PAYABLE]: {
    debit:         '__EXPENSE_ACCOUNT__',
    credit:        'Accounts Payable',
    defaultDebit:  'Advertising',  // neutral expense fallback; resolveExpenseAccount handles specifics
  },
  [TRANSACTION_TYPES.DEPRECIATION]: {
    debit:  'Depreciation Expense',
    credit: 'Accumulated Depreciation',
  },
  [TRANSACTION_TYPES.ADJUSTMENT]: {
    debit:  '__ADJUSTMENT_DEBIT__',
    credit: '__ADJUSTMENT_CREDIT__',
  },

  // ── Extended types (Phase 2) ────────────────────────────────────────────────
  /**
   * Financed asset purchase — Asset is acquired via a liability (no cash outflow).
   * Debit: Asset account (e.g., Company Car, Office Equipment)
   * Credit: Liability account (e.g., Company Car Loan, Loan Payable, Accounts Payable)
   */
  [TRANSACTION_TYPES.FINANCED_ASSET_PURCHASE]: {
    debit:         '__ASSET_ACCOUNT__',
    credit:        '__LIABILITY_ACCOUNT__',
    defaultCredit: 'Loan Payable',
  },

  /**
   * Payroll with tax withholding — multi-line preferred but simplified here.
   * For full multi-line: Debit Wages, Credit Cash (net) + Credit WHT Payable + Credit Super Payable.
   * The simplified template handles the single-entry fallback.
   */
  [TRANSACTION_TYPES.PAYROLL_WITH_TAX]: {
    debit:         'Wages and Salaries',
    credit:        '__SOURCE__',
    defaultCredit: 'Cash at Bank',
  },

  /**
   * GST-inclusive sale — Cash/Bank debit, Revenue + GST Payable credit.
   * Multi-line preferred; simplified template for single-entry fallback.
   */
  [TRANSACTION_TYPES.GST_INCLUSIVE_SALE]: {
    debit:        '__SOURCE__',
    credit:       '__REVENUE_ACCOUNT__',
    defaultDebit: 'Cash at Bank',
    defaultCredit:'Sales',
  },

  /**
   * Advance revenue from customer — Cash in, Unearned Revenue credited (liability).
   * Debit: Cash at Bank / Credit: Unearned Revenue
   */
  [TRANSACTION_TYPES.ADVANCE_REVENUE]: {
    debit:        '__SOURCE__',
    credit:       'Unearned Revenue',
    defaultDebit: 'Cash at Bank',
  },

  /**
   * Prepaid expense — Asset recorded; cash out now, expense recognized later.
   * Debit: Prepaid Expenses / Credit: Cash
   */
  [TRANSACTION_TYPES.PREPAID_EXPENSE]: {
    debit:         'Prepaid Expenses',
    credit:        '__SOURCE__',
    defaultCredit: 'Cash at Bank',
  },

  /**
   * WHT payment to FBR — debit the payable, credit cash.
   * Debit: WHT Payable / Credit: Cash at Bank
   */
  [TRANSACTION_TYPES.WHT_PAYMENT]: {
    debit:         'WHT Payable',
    credit:        '__SOURCE__',
    defaultCredit: 'Cash at Bank',
  },

  // ── Phase 3 — Accounting Intelligence Types ────────────────────────────────

  /**
   * Accrual expense — expense incurred but not yet paid.
   * Debit: Expense account / Credit: Accrued Expenses (liability)
   * Example: "Record December electricity bill not yet paid"
   */
  [TRANSACTION_TYPES.ACCRUAL_EXPENSE]: {
    debit:         '__EXPENSE_ACCOUNT__',
    credit:        'Accrued Expenses',
    defaultDebit:  'Advertising',
  },

  /**
   * Accrual income — revenue earned but not yet received.
   * Debit: Accounts Receivable / Credit: Revenue account
   * Example: "Invoice client for consulting done in April (unpaid)"
   */
  [TRANSACTION_TYPES.ACCRUAL_INCOME]: {
    debit:         'Accounts Receivable',
    credit:        '__REVENUE_ACCOUNT__',
    defaultCredit: 'Sales',
  },

  /**
   * COGS recognition — record cost when inventory is sold.
   * Debit: Cost of Goods Sold / Credit: Inventory
   * Example: "Recognize cost of goods sold for this week's sales"
   */
  [TRANSACTION_TYPES.COGS_RECOGNITION]: {
    debit:  'Cost of Goods Sold',
    credit: 'Inventory',
  },

  /**
   * Rent payment with WHT deduction (multi-line, handled in journalGeneratorService).
   * Debit: Rent = gross / Credit: Cash (net) + Credit: WHT Payable
   * Template below is the 2-line fallback when taxAmount is absent.
   */
  [TRANSACTION_TYPES.WHT_ON_RENT]: {
    debit:         'Rent',
    credit:        '__SOURCE__',
    defaultCredit: 'Cash at Bank',
  },

  /**
   * Service fee payment with WHT deduction (multi-line, handled in journalGeneratorService).
   * Debit: Expense = gross / Credit: Cash (net) + Credit: WHT Payable
   * Template below is the 2-line fallback when taxAmount is absent.
   */
  [TRANSACTION_TYPES.WHT_ON_SERVICES]: {
    debit:         '__EXPENSE_ACCOUNT__',
    credit:        '__SOURCE__',
    defaultCredit: 'Cash at Bank',
    defaultDebit:  'Professional Fees',
  },

  // ── Phase 3 Step 4 — Tax + Liability + Inventory ───────────────────────────

  /**
   * Purchase where stated amount is net (before tax) — "plus GST on credit"
   * Multi-line: DR Expense/Inventory (net) + DR GST Receivable / CR Cash/AP (gross)
   * 2-line fallback when no taxAmount available.
   */
  [TRANSACTION_TYPES.GST_EXCLUSIVE_PURCHASE]: {
    debit:         '__EXPENSE_OR_INVENTORY__',
    credit:        '__SOURCE__',
    defaultCredit: 'Accounts Payable',
    defaultDebit:  'Inventory',
  },

  /**
   * Sale where stated amount is net (before tax) — "plus GST" / "excluding tax"
   * Multi-line: DR Cash/AR (gross) / CR Sales (net) + CR GST Payable
   * 2-line fallback: DR Cash / CR Sales (full amount when no tax breakdown).
   */
  [TRANSACTION_TYPES.GST_EXCLUSIVE_SALE]: {
    debit:        '__SOURCE__',
    credit:       '__REVENUE_ACCOUNT__',
    defaultDebit: 'Cash at Bank',
    defaultCredit:'Sales',
  },

  /**
   * Customer returns goods — reverses the sale.
   * DR Sales Returns / CR Cash or Accounts Receivable
   * (+ DR Inventory / CR COGS when costAmount is known)
   */
  [TRANSACTION_TYPES.SALES_RETURN]: {
    debit:         'Sales Returns',
    credit:        '__SOURCE__',
    defaultCredit: 'Cash at Bank',
  },

  /**
   * Business returns goods to supplier.
   * DR Cash or Accounts Payable / CR Inventory
   */
  [TRANSACTION_TYPES.PURCHASE_RETURN]: {
    debit:         '__SOURCE__',
    credit:        'Inventory',
    defaultDebit:  'Accounts Payable',
  },

  /**
   * Inventory write-down/write-up — stock adjustment.
   * Write-down: DR Inventory Write-Off / CR Inventory
   * Write-up:   DR Inventory / CR Other Revenue
   * Resolved by journalGeneratorService based on adjustmentType.
   */
  [TRANSACTION_TYPES.INVENTORY_ADJUSTMENT]: {
    debit:  '__ADJUSTMENT_DEBIT__',
    credit: '__ADJUSTMENT_CREDIT__',
  },

  /**
   * Record payroll as liability (before paying employees).
   * Multi-line: DR Wages / CR Wages Payable (net) + CR WHT Payable + CR EOBI Payable
   * 2-line fallback: DR Wages / CR Wages Payable
   */
  [TRANSACTION_TYPES.PAYROLL_PAYABLE]: {
    debit:         'Wages and Salaries',
    credit:        'Wages Payable',
  },

  /**
   * Pay the previously recorded wages payable.
   * DR Wages Payable / CR Cash at Bank
   */
  [TRANSACTION_TYPES.PAYROLL_PAYMENT]: {
    debit:         'Wages Payable',
    credit:        '__SOURCE__',
    defaultCredit: 'Cash at Bank',
  },

  /**
   * Pay GST / WHT / SRB to the tax authority.
   * DR Tax Payable account / CR Cash at Bank
   * The specific payable account is resolved from parsedData.taxType.
   */
  [TRANSACTION_TYPES.TAX_PAYABLE_PAYMENT]: {
    debit:         '__TAX_PAYABLE__',
    credit:        '__SOURCE__',
    defaultDebit:  'GST Payable',
    defaultCredit: 'Cash at Bank',
  },
});

/* ── Expense subcategory → DB account name ──────────────────────────────────
 * All names MUST exactly match accountName in DEFAULT_ACCOUNTS.
 * ─────────────────────────────────────────────────────────────────────────── */
const EXPENSE_ACCOUNT_MAP = Object.freeze({
  // Utilities (6150)
  electricity:           'Utilities',
  internet:              'Utilities',
  gas:                   'Utilities',
  water:                 'Utilities',
  mobile_bill:           'Utilities',
  // Office-related — map to Advertising as a close general-expenses proxy
  // (no dedicated Office Supplies account in default CoA; Advertising is least wrong)
  office_supplies:       'Advertising',
  stationery:            'Advertising',
  printing:              'Advertising',
  // Insurance — maps to Prepaid Expenses (asset) when prepaid, otherwise Advertising
  // Using Prepaid Expenses as the closest match in default CoA
  insurance:             'Prepaid Expenses',
  // Miscellaneous — general catch-all, use Advertising as neutral expense bucket
  miscellaneous:         'Advertising',
  // Rent (6110)
  rent:                  'Rent',
  // Wages and Salaries (6180)
  salary:                'Wages and Salaries',
  // Company Car Expenses (6130)
  fuel:                  'Company Car Expenses',
  transport:             'Company Car Expenses',
  maintenance:           'Company Car Expenses',
  repairs:               'Company Car Expenses',
  // Advertising (6160)
  marketing:             'Advertising',
  ads:                   'Advertising',
  // Website Hosting (6140)
  hosting:               'Website Hosting',
  software_subscription: 'Website Hosting',
  cloud_services:        'Website Hosting',
  domain:                'Website Hosting',
  // Bank Fees (6120)
  bank_fee:              'Bank Fees',
  // Interest Expense (6240) — NEW account
  interest:              'Interest Expense',
  // Depreciation Expense (6230) — NEW account
  depreciation:          'Depreciation Expense',
  // WHT Payable (2125) — credit not debit, but used as debit in tax payments
  tax:                   'WHT Payable',
  wht:                   'WHT Payable',
  // Superannuation (6190) — exists in DB
  superannuation:        'Superannuation',
  eobi:                  'Superannuation',  // EOBI → closest equivalent
  // Freight (6170) — exists in DB
  freight:               'Freight',
  // Phase 3 additions — Professional & Legal (maps to Professional Fees; fuzzy resolves to closest DB account)
  legal_fees:            'Professional Fees',
  legal:                 'Professional Fees',
  professional_services: 'Professional Fees',
  professional_fees:     'Professional Fees',
  audit_fees:            'Professional Fees',
  accounting_fees:       'Professional Fees',
  consultant:            'Professional Fees',
  // Training & Development — map to Advertising (nearest catch-all in default CoA)
  training:              'Advertising',
  workshop:              'Advertising',
  seminar:               'Advertising',
  // Cleaning & Security — catch-all (no dedicated account in default CoA)
  cleaning:              'Advertising',
  security:              'Advertising',
  // Travel — Company Car Expenses is closest in default CoA; businesses with
  // a 'Travel and Accommodation' account will resolve there via fuzzy matching
  travel_expense:        'Company Car Expenses',
  accommodation:         'Company Car Expenses',
  hotel:                 'Company Car Expenses',
  flight:                'Company Car Expenses',
  // Courier & Packaging — Freight account (6170)
  courier:               'Freight',
  postage:               'Freight',
  packaging:             'Freight',
  customs_duty:          'Freight',
  // Meals & Entertainment — Advertising is the nearest catch-all
  meals:                 'Advertising',
  entertainment:         'Advertising',
  // Medical & Uniforms — HR-adjacent, nearest = Wages and Salaries
  medical:               'Wages and Salaries',
  uniforms:              'Wages and Salaries',
  // Office supplies / chairs — Furniture and Fittings when capitalized, otherwise Office Supplies
  office_chairs:         'Furniture and Fittings',
  chairs:                'Furniture and Fittings',
  desk:                  'Furniture and Fittings',
  shelving:              'Furniture and Fittings',
});

/* ── Revenue subcategory → DB account name ──────────────────────────────────
 * ─────────────────────────────────────────────────────────────────────────── */
const REVENUE_ACCOUNT_MAP = Object.freeze({
  // Sales (4110)
  service_revenue:    'Sales',
  product_sales:      'Sales',
  consulting:         'Sales',
  // Other Revenue (4120)
  commission:         'Other Revenue',
  subscription_income:'Other Revenue',
  investment_income:  'Other Revenue',
  rental_income:      'Other Revenue',
  gst_inclusive_sale: 'Sales',
  // Interest Income (4130)
  interest_income:    'Interest Income',
  // Advance revenue defers to Unearned Revenue (handled in template)
  advance_revenue:    'Unearned Revenue',
});

/* ── Asset subcategory → DB account name ────────────────────────────────────
 * ─────────────────────────────────────────────────────────────────────────── */
const ASSET_ACCOUNT_MAP = Object.freeze({
  // Office Equipment (1220)
  equipment:   'Office Equipment',
  laptop:      'Office Equipment',
  machinery:   'Office Equipment',
  // Furniture and Fittings (1210)
  furniture:   'Furniture and Fittings',
  // Company Car (1230)
  vehicle:     'Company Car',
  // Inventory (1150)
  inventory:   'Inventory',
  // Prepaid Expenses (1120)
  prepaid:     'Prepaid Expenses',
});

/* ── Liability subcategory → DB account name ─────────────────────────────────
 * Used when resolving __LIABILITY_ACCOUNT__ (e.g., financed asset purchase)
 * ─────────────────────────────────────────────────────────────────────────── */
const LIABILITY_ACCOUNT_MAP = Object.freeze({
  // General loan (2230) — default for financed purchases
  loan:                  'Loan Payable',
  installment_liability: 'Loan Payable',
  // Vehicle loan (2210)
  vehicle_loan:          'Company Car Loan',
  car_loan:              'Company Car Loan',
  // Equipment loan (2220)
  equipment_loan:        'Equipment Loan',
  // Accounts payable (2110)
  accounts_payable_sub:  'Accounts Payable',
  // Tax liabilities
  tax_liability:         'WHT Payable',
  wht_liability:         'WHT Payable',
  // Payroll liabilities
  payroll_liability:     'Wages Payable',
  // Unearned Revenue (2170)
  unearned_revenue:      'Unearned Revenue',
  // Phase 3 — Accrual liabilities
  accrued_expenses:      'Accrued Expenses',
  accrued_liabilities:   'Accrued Expenses',
  interest_payable:      'Interest Payable',
  accrued_interest:      'Interest Payable',
  // Director's / Shareholder loan
  director_loan:         "Director's Loan",
  shareholder_loan:      "Director's Loan",
});

/* ── Source account aliases → DB account name ───────────────────────────────
 * Normalizes Gemini's sourceAccount string to an exact DB accountName.
 * ─────────────────────────────────────────────────────────────────────────── */
const SOURCE_ACCOUNT_ALIASES = Object.freeze({
  // Cash variants → Cash on Hand (1020)
  cash:             'Cash on Hand',
  'cash in hand':   'Cash on Hand',
  'petty cash':     'Cash on Hand',
  hand:             'Cash on Hand',
  // Bank variants → Cash at Bank (1010) as generic
  bank:             'Cash at Bank',
  'bank account':   'Cash at Bank',
  // Specific banks — these stay as-is (no matching account in default; fuzzy resolves them)
  hbl:              'Cash at Bank',
  'hbl bank':       'Cash at Bank',
  'habib bank':     'Cash at Bank',
  meezan:           'Cash at Bank',
  'meezan bank':    'Cash at Bank',
  ubl:              'Cash at Bank',
  'ubl bank':       'Cash at Bank',
  'united bank':    'Cash at Bank',
  allied:           'Cash at Bank',
  'allied bank':    'Cash at Bank',
  abl:              'Cash at Bank',
  mcb:              'Cash at Bank',
  'mcb bank':       'Cash at Bank',
  nib:              'Cash at Bank',
  // Wallets (also resolve to Bank or Cash)
  jazzcash:         'Cash at Bank',
  'jazz cash':      'Cash at Bank',
  easypaisa:        'Cash at Bank',
  'easy paisa':     'Cash at Bank',
  // Online
  paypal:           'Cash at Bank',
  stripe:           'Cash at Bank',
  // Credit card → tracks as liability
  'credit card':    'Accounts Payable',
});

module.exports = {
  JOURNAL_TEMPLATES,
  EXPENSE_ACCOUNT_MAP,
  REVENUE_ACCOUNT_MAP,
  ASSET_ACCOUNT_MAP,
  LIABILITY_ACCOUNT_MAP,
  SOURCE_ACCOUNT_ALIASES,
};
