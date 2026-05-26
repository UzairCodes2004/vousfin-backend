/**
 * @module chartOfAccounts
 * @description Static chart-of-accounts table used by the NLP validation layer.
 *
 * IMPORTANT: Account names here MUST match the canonical names in MongoDB
 * (config/constants.js DEFAULT_ACCOUNTS) so that the NLP validator does not
 * produce false "Account not found" warnings for correctly-generated entries.
 *
 * Phase 2 sync:
 *  - Primary names updated to match DB canonical names (Gimbla-style template).
 *  - All old names kept as aliases for backward compatibility.
 *  - 8 new Phase 1 accounts added: Prepaid Expenses, Inventory, Accumulated
 *    Depreciation, WHT Payable, Unearned Revenue, Loan Payable, Depreciation
 *    Expense, Interest Expense.
 *  - Pakistani bank/wallet accounts added.
 */

const { ACCOUNT_TYPES } = require('./accountTypes');

const acct = (name, type, normalBalance, aliases) => ({
  name, type, normalBalance, aliases,
});

const A  = ACCOUNT_TYPES.ASSET;
const L  = ACCOUNT_TYPES.LIABILITY;
const E  = ACCOUNT_TYPES.EQUITY;
const R  = ACCOUNT_TYPES.REVENUE;
const X  = ACCOUNT_TYPES.EXPENSE;
const CA = ACCOUNT_TYPES.CONTRA_ASSET;

const CHART_OF_ACCOUNTS = Object.freeze([

  // ── Assets — Bank and Cash ───────────────────────────────────────────────
  // DB canonical: 'Cash at Bank', 'Cash on Hand'
  acct('Cash at Bank',   A, 'debit', [
    'cash at bank', 'bank', 'bank account', 'hbl', 'hbl bank', 'habib bank',
    'meezan', 'meezan bank', 'ubl', 'ubl bank', 'united bank',
    'allied', 'allied bank', 'abl', 'mcb', 'mcb bank',
    'bank al habib', 'habib metropolitan', 'faysal bank', 'askari bank',
    'silk bank', 'js bank', 'bank alfalah', 'alfalah', 'standard chartered',
    'hsbc', 'citibank', 'nib bank',
  ]),
  acct('Cash on Hand',   A, 'debit', [
    'cash on hand', 'cash', 'cash in hand', 'petty cash', 'petty cash fund',
    'hand cash', 'on-hand cash',
  ]),
  acct('JazzCash',       A, 'debit', ['jazzcash', 'jazz cash', 'jazz wallet']),
  acct('EasyPaisa',      A, 'debit', ['easypaisa', 'easy paisa', 'telenor wallet']),
  acct('PayPal',         A, 'debit', ['paypal']),
  acct('Stripe',         A, 'debit', ['stripe']),

  // ── Assets — Tax Receivables (Input Tax Credits) ─────────────────────────
  acct('GST Receivable',  A, 'debit', [
    'gst receivable', 'input tax', 'input gst', 'input vat', 'sales tax receivable',
    'tax recoverable', 'gst input', 'vat receivable', 'input tax credit', 'itc',
  ]),
  acct('SRB Receivable',  A, 'debit', [
    'srb receivable', 'srb input', 'sindh sales tax receivable', 'provincial tax receivable',
    'pra receivable', 'kpra receivable', 'bra receivable',
  ]),
  acct('WHT Receivable',  A, 'debit', [
    'wht receivable', 'withholding tax receivable', 'tax withheld receivable',
    'advance tax', 'advance income tax', 'prepaid income tax',
  ]),

  // ── Assets — Current ─────────────────────────────────────────────────────
  // DB canonical: 'Accounts Receivable', 'Prepaid Expenses', 'Inventory'
  acct('Accounts Receivable', A, 'debit', [
    'accounts receivable', 'receivable', 'receivables', 'a/r', 'debtors',
    'trade debtors', 'trade receivables', 'sundry debtors', 'debtor',
  ]),
  acct('Prepaid Expenses',    A, 'debit', [
    'prepaid expenses', 'prepaid', 'advance payment', 'advances paid',
    'prepaid insurance', 'prepaid rent',
  ]),
  acct('Inventory',           A, 'debit', [
    'inventory', 'stock', 'merchandise', 'goods', 'raw materials',
  ]),

  // ── Assets — Non-current ─────────────────────────────────────────────────
  // DB canonical: 'Office Equipment', 'Furniture and Fittings', 'Company Car'
  acct('Office Equipment',      A, 'debit', [
    'office equipment', 'equipment', 'tools', 'computer', 'laptop',
    'computer equipment', 'computers and equipment',
  ]),
  acct('Furniture and Fittings', A, 'debit', [
    'furniture and fittings', 'furniture', 'fixtures',
    'office furniture', 'furniture & fixtures',
    'chairs', 'office chairs', 'desk', 'desks', 'shelves', 'shelving',
    'tables', 'cabinets', 'partitions',
  ]),
  acct('Company Car',            A, 'debit', [
    'company car', 'vehicle', 'car', 'bike', 'motorcycle',
    'scooter', 'truck', 'van', 'motorbike', 'auto',
  ]),
  acct('Machinery',              A, 'debit', ['machinery', 'machine', 'plant and machinery']),
  acct('Fixed Assets',           A, 'debit', ['fixed assets', 'ppe', 'property plant equipment']),

  // ── Contra-Asset ─────────────────────────────────────────────────────────
  // DB canonical: 'Accumulated Depreciation'
  acct('Accumulated Depreciation', CA, 'credit', [
    'accumulated depreciation', 'accum depreciation', 'depreciation reserve',
  ]),

  // ── Liabilities — Current ────────────────────────────────────────────────
  // DB canonical: 'Accounts Payable', 'GST Payable', 'WHT Payable',
  //               'Wages Payable', 'Unearned Revenue'
  acct('Accounts Payable',          L, 'credit', [
    'accounts payable', 'payable', 'payables', 'creditors', 'a/p',
  ]),
  acct('GST Payable',               L, 'credit', [
    'gst payable', 'gst', 'sales tax payable', 'output vat', 'vat payable',
    'tax payable', 'taxes payable', 'output tax', 'output gst',
  ]),
  acct('SRB Payable',               L, 'credit', [
    'srb payable', 'srb', 'sindh revenue board', 'sindh sales tax',
    'pra payable', 'punjab revenue authority', 'punjab sales tax',
    'kpra payable', 'bra payable', 'provincial tax payable', 'provincial sales tax payable',
  ]),
  acct('WHT Payable',               L, 'credit', [
    'wht payable', 'wht', 'withholding tax', 'withholding tax payable',
    'income tax withholding', 'tax withheld',
  ]),
  acct("Director's Loan",           L, 'credit', [
    "director's loan", 'directors loan', 'director loan', 'shareholder loan',
  ]),
  acct('Wages Payable',             L, 'credit', [
    'wages payable', 'salaries payable', 'salary payable', 'payroll payable',
    'staff payable', 'employee payable', 'net wages payable', 'accrued wages',
    'accrued salaries', 'accrued payroll',
  ]),
  acct('EOBI Payable',              L, 'credit', [
    'eobi payable', 'eobi', 'employees old age benefits', 'provident fund payable',
    'pension payable', 'gratuity payable', 'sessi payable', 'pessi payable',
  ]),
  acct('PAYG Withholding Payable',  L, 'credit', [
    'payg withholding payable', 'payg', 'payg withholding', 'paye payable',
  ]),
  acct('Superannuation Payable',    L, 'credit', [
    'superannuation payable', 'super payable', 'eobi payable',
  ]),
  acct('Unearned Revenue',          L, 'credit', [
    'unearned revenue', 'deferred revenue', 'advance payment received',
    'advance from customer', 'customer advance', 'customer deposit',
  ]),
  acct('Credit Card',               L, 'credit', ['credit card', 'cc', 'visa', 'mastercard']),
  acct('Accrued Expenses',          L, 'credit', ['accrued expenses', 'accrued liabilities', 'accrued costs']),
  acct('Interest Payable',          L, 'credit', ['interest payable', 'accrued interest']),

  // ── Liabilities — Non-current ────────────────────────────────────────────
  // DB canonical: 'Company Car Loan', 'Equipment Loan', 'Loan Payable'
  acct('Company Car Loan',  L, 'credit', [
    'company car loan', 'car loan', 'vehicle loan', 'auto loan',
  ]),
  acct('Equipment Loan',    L, 'credit', [
    'equipment loan', 'machinery loan', 'asset loan', 'term loan',
  ]),
  acct('Loan Payable',      L, 'credit', [
    'loan payable', 'loan', 'bank loan', 'general loan', 'borrowing',
    'installment liability', 'finance lease',
  ]),

  // ── Equity ───────────────────────────────────────────────────────────────
  // DB canonical: 'Capital / Investment' (3110), 'Distributions / Drawings' (3120),
  //               'Retained Earnings' (3210), 'Current Year Earnings' (3310)
  acct('Capital / Investment',     E, 'credit', [
    'capital / investment', 'capital', 'investment', 'owner capital',
    "owner's equity", 'owner equity', 'equity', 'invested capital', 'share capital',
  ]),
  acct('Distributions / Drawings', E, 'debit', [
    'distributions / drawings', 'distributions', 'drawings',
    "owner's drawings", 'owner drawings', 'withdrawal', 'owner withdrawal',
  ]),
  acct('Retained Earnings',        E, 'credit', [
    'retained earnings', 'accumulated profit', 'accumulated surplus',
  ]),
  acct('Current Year Earnings',    E, 'credit', [
    'current year earnings', 'net income', 'net profit', 'current earnings',
  ]),

  // ── Revenue ──────────────────────────────────────────────────────────────
  // DB canonical: 'Sales', 'Other Revenue', 'Interest Income'
  acct('Sales',           R, 'credit', [
    'sales', 'sales revenue', 'product sales', 'revenue', 'goods sold',
    'service revenue', 'service income', 'consulting revenue',
    'subscription income', 'recurring revenue',
  ]),
  acct('Other Revenue',   R, 'credit', [
    'other revenue', 'other income', 'commission', 'commission income',
    'miscellaneous income',
  ]),
  acct('Interest Income', R, 'credit', [
    'interest income', 'investment income', 'dividend', 'bank interest',
  ]),

  // ── Direct Costs ─────────────────────────────────────────────────────────
  acct('Cost of Goods Sold', X, 'debit', [
    'cost of goods sold', 'cogs', 'cost of sales', 'cost of revenue',
  ]),

  // ── Expenses ─────────────────────────────────────────────────────────────
  // DB canonical names used as primary name everywhere below.
  acct('Bank Fees',             X, 'debit', [
    'bank fees', 'bank charges', 'bank fee', 'service charges',
    'transaction fee',
  ]),
  acct('Rent',                  X, 'debit', [
    'rent', 'office rent', 'shop rent', 'premises rent', 'rent expense',
  ]),
  acct('Advertising',           X, 'debit', [
    'advertising', 'ads', 'ad spend', 'marketing', 'promotion',
    'advertising expense', 'marketing expense', 'digital marketing',
  ]),
  acct('Utilities',             X, 'debit', [
    'utilities', 'utilities expense', 'utility expense',
    'electricity', 'electric bill', 'light bill', 'power bill', 'wapda', 'lesco', 'iesco',
    'gas', 'gas bill', 'sui gas', 'sngpl', 'ssgc',
    'water', 'water bill',
    'internet', 'wifi', 'broadband',
    'mobile bill', 'phone bill',
  ]),
  acct('Wages and Salaries',    X, 'debit', [
    'wages and salaries', 'salary', 'salaries', 'wages', 'payroll',
    'salary expense', 'salaries expense', 'staff salaries',
  ]),
  acct('Subcontractors',        X, 'debit', [
    'subcontractors', 'freelancers', 'contractors', 'outsourcing',
  ]),
  acct('Company Car Expenses',  X, 'debit', [
    'company car expenses', 'fuel', 'petrol', 'diesel', 'transport',
    'travel', 'vehicle running', 'fuel expense', 'fuel cost',
  ]),
  acct('Website Hosting',       X, 'debit', [
    'website hosting', 'hosting', 'web hosting', 'hosting expense',
    'server', 'domain', 'domain name',
    'software subscription', 'software', 'saas',
    'cloud services', 'cloud', 'aws', 'azure', 'gcp',
  ]),
  acct('Travel and Accommodation', X, 'debit', [
    'travel and accommodation', 'travel', 'accommodation', 'hotel',
    'flight', 'air ticket', 'transport expense',
  ]),
  acct('Depreciation Expense',  X, 'debit', [
    'depreciation expense', 'depreciation', 'amortisation', 'amortization',
  ]),
  acct('Interest Expense',      X, 'debit', [
    'interest expense', 'interest', 'interest paid', 'loan interest',
    'finance cost', 'financing cost',
  ]),
  acct('Maintenance Expense',   X, 'debit', [
    'maintenance', 'maintenance expense', 'repairs', 'repair',
    'repairs expense',
  ]),
  acct('Office Supplies Expense', X, 'debit', [
    'office supplies', 'supplies', 'stationery', 'printing',
  ]),
  acct('Insurance Expense',     X, 'debit', [
    'insurance', 'insurance premium', 'insurance expense',
  ]),
  acct('Professional Fees',     X, 'debit', [
    'professional fees', 'legal fees', 'audit fees', 'accounting fees',
    'consulting fees', 'legal', 'lawyer fees', 'attorney fees',
    'professional services', 'advisory fees', 'tax advisory',
  ]),
  // DB accounts (6170, 6190) — must use canonical DB names as primary
  acct('Freight',               X, 'debit', [
    'freight', 'shipping', 'courier', 'logistics', 'delivery charges',
  ]),
  acct('Superannuation',        X, 'debit', [
    'superannuation', 'super', 'eobi', 'eobi contribution',
    'pension contribution', 'provident fund',
  ]),
  // Currency gain/loss accounts (6200–6220) — validation recognition only
  acct('Realised Currency Gains',    X, 'debit', ['realised currency gains', 'realized currency gains', 'fx gain']),
  acct('Unrealised Currency Gains',  X, 'debit', ['unrealised currency gains', 'unrealized currency gains']),
  acct('Bank Currency Revaluations', X, 'debit', ['bank currency revaluations', 'fx revaluation']),
  // Phase 3 additions — common SME expense accounts
  acct('Training Expense',      X, 'debit', ['training', 'training expense', 'workshop', 'seminar', 'course']),
  acct('Cleaning Expense',      X, 'debit', ['cleaning', 'janitorial', 'cleaning services', 'sanitation']),
  acct('Security Expense',      X, 'debit', ['security', 'security services', 'guard', 'watchman']),
  acct('Meals and Entertainment', X, 'debit', ['meals', 'entertainment', 'client entertainment', 'lunch', 'dinner', 'canteen', 'refreshments']),
  acct('Medical Expense',       X, 'debit', ['medical', 'medical allowance', 'health expense', 'clinic']),
  acct('Uniforms Expense',      X, 'debit', ['uniforms', 'staff uniforms', 'workwear']),
  acct('Postage and Courier',   X, 'debit', ['postage', 'courier', 'courier charges', 'stamps', 'post office']),
  acct('Packaging Expense',     X, 'debit', ['packaging', 'packing materials', 'packing']),
  acct('Customs Duty',          X, 'debit', ['customs duty', 'customs', 'import duty', 'import charges']),
  acct('Accrued Expenses',      L, 'credit', ['accrued expenses', 'accrued liabilities', 'accruals', 'accrued costs']),
  acct('Inventory Write-Off',   X, 'debit', [
    'inventory write-off', 'inventory write off', 'inventory loss', 'stock write-off',
    'stock loss', 'inventory shrinkage', 'inventory damage', 'obsolete inventory',
    'expired inventory', 'inventory wastage', 'spoilage', 'shrinkage',
  ]),
  acct('Sales Returns',         X, 'debit', [
    'sales returns', 'sales return', 'return inwards', 'customer returns',
    'goods returned by customer', 'customer refund expense',
  ]),
  acct('Purchase Returns',      A, 'credit', [    // contra-asset (reduces inventory cost)
    'purchase returns', 'purchase return', 'return outwards', 'supplier returns',
    'goods returned to supplier',
  ]),
  // Generic fallback expense — must be last so specific entries take precedence
  acct('Miscellaneous Expense', X, 'debit', [
    'miscellaneous', 'misc', 'sundry', 'other expense',
  ]),
]);

// ── Quick lookup: lowercase alias → account object ─────────────────────────
const ACCOUNT_ALIAS_MAP = new Map();
for (const account of CHART_OF_ACCOUNTS) {
  // Primary name
  ACCOUNT_ALIAS_MAP.set(account.name.toLowerCase(), account);
  // All aliases
  for (const alias of account.aliases) {
    if (!ACCOUNT_ALIAS_MAP.has(alias.toLowerCase())) {
      ACCOUNT_ALIAS_MAP.set(alias.toLowerCase(), account);
    }
  }
}

const VALID_ACCOUNT_NAMES = new Set(CHART_OF_ACCOUNTS.map((a) => a.name));

module.exports = { CHART_OF_ACCOUNTS, ACCOUNT_ALIAS_MAP, VALID_ACCOUNT_NAMES };
