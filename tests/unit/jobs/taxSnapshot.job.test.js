'use strict';

jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('node-cron', () => ({ schedule: jest.fn() }));
jest.mock('../../../models/Business.model', () => ({ find: jest.fn() }));
jest.mock('../../../models/ChartOfAccount.model', () => ({ distinct: jest.fn() }));
jest.mock('../../../services/taxSnapshot.service', () => ({ captureSnapshot: jest.fn() }));

const cron           = require('node-cron');
const Business       = require('../../../models/Business.model');
const ChartOfAccount = require('../../../models/ChartOfAccount.model');
const taxSnapshot    = require('../../../services/taxSnapshot.service');
const job            = require('../../../jobs/taxSnapshot.job');

beforeEach(() => jest.clearAllMocks());

function mockFlagged(list) {
  Business.find.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(list) }) });
}

describe('taxSnapshot.job.resolveTargetBusinessIds', () => {
  it('unions businesses with tax accounts and flag-enabled ones, deduped', async () => {
    ChartOfAccount.distinct.mockResolvedValue(['acctA', 'shared']);
    mockFlagged([{ _id: 'flagB' }, { _id: 'shared' }]);

    const ids = await job.resolveTargetBusinessIds();

    expect(ChartOfAccount.distinct).toHaveBeenCalledWith('businessId', { accountCode: { $in: job.TAX_ACCOUNT_CODES } });
    expect(Business.find).toHaveBeenCalledWith(job.FLAG_FILTER);
    expect(ids.sort()).toEqual(['acctA', 'flagB', 'shared']); // 'shared' appears once
  });

  it('captures businesses that track tax in the GL even with tax flags off', async () => {
    ChartOfAccount.distinct.mockResolvedValue(['ledgerOnly']);
    mockFlagged([]); // no flags enabled anywhere
    const ids = await job.resolveTargetBusinessIds();
    expect(ids).toEqual(['ledgerOnly']);
  });
});

describe('taxSnapshot.job.runOnce', () => {
  it('captures a snapshot for every tax-tracking business', async () => {
    ChartOfAccount.distinct.mockResolvedValue(['b1', 'b2']);
    mockFlagged([]);
    taxSnapshot.captureSnapshot.mockResolvedValue({});

    const asOf  = new Date(2026, 5, 10);
    const stats = await job.runOnce(asOf);

    expect(taxSnapshot.captureSnapshot).toHaveBeenCalledWith('b1', asOf);
    expect(taxSnapshot.captureSnapshot).toHaveBeenCalledWith('b2', asOf);
    expect(stats).toEqual({ businesses: 2, captured: 2, errors: 0 });
  });

  it('continues past a failing business and counts the error', async () => {
    ChartOfAccount.distinct.mockResolvedValue(['b1', 'b2']);
    mockFlagged([]);
    taxSnapshot.captureSnapshot
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({});

    const stats = await job.runOnce(new Date());
    expect(stats).toEqual({ businesses: 2, captured: 1, errors: 1 });
  });

  it('only targets active businesses in the flag filter', () => {
    expect(job.FLAG_FILTER).toMatchObject({ isActive: { $ne: false } });
    expect(Array.isArray(job.FLAG_FILTER.$or)).toBe(true);
  });
});

describe('taxSnapshot.job.scheduleTaxSnapshots', () => {
  it('registers a daily 00:30 cron', () => {
    job.scheduleTaxSnapshots();
    expect(cron.schedule).toHaveBeenCalledWith(
      '30 0 * * *',
      expect.any(Function),
      expect.objectContaining({ timezone: expect.any(String) })
    );
  });
});
