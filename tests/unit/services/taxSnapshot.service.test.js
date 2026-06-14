'use strict';

// taxSnapshot orchestrates: read the live position → upsert today's row → read trend.
// We mock both collaborators so this tests the mapping + date logic in isolation.
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../../services/taxPosition.service', () => ({ getLivePosition: jest.fn() }));
jest.mock('../../../repositories/taxPositionSnapshot.repository', () => ({ upsertForDate: jest.fn(), trend: jest.fn() }));

const taxPosition = require('../../../services/taxPosition.service');
const repo        = require('../../../repositories/taxPositionSnapshot.repository');
const taxSnapshot = require('../../../services/taxSnapshot.service');

const BIZ = '507f1f77bcf86cd799439060';

const samplePosition = {
  asOf:         new Date(2026, 5, 10).toISOString(),
  currency:     'PKR',
  country:      'PK',
  totalPayable: 1500,
  taxes: [
    { taxType: 'GST',        label: 'GST / Sales Tax',  liability: 1200, refundable: false, raw: 1200, status: 'tracked',     nextDeadline: { daysRemaining: 8 } },
    { taxType: 'WHT',        label: 'Withholding Tax',  liability: 300,  refundable: false,            status: 'tracked',     nextDeadline: { daysRemaining: 5 } },
    { taxType: 'INCOME_TAX', label: 'Income Tax',       liability: 0,    refundable: false,            status: 'not_tracked', nextDeadline: null },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
  taxPosition.getLivePosition.mockResolvedValue(samplePosition);
  repo.upsertForDate.mockImplementation((b, date, payload) => Promise.resolve({ _id: 'snap1', businessId: b, date, ...payload }));
  repo.trend.mockResolvedValue([]);
});

describe('taxSnapshot.captureSnapshot', () => {
  it('reads the live position and upserts a snapshot for today (local date key)', async () => {
    const asOf = new Date(2026, 5, 10, 14, 30); // local June 10 14:30
    await taxSnapshot.captureSnapshot(BIZ, asOf);

    expect(taxPosition.getLivePosition).toHaveBeenCalledWith(BIZ, asOf);
    const [bizArg, dateArg, payload] = repo.upsertForDate.mock.calls[0];
    expect(bizArg).toBe(BIZ);
    expect(dateArg).toBe('2026-06-10');          // local YYYY-MM-DD — no UTC drift
    expect(payload.totalPayable).toBe(1500);
    expect(payload.currency).toBe('PKR');
    expect(payload.country).toBe('PK');
  });

  it('persists a slimmed per-tax line (type, liability, refundable, status only)', async () => {
    await taxSnapshot.captureSnapshot(BIZ, new Date(2026, 5, 10));
    const payload = repo.upsertForDate.mock.calls[0][2];
    expect(payload.taxes).toEqual([
      { taxType: 'GST',        liability: 1200, refundable: false, status: 'tracked'     },
      { taxType: 'WHT',        liability: 300,  refundable: false, status: 'tracked'     },
      { taxType: 'INCOME_TAX', liability: 0,    refundable: false, status: 'not_tracked' },
    ]);
    // transient display fields are NOT persisted
    expect(payload.taxes[0].label).toBeUndefined();
    expect(payload.taxes[0].nextDeadline).toBeUndefined();
  });

  it('is idempotent for the same day — derives the same date key on re-run', async () => {
    await taxSnapshot.captureSnapshot(BIZ, new Date(2026, 5, 10, 1, 0));
    await taxSnapshot.captureSnapshot(BIZ, new Date(2026, 5, 10, 23, 0));
    expect(repo.upsertForDate.mock.calls[0][1]).toBe('2026-06-10');
    expect(repo.upsertForDate.mock.calls[1][1]).toBe('2026-06-10');
  });

  it('returns the upserted snapshot', async () => {
    const snap = await taxSnapshot.captureSnapshot(BIZ, new Date(2026, 5, 10));
    expect(snap._id).toBe('snap1');
  });
});

describe('taxSnapshot.getTrend', () => {
  it('queries from the 1st of the (months-1)-back month and returns mapped points', async () => {
    repo.trend.mockResolvedValue([
      { date: '2026-05-31', totalPayable: 900,  taxes: [{ taxType: 'GST', liability: 900 }],  currency: 'PKR' },
      { date: '2026-06-10', totalPayable: 1500, taxes: [{ taxType: 'GST', liability: 1200 }], currency: 'PKR' },
    ]);
    const trend = await taxSnapshot.getTrend(BIZ, 6, new Date(2026, 5, 10));

    expect(repo.trend).toHaveBeenCalledWith(BIZ, '2026-01-01'); // Jan..Jun inclusive = 6 months
    expect(trend.months).toBe(6);
    expect(trend.from).toBe('2026-01-01');
    expect(trend.points).toHaveLength(2);
    expect(trend.points[1].totalPayable).toBe(1500);
  });

  it('clamps an out-of-range months value', async () => {
    await taxSnapshot.getTrend(BIZ, 99, new Date(2026, 5, 10));
    expect(repo.trend).toHaveBeenCalledWith(BIZ, '2024-07-01'); // clamped to 24 months
  });

  it('defaults to 6 months', async () => {
    await taxSnapshot.getTrend(BIZ, undefined, new Date(2026, 5, 10));
    expect(repo.trend).toHaveBeenCalledWith(BIZ, '2026-01-01');
  });
});
