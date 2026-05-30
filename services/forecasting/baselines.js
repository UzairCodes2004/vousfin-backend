// services/forecasting/baselines.js
//
// Forecast Platform — F3. Naive baseline forecasters (pure).
//
// These are the floor every real model must beat. The platform's BASELINE GATE
// refuses to promote a model whose backtest error is not below seasonal-naive.
// All forecasters share one signature so the backtest harness can run any of
// them (and real models) through the identical evaluation path:
//
//     forecastFn(trainSeries:number[], horizon:number, opts) -> number[] (len horizon)
//
'use strict';

const last = (s) => (s.length ? s[s.length - 1] : 0);

/** Repeat the last observed value. */
function naive(series, horizon) {
  return Array(horizon).fill(Math.max(0, last(series)));
}

/** Repeat the value from one season ago, cycling through the season. */
function seasonalNaive(series, horizon, { period = 12 } = {}) {
  const n = series.length;
  if (n < period) return naive(series, horizon);
  return Array.from({ length: horizon }, (_, i) => {
    const idx = n - period + (i % period);
    return Math.max(0, idx >= 0 ? series[idx] : last(series));
  });
}

/** Last value + average per-step drift (slope across the whole series). */
function drift(series, horizon) {
  const n = series.length;
  if (n < 2) return naive(series, horizon);
  const slope = (series[n - 1] - series[0]) / (n - 1);
  return Array.from({ length: horizon }, (_, i) => Math.max(0, series[n - 1] + slope * (i + 1)));
}

/** Flat trailing moving-average. */
function movingAverage(series, horizon, { window = 3 } = {}) {
  const n = series.length;
  if (!n) return Array(horizon).fill(0);
  const w = series.slice(Math.max(0, n - window));
  const m = w.reduce((s, v) => s + v, 0) / w.length;
  return Array(horizon).fill(Math.max(0, m));
}

/** Registry of named baselines (for the backtest comparison table). */
const BASELINES = { naive, seasonalNaive, drift, movingAverage };

module.exports = { naive, seasonalNaive, drift, movingAverage, BASELINES };
