/**
 * tests/unit/services/driftMonitor.service.test.js
 *
 * Forecast Platform — F5. Drift monitor: data drift (PSI) + accuracy decay →
 * shouldRetrain, logged to ForecastDriftEvent.
 */
'use strict';

jest.mock('../../../services/forecasting/lstmForecastService', () => ({ fetchMonthlyData: jest.fn() }));
jest.mock('../../../models/ForecastAccuracy.model', () => ({ find: jest.fn() }));
jest.mock('../../../models/ForecastDriftEvent.model', () => ({ create: jest.fn().mockResolvedValue({}) }));

const mongoose = require('mongoose');
const monitor = require('../../../services/forecasting/driftMonitor.service');
const lstm = require('../../../services/forecasting/lstmForecastService');
const ForecastAccuracy = require('../../../models/ForecastAccuracy.model');
const ForecastDriftEvent = require('../../../models/ForecastDriftEvent.model');

const BIZ = '507f1f77bcf86cd799439060';
beforeAll(() => Object.defineProperty(mongoose.connection, 'readyState', { configurable: true, get: () => 1 }));
const accChain = (rows) => ({ sort: () => ({ select: () => ({ lean: () => Promise.resolve(rows) }) }) });

beforeEach(() => {
  jest.clearAllMocks();
  ForecastAccuracy.find.mockReturnValue(accChain([])); // no realized accuracy by default
});

it('flags severe data drift (distribution shift) → shouldRetrain', async () => {
  // first half ~100, second half ~400 → big PSI
  const monthly = [100, 102, 98, 101, 99, 103, 400, 402, 398, 401, 399, 403].map((revenue) => ({ revenue }));
  lstm.fetchMonthlyData.mockResolvedValue(monthly);

  const res = await monitor.checkDrift(BIZ, { target: 'Revenue' });
  expect(res.driftLevel).toBe('severe');
  expect(res.shouldRetrain).toBe(true);
  expect(ForecastDriftEvent.create).toHaveBeenCalled();
});

it('does not retrain on a stable series with no accuracy decay', async () => {
  // identical halves → no distribution shift
  const monthly = [100, 101, 99, 100, 101, 99, 100, 101, 99, 100, 101, 99].map((revenue) => ({ revenue }));
  lstm.fetchMonthlyData.mockResolvedValue(monthly);

  const res = await monitor.checkDrift(BIZ, { target: 'Revenue' });
  expect(res.driftLevel).toBe('none');
  expect(res.shouldRetrain).toBe(false);
});

it('triggers retrain on accuracy decay even without data drift', async () => {
  const monthly = [100, 101, 99, 100, 101, 99, 100, 101, 99, 100, 101, 99].map((revenue) => ({ revenue }));
  lstm.fetchMonthlyData.mockResolvedValue(monthly);
  // realized error worsened from ~5% to ~30%
  ForecastAccuracy.find.mockReturnValue(accChain(
    [5, 6, 5, 6, 30, 32, 31, 33].map((pctError) => ({ pctError }))
  ));

  const res = await monitor.checkDrift(BIZ, { target: 'Revenue' });
  expect(res.decayed).toBe(true);
  expect(res.shouldRetrain).toBe(true);
});
