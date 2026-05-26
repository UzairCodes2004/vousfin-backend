/**
 * @module transactionTypes
 * @description Supported transaction type constants for the NL Parser module.
 * Maps to the high-level accounting transaction classifications used throughout vousFin.
 *
 * IMPORTANT: NLP snake_case types are translated to API Title Case types in
 * nlParserPreview.helper.js → NL_TYPE_TO_API before being stored in MongoDB.
 */

const TRANSACTION_TYPES = Object.freeze({
  // ── Core types ──────────────────────────────────────────────────────────────
  INCOME:                  'income',
  EXPENSE:                 'expense',
  ASSET_PURCHASE:          'asset_purchase',
  INVENTORY_PURCHASE:      'inventory_purchase',
  INVENTORY_SALE:          'inventory_sale',
  OWNER_INVESTMENT:        'owner_investment',
  OWNER_WITHDRAWAL:        'owner_withdrawal',
  LOAN_RECEIVED:           'loan_received',
  LOAN_PAYMENT:            'loan_payment',
  LIABILITY_PAYMENT:       'liability_payment',
  TRANSFER:                'transfer',
  REFUND:                  'refund',
  SALARY:                  'salary',
  TAX:                     'tax',
  ACCOUNTS_RECEIVABLE:     'accounts_receivable',
  ACCOUNTS_PAYABLE:        'accounts_payable',
  DEPRECIATION:            'depreciation',
  ADJUSTMENT:              'adjustment',

  // ── Extended types (Phase 2 additions) ─────────────────────────────────────
  /** Asset bought on credit/installment — Debit: Asset / Credit: Loan Payable or AP */
  FINANCED_ASSET_PURCHASE: 'financed_asset_purchase',

  /** Payroll with tax withholding — multi-line journal */
  PAYROLL_WITH_TAX:        'payroll_with_tax',

  /** Sale including GST component — Debit: Cash / Credit: Revenue + GST Payable */
  GST_INCLUSIVE_SALE:      'gst_inclusive_sale',

  /** Advance received from customer — Debit: Cash / Credit: Unearned Revenue */
  ADVANCE_REVENUE:         'advance_revenue',

  /** Prepaid expense — Debit: Prepaid Expenses / Credit: Cash */
  PREPAID_EXPENSE:         'prepaid_expense',

  /** Withholding tax deduction */
  WHT_PAYMENT:             'wht_payment',

  // ── Phase 3 — Accounting Intelligence Layer ────────────────────────────────
  /** Expense incurred but not yet paid — Debit: Expense / Credit: Accrued Expenses */
  ACCRUAL_EXPENSE:         'accrual_expense',

  /** Revenue earned but not yet received — Debit: Accounts Receivable / Credit: Revenue */
  ACCRUAL_INCOME:          'accrual_income',

  /** Cost of goods sold recognition — Debit: COGS / Credit: Inventory */
  COGS_RECOGNITION:        'cogs_recognition',

  /** Rent payment with WHT deducted at source — multi-line journal */
  WHT_ON_RENT:             'wht_on_rent',

  /** Service fee payment with WHT deducted at source — multi-line journal */
  WHT_ON_SERVICES:         'wht_on_services',

  // ── Phase 3 Step 4 — Tax + Liability + Inventory ──────────────────────────
  /**
   * Purchase where the stated amount is net (before tax).
   * "plus GST", "excluding tax", "+ 17% GST"
   * DR Expense/Inventory (net) + DR GST Receivable / CR Cash/AP (gross)
   */
  GST_EXCLUSIVE_PURCHASE:  'gst_exclusive_purchase',

  /**
   * Sale where the stated amount is net (before tax).
   * "plus GST", "excluding tax", "net price"
   * DR Cash/AR (gross) / CR Sales (net) + CR GST Payable
   */
  GST_EXCLUSIVE_SALE:      'gst_exclusive_sale',

  /**
   * Customer returns goods to the business — reverses the original sale.
   * DR Sales Returns / CR Cash or AR (+ DR Inventory / CR COGS if cost known)
   */
  SALES_RETURN:            'sales_return',

  /**
   * Business returns goods to supplier — reverses the original purchase.
   * DR Cash or Accounts Payable / CR Inventory
   */
  PURCHASE_RETURN:         'purchase_return',

  /**
   * Stock count discrepancy, damage, expiry or write-off adjustment.
   * Write-down: DR Inventory Write-Off / CR Inventory
   * Write-up:   DR Inventory / CR Other Revenue
   */
  INVENTORY_ADJUSTMENT:    'inventory_adjustment',

  /**
   * Record payroll liability BEFORE paying employees.
   * DR Wages and Salaries / CR Wages Payable + CR WHT Payable [+ CR EOBI Payable]
   */
  PAYROLL_PAYABLE:         'payroll_payable',

  /**
   * Settle previously recorded Wages Payable.
   * DR Wages Payable / CR Cash at Bank
   */
  PAYROLL_PAYMENT:         'payroll_payment',

  /**
   * Pay GST, SRB, or WHT liability to the tax authority (FBR/SRB/PRA etc.).
   * DR GST Payable / WHT Payable / SRB Payable / CR Cash at Bank
   */
  TAX_PAYABLE_PAYMENT:     'tax_payable_payment',
});

/**
 * Set of all valid transaction type values for quick lookup.
 */
const VALID_TRANSACTION_TYPES = new Set(Object.values(TRANSACTION_TYPES));

/**
 * Cash flow direction mapping for each transaction type.
 */
const CASH_FLOW_MAP = Object.freeze({
  [TRANSACTION_TYPES.INCOME]:                  'inflow',
  [TRANSACTION_TYPES.EXPENSE]:                 'outflow',
  [TRANSACTION_TYPES.ASSET_PURCHASE]:          'outflow',
  [TRANSACTION_TYPES.INVENTORY_PURCHASE]:      'outflow',
  [TRANSACTION_TYPES.INVENTORY_SALE]:          'inflow',
  [TRANSACTION_TYPES.OWNER_INVESTMENT]:        'inflow',
  [TRANSACTION_TYPES.OWNER_WITHDRAWAL]:        'outflow',
  [TRANSACTION_TYPES.LOAN_RECEIVED]:           'inflow',
  [TRANSACTION_TYPES.LOAN_PAYMENT]:            'outflow',
  [TRANSACTION_TYPES.LIABILITY_PAYMENT]:       'outflow',
  [TRANSACTION_TYPES.TRANSFER]:                'non_cash',
  [TRANSACTION_TYPES.REFUND]:                  'inflow',
  [TRANSACTION_TYPES.SALARY]:                  'outflow',
  [TRANSACTION_TYPES.TAX]:                     'outflow',
  [TRANSACTION_TYPES.ACCOUNTS_RECEIVABLE]:     'non_cash',
  [TRANSACTION_TYPES.ACCOUNTS_PAYABLE]:        'non_cash',
  [TRANSACTION_TYPES.DEPRECIATION]:            'non_cash',
  [TRANSACTION_TYPES.ADJUSTMENT]:              'non_cash',
  // Extended
  [TRANSACTION_TYPES.FINANCED_ASSET_PURCHASE]: 'non_cash',   // no cash moves — asset ↔ liability
  [TRANSACTION_TYPES.PAYROLL_WITH_TAX]:        'outflow',
  [TRANSACTION_TYPES.GST_INCLUSIVE_SALE]:      'inflow',
  [TRANSACTION_TYPES.ADVANCE_REVENUE]:         'inflow',
  [TRANSACTION_TYPES.PREPAID_EXPENSE]:         'outflow',
  [TRANSACTION_TYPES.WHT_PAYMENT]:             'outflow',
  // Phase 3
  [TRANSACTION_TYPES.ACCRUAL_EXPENSE]:         'non_cash',  // no immediate cash movement
  [TRANSACTION_TYPES.ACCRUAL_INCOME]:          'non_cash',  // receivable created, no cash yet
  [TRANSACTION_TYPES.COGS_RECOGNITION]:        'non_cash',  // inventory ↔ COGS, no cash
  [TRANSACTION_TYPES.WHT_ON_RENT]:             'outflow',   // net cash paid to landlord
  [TRANSACTION_TYPES.WHT_ON_SERVICES]:         'outflow',   // net cash paid to service provider
  // Phase 3 Step 4
  [TRANSACTION_TYPES.GST_EXCLUSIVE_PURCHASE]:  'outflow',   // cash/AP paid for goods + tax
  [TRANSACTION_TYPES.GST_EXCLUSIVE_SALE]:      'inflow',    // cash/AR received for goods + tax
  [TRANSACTION_TYPES.SALES_RETURN]:            'outflow',   // cash/AR refunded to customer
  [TRANSACTION_TYPES.PURCHASE_RETURN]:         'inflow',    // cash/AP refunded from supplier
  [TRANSACTION_TYPES.INVENTORY_ADJUSTMENT]:    'non_cash',  // inventory ledger adjustment
  [TRANSACTION_TYPES.PAYROLL_PAYABLE]:         'non_cash',  // liability created, no cash yet
  [TRANSACTION_TYPES.PAYROLL_PAYMENT]:         'outflow',   // cash paid for wages payable
  [TRANSACTION_TYPES.TAX_PAYABLE_PAYMENT]:     'outflow',   // cash paid to tax authority
});

/**
 * Transactions that represent reversals or corrections where normal
 * debit/credit behavior may be intentionally reversed.
 */
const REVERSAL_TYPES = new Set([
  TRANSACTION_TYPES.REFUND,
  TRANSACTION_TYPES.ADJUSTMENT,
  TRANSACTION_TYPES.SALES_RETURN,
  TRANSACTION_TYPES.PURCHASE_RETURN,
  TRANSACTION_TYPES.INVENTORY_ADJUSTMENT,
]);

module.exports = {
  TRANSACTION_TYPES,
  VALID_TRANSACTION_TYPES,
  CASH_FLOW_MAP,
  REVERSAL_TYPES,
};
