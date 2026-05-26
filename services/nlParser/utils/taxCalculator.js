/**
 * @module taxCalculator
 * @description ERP-grade tax calculation engine for vousFin NLP pipeline.
 *
 * Handles:
 *  — Tax-inclusive transactions  (amount already includes tax → back-calculate)
 *  — Tax-exclusive transactions  (amount is net before tax  → add tax on top)
 *  — Input tax / Output tax distinction
 *  — Multiple tax types: GST, VAT, Sales Tax, SRB, PRA, KPK/BRA, WHT variants
 *  — Pakistan-specific rates with sensible defaults
 *
 * Design principle:
 *  All arithmetic is rounded to 2 decimal places at each step to avoid
 *  floating-point drift.  Functions are pure — no side effects.
 */

'use strict';

/* ── Pakistan statutory tax rates (2024–25) ────────────────────────────────
 * Sources: FBR, SRB, PRA, KPRA, BRA official rate schedules.
 * These are DEFAULT rates; individual transactions may specify a different rate
 * via parsedData.taxRate, which always takes precedence.
 * ─────────────────────────────────────────────────────────────────────────── */
const DEFAULT_TAX_RATES = Object.freeze({
  // Federal Sales Tax (GST) — FBR
  GST:              17,    // General Sales Tax — standard rate
  VAT:              17,    // Value Added Tax (same system in Pakistan)
  SALES_TAX:        17,    // Generic "sales tax" → assume federal GST
  // Provincial Sales Tax
  SRB:              13,    // Sindh Revenue Board
  PRA:              16,    // Punjab Revenue Authority
  KPRA:             15,    // KPK Revenue Authority
  BRA:              15,    // Balochistan Revenue Authority
  // Withholding Tax — on payments (deducted at source)
  WHT_SERVICES_CO:   8,   // WHT on services — companies (filers)
  WHT_SERVICES_IND: 10,   // WHT on services — individuals (filers)
  WHT_GOODS_CO:    4.5,   // WHT on goods — companies
  WHT_RENT_FILER:  10,    // WHT on rent — tax filers
  WHT_RENT_NONFILER: 15,  // WHT on rent — non-filers
  // Payroll deductions
  EOBI_EMPLOYER:    5,    // EOBI employer contribution (% of minimum wage)
  EOBI_EMPLOYEE:    1,    // EOBI employee contribution
});

/* ── Tax type → account name mappings ──────────────────────────────────────
 * Maps a tax type string to the receivable (input) and payable (output)
 * accounts used in journal entries.
 * ─────────────────────────────────────────────────────────────────────────── */
const TAX_ACCOUNT_MAP = Object.freeze({
  GST:        { payable: 'GST Payable',         receivable: 'GST Receivable' },
  VAT:        { payable: 'GST Payable',         receivable: 'GST Receivable' },
  SALES_TAX:  { payable: 'GST Payable',         receivable: 'GST Receivable' },
  SRB:        { payable: 'SRB Payable',         receivable: 'SRB Receivable' },
  PRA:        { payable: 'SRB Payable',         receivable: 'SRB Receivable' },   // grouped
  KPRA:       { payable: 'SRB Payable',         receivable: 'SRB Receivable' },
  BRA:        { payable: 'SRB Payable',         receivable: 'SRB Receivable' },
  WHT:        { payable: 'WHT Payable',         receivable: 'WHT Receivable' },
  WHT_RENT:   { payable: 'WHT Payable',         receivable: 'WHT Receivable' },
  WHT_SERVICES:{ payable: 'WHT Payable',        receivable: 'WHT Receivable' },
  WHT_GOODS:  { payable: 'WHT Payable',         receivable: 'WHT Receivable' },
  // Default fallback
  DEFAULT:    { payable: 'GST Payable',         receivable: 'GST Receivable' },
});

/* ── Tax type keyword normaliser ────────────────────────────────────────────
 * Maps strings Gemini might produce → canonical TAX_ACCOUNT_MAP key.
 * ─────────────────────────────────────────────────────────────────────────── */
const TAX_TYPE_ALIASES = Object.freeze({
  gst:         'GST',
  'sales tax': 'SALES_TAX',
  'sales_tax': 'SALES_TAX',
  vat:         'VAT',
  srb:         'SRB',
  pra:         'PRA',
  kpra:        'KPRA',
  bra:         'BRA',
  wht:         'WHT',
  'wht_rent':  'WHT_RENT',
  'withholding tax on rent':     'WHT_RENT',
  'wht_services': 'WHT_SERVICES',
  'withholding tax on services': 'WHT_SERVICES',
  'wht_goods': 'WHT_GOODS',
  'withholding tax on goods':    'WHT_GOODS',
  'federal gst': 'GST',
  'provincial sales tax': 'SRB',  // default to SRB for generic "provincial"
  'sindh sales tax': 'SRB',
  'punjab sales tax': 'PRA',
  'kpk sales tax': 'KPRA',
  'balochistan sales tax': 'BRA',
});

/* ═══════════════════════════════════════════════════════════════════════════
 * Core calculation functions
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Extract tax from a tax-inclusive (gross) amount.
 * Example: amount = 11700 (includes 17% GST), rate = 17
 *   → taxAmount = 1700, netAmount = 10000, grossAmount = 11700
 *
 * @param {number} grossAmount - Total amount (includes tax)
 * @param {number} ratePercent - Tax rate as percentage (e.g., 17 for 17%)
 * @returns {{ netAmount: number, taxAmount: number, grossAmount: number }}
 */
function calcFromInclusive(grossAmount, ratePercent) {
  if (!grossAmount || grossAmount <= 0) return { netAmount: 0, taxAmount: 0, grossAmount: 0 };
  if (!ratePercent || ratePercent <= 0) return { netAmount: grossAmount, taxAmount: 0, grossAmount };

  const rate       = ratePercent / 100;
  const netAmount  = r2(grossAmount / (1 + rate));
  const taxAmount  = r2(grossAmount - netAmount);
  return { netAmount, taxAmount, grossAmount: r2(grossAmount) };
}

/**
 * Add tax to a tax-exclusive (net) amount.
 * Example: amount = 10000 (before 17% GST), rate = 17
 *   → taxAmount = 1700, netAmount = 10000, grossAmount = 11700
 *
 * @param {number} netAmount   - Amount before tax
 * @param {number} ratePercent - Tax rate as percentage
 * @returns {{ netAmount: number, taxAmount: number, grossAmount: number }}
 */
function calcFromExclusive(netAmount, ratePercent) {
  if (!netAmount || netAmount <= 0) return { netAmount: 0, taxAmount: 0, grossAmount: 0 };
  if (!ratePercent || ratePercent <= 0) return { netAmount: r2(netAmount), taxAmount: 0, grossAmount: r2(netAmount) };

  const taxAmount   = r2(netAmount * ratePercent / 100);
  const grossAmount = r2(netAmount + taxAmount);
  return { netAmount: r2(netAmount), taxAmount, grossAmount };
}

/**
 * Resolve tax amount from parsedData.
 * Priority:  parsedData.taxAmount  >  calcFromExclusive  >  calcFromInclusive
 *
 * @param {object} parsedData
 * @param {'inclusive'|'exclusive'} mode
 * @returns {{ netAmount: number, taxAmount: number, grossAmount: number, taxAccount: object }}
 */
function resolveTaxAmounts(parsedData, mode = 'inclusive') {
  const { amount, taxAmount: explicit, taxRate, isTaxExclusive, taxType } = parsedData;
  const resolvedType = resolveTaxType(taxType);
  const accounts     = TAX_ACCOUNT_MAP[resolvedType] || TAX_ACCOUNT_MAP.DEFAULT;

  // Override mode with parsedData flag when present
  const effectiveMode = (isTaxExclusive === true) ? 'exclusive' : mode;

  // 1. Explicit taxAmount provided by Gemini
  if (explicit && explicit > 0) {
    const grossAmount = effectiveMode === 'exclusive'
      ? r2(amount + explicit)
      : r2(amount);
    const netAmount = effectiveMode === 'exclusive'
      ? r2(amount)
      : r2(amount - explicit);
    return { netAmount, taxAmount: r2(explicit), grossAmount, taxAccount: accounts };
  }

  // 2. Calculate from taxRate
  const rate = taxRate || DEFAULT_TAX_RATES[resolvedType] || DEFAULT_TAX_RATES.GST;

  if (effectiveMode === 'exclusive') {
    return { ...calcFromExclusive(amount, rate), taxAccount: accounts };
  }
  return { ...calcFromInclusive(amount, rate), taxAccount: accounts };
}

/**
 * Resolve raw taxType string → canonical TAX_ACCOUNT_MAP key.
 * @param {string|null} raw
 * @returns {string} canonical key
 */
function resolveTaxType(raw) {
  if (!raw) return 'GST'; // default
  const cleaned = raw.toString().toLowerCase().trim();
  return TAX_TYPE_ALIASES[cleaned] || raw.toString().toUpperCase().trim() || 'GST';
}

/**
 * Get the default tax rate for a resolved tax type.
 * @param {string} resolvedType - canonical key
 * @returns {number}
 */
function getDefaultRate(resolvedType) {
  return DEFAULT_TAX_RATES[resolvedType] || DEFAULT_TAX_RATES.GST;
}

/**
 * Get payable account name for output tax (sales).
 * @param {string|null} taxType - raw tax type from parsedData
 * @returns {string}
 */
function getTaxPayableAccount(taxType) {
  const resolved = resolveTaxType(taxType);
  return (TAX_ACCOUNT_MAP[resolved] || TAX_ACCOUNT_MAP.DEFAULT).payable;
}

/**
 * Get receivable account name for input tax (purchases).
 * @param {string|null} taxType - raw tax type from parsedData
 * @returns {string}
 */
function getTaxReceivableAccount(taxType) {
  const resolved = resolveTaxType(taxType);
  return (TAX_ACCOUNT_MAP[resolved] || TAX_ACCOUNT_MAP.DEFAULT).receivable;
}

/* ── Inventory adjustment helpers ───────────────────────────────────────── */

/**
 * Determine journal accounts for an inventory adjustment.
 * @param {'write_down'|'write_up'|string} adjustmentType
 * @returns {{ debitAccount: string, creditAccount: string }}
 */
function resolveInventoryAdjustmentAccounts(adjustmentType) {
  const type = (adjustmentType || 'write_down').toLowerCase().trim();

  if (type === 'write_up' || type === 'gain') {
    return { debitAccount: 'Inventory', creditAccount: 'Other Revenue' };
  }
  // write_down, shrinkage, damage, loss, expired, obsolete
  return { debitAccount: 'Inventory Write-Off', creditAccount: 'Inventory' };
}

/* ── Internal rounding helper ───────────────────────────────────────────── */
function r2(n) {
  return Math.round((n || 0) * 100) / 100;
}

/* ── Module exports ─────────────────────────────────────────────────────── */
module.exports = {
  DEFAULT_TAX_RATES,
  TAX_ACCOUNT_MAP,
  TAX_TYPE_ALIASES,
  calcFromInclusive,
  calcFromExclusive,
  resolveTaxAmounts,
  resolveTaxType,
  getDefaultRate,
  getTaxPayableAccount,
  getTaxReceivableAccount,
  resolveInventoryAdjustmentAccounts,
};
