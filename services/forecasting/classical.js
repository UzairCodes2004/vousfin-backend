// services/forecasting/classical.js
//
// Forecast Platform — F3. Classical statistical forecaster (pure), same
// signature as the baselines so it runs through the identical backtest harness.
// This is the reproducible, in-process "model under test" for the baseline gate
// (the external Bi-LSTM is served when available; this validates the floor and
// becomes the canonical classical member of the F4 ensemble).
//
'use strict';

const safeDiv = (a, b) => (b ? a / b : 0);

/** Holt's double exponential smoothing (level + trend). */
function holtsDouble(series, horizon, { alpha = 0.45, beta = 0.2 } = {}) {
  if (series.length < 2) return Array(horizon).fill(Math.max(0, series[0] || 0));
  let level = series[0];
  let trend = series[1] - series[0];
  for (let i = 1; i < series.length; i++) {
    const prev = level;
    level = alpha * series[i] + (1 - alpha) * (level + trend);
    trend = beta * (level - prev) + (1 - beta) * trend;
  }
  return Array.from({ length: horizon }, (_, h) => Math.max(0, level + (h + 1) * trend));
}

/**
 * Holt-Winters triple exponential smoothing (level + trend + seasonal).
 * Falls back to Holt's double when the series is too short for the season.
 */
function holtWinters(series, horizon, { alpha = 0.45, beta = 0.2, gamma = 0.15, period = 3 } = {}) {
  if (series.length < 2) return Array(horizon).fill(Math.max(0, series[0] || 0));
  if (series.length < period * 2) return holtsDouble(series, horizon, { alpha, beta });

  const n = series.length;
  const m = period;
  let level = series.slice(0, m).reduce((s, v) => s + v, 0) / m;
  const secondMean = series.slice(m, 2 * m).reduce((s, v) => s + v, 0) / m;
  let trend = (secondMean - level) / m;
  const seasonal = Array(m).fill(1);
  for (let i = 0; i < Math.min(m, n); i++) seasonal[i] = safeDiv(series[i], level || 1);

  for (let t = 0; t < n; t++) {
    const si = seasonal[t % m];
    const prevLevel = level;
    level = alpha * safeDiv(series[t], si) + (1 - alpha) * (level + trend);
    trend = beta * (level - prevLevel) + (1 - beta) * trend;
    seasonal[t % m] = gamma * safeDiv(series[t], level) + (1 - gamma) * si;
  }
  return Array.from({ length: horizon }, (_, h) => {
    const si = seasonal[(n + h) % m];
    return Math.max(0, (level + (h + 1) * trend) * (si || 1));
  });
}

/** Backtest-harness adapter: a forecastFn that picks HW vs Holt's by data length. */
function holtWintersForecaster(train, horizon, opts = {}) {
  return holtWinters(train, horizon, opts);
}

module.exports = { holtsDouble, holtWinters, holtWintersForecaster };
