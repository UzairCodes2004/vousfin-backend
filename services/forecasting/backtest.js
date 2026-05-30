// services/forecasting/backtest.js
//
// Forecast Platform — F3. Walk-forward (rolling-origin) backtest harness (pure).
//
// LEAKAGE-SAFE BY CONSTRUCTION: for each fold the forecaster only ever sees the
// training prefix `series[0..i]` and predicts the *future* slice `series[i..i+h]`
// — never the other way around. Any forecastFn with the shared signature
// (train, horizon, opts) -> number[] can be evaluated through this one path, so
// baselines, the classical model and (later) the ensemble are scored identically.
//
'use strict';
const metrics = require('./metrics');

/**
 * Generate rolling-origin folds.
 * @returns {Array<{ trainEnd, train, test }>}
 */
function rollingOriginSplits(series, { minTrain = 4, horizon = 1, step = 1 } = {}) {
  const folds = [];
  for (let i = minTrain; i < series.length; i += step) {
    const test = series.slice(i, i + horizon);
    if (!test.length) break;
    folds.push({ trainEnd: i, train: series.slice(0, i), test });
  }
  return folds;
}

/**
 * Evaluate one forecaster across all folds; pools predictions and reports
 * aggregate metrics. MASE is averaged per-fold (each scaled by its own train).
 *
 * @param {number[]} series
 * @param {(train, horizon, opts) => number[]} forecastFn
 * @param {Object} opts { minTrain, horizon, step, period }
 */
function evaluateForecaster(series, forecastFn, opts = {}) {
  const { minTrain = 4, horizon = 1, step = 1, period = 1 } = opts;
  const folds = rollingOriginSplits(series, { minTrain, horizon, step });
  if (!folds.length) {
    return { folds: 0, mae: null, rmse: null, mape: null, smape: null, mase: null, insufficient: true };
  }

  const allActual = [];
  const allPred = [];
  const maseFold = [];
  for (const f of folds) {
    const preds = forecastFn(f.train, f.test.length, { period }) || [];
    for (let i = 0; i < f.test.length; i++) {
      allActual.push(f.test[i]);
      allPred.push(preds[i] != null ? preds[i] : metrics.mean(f.train));
    }
    const fm = metrics.mase(f.test, preds, f.train, period);
    if (fm != null && Number.isFinite(fm)) maseFold.push(fm);
  }

  return {
    folds: folds.length,
    mae:   metrics.mae(allActual, allPred),
    rmse:  metrics.rmse(allActual, allPred),
    mape:  metrics.mape(allActual, allPred),
    smape: metrics.smape(allActual, allPred),
    mase:  maseFold.length ? Math.round(metrics.mean(maseFold) * 10000) / 10000 : null,
    n:     allActual.length,
  };
}

/**
 * Compare several named forecasters on the same series.
 * @param {Object<string, Function>} forecasters  name → forecastFn
 * @returns {{ results, winner }}  winner = lowest MAE (finite)
 */
function compareForecasters(series, forecasters, opts = {}) {
  const results = {};
  for (const [name, fn] of Object.entries(forecasters)) {
    results[name] = evaluateForecaster(series, fn, opts);
  }
  const ranked = Object.entries(results)
    .filter(([, r]) => r.mae != null)
    .sort((a, b) => a[1].mae - b[1].mae);
  return { results, winner: ranked.length ? ranked[0][0] : null };
}

module.exports = { rollingOriginSplits, evaluateForecaster, compareForecasters };
