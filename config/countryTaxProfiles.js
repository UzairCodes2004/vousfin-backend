/**
 * countryTaxProfiles.js — Phase 5.4.1
 *
 * Canonical, country-aware tax profiles for the VousFin modular tax engine.
 * Each profile is self-contained — taxEngine.service.js reads from here,
 * never embeds tax rules inline.
 *
 * Adding a new country: add one entry to COUNTRY_TAX_PROFILES.
 * Existing countries never need to be touched for that.
 *
 * Supported countries: PK · AE · SA · IN · US · GB
 *
 * @typedef {Object} TaxComponent
 * @property {string}   type              - Canonical identifier (e.g. 'GST', 'WHT')
 * @property {string}   name              - Human-readable name
 * @property {number}   rate              - Default rate (%)
 * @property {'output'|'input'|'both'} side - output = on sales, input = on purchases
 * @property {string[]} applicableTo      - TRANSACTION_TYPES this tax applies to
 * @property {boolean}  autoApply         - Suggest automatically
 * @property {boolean}  recoverable       - Is input tax recoverable (like VAT)?
 * @property {boolean}  isWithholding     - Is this deducted at source?
 * @property {string}   accountPayable    - Liability account name
 * @property {string}   accountReceivable - Asset account name (input tax)
 * @property {number}   [accountPayableCode]    - CoA code for auto-seeding
 * @property {number}   [accountReceivableCode] - CoA code for auto-seeding
 *
 * @typedef {Object} WhtSchedule
 * @property {string}   category   - Payment category
 * @property {number}   rateNormal - Rate for registered / filers
 * @property {number}   [rateNonFiler] - Rate for non-filers
 * @property {string}   account    - Payable account name
 *
 * @typedef {Object} ReverseChargeRule
 * @property {string}   description - When reverse charge applies
 * @property {string}   taxType     - Tax type key
 * @property {number}   rate        - Rate (%)
 * @property {string[]} applicableTo - Transaction types
 */

'use strict';

const { TRANSACTION_TYPES } = require('./constants');

// ─── Transaction type shortcuts ──────────────────────────────────────────────
const T = TRANSACTION_TYPES;

// ─── Sale / purchase type arrays (reused across profiles) ────────────────────
const SALE_TYPES     = [T.CASH_SALE, T.CREDIT_SALE, T.INVENTORY_SALE];
const PURCHASE_TYPES = [T.CASH_PURCHASE, T.CREDIT_PURCHASE, T.INVENTORY_PURCHASE];

// ═════════════════════════════════════════════════════════════════════════════
//  COUNTRY PROFILES
// ═════════════════════════════════════════════════════════════════════════════

const COUNTRY_TAX_PROFILES = Object.freeze({

  // ──────────────────────────────────────────────────────────────────────────
  //  PAKISTAN (PK)
  //  Tax authority: FBR (federal), SRB / PRA / KPRA / BRA (provincial)
  //  Standard GST: 18% (Finance Act 2024) — was 17%, override at business level
  // ──────────────────────────────────────────────────────────────────────────
  PK: {
    country: 'PK',
    countryName: 'Pakistan',
    defaultCurrency: 'PKR',
    taxIdentifierLabel: 'NTN / STRN',    // National Tax Number / Sales Tax Reg No
    filingFrequencyDefault: 'monthly',

    taxes: [
      {
        type: 'GST',
        name: 'General Sales Tax (Federal)',
        rate: 18,
        side: 'output',
        applicableTo: SALE_TYPES,
        autoApply: false,
        recoverable: true,
        isWithholding: false,
        accountPayable:    'GST Payable',
        accountReceivable: 'GST Receivable',
        accountPayableCode: 2120,
        accountReceivableCode: 1170,
      },
      {
        type: 'GST_INPUT',
        name: 'GST Input (Purchase)',
        rate: 18,
        side: 'input',
        applicableTo: PURCHASE_TYPES,
        autoApply: false,
        recoverable: true,
        isWithholding: false,
        accountPayable:    'GST Payable',
        accountReceivable: 'GST Receivable',
        accountPayableCode: 2120,
        accountReceivableCode: 1170,
      },
      {
        type: 'SRB',
        name: 'Sindh Sales Tax on Services',
        rate: 13,
        side: 'both',
        applicableTo: [...SALE_TYPES, ...PURCHASE_TYPES],
        autoApply: false,
        recoverable: false,
        isWithholding: false,
        accountPayable:    'SRB Payable',
        accountReceivable: 'SRB Receivable',
        accountPayableCode: 2121,
        accountReceivableCode: 1171,
      },
      {
        type: 'PRA',
        name: 'Punjab Revenue Authority Sales Tax',
        rate: 16,
        side: 'both',
        applicableTo: [...SALE_TYPES, ...PURCHASE_TYPES],
        autoApply: false,
        recoverable: false,
        isWithholding: false,
        accountPayable:    'SRB Payable',     // grouped under SRB Payable
        accountReceivable: 'SRB Receivable',
        accountPayableCode: 2121,
        accountReceivableCode: 1171,
      },
      {
        type: 'KPRA',
        name: 'KPK Revenue Authority Sales Tax',
        rate: 15,
        side: 'both',
        applicableTo: [...SALE_TYPES, ...PURCHASE_TYPES],
        autoApply: false,
        recoverable: false,
        isWithholding: false,
        accountPayable:    'SRB Payable',
        accountReceivable: 'SRB Receivable',
        accountPayableCode: 2121,
        accountReceivableCode: 1171,
      },
      {
        type: 'BRA',
        name: 'Balochistan Revenue Authority Sales Tax',
        rate: 15,
        side: 'both',
        applicableTo: [...SALE_TYPES, ...PURCHASE_TYPES],
        autoApply: false,
        recoverable: false,
        isWithholding: false,
        accountPayable:    'SRB Payable',
        accountReceivable: 'SRB Receivable',
        accountPayableCode: 2121,
        accountReceivableCode: 1171,
      },
    ],

    // ── WHT schedules (deducted at source) ──────────────────────────────────
    whtSchedules: [
      { category: 'services_company',  rateNormal: 8,   rateNonFiler: 12,  account: 'WHT Payable' },
      { category: 'services_individual',rateNormal: 10,  rateNonFiler: 15,  account: 'WHT Payable' },
      { category: 'goods_company',     rateNormal: 4.5, rateNonFiler: 9,   account: 'WHT Payable' },
      { category: 'rent_filer',        rateNormal: 10,  rateNonFiler: 15,  account: 'WHT Payable' },
      { category: 'salary',            rateNormal: 0,   rateNonFiler: null,account: 'WHT Payable' },  // slab-based
      { category: 'dividends',         rateNormal: 15,  rateNonFiler: 30,  account: 'WHT Payable' },
    ],

    // No reverse charge in Pakistan (standard GST regime)
    reverseChargeRules: [],

    // ── Additional accounts needed (seeded on tax-enable) ───────────────────
    additionalAccounts: [
      { accountCode: '1170', accountName: 'GST Receivable',  accountType: 'Asset',     accountSubtype: 'Current Assets',      normalBalance: 'Debit',  isDefault: false },
      { accountCode: '2121', accountName: 'SRB Payable',     accountType: 'Liability', accountSubtype: 'Current Liabilities', normalBalance: 'Credit', isDefault: false },
      { accountCode: '1171', accountName: 'SRB Receivable',  accountType: 'Asset',     accountSubtype: 'Current Assets',      normalBalance: 'Debit',  isDefault: false },
      { accountCode: '2122', accountName: 'WHT Receivable',  accountType: 'Asset',     accountSubtype: 'Current Assets',      normalBalance: 'Debit',  isDefault: false },
    ],
  },

  // ──────────────────────────────────────────────────────────────────────────
  //  UNITED ARAB EMIRATES (AE)
  //  VAT introduced Jan 2018 · Standard rate: 5%
  //  Authority: Federal Tax Authority (FTA)
  //  Reverse charge: Applicable on imported services
  // ──────────────────────────────────────────────────────────────────────────
  AE: {
    country: 'AE',
    countryName: 'United Arab Emirates',
    defaultCurrency: 'AED',
    taxIdentifierLabel: 'TRN (Tax Registration Number)',
    filingFrequencyDefault: 'quarterly',

    taxes: [
      {
        type: 'VAT',
        name: 'Value Added Tax',
        rate: 5,
        side: 'output',
        applicableTo: SALE_TYPES,
        autoApply: false,
        recoverable: true,
        isWithholding: false,
        accountPayable:    'VAT Payable',
        accountReceivable: 'VAT Receivable (Input)',
        accountPayableCode: 2123,
        accountReceivableCode: 1172,
      },
      {
        type: 'VAT_INPUT',
        name: 'Input VAT (Purchases)',
        rate: 5,
        side: 'input',
        applicableTo: PURCHASE_TYPES,
        autoApply: false,
        recoverable: true,
        isWithholding: false,
        accountPayable:    'VAT Payable',
        accountReceivable: 'VAT Receivable (Input)',
        accountPayableCode: 2123,
        accountReceivableCode: 1172,
      },
      {
        type: 'VAT_EXEMPT',
        name: 'VAT Exempt Supply',
        rate: 0,
        side: 'both',
        applicableTo: [...SALE_TYPES, ...PURCHASE_TYPES],
        autoApply: false,
        recoverable: false,
        isWithholding: false,
        accountPayable:    'VAT Payable',
        accountReceivable: 'VAT Receivable (Input)',
        accountPayableCode: 2123,
        accountReceivableCode: 1172,
      },
      {
        type: 'VAT_ZERO',
        name: 'Zero-Rated VAT (Exports)',
        rate: 0,
        side: 'output',
        applicableTo: SALE_TYPES,
        autoApply: false,
        recoverable: true,
        isWithholding: false,
        accountPayable:    'VAT Payable',
        accountReceivable: 'VAT Recoverable (Zero-Rated)',
        accountPayableCode: 2123,
        accountReceivableCode: 1173,
      },
    ],

    whtSchedules: [], // UAE has no WHT on domestic payments

    reverseChargeRules: [
      {
        description: 'Imported services subject to reverse charge (Article 48, UAE VAT Law)',
        taxType: 'VAT_REVERSE_CHARGE',
        rate: 5,
        applicableTo: [T.CREDIT_PURCHASE, T.CASH_PURCHASE],
        conditions: {
          isImportedService: true,    // flag on transaction
          supplierCountry: 'non-AE', // supplier outside UAE
        },
        // Journal: DR Input VAT + DR Service Expense / CR Output VAT (RC) + CR AP
      },
    ],

    additionalAccounts: [
      { accountCode: '2123', accountName: 'VAT Payable',                accountType: 'Liability', accountSubtype: 'Current Liabilities', normalBalance: 'Credit', isDefault: false },
      { accountCode: '1172', accountName: 'VAT Receivable (Input)',      accountType: 'Asset',     accountSubtype: 'Current Assets',      normalBalance: 'Debit',  isDefault: false },
      { accountCode: '1173', accountName: 'VAT Recoverable (Zero-Rated)',accountType: 'Asset',     accountSubtype: 'Current Assets',      normalBalance: 'Debit',  isDefault: false },
      { accountCode: '2124', accountName: 'VAT Payable (Reverse Charge)',accountType: 'Liability', accountSubtype: 'Current Liabilities', normalBalance: 'Credit', isDefault: false },
    ],
  },

  // ──────────────────────────────────────────────────────────────────────────
  //  SAUDI ARABIA (SA)
  //  VAT introduced Jan 2018 · Increased to 15% in Jul 2020
  //  Authority: ZATCA (Zakat, Tax and Customs Authority)
  //  E-invoicing (FATOORAH): Phase 1 live Dec 2021, Phase 2 rollout in progress
  // ──────────────────────────────────────────────────────────────────────────
  SA: {
    country: 'SA',
    countryName: 'Saudi Arabia',
    defaultCurrency: 'SAR',
    taxIdentifierLabel: 'VAT Registration Number (15 digits)',
    filingFrequencyDefault: 'monthly',  // Large taxpayers; small = quarterly

    taxes: [
      {
        type: 'VAT',
        name: 'Value Added Tax (Saudi)',
        rate: 15,
        side: 'output',
        applicableTo: SALE_TYPES,
        autoApply: false,
        recoverable: true,
        isWithholding: false,
        accountPayable:    'VAT Payable',
        accountReceivable: 'VAT Receivable (Input)',
        accountPayableCode: 2123,
        accountReceivableCode: 1172,
      },
      {
        type: 'VAT_INPUT',
        name: 'Input VAT (Purchases)',
        rate: 15,
        side: 'input',
        applicableTo: PURCHASE_TYPES,
        autoApply: false,
        recoverable: true,
        isWithholding: false,
        accountPayable:    'VAT Payable',
        accountReceivable: 'VAT Receivable (Input)',
        accountPayableCode: 2123,
        accountReceivableCode: 1172,
      },
      {
        type: 'VAT_ZERO',
        name: 'Zero-Rated VAT (Exports / Int\'l Transport)',
        rate: 0,
        side: 'output',
        applicableTo: SALE_TYPES,
        autoApply: false,
        recoverable: true,
        isWithholding: false,
        accountPayable:    'VAT Payable',
        accountReceivable: 'VAT Receivable (Input)',
        accountPayableCode: 2123,
        accountReceivableCode: 1172,
      },
    ],

    whtSchedules: [
      // WHT on payments to non-residents — Article 68, Saudi Income Tax Law
      { category: 'technical_services_nonresident', rateNormal: 5,  account: 'WHT Payable' },
      { category: 'royalties_nonresident',           rateNormal: 15, account: 'WHT Payable' },
      { category: 'dividends_nonresident',           rateNormal: 5,  account: 'WHT Payable' },
      { category: 'rent_nonresident',                rateNormal: 15, account: 'WHT Payable' },
      { category: 'management_fees',                 rateNormal: 20, account: 'WHT Payable' },
    ],

    reverseChargeRules: [
      {
        description: 'Reverse charge on imported goods/services (Article 10, Saudi VAT)',
        taxType: 'VAT_REVERSE_CHARGE',
        rate: 15,
        applicableTo: [T.CREDIT_PURCHASE, T.CASH_PURCHASE],
        conditions: {
          isImportedService: true,
          supplierCountry: 'non-SA',
        },
      },
    ],

    // ZATCA requires QR-coded invoices (FATOORAH)
    eInvoicingRequired: true,
    eInvoicingStandard: 'FATOORAH',

    additionalAccounts: [
      { accountCode: '2123', accountName: 'VAT Payable',           accountType: 'Liability', accountSubtype: 'Current Liabilities', normalBalance: 'Credit', isDefault: false },
      { accountCode: '1172', accountName: 'VAT Receivable (Input)',accountType: 'Asset',     accountSubtype: 'Current Assets',      normalBalance: 'Debit',  isDefault: false },
      { accountCode: '2124', accountName: 'VAT Payable (Reverse Charge)', accountType: 'Liability', accountSubtype: 'Current Liabilities', normalBalance: 'Credit', isDefault: false },
    ],
  },

  // ──────────────────────────────────────────────────────────────────────────
  //  INDIA (IN)
  //  GST framework: CGST + SGST (intra-state) | IGST (inter-state)
  //  Standard rate: 18% (split as 9% CGST + 9% SGST / 18% IGST)
  //  Authority: GSTN (Goods and Services Tax Network)
  //  TDS (Tax Deducted at Source) under Income Tax Act
  // ──────────────────────────────────────────────────────────────────────────
  IN: {
    country: 'IN',
    countryName: 'India',
    defaultCurrency: 'INR',
    taxIdentifierLabel: 'GSTIN (15-digit)',
    filingFrequencyDefault: 'monthly',

    taxes: [
      // ── GST standard (18%) – intra-state split ──────────────────────────
      {
        type: 'CGST',
        name: 'Central GST (9%)',
        rate: 9,
        side: 'output',
        applicableTo: SALE_TYPES,
        autoApply: false,
        recoverable: true,
        isWithholding: false,
        accountPayable:    'CGST Payable',
        accountReceivable: 'CGST Receivable',
        accountPayableCode: 2127,
        accountReceivableCode: 1175,
        pairedWith: 'SGST',   // always paired with SGST for intra-state
      },
      {
        type: 'SGST',
        name: 'State GST (9%)',
        rate: 9,
        side: 'output',
        applicableTo: SALE_TYPES,
        autoApply: false,
        recoverable: true,
        isWithholding: false,
        accountPayable:    'SGST Payable',
        accountReceivable: 'SGST Receivable',
        accountPayableCode: 2128,
        accountReceivableCode: 1176,
        pairedWith: 'CGST',
      },
      {
        type: 'IGST',
        name: 'Integrated GST (18%) — inter-state / imports',
        rate: 18,
        side: 'both',
        applicableTo: [...SALE_TYPES, ...PURCHASE_TYPES],
        autoApply: false,
        recoverable: true,
        isWithholding: false,
        accountPayable:    'IGST Payable',
        accountReceivable: 'IGST Receivable',
        accountPayableCode: 2129,
        accountReceivableCode: 1177,
      },
      // Reduced slabs (5% and 12%)
      {
        type: 'GST_5',
        name: 'GST 5% (Essential goods / services)',
        rate: 5,
        side: 'both',
        applicableTo: [...SALE_TYPES, ...PURCHASE_TYPES],
        autoApply: false,
        recoverable: true,
        isWithholding: false,
        accountPayable:    'IGST Payable',
        accountReceivable: 'IGST Receivable',
        accountPayableCode: 2129,
        accountReceivableCode: 1177,
      },
      {
        type: 'GST_12',
        name: 'GST 12%',
        rate: 12,
        side: 'both',
        applicableTo: [...SALE_TYPES, ...PURCHASE_TYPES],
        autoApply: false,
        recoverable: true,
        isWithholding: false,
        accountPayable:    'IGST Payable',
        accountReceivable: 'IGST Receivable',
        accountPayableCode: 2129,
        accountReceivableCode: 1177,
      },
    ],

    // ── TDS schedules (Section 194 family) ──────────────────────────────────
    whtSchedules: [
      { category: 'tds_salary',          rateNormal: 0,  account: 'TDS Payable' },   // slab-based
      { category: 'tds_contractor',      rateNormal: 1,  account: 'TDS Payable' },   // Sec 194C
      { category: 'tds_professional',    rateNormal: 10, account: 'TDS Payable' },   // Sec 194J
      { category: 'tds_rent',            rateNormal: 10, account: 'TDS Payable' },   // Sec 194I
      { category: 'tds_interest_bank',   rateNormal: 10, account: 'TDS Payable' },   // Sec 194A
      { category: 'tds_dividends',       rateNormal: 10, account: 'TDS Payable' },   // Sec 194
    ],

    reverseChargeRules: [
      {
        description: 'Reverse charge on import of services from outside India (IGST Act, Sec 5(3))',
        taxType: 'IGST',
        rate: 18,
        applicableTo: [T.CREDIT_PURCHASE, T.CASH_PURCHASE],
        conditions: { isImportedService: true, supplierCountry: 'non-IN' },
      },
      {
        description: 'Reverse charge — GTA (Goods Transport Agency) services',
        taxType: 'IGST',
        rate: 5,
        applicableTo: [T.CASH_PURCHASE, T.CREDIT_PURCHASE],
        conditions: { vendorType: 'GTA' },
      },
    ],

    additionalAccounts: [
      { accountCode: '2127', accountName: 'CGST Payable',    accountType: 'Liability', accountSubtype: 'Current Liabilities', normalBalance: 'Credit', isDefault: false },
      { accountCode: '2128', accountName: 'SGST Payable',    accountType: 'Liability', accountSubtype: 'Current Liabilities', normalBalance: 'Credit', isDefault: false },
      { accountCode: '2129', accountName: 'IGST Payable',    accountType: 'Liability', accountSubtype: 'Current Liabilities', normalBalance: 'Credit', isDefault: false },
      { accountCode: '2130', accountName: 'TDS Payable',     accountType: 'Liability', accountSubtype: 'Current Liabilities', normalBalance: 'Credit', isDefault: false },
      { accountCode: '1175', accountName: 'CGST Receivable', accountType: 'Asset',     accountSubtype: 'Current Assets',      normalBalance: 'Debit',  isDefault: false },
      { accountCode: '1176', accountName: 'SGST Receivable', accountType: 'Asset',     accountSubtype: 'Current Assets',      normalBalance: 'Debit',  isDefault: false },
      { accountCode: '1177', accountName: 'IGST Receivable', accountType: 'Asset',     accountSubtype: 'Current Assets',      normalBalance: 'Debit',  isDefault: false },
    ],
  },

  // ──────────────────────────────────────────────────────────────────────────
  //  UNITED KINGDOM (GB)
  //  VAT standard rate: 20% · Reduced: 5% (domestic fuel / power, child safety)
  //  Authority: HMRC · MTD (Making Tax Digital) required for VAT
  // ──────────────────────────────────────────────────────────────────────────
  GB: {
    country: 'GB',
    countryName: 'United Kingdom',
    defaultCurrency: 'GBP',
    taxIdentifierLabel: 'VAT Registration Number',
    filingFrequencyDefault: 'quarterly',

    taxes: [
      {
        type: 'VAT',
        name: 'VAT Standard (20%)',
        rate: 20,
        side: 'output',
        applicableTo: SALE_TYPES,
        autoApply: false,
        recoverable: true,
        isWithholding: false,
        accountPayable:    'VAT Payable',
        accountReceivable: 'VAT Receivable (Input)',
        accountPayableCode: 2123,
        accountReceivableCode: 1172,
      },
      {
        type: 'VAT_INPUT',
        name: 'Input VAT (Purchases)',
        rate: 20,
        side: 'input',
        applicableTo: PURCHASE_TYPES,
        autoApply: false,
        recoverable: true,
        isWithholding: false,
        accountPayable:    'VAT Payable',
        accountReceivable: 'VAT Receivable (Input)',
        accountPayableCode: 2123,
        accountReceivableCode: 1172,
      },
      {
        type: 'VAT_REDUCED',
        name: 'VAT Reduced (5%)',
        rate: 5,
        side: 'both',
        applicableTo: [...SALE_TYPES, ...PURCHASE_TYPES],
        autoApply: false,
        recoverable: true,
        isWithholding: false,
        accountPayable:    'VAT Payable',
        accountReceivable: 'VAT Receivable (Input)',
        accountPayableCode: 2123,
        accountReceivableCode: 1172,
      },
    ],

    whtSchedules: [], // UK PAYE handled separately; no WHT on B2B

    reverseChargeRules: [
      {
        description: 'Construction Industry Scheme (CIS) reverse charge',
        taxType: 'VAT_REVERSE_CHARGE',
        rate: 20,
        applicableTo: [T.CREDIT_PURCHASE, T.CASH_PURCHASE],
        conditions: { industry: 'construction' },
      },
    ],

    additionalAccounts: [
      { accountCode: '2123', accountName: 'VAT Payable',           accountType: 'Liability', accountSubtype: 'Current Liabilities', normalBalance: 'Credit', isDefault: false },
      { accountCode: '1172', accountName: 'VAT Receivable (Input)',accountType: 'Asset',     accountSubtype: 'Current Assets',      normalBalance: 'Debit',  isDefault: false },
    ],
  },

  // ──────────────────────────────────────────────────────────────────────────
  //  UNITED STATES (US)
  //  No federal VAT/GST. Sales tax is state-administered (rates vary by state).
  //  Default: 0% (no tax auto-applied). Businesses configure state rate manually.
  // ──────────────────────────────────────────────────────────────────────────
  US: {
    country: 'US',
    countryName: 'United States',
    defaultCurrency: 'USD',
    taxIdentifierLabel: 'EIN (Employer Identification Number)',
    filingFrequencyDefault: 'monthly',

    taxes: [
      {
        type: 'SALES_TAX',
        name: 'State / Local Sales Tax',
        rate: 0,    // Configured per business (state-dependent)
        side: 'output',
        applicableTo: SALE_TYPES,
        autoApply: false,
        recoverable: false,
        isWithholding: false,
        accountPayable:    'Sales Tax Payable',
        accountReceivable: null,   // US sales tax is not recoverable
        accountPayableCode: 2126,
        accountReceivableCode: null,
      },
    ],

    whtSchedules: [
      { category: 'backup_withholding', rateNormal: 24,  account: 'WHT Payable' },  // IRS backup WHT
      { category: 'nonresident_alien',  rateNormal: 30,  account: 'WHT Payable' },  // FIRPTA / NRA
    ],

    reverseChargeRules: [], // US has no VAT reverse charge

    additionalAccounts: [
      { accountCode: '2126', accountName: 'Sales Tax Payable', accountType: 'Liability', accountSubtype: 'Current Liabilities', normalBalance: 'Credit', isDefault: false },
    ],
  },

});

// ─── Lookup helpers ───────────────────────────────────────────────────────────

/**
 * Get a country tax profile. Falls back to PK when not found.
 * @param {string} countryCode - ISO 3166-1 alpha-2 (e.g. 'AE')
 * @returns {object} profile
 */
function getProfile(countryCode = 'PK') {
  return COUNTRY_TAX_PROFILES[countryCode?.toUpperCase()] || COUNTRY_TAX_PROFILES.PK;
}

/**
 * Get a specific tax component from a profile by type key.
 * @param {string} countryCode
 * @param {string} taxType  - e.g. 'GST', 'VAT', 'CGST'
 * @returns {object|null}
 */
function getTaxComponent(countryCode, taxType) {
  const profile = getProfile(countryCode);
  return profile.taxes.find(t => t.type === taxType) || null;
}

/**
 * Get applicable taxes for a given country + transaction type.
 * @param {string} countryCode
 * @param {string} transactionType - TRANSACTION_TYPES value
 * @returns {object[]} matching tax components
 */
function getApplicableTaxes(countryCode, transactionType) {
  const profile = getProfile(countryCode);
  return profile.taxes.filter(t => t.applicableTo.includes(transactionType));
}

/**
 * Get WHT schedule for a category.
 * @param {string} countryCode
 * @param {string} category - e.g. 'services_company'
 * @returns {object|null}
 */
function getWhtSchedule(countryCode, category) {
  const profile = getProfile(countryCode);
  return profile.whtSchedules.find(w => w.category === category) || null;
}

/**
 * List all supported country codes.
 * @returns {string[]}
 */
function getSupportedCountries() {
  return Object.keys(COUNTRY_TAX_PROFILES);
}

module.exports = {
  COUNTRY_TAX_PROFILES,
  getProfile,
  getTaxComponent,
  getApplicableTaxes,
  getWhtSchedule,
  getSupportedCountries,
};
