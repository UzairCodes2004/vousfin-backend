/**
 * @module subcategories
 * @description Subcategory constants for transaction classification.
 * All values are used by the NLP parser for account mapping and journal generation.
 */

const EXPENSE_SUBCATEGORIES = Object.freeze({
  ELECTRICITY:          'electricity',
  INTERNET:             'internet',
  GAS:                  'gas',
  WATER:                'water',
  MOBILE_BILL:          'mobile_bill',
  RENT:                 'rent',
  SALARY:               'salary',
  FUEL:                 'fuel',
  TRANSPORT:            'transport',
  MAINTENANCE:          'maintenance',
  REPAIRS:              'repairs',
  OFFICE_SUPPLIES:      'office_supplies',
  STATIONERY:           'stationery',
  MARKETING:            'marketing',
  ADS:                  'ads',
  HOSTING:              'hosting',
  SOFTWARE_SUBSCRIPTION:'software_subscription',
  CLOUD_SERVICES:       'cloud_services',
  DOMAIN:               'domain',
  PRINTING:             'printing',
  INSURANCE:            'insurance',
  BANK_FEE:             'bank_fee',
  TAX:                  'tax',
  // Extended
  INTEREST:             'interest',
  DEPRECIATION:         'depreciation',
  WHT:                  'wht',
  EOBI:                 'eobi',
  SUPERANNUATION:       'superannuation',
  FREIGHT:              'freight',
  MISCELLANEOUS:        'miscellaneous',
  // Phase 3 additions — professional & specialized costs
  LEGAL_FEES:           'legal_fees',
  PROFESSIONAL_SERVICES:'professional_services',
  AUDIT_FEES:           'audit_fees',
  TRAINING:             'training',
  CLEANING:             'cleaning',
  SECURITY:             'security',
  TRAVEL_EXPENSE:       'travel_expense',
  ACCOMMODATION:        'accommodation',
  PACKAGING:            'packaging',
  CUSTOMS_DUTY:         'customs_duty',
  UNIFORMS:             'uniforms',
  MEALS:                'meals',
  ENTERTAINMENT:        'entertainment',
  MEDICAL:              'medical',
  COURIER:              'courier',
  POSTAGE:              'postage',
});

const INCOME_SUBCATEGORIES = Object.freeze({
  SERVICE_REVENUE:      'service_revenue',
  PRODUCT_SALES:        'product_sales',
  CONSULTING:           'consulting',
  COMMISSION:           'commission',
  SUBSCRIPTION_INCOME:  'subscription_income',
  INVESTMENT_INCOME:    'investment_income',
  INTEREST_INCOME:      'interest_income',
  RENTAL_INCOME:        'rental_income',
  // Extended
  ADVANCE_REVENUE:      'advance_revenue',
  GST_INCLUSIVE_SALE:   'gst_inclusive_sale',
});

const ASSET_CATEGORIES = Object.freeze({
  EQUIPMENT:            'equipment',
  FURNITURE:            'furniture',
  LAPTOP:               'laptop',
  VEHICLE:              'vehicle',
  SCOOTER:              'vehicle',     // alias → vehicle
  MOTORCYCLE:           'vehicle',     // alias → vehicle
  CAR:                  'vehicle',     // alias → vehicle
  INVENTORY:            'inventory',
  MACHINERY:            'machinery',
  PREPAID:              'prepaid',
  LAND:                 'land',
  BUILDING:             'building',
});

const LIABILITY_CATEGORIES = Object.freeze({
  LOAN:                    'loan',
  INSTALLMENT_LIABILITY:   'installment_liability',
  PAYROLL_LIABILITY:       'payroll_liability',
  TAX_LIABILITY:           'tax_liability',
  ACCOUNTS_PAYABLE:        'accounts_payable_sub',
  UNEARNED_REVENUE:        'unearned_revenue',
  WHT_LIABILITY:           'wht_liability',
});

/**
 * Utility subcategories grouped under expense for utility-specific bill detection.
 */
const UTILITY_SUBCATEGORIES = new Set([
  EXPENSE_SUBCATEGORIES.ELECTRICITY,
  EXPENSE_SUBCATEGORIES.INTERNET,
  EXPENSE_SUBCATEGORIES.GAS,
  EXPENSE_SUBCATEGORIES.WATER,
  EXPENSE_SUBCATEGORIES.MOBILE_BILL,
]);

/**
 * All valid subcategory values across all types.
 * NOTE: If a new subcategory is added, add it here too.
 */
const ALL_SUBCATEGORIES = new Set([
  ...Object.values(EXPENSE_SUBCATEGORIES),
  ...Object.values(INCOME_SUBCATEGORIES),
  ...Object.values(ASSET_CATEGORIES),
  ...Object.values(LIABILITY_CATEGORIES),
]);

/**
 * Maps keyword hints to subcategories for extraction assistance.
 * Used by the SUBCATEGORY_KEYWORDS lookup and the rule-based fallback parser.
 */
const SUBCATEGORY_KEYWORDS = Object.freeze({
  // Utilities → maps to Utilities account (6150)
  electricity: EXPENSE_SUBCATEGORIES.ELECTRICITY,
  'electric bill': EXPENSE_SUBCATEGORIES.ELECTRICITY,
  'light bill': EXPENSE_SUBCATEGORIES.ELECTRICITY,
  'power bill': EXPENSE_SUBCATEGORIES.ELECTRICITY,
  wapda: EXPENSE_SUBCATEGORIES.ELECTRICITY,
  kelectric: EXPENSE_SUBCATEGORIES.ELECTRICITY,
  lesco: EXPENSE_SUBCATEGORIES.ELECTRICITY,
  iesco: EXPENSE_SUBCATEGORIES.ELECTRICITY,
  internet: EXPENSE_SUBCATEGORIES.INTERNET,
  wifi: EXPENSE_SUBCATEGORIES.INTERNET,
  broadband: EXPENSE_SUBCATEGORIES.INTERNET,
  nayatel: EXPENSE_SUBCATEGORIES.INTERNET,
  ptcl: EXPENSE_SUBCATEGORIES.INTERNET,
  gas: EXPENSE_SUBCATEGORIES.GAS,
  'gas bill': EXPENSE_SUBCATEGORIES.GAS,
  sui: EXPENSE_SUBCATEGORIES.GAS,
  sngpl: EXPENSE_SUBCATEGORIES.GAS,
  ssgc: EXPENSE_SUBCATEGORIES.GAS,
  water: EXPENSE_SUBCATEGORIES.WATER,
  'water bill': EXPENSE_SUBCATEGORIES.WATER,
  'mobile bill': EXPENSE_SUBCATEGORIES.MOBILE_BILL,
  'phone bill': EXPENSE_SUBCATEGORIES.MOBILE_BILL,
  jazz: EXPENSE_SUBCATEGORIES.MOBILE_BILL,
  zong: EXPENSE_SUBCATEGORIES.MOBILE_BILL,
  telenor: EXPENSE_SUBCATEGORIES.MOBILE_BILL,
  ufone: EXPENSE_SUBCATEGORIES.MOBILE_BILL,
  // Rent
  rent: EXPENSE_SUBCATEGORIES.RENT,
  'office rent': EXPENSE_SUBCATEGORIES.RENT,
  'shop rent': EXPENSE_SUBCATEGORIES.RENT,
  // Salary / Wages
  salary: EXPENSE_SUBCATEGORIES.SALARY,
  wages: EXPENSE_SUBCATEGORIES.SALARY,
  payroll: EXPENSE_SUBCATEGORIES.SALARY,
  salaries: EXPENSE_SUBCATEGORIES.SALARY,
  // Vehicle / Transport → Company Car Expenses (6130)
  fuel: EXPENSE_SUBCATEGORIES.FUEL,
  petrol: EXPENSE_SUBCATEGORIES.FUEL,
  diesel: EXPENSE_SUBCATEGORIES.FUEL,
  transport: EXPENSE_SUBCATEGORIES.TRANSPORT,
  travel: EXPENSE_SUBCATEGORIES.TRANSPORT,
  uber: EXPENSE_SUBCATEGORIES.TRANSPORT,
  careem: EXPENSE_SUBCATEGORIES.TRANSPORT,
  'car expenses': EXPENSE_SUBCATEGORIES.TRANSPORT,
  maintenance: EXPENSE_SUBCATEGORIES.MAINTENANCE,
  repair: EXPENSE_SUBCATEGORIES.REPAIRS,
  repairs: EXPENSE_SUBCATEGORIES.REPAIRS,
  // Office supplies → Utilities
  'office supplies': EXPENSE_SUBCATEGORIES.OFFICE_SUPPLIES,
  stationery: EXPENSE_SUBCATEGORIES.STATIONERY,
  // Advertising (6160)
  marketing: EXPENSE_SUBCATEGORIES.MARKETING,
  ads: EXPENSE_SUBCATEGORIES.ADS,
  advertisement: EXPENSE_SUBCATEGORIES.ADS,
  advertising: EXPENSE_SUBCATEGORIES.ADS,
  'google ads': EXPENSE_SUBCATEGORIES.ADS,
  'facebook ads': EXPENSE_SUBCATEGORIES.ADS,
  // Hosting (6140)
  hosting: EXPENSE_SUBCATEGORIES.HOSTING,
  'web hosting': EXPENSE_SUBCATEGORIES.HOSTING,
  subscription: EXPENSE_SUBCATEGORIES.SOFTWARE_SUBSCRIPTION,
  software: EXPENSE_SUBCATEGORIES.SOFTWARE_SUBSCRIPTION,
  saas: EXPENSE_SUBCATEGORIES.SOFTWARE_SUBSCRIPTION,
  cloud: EXPENSE_SUBCATEGORIES.CLOUD_SERVICES,
  aws: EXPENSE_SUBCATEGORIES.CLOUD_SERVICES,
  azure: EXPENSE_SUBCATEGORIES.CLOUD_SERVICES,
  domain: EXPENSE_SUBCATEGORIES.DOMAIN,
  printing: EXPENSE_SUBCATEGORIES.PRINTING,
  insurance: EXPENSE_SUBCATEGORIES.INSURANCE,
  // Bank Fees (6120)
  'bank fee': EXPENSE_SUBCATEGORIES.BANK_FEE,
  'bank charges': EXPENSE_SUBCATEGORIES.BANK_FEE,
  // Interest (6240)
  interest: EXPENSE_SUBCATEGORIES.INTEREST,
  'interest expense': EXPENSE_SUBCATEGORIES.INTEREST,
  'loan interest': EXPENSE_SUBCATEGORIES.INTEREST,
  // Depreciation (6230)
  depreciation: EXPENSE_SUBCATEGORIES.DEPRECIATION,
  amortization: EXPENSE_SUBCATEGORIES.DEPRECIATION,
  // Tax / WHT
  tax: EXPENSE_SUBCATEGORIES.TAX,
  'income tax': EXPENSE_SUBCATEGORIES.TAX,
  wht: EXPENSE_SUBCATEGORIES.WHT,
  'withholding tax': EXPENSE_SUBCATEGORIES.WHT,
  // Superannuation / EOBI
  superannuation: EXPENSE_SUBCATEGORIES.SUPERANNUATION,
  eobi: EXPENSE_SUBCATEGORIES.EOBI,
  // Freight & Logistics
  freight: EXPENSE_SUBCATEGORIES.FREIGHT,
  shipping: EXPENSE_SUBCATEGORIES.FREIGHT,
  courier: EXPENSE_SUBCATEGORIES.COURIER,
  'courier charges': EXPENSE_SUBCATEGORIES.COURIER,
  delivery: EXPENSE_SUBCATEGORIES.FREIGHT,
  logistics: EXPENSE_SUBCATEGORIES.FREIGHT,
  packaging: EXPENSE_SUBCATEGORIES.PACKAGING,
  packing: EXPENSE_SUBCATEGORIES.PACKAGING,
  customs: EXPENSE_SUBCATEGORIES.CUSTOMS_DUTY,
  'customs duty': EXPENSE_SUBCATEGORIES.CUSTOMS_DUTY,
  import: EXPENSE_SUBCATEGORIES.CUSTOMS_DUTY,
  // Professional & Legal
  legal: EXPENSE_SUBCATEGORIES.LEGAL_FEES,
  'legal fees': EXPENSE_SUBCATEGORIES.LEGAL_FEES,
  lawyer: EXPENSE_SUBCATEGORIES.LEGAL_FEES,
  attorney: EXPENSE_SUBCATEGORIES.LEGAL_FEES,
  'professional services': EXPENSE_SUBCATEGORIES.PROFESSIONAL_SERVICES,
  'professional fees': EXPENSE_SUBCATEGORIES.PROFESSIONAL_SERVICES,
  consultant: EXPENSE_SUBCATEGORIES.PROFESSIONAL_SERVICES,
  'audit fees': EXPENSE_SUBCATEGORIES.AUDIT_FEES,
  audit: EXPENSE_SUBCATEGORIES.AUDIT_FEES,
  // Training & Development
  training: EXPENSE_SUBCATEGORIES.TRAINING,
  workshop: EXPENSE_SUBCATEGORIES.TRAINING,
  seminar: EXPENSE_SUBCATEGORIES.TRAINING,
  course: EXPENSE_SUBCATEGORIES.TRAINING,
  // Cleaning & Maintenance
  cleaning: EXPENSE_SUBCATEGORIES.CLEANING,
  'cleaning services': EXPENSE_SUBCATEGORIES.CLEANING,
  janitorial: EXPENSE_SUBCATEGORIES.CLEANING,
  // Security
  security: EXPENSE_SUBCATEGORIES.SECURITY,
  'security services': EXPENSE_SUBCATEGORIES.SECURITY,
  guard: EXPENSE_SUBCATEGORIES.SECURITY,
  // Travel
  'travel expense': EXPENSE_SUBCATEGORIES.TRAVEL_EXPENSE,
  accommodation: EXPENSE_SUBCATEGORIES.ACCOMMODATION,
  hotel: EXPENSE_SUBCATEGORIES.ACCOMMODATION,
  flight: EXPENSE_SUBCATEGORIES.TRAVEL_EXPENSE,
  'air ticket': EXPENSE_SUBCATEGORIES.TRAVEL_EXPENSE,
  visa: EXPENSE_SUBCATEGORIES.TRAVEL_EXPENSE,
  // Uniforms & Medical
  uniforms: EXPENSE_SUBCATEGORIES.UNIFORMS,
  'staff uniforms': EXPENSE_SUBCATEGORIES.UNIFORMS,
  medical: EXPENSE_SUBCATEGORIES.MEDICAL,
  'medical allowance': EXPENSE_SUBCATEGORIES.MEDICAL,
  // Meals & Entertainment
  meals: EXPENSE_SUBCATEGORIES.MEALS,
  lunch: EXPENSE_SUBCATEGORIES.MEALS,
  dinner: EXPENSE_SUBCATEGORIES.MEALS,
  canteen: EXPENSE_SUBCATEGORIES.MEALS,
  entertainment: EXPENSE_SUBCATEGORIES.ENTERTAINMENT,
  'client entertainment': EXPENSE_SUBCATEGORIES.ENTERTAINMENT,
  // Postage
  postage: EXPENSE_SUBCATEGORIES.POSTAGE,
  stamps: EXPENSE_SUBCATEGORIES.POSTAGE,

  // ── Income keywords ──────────────────────────────────────────────────────────
  'service revenue': INCOME_SUBCATEGORIES.SERVICE_REVENUE,
  'client payment': INCOME_SUBCATEGORIES.SERVICE_REVENUE,
  'product sales': INCOME_SUBCATEGORIES.PRODUCT_SALES,
  sales: INCOME_SUBCATEGORIES.PRODUCT_SALES,
  sold: INCOME_SUBCATEGORIES.PRODUCT_SALES,
  consulting: INCOME_SUBCATEGORIES.CONSULTING,
  consultancy: INCOME_SUBCATEGORIES.CONSULTING,
  commission: INCOME_SUBCATEGORIES.COMMISSION,
  'subscription income': INCOME_SUBCATEGORIES.SUBSCRIPTION_INCOME,
  'investment income': INCOME_SUBCATEGORIES.INVESTMENT_INCOME,
  dividend: INCOME_SUBCATEGORIES.INVESTMENT_INCOME,
  'interest income': INCOME_SUBCATEGORIES.INTEREST_INCOME,
  'bank interest': INCOME_SUBCATEGORIES.INTEREST_INCOME,
  rental: INCOME_SUBCATEGORIES.RENTAL_INCOME,
  rent_income: INCOME_SUBCATEGORIES.RENTAL_INCOME,
  advance: INCOME_SUBCATEGORIES.ADVANCE_REVENUE,
  'advance payment': INCOME_SUBCATEGORIES.ADVANCE_REVENUE,
  'advance received': INCOME_SUBCATEGORIES.ADVANCE_REVENUE,
  deposit: INCOME_SUBCATEGORIES.ADVANCE_REVENUE,

  // ── Asset keywords ───────────────────────────────────────────────────────────
  equipment: ASSET_CATEGORIES.EQUIPMENT,
  furniture: ASSET_CATEGORIES.FURNITURE,
  laptop: ASSET_CATEGORIES.LAPTOP,
  computer: ASSET_CATEGORIES.LAPTOP,
  vehicle: ASSET_CATEGORIES.VEHICLE,
  car: ASSET_CATEGORIES.VEHICLE,
  bike: ASSET_CATEGORIES.VEHICLE,
  motorcycle: ASSET_CATEGORIES.VEHICLE,
  scooter: ASSET_CATEGORIES.VEHICLE,
  'motor cycle': ASSET_CATEGORIES.VEHICLE,
  inventory: ASSET_CATEGORIES.INVENTORY,
  stock: ASSET_CATEGORIES.INVENTORY,
  goods: ASSET_CATEGORIES.INVENTORY,
  machinery: ASSET_CATEGORIES.MACHINERY,
  machine: ASSET_CATEGORIES.MACHINERY,
  prepaid: ASSET_CATEGORIES.PREPAID,
  'prepaid expense': ASSET_CATEGORIES.PREPAID,
  advance_expense: ASSET_CATEGORIES.PREPAID,
});

module.exports = {
  EXPENSE_SUBCATEGORIES,
  INCOME_SUBCATEGORIES,
  ASSET_CATEGORIES,
  LIABILITY_CATEGORIES,
  UTILITY_SUBCATEGORIES,
  ALL_SUBCATEGORIES,
  SUBCATEGORY_KEYWORDS,
};
