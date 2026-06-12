/**
 * tests/unit/services/taxReport.reconcile.service.test.js
 *
 * Verifies reconcileTaxToLedger() derives the tax return DIRECTLY from the
 * movement on the GL tax control accounts (authoritative) — so it captures
 * every tax posting (incl. invoice/bill recognition tax JEs) and ties to the
 * ledger by construction:
 *   output tax = Σ(credits − debits) on output (liability) tax accounts
 *   input  tax = Σ(debits − credits) on input  (asset)     tax accounts
 */
'use strict';

const mockJE  = { aggregate: jest.fn() };
const mockCOA = { find: jest.fn() };

jest.mock('mongoose', () => ({
  model: (name) => (name === 'JournalEntry' ? mockJE : mockCOA),
  Types: { ObjectId: function (v) { return v; } },
}));
jest.mock('../../../repositories/transaction.repository', () => ({ EFFECTIVE_LINES_STAGE: { $addFields: {} } }));
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const taxReport = require('../../../services/taxReport.service');

const BIZ = '507f1f77bcf86cd799439060';

beforeEach(() => {
  jest.clearAllMocks();
  // PK profile: output 2120 (GST Payable, Liability), input 1170 (GST Receivable, Asset).
  mockCOA.find.mockReturnValue({
    select: () => ({
      lean: () => Promise.resolve([
        { _id: 'out1', accountCode: '2120', accountName: 'GST Payable',    accountType: 'Liability' },
        { _id: 'in1',  accountCode: '1170', accountName: 'GST Receivable', accountType: 'Asset' },
      ]),
    }),
  });
});

it('nets credits−debits on output accounts and debits−credits on input accounts', async () => {
  mockJE.aggregate.mockResolvedValue([
    { _id: { acct: 'out1', type: 'credit' }, total: 1700 }, // output tax charged
    { _id: { acct: 'out1', type: 'debit' },  total: 200 },  // a credit-note reversal
    { _id: { acct: 'in1',  type: 'debit' },  total: 500 },  // input tax incurred
  ]);

  const r = await taxReport.reconcileTaxToLedger(BIZ, {}, 'PK');

  expect(r.glOutputTax).toBe(1500);   // 1700 − 200
  expect(r.glInputTax).toBe(500);
  expect(r.glNetPayable).toBe(1000);  // 1500 − 500
  expect(r.taxAccounts.output).toContain('2120');
  expect(r.taxAccounts.input).toContain('1170');
});

it('returns zeros and skips the aggregation when the business has no tax accounts', async () => {
  mockCOA.find.mockReturnValue({ select: () => ({ lean: () => Promise.resolve([]) }) });

  const r = await taxReport.reconcileTaxToLedger(BIZ, {}, 'PK');

  expect(r).toEqual({ glOutputTax: 0, glInputTax: 0, glNetPayable: 0, taxAccounts: { output: [], input: [] } });
  expect(mockJE.aggregate).not.toHaveBeenCalled();
});
