/**
 * tests/unit/services/forecastStore.service.test.js
 *
 * Forecast Platform — F3. The baseline gate, backtest-against-baseline, model
 * registration, and run persistence.
 */
'use strict';

jest.mock('../../../models/ModelRegistry.model', () => ({ findOne: jest.fn(), create: jest.fn() }));
jest.mock('../../../models/ForecastRun.model', () => ({ create: jest.fn() }));
jest.mock('../../../models/ForecastAccuracy.model', () => ({ updateOne: jest.fn().mockResolvedValue({}) }));

const mongoose = require('mongoose');
const store = require('../../../services/forecasting/forecastStore.service');
const baselines = require('../../../services/forecasting/baselines');
const classical = require('../../../services/forecasting/classical');
const ModelRegistry = require('../../../models/ModelRegistry.model');
const ForecastRun = require('../../../models/ForecastRun.model');

const BIZ = '507f1f77bcf86cd799439060';
beforeAll(() => Object.defineProperty(mongoose.connection, 'readyState', { configurable: true, get: () => 1 }));
beforeEach(() => jest.clearAllMocks());

describe('applyGate (pure)', () => {
  it('passes when the model beats seasonal-naive', () => {
    expect(store.applyGate(0.6, 0.9).gatePassed).toBe(true);
  });
  it('fails when the model loses to seasonal-naive', () => {
    expect(store.applyGate(1.2, 0.9).gatePassed).toBe(false);
  });
  it('falls back to the naive floor (MASE<1) when no seasonal baseline', () => {
    expect(store.applyGate(0.8, null).gatePassed).toBe(true);
    expect(store.applyGate(1.4, null).gatePassed).toBe(false);
  });
  it('fails safe when the model backtest is unavailable', () => {
    expect(store.applyGate(null, 0.5).gatePassed).toBe(false);
  });
});

describe('backtestModel', () => {
  it('scores the model and the seasonal-naive baseline on identical folds', () => {
    const trend = [10, 20, 30, 40, 50, 60, 70, 80, 90];
    const res = store.backtestModel(trend, baselines.drift, { period: 1, horizon: 1 });
    expect(res.model.mase).toBeLessThan(1);          // drift beats naive on a trend
    expect(typeof res.gatePassed).toBe('boolean');
    expect(res.seasonalNaive).toBeDefined();
  });
});

describe('evaluateAndRegister', () => {
  it('registers a champion when the gate passes', async () => {
    ModelRegistry.findOne.mockReturnValue({ sort: () => ({ select: () => ({ lean: () => Promise.resolve({ version: 2 }) }) }) });
    ModelRegistry.create.mockResolvedValue({ _id: 'reg1', version: 3 });
    const trend = [10, 20, 30, 40, 50, 60, 70, 80, 90];
    const v = await store.evaluateAndRegister(BIZ, {
      target: 'Revenue', granularity: 'monthly', series: trend, period: 1, horizon: 1,
      forecastFn: classical.holtWintersForecaster, modelType: 'Holt-Winters',
    });
    expect(ModelRegistry.create).toHaveBeenCalled();
    const created = ModelRegistry.create.mock.calls[0][0];
    expect(created.version).toBe(3);
    expect(['champion', 'baseline']).toContain(created.status);
    expect(v.modelVersion).toBe(3);
  });
});

describe('recordForecast', () => {
  it('persists a run and returns the gate verdict (uses 24h-cached registry)', async () => {
    ModelRegistry.findOne.mockReturnValue({ sort: () => ({ lean: () => Promise.resolve({ _id: 'r1', version: 5, gatePassed: true, modelMase: 0.7, baselineMase: 0.9 }) }) });
    ForecastRun.create.mockResolvedValue({ _id: 'run1' });
    const verdict = await store.recordForecast(BIZ, {
      target: 'Revenue', granularity: 'monthly', horizon: 3,
      series: [10, 20, 30, 40, 50, 60], period: 1, forecastFn: classical.holtWintersForecaster,
      modelType: 'Holt-Winters', predicted: [70, 80, 90], lower: [60, 70, 80], upper: [80, 90, 100],
      periodLabels: ['Jul', 'Aug', 'Sep'], dataSource: 'live',
    });
    expect(ForecastRun.create).toHaveBeenCalled();
    expect(verdict.modelVersion).toBe(5);
    expect(verdict.gatePassed).toBe(true);
    const run = ForecastRun.create.mock.calls[0][0];
    expect(run.inputsHash).toMatch(/^[a-f0-9]{64}$/);
    expect(run.predicted).toEqual([70, 80, 90]);
  });

  it('never throws on a downstream failure (fire-and-forget safety)', async () => {
    ModelRegistry.findOne.mockReturnValue({ sort: () => ({ lean: () => Promise.reject(new Error('db boom')) }) });
    ForecastRun.create.mockResolvedValue({ _id: 'run2' });
    await expect(store.recordForecast(BIZ, {
      target: 'Revenue', horizon: 1, series: [1, 2, 3, 4, 5], forecastFn: classical.holtWintersForecaster,
      modelType: 'Holt-Winters', predicted: [6],
    })).resolves.not.toThrow();
  });
});
