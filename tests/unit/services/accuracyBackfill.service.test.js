/**
 * tests/unit/services/accuracyBackfill.service.test.js
 *
 * Forecast Platform — A2. Walk-forward accuracy backfill: leakage-safe
 * reconstruction of realized accuracy + idempotent persistence.
 */
'use strict';

jest.mock('../../../models/ForecastRun.model', () => ({ findOne: jest.fn(), create: jest.fn() }));
jest.mock('../../../models/ForecastAccuracy.model', () => ({ updateOne: jest.fn().mockResolvedValue({}) }));
jest.mock('../../../services/forecasting/lstmForecastService', () => ({ fetchMonthlyData: jest.fn() }));
jest.mock('../../../services/forecasting/championChallenger.service', () => ({ retrain: jest.fn().mockResolvedValue({ retrained: true }) }));

const mongoose = require('mongoose');
const svc = require('../../../services/forecasting/accuracyBackfill.service');
const ForecastRun = require('../../../models/ForecastRun.model');
const ForecastAccuracy = require('../../../models/ForecastAccuracy.model');
const lstm = require('../../../services/forecasting/lstmForecastService');

const BIZ = '507f1f77bcf86cd799439060';
beforeAll(() => Object.defineProperty(mongoose.connection, 'readyState', { configurable: true, get: () => 1 }));
beforeEach(() => jest.clearAllMocks());

describe('rollingOriginPoints (pure, leakage-safe)', () => {
  it('reconstructs one-step points using only past data', () => {
    const series = [100, 110, 120, 130, 140, 150, 160, 170, 180, 190];
    const pts = svc.rollingOriginPoints(series, { period: 3 });
    expect(pts.length).toBeGreaterThan(0);
    pts.forEach((p) => {
      expect(p).toHaveProperty('predicted');
      expect(p).toHaveProperty('actual');
      expect(p.absError).toBeGreaterThanOrEqual(0);
      expect(typeof p.withinInterval).toBe('boolean');
    });
    // a clean trend should be forecast reasonably well (modest error)
    const avgPct = pts.reduce((s, p) => s + (p.pctError || 0), 0) / pts.length;
    expect(avgPct).toBeLessThan(25);
  });

  it('returns no points for a too-short series', () => {
    expect(svc.rollingOriginPoints([1, 2, 3], { period: 3 })).toHaveLength(0);
  });
});

describe('backfillBusiness (idempotent persistence)', () => {
  const monthly = Array.from({ length: 14 }, (_, i) => ({ revenue: 1000 + i * 60, expenses: 600 + i * 30, profit: 400 + i * 30 }));

  it('creates a synthetic backfill run and upserts accuracy points', async () => {
    lstm.fetchMonthlyData.mockResolvedValue(monthly);
    ForecastRun.findOne.mockResolvedValue(null);                 // no prior backfill run
    ForecastRun.create.mockResolvedValue({ _id: 'run1' });

    const stats = await svc.backfillBusiness(BIZ, { targets: ['Revenue'] });
    expect(stats.targets).toBe(1);
    expect(stats.points).toBeGreaterThan(0);
    expect(ForecastRun.create).toHaveBeenCalledTimes(1);
    expect(ForecastAccuracy.updateOne).toHaveBeenCalled();
    // upsert (idempotent), keyed by run + step
    const call = ForecastAccuracy.updateOne.mock.calls[0];
    expect(call[2]).toEqual({ upsert: true });
  });

  it('reuses the existing backfill run on re-run (no duplicate run)', async () => {
    lstm.fetchMonthlyData.mockResolvedValue(monthly);
    ForecastRun.findOne.mockResolvedValue({ _id: 'existing' });  // prior run exists
    const stats = await svc.backfillBusiness(BIZ, { targets: ['Revenue'] });
    expect(ForecastRun.create).not.toHaveBeenCalled();
    expect(stats.points).toBeGreaterThan(0);
  });

  it('skips targets with too little history', async () => {
    lstm.fetchMonthlyData.mockResolvedValue([{ revenue: 100 }, { revenue: 110 }]);
    const stats = await svc.backfillBusiness(BIZ, { targets: ['Revenue'] });
    expect(stats.targets).toBe(0);
    expect(stats.skipped).toBe(1);
  });
});
