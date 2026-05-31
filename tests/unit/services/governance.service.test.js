/**
 * tests/unit/services/governance.service.test.js
 *
 * Forecast Platform — F9. Auto-rollback decision + execution, champion dashboard,
 * and usage metering.
 */
'use strict';

jest.mock('../../../models/ModelRegistry.model', () => ({ findOne: jest.fn() }));
jest.mock('../../../models/ForecastAccuracy.model', () => ({ aggregate: jest.fn() }));
jest.mock('../../../models/ForecastDriftEvent.model', () => ({ findOne: jest.fn() }));
jest.mock('../../../models/UsageMeter.model', () => ({ updateOne: jest.fn().mockResolvedValue({}), aggregate: jest.fn() }));
jest.mock('../../../services/forecasting/accuracyScore.service', () => ({ score: jest.fn() }));
jest.mock('../../../services/audit.service', () => ({ log: jest.fn().mockResolvedValue(true) }));
jest.mock('../../../services/forecasting/championChallenger.service', () => ({ retrain: jest.fn().mockResolvedValue({ retrained: true }) }));

const mongoose = require('mongoose');
const governance = require('../../../services/forecasting/governance.service');
const usageMeter = require('../../../services/forecasting/usageMeter.service');
const ModelRegistry = require('../../../models/ModelRegistry.model');
const ForecastAccuracy = require('../../../models/ForecastAccuracy.model');
const UsageMeter = require('../../../models/UsageMeter.model');

const BIZ = '507f1f77bcf86cd799439060';
beforeAll(() => Object.defineProperty(mongoose.connection, 'readyState', { configurable: true, get: () => 1 }));
beforeEach(() => jest.clearAllMocks());

describe('shouldRollback (pure)', () => {
  it('rolls back when realized error blows past the backtest promise', () => {
    expect(governance.shouldRollback(40, 15).rollback).toBe(true);   // 40 > 15*1.5
  });
  it('does not roll back within tolerance', () => {
    expect(governance.shouldRollback(18, 15).rollback).toBe(false);  // 18 < 22.5
    expect(governance.shouldRollback(10, 8).rollback).toBe(false);   // below floor
  });
  it('is safe with no realized data', () => {
    expect(governance.shouldRollback(null, 15).rollback).toBe(false);
  });
});

describe('autoRollback (execution)', () => {
  const champ = (over = {}) => ({ _id: 'c5', version: 5, modelMase: 0.6, backtest: { mape: 12 }, status: 'champion', save: jest.fn(), ...over });

  it('restores the best prior gated version on regression', async () => {
    const champion = champ();
    const prior = { _id: 'c3', version: 3, modelMase: 0.5, status: 'retired', save: jest.fn() };
    ModelRegistry.findOne
      .mockReturnValueOnce({ sort: () => Promise.resolve(champion) })   // current champion
      .mockReturnValueOnce({ sort: () => Promise.resolve(prior) });     // best prior
    ForecastAccuracy.aggregate.mockResolvedValue([{ mape: 35, points: 9 }]); // realized way worse than 12

    const r = await governance.autoRollback(BIZ, 'Revenue');
    expect(r.rolledBack).toBe(true);
    expect(r.action).toBe('restored_prior');
    expect(prior.status).toBe('champion');
    expect(champion.status).toBe('retired');
  });

  it('retrains when there is no prior version to restore', async () => {
    const championChallenger = require('../../../services/forecasting/championChallenger.service');
    const champion = champ();
    ModelRegistry.findOne
      .mockReturnValueOnce({ sort: () => Promise.resolve(champion) })
      .mockReturnValueOnce({ sort: () => Promise.resolve(null) });      // no prior
    ForecastAccuracy.aggregate.mockResolvedValue([{ mape: 40, points: 9 }]);

    const r = await governance.autoRollback(BIZ, 'Revenue');
    expect(r.action).toBe('retrained');
    expect(championChallenger.retrain).toHaveBeenCalled();
  });

  it('does nothing when realized accuracy is within tolerance', async () => {
    ModelRegistry.findOne.mockReturnValueOnce({ sort: () => Promise.resolve(champ()) });
    ForecastAccuracy.aggregate.mockResolvedValue([{ mape: 14, points: 9 }]); // close to backtest 12
    const r = await governance.autoRollback(BIZ, 'Revenue');
    expect(r.rolledBack).toBe(false);
    expect(r.reason).toBe('within_tolerance');
  });

  it('skips on insufficient realized data', async () => {
    ModelRegistry.findOne.mockReturnValueOnce({ sort: () => Promise.resolve(champ()) });
    ForecastAccuracy.aggregate.mockResolvedValue([{ mape: 40, points: 2 }]);
    const r = await governance.autoRollback(BIZ, 'Revenue');
    expect(r.reason).toBe('insufficient_realized');
  });
});

describe('usage metering', () => {
  it('upserts an incrementing per-day counter (never throws)', async () => {
    await usageMeter.record(BIZ, '/api/v1/forecast-registry');
    expect(UsageMeter.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: BIZ, endpoint: '/api/v1/forecast-registry' }),
      expect.objectContaining({ $inc: { count: 1 } }),
      { upsert: true }
    );
  });

  it('rolls up usage by endpoint', async () => {
    UsageMeter.aggregate.mockResolvedValue([{ _id: '/api/v1/forecast-registry', calls: 12 }, { _id: '/api/v1/forecast-domains', calls: 5 }]);
    const u = await usageMeter.usage(BIZ, {});
    expect(u.total).toBe(17);
    expect(u.byEndpoint[0].calls).toBe(12);
  });
});
