'use strict';

jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../../models/TaxPositionSnapshot.model', () => ({
  findOneAndUpdate: jest.fn(),
  find:             jest.fn(),
}));

const Model = require('../../../models/TaxPositionSnapshot.model');
const repo  = require('../../../repositories/taxPositionSnapshot.repository');

beforeEach(() => jest.clearAllMocks());

describe('taxPositionSnapshot.repository.upsertForDate', () => {
  it('upserts on the (businessId, date) key and returns the lean doc', async () => {
    Model.findOneAndUpdate.mockReturnValue({ lean: () => Promise.resolve({ _id: 's1' }) });

    const out = await repo.upsertForDate('biz1', '2026-06-10', { totalPayable: 100, taxes: [], currency: 'PKR' });

    const [filter, update, options] = Model.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ businessId: 'biz1', date: '2026-06-10' });
    expect(update.$set.totalPayable).toBe(100);
    expect(update.$set.businessId).toBe('biz1');
    expect(update.$set.date).toBe('2026-06-10');
    expect(options).toMatchObject({ upsert: true, new: true });
    expect(out).toEqual({ _id: 's1' });
  });
});

describe('taxPositionSnapshot.repository.trend', () => {
  it('returns rows on/after fromDate, ascending by date', async () => {
    const lean = jest.fn().mockResolvedValue([{ date: '2026-06-10' }]);
    const sort = jest.fn(() => ({ lean }));
    Model.find.mockReturnValue({ sort });

    const rows = await repo.trend('biz1', '2026-01-01');

    const [filter, projection] = Model.find.mock.calls[0];
    expect(filter).toEqual({ businessId: 'biz1', date: { $gte: '2026-01-01' } });
    expect(projection).toMatchObject({ date: 1, totalPayable: 1, taxes: 1 });
    expect(sort).toHaveBeenCalledWith({ date: 1 });
    expect(rows).toEqual([{ date: '2026-06-10' }]);
  });
});
