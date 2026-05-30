/**
 * tests/unit/services/championChallenger.service.test.js
 *
 * Forecast Platform — F5. Promotion logic: a challenger becomes champion only if
 * it passes the baseline gate AND beats the current champion's MASE.
 */
'use strict';

jest.mock('../../../models/ModelRegistry.model', () => ({ findOne: jest.fn(), create: jest.fn() }));
jest.mock('../../../services/forecasting/ensemble', () => ({
  buildEnsemble: jest.fn(() => ({ forecastFn: () => [1], weights: { a: 0.6, b: 0.4 } })),
}));
jest.mock('../../../services/forecasting/forecastStore.service', () => ({ backtestModel: jest.fn() }));
jest.mock('../../../services/forecasting/lstmForecastService', () => ({ fetchMonthlyData: jest.fn() }));
jest.mock('../../../services/audit.service', () => ({ log: jest.fn().mockResolvedValue(true) }));
jest.mock('../../../services/businessEventEngine.service', () => ({ businessEvents: { emit: jest.fn() } }));

const mongoose = require('mongoose');
const cc = require('../../../services/forecasting/championChallenger.service');
const ModelRegistry = require('../../../models/ModelRegistry.model');
const forecastStore = require('../../../services/forecasting/forecastStore.service');
const lstm = require('../../../services/forecasting/lstmForecastService');

const BIZ = '507f1f77bcf86cd799439060';
beforeAll(() => Object.defineProperty(mongoose.connection, 'readyState', { configurable: true, get: () => 1 }));

const monthly = Array.from({ length: 12 }, (_, i) => ({ revenue: 100 + i * 5 }));
function priorChain(version) { return { sort: () => ({ select: () => ({ lean: () => Promise.resolve(version != null ? { version } : null) }) }) }; }

beforeEach(() => {
  jest.clearAllMocks();
  lstm.fetchMonthlyData.mockResolvedValue(monthly);
});

it('promotes the first champion when the gate passes', async () => {
  forecastStore.backtestModel.mockReturnValue({ model: { mase: 0.6 }, seasonalNaive: { mase: 0.9 }, gatePassed: true, reason: 'beats_seasonal_naive' });
  ModelRegistry.findOne
    .mockReturnValueOnce(priorChain(null))                                   // prior version lookup
    .mockReturnValueOnce({ sort: () => Promise.resolve(null) });             // getChampion → none
  ModelRegistry.create.mockResolvedValue({ _id: 'c1', version: 1, modelMase: 0.6, status: 'challenger', save: jest.fn() });

  const res = await cc.retrain(BIZ, { target: 'Revenue' });
  expect(res.promoted).toBe(true);
  expect(res.decision).toBe('promoted_first_champion');
});

it('promotes a challenger that beats the current champion', async () => {
  forecastStore.backtestModel.mockReturnValue({ model: { mase: 0.5 }, seasonalNaive: { mase: 0.9 }, gatePassed: true, reason: 'beats_seasonal_naive' });
  const champion = { _id: 'champ', modelMase: 0.8, status: 'champion', save: jest.fn() };
  ModelRegistry.findOne
    .mockReturnValueOnce(priorChain(4))
    .mockReturnValueOnce({ sort: () => Promise.resolve(champion) });
  const challenger = { _id: 'c5', version: 5, modelMase: 0.5, status: 'challenger', save: jest.fn() };
  ModelRegistry.create.mockResolvedValue(challenger);

  const res = await cc.retrain(BIZ, { target: 'Revenue' });
  expect(res.promoted).toBe(true);
  expect(res.decision).toBe('promoted_over_champion');
  expect(challenger.save).toHaveBeenCalled();      // promoted to champion
  expect(champion.save).toHaveBeenCalled();         // retired
  expect(champion.status).toBe('retired');
});

it('keeps the champion when the challenger is worse', async () => {
  forecastStore.backtestModel.mockReturnValue({ model: { mase: 0.7 }, seasonalNaive: { mase: 0.9 }, gatePassed: true, reason: 'beats_seasonal_naive' });
  const champion = { _id: 'champ', modelMase: 0.4, status: 'champion', save: jest.fn() };
  ModelRegistry.findOne
    .mockReturnValueOnce(priorChain(4))
    .mockReturnValueOnce({ sort: () => Promise.resolve(champion) });
  ModelRegistry.create.mockResolvedValue({ _id: 'c5', version: 5, modelMase: 0.7, status: 'challenger', save: jest.fn() });

  const res = await cc.retrain(BIZ, { target: 'Revenue' });
  expect(res.promoted).toBe(false);
  expect(res.decision).toBe('kept_challenger');
  expect(champion.save).not.toHaveBeenCalled();
});

it('rejects a challenger that fails the baseline gate', async () => {
  forecastStore.backtestModel.mockReturnValue({ model: { mase: 1.3 }, seasonalNaive: { mase: 0.9 }, gatePassed: false, reason: 'loses_to_seasonal_naive' });
  ModelRegistry.findOne
    .mockReturnValueOnce(priorChain(2))
    .mockReturnValueOnce({ sort: () => Promise.resolve(null) });
  ModelRegistry.create.mockResolvedValue({ _id: 'c3', version: 3, modelMase: 1.3, status: 'challenger', save: jest.fn() });

  const res = await cc.retrain(BIZ, { target: 'Revenue' });
  expect(res.promoted).toBe(false);
  expect(res.decision).toBe('rejected_failed_gate');
});

it('skips retrain on insufficient history', async () => {
  lstm.fetchMonthlyData.mockResolvedValue([{ revenue: 100 }, { revenue: 110 }]);
  const res = await cc.retrain(BIZ, { target: 'Revenue' });
  expect(res.retrained).toBe(false);
  expect(res.reason).toBe('insufficient_history');
});
