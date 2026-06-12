/**
 * tests/unit/services/report.financialStatements.test.js
 *
 * Regression tests for the report-correctness fixes (roadmap §A1 + §A2):
 *
 *   A1 — Income Statement now reflects COGS that lives only in journalLines
 *        (so it can no longer disagree with the Balance Sheet).
 *   A2 — Balance Sheet folds current-year (unclosed) earnings into equity, so
 *        the accounting equation balances by construction.
 *
 * Repositories are mocked — these prove the report-layer MATH. The underlying
 * aggregation (transaction.repository) shares ONE line-normalisation stage with
 * the Trial Balance; that sharing is guarded in
 * tests/unit/repositories/transaction.repository.effectiveLines.test.js.
 */
'use strict';

jest.mock('../../../repositories/transaction.repository', () => ({
  getDebitCreditTotals: jest.fn(),
  getIncomeStatementData: jest.fn(),
  getGeneralLedgerEntries: jest.fn(),
}));
jest.mock('../../../repositories/account.repository', () => ({
  findByBusiness: jest.fn(),
}));
jest.mock('../../../utils/reportCache', () => ({
  get: jest.fn(() => null), // always miss → force recompute
  set: jest.fn(),
  invalidate: jest.fn(),
}));
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const reportService          = require('../../../services/report.service');
const transactionRepository  = require('../../../repositories/transaction.repository');
const accountRepository      = require('../../../repositories/account.repository');

const BIZ = 'biz1';

// A minimal but realistic chart of accounts.
const ACCOUNTS = [
  { _id: 'cash',    accountName: 'Cash at Bank',       accountType: 'Asset',     accountSubtype: 'Bank and Cash',     normalBalance: 'Debit'  },
  { _id: 'inv',     accountName: 'Inventory',          accountType: 'Asset',     accountSubtype: 'Current Assets',    normalBalance: 'Debit'  },
  { _id: 'cap',     accountName: 'Owner Capital',      accountType: 'Equity',    accountSubtype: 'Equity',            normalBalance: 'Credit' },
  { _id: 'sales',   accountName: 'Sales',              accountType: 'Revenue',   accountSubtype: 'Revenue',           normalBalance: 'Credit' },
  { _id: 'cogs',    accountName: 'Cost of Goods Sold', accountType: 'Expense',   accountSubtype: 'Direct Cost',       normalBalance: 'Debit'  },
  { _id: 'rent',    accountName: 'Rent',               accountType: 'Expense',   accountSubtype: 'Expenses',          normalBalance: 'Debit'  },
];

beforeEach(() => jest.clearAllMocks());

describe('A2 — Balance Sheet balances by construction (current earnings in equity)', () => {
  // Scenario (as-of balances derived from a compound inventory sale):
  //   Owner invests 1000 cash          DR cash 1000 / CR capital 1000
  //   Buys inventory 600 cash          DR inv  600  / CR cash    600
  //   Sells goods 500 cash, COGS 300   DR cash 500  / CR sales 500 ; DR cogs 300 / CR inv 300
  //
  // The COGS/inventory legs are exactly the part that used to be invisible to the
  // P&L; here they MUST flow through to current earnings inside equity.
  beforeEach(() => {
    accountRepository.findByBusiness.mockResolvedValue(ACCOUNTS);
    transactionRepository.getDebitCreditTotals.mockResolvedValue({
      debitTotals: [
        { _id: 'cash', total: 1500 }, // 1000 invest + 500 sale
        { _id: 'inv',  total: 600 },
        { _id: 'cogs', total: 300 },
      ],
      creditTotals: [
        { _id: 'cap',   total: 1000 },
        { _id: 'cash',  total: 600 },
        { _id: 'sales', total: 500 },
        { _id: 'inv',   total: 300 },
      ],
    });
  });

  test('equation holds: Assets === Liabilities + Equity (incl. current earnings)', async () => {
    const bs = await reportService.getBalanceSheet(BIZ, '2026-01-31');

    expect(bs.totalAssets).toBe(1200);            // cash 900 + inventory 300
    expect(bs.totalLiabilities).toBe(0);
    expect(bs.currentEarnings).toBe(200);         // sales 500 − COGS 300
    expect(bs.totalEquity).toBe(1200);            // capital 1000 + earnings 200
    expect(bs.totalLiabilitiesAndEquity).toBe(1200);
    expect(bs.equationValid).toBe(true);
  });

  test('equity section contains the derived "Current Year Earnings" line so it foots', async () => {
    const bs = await reportService.getBalanceSheet(BIZ, '2026-01-31');

    const earningsRow = bs.equity.accounts.find(a => a.accountName === 'Current Year Earnings');
    expect(earningsRow).toBeDefined();
    expect(earningsRow.balance).toBe(200);
    expect(earningsRow.isDerived).toBe(true);

    // The equity detail must sum to the reported equity total.
    const equitySum = bs.equity.accounts.reduce((s, a) => s + a.balance, 0);
    expect(equitySum).toBe(bs.totalEquity);

    // Backward-compatible alias preserved.
    expect(bs.retainedEarnings).toBe(200);
  });

  test('regression: a profitable business no longer reports an imbalance', async () => {
    const bs = await reportService.getBalanceSheet(BIZ, '2026-01-31');
    // Before the fix, equity excluded the 200 of earnings → equation was off by 200.
    expect(Math.abs(bs.totalAssets - bs.totalLiabilitiesAndEquity)).toBeLessThan(0.01);
  });
});

describe('A1 — Income Statement consumes COGS (gross profit correct)', () => {
  test('COGS returned by the repository lands in the COGS bucket and gross profit', async () => {
    // This is exactly what the fixed getIncomeStatementData now yields for a
    // compound inventory sale: COGS appears in `expenses`.
    transactionRepository.getIncomeStatementData.mockResolvedValue({
      revenue:  [{ name: 'Sales', amount: 500 }],
      expenses: [
        { name: 'Cost of Goods Sold', amount: 300 },
        { name: 'Rent',               amount: 100 },
      ],
    });

    const is = await reportService.getIncomeStatement(BIZ, '2026-01-01', '2026-01-31');

    expect(is.totalRevenue).toBe(500);
    expect(is.cogs.total).toBe(300);        // classified as COGS by name
    expect(is.grossProfit).toBe(200);       // 500 − 300
    expect(is.operatingExpenses.total).toBe(100); // Rent
    expect(is.netProfit).toBe(100);         // 200 − 100 opex
  });

  test('net income equals Balance-Sheet current earnings for the same facts', async () => {
    // Ties the two statements together: the P&L net income (500−300−... ) and the
    // BS current earnings must describe the same economic result.
    transactionRepository.getIncomeStatementData.mockResolvedValue({
      revenue:  [{ name: 'Sales', amount: 500 }],
      expenses: [{ name: 'Cost of Goods Sold', amount: 300 }],
    });
    const is = await reportService.getIncomeStatement(BIZ, '2026-01-01', '2026-01-31');
    expect(is.netProfit).toBe(200); // matches bs.currentEarnings (200) above
  });
});

describe('A1b — General Ledger includes journalLines legs (GL === Trial Balance)', () => {
  beforeEach(() => {
    accountRepository.findByBusiness.mockResolvedValue(ACCOUNTS);
    // No prior-period activity → opening balances are all zero.
    transactionRepository.getDebitCreditTotals.mockResolvedValue({ debitTotals: [], creditTotals: [] });
    // One compound inventory sale: the COGS/Inventory legs exist ONLY in journalLines.
    transactionRepository.getGeneralLedgerEntries.mockResolvedValue([
      {
        _id: 't1',
        transactionDate: new Date('2026-01-15'),
        description: 'Sale',
        transactionType: 'CASH_SALE',
        transactionReference: 'INV-1',
        invoiceNumber: 'INV-1',
        amount: 500,
        debitAccountId:  { _id: 'cash' },
        creditAccountId: { _id: 'sales' },
        journalLines: [
          { accountId: 'cash',  type: 'debit',  amount: 500 },
          { accountId: 'sales', type: 'credit', amount: 500 },
          { accountId: 'cogs',  type: 'debit',  amount: 300 },
          { accountId: 'inv',   type: 'credit', amount: 300 },
        ],
      },
    ]);
  });

  test('COGS and Inventory legs now appear in their per-account ledgers', async () => {
    const gl = await reportService.getGeneralLedger(BIZ, '2026-01-01', '2026-01-31');
    const byId = Object.fromEntries(gl.accounts.map(a => [a.accountId, a]));

    // Before the fix these two ledgers would not exist at all.
    expect(byId.cogs).toBeDefined();
    expect(byId.inv).toBeDefined();
    expect(byId.cogs.entries[0].debit).toBe(300);
    expect(byId.inv.entries[0].credit).toBe(300);
  });

  test('GL closing balances equal the as-of (Trial Balance) balances', async () => {
    const gl = await reportService.getGeneralLedger(BIZ, '2026-01-01', '2026-01-31');
    const byId = Object.fromEntries(gl.accounts.map(a => [a.accountId, a]));

    expect(byId.cash.closingBalance).toBe(500);   // Debit-normal +500
    expect(byId.sales.closingBalance).toBe(500);  // Credit-normal +500
    expect(byId.cogs.closingBalance).toBe(300);   // Debit-normal +300  ← was missing
    expect(byId.inv.closingBalance).toBe(-300);   // Debit-normal, credited 300 ← was missing
  });
});
