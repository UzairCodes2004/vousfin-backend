/**
 * tests/unit/services/forecasting.backtest.test.js
 *
 * Forecast Platform — F3. Pure forecasting science:
 * metrics, baselines, classical forecaster, and the leakage-safe walk-forward
 * backtest harness (incl. the "MASE < 1 beats naive" property).
 */
'use strict';

const m = require('../../../services/forecasting/metrics');
const b = require('../../../services/forecasting/baselines');
const c = require('../../../services/forecasting/classical');
const bt = require('../../../services/forecasting/backtest');

describe('metrics', () => {
  const a = [100, 110, 120];
  const f = [100, 100, 100];
  it('mae / rmse', () => {
    expect(m.mae(a, f)).toBe(10);          // (0+10+20)/3
    expect(m.rmse(a, f)).toBeCloseTo(Math.sqrt((0 + 100 + 400) / 3), 3);
  });
  it('mape / smape are percentages', () => {
    expect(m.mape(a, f)).toBeGreaterThan(0);
    expect(m.smape(a, f)).toBeGreaterThan(0);
  });
  it('mase < 1 when the forecast beats the naive in-sample step', () => {
    const train = [10, 20, 30, 40];        // naive one-step error scale = 10
    const actuals = [50, 60];
    const good = [50, 60];                  // perfect → mase 0
    const bad  = [10, 10];                  // worse than naive
    expect(m.mase(actuals, good, train, 1)).toBe(0);
    expect(m.mase(actuals, bad, train, 1)).toBeGreaterThan(1);
  });
  it('coverage + pinball', () => {
    expect(m.coverage([5, 5, 5], [0, 0, 6], [10, 10, 10])).toBeCloseTo(2 / 3, 3);
    expect(m.pinball([10], [8], 0.5)).toBeCloseTo(1, 3); // 0.5*|2|
  });
});

describe('baselines', () => {
  const s = [10, 20, 30, 40, 50, 60];
  it('naive repeats the last value', () => {
    expect(b.naive(s, 3)).toEqual([60, 60, 60]);
  });
  it('drift extrapolates the average slope', () => {
    expect(b.drift(s, 2)).toEqual([70, 80]);   // slope = 10
  });
  it('seasonalNaive repeats one season ago', () => {
    const seasonal = [1, 2, 3, 1, 2, 3];
    expect(b.seasonalNaive(seasonal, 3, { period: 3 })).toEqual([1, 2, 3]);
  });
  it('movingAverage is flat trailing mean', () => {
    expect(b.movingAverage(s, 1, { window: 3 })).toEqual([50]); // (40+50+60)/3
  });
});

describe('classical forecaster', () => {
  it('Holt-Winters tracks a trending series upward', () => {
    const trend = [10, 20, 30, 40, 50, 60, 70, 80];
    const f = c.holtWintersForecaster(trend, 2, { period: 3 });
    expect(f[0]).toBeGreaterThan(70);
    expect(f.length).toBe(2);
  });
});

describe('backtest harness (walk-forward, leakage-safe)', () => {
  const series = [10, 20, 30, 40, 50, 60, 70, 80];

  it('produces folds where train precedes test (no look-ahead)', () => {
    const folds = bt.rollingOriginSplits(series, { minTrain: 4, horizon: 1 });
    expect(folds.length).toBe(4);
    folds.forEach((f) => {
      expect(f.train[f.train.length - 1]).toBeLessThan(f.test[0]); // strictly increasing series
    });
  });

  it('drift beats naive on a linear trend (MASE lower)', () => {
    const evalNaive = bt.evaluateForecaster(series, b.naive, { minTrain: 3, horizon: 1 });
    const evalDrift = bt.evaluateForecaster(series, b.drift, { minTrain: 3, horizon: 1 });
    expect(evalDrift.mae).toBeLessThan(evalNaive.mae);
    expect(evalDrift.mase).toBeLessThan(1); // beats the naive floor
  });

  it('compareForecasters ranks the winner by MAE', () => {
    const { winner } = bt.compareForecasters(series, { naive: b.naive, drift: b.drift }, { minTrain: 3, horizon: 1 });
    expect(winner).toBe('drift');
  });
});
