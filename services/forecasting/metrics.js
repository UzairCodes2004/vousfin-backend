// services/forecasting/metrics.js
//
// Forecast Platform — F3. Forecast accuracy metrics (pure, no I/O).
//
// Point metrics (MAE/RMSE/MAPE/sMAPE/MASE) + probabilistic metrics (pinball loss,
// interval coverage). MASE is scaled by the in-sample naive error so it is
// comparable across series of different magnitudes — and "MASE < 1" literally
// means "better than the naive forecast", which is the platform's baseline gate.
//
'use strict';

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const r4 = (v) => Math.round((Number(v) || 0) * 10000) / 10000;

/** Mean Absolute Error. */
function mae(actuals, preds) {
  const n = Math.min(actuals.length, preds.length);
  if (!n) return null;
  let s = 0; for (let i = 0; i < n; i++) s += Math.abs(actuals[i] - preds[i]);
  return r4(s / n);
}

/** Root Mean Squared Error. */
function rmse(actuals, preds) {
  const n = Math.min(actuals.length, preds.length);
  if (!n) return null;
  let s = 0; for (let i = 0; i < n; i++) s += (actuals[i] - preds[i]) ** 2;
  return r4(Math.sqrt(s / n));
}

/** Mean Absolute Percentage Error (%, skips zero actuals). */
function mape(actuals, preds) {
  const n = Math.min(actuals.length, preds.length);
  let s = 0; let c = 0;
  for (let i = 0; i < n; i++) {
    if (actuals[i] !== 0) { s += Math.abs((actuals[i] - preds[i]) / actuals[i]); c++; }
  }
  return c ? r4((s / c) * 100) : null;
}

/** Symmetric MAPE (%, bounded, handles zeros gracefully). */
function smape(actuals, preds) {
  const n = Math.min(actuals.length, preds.length);
  if (!n) return null;
  let s = 0; let c = 0;
  for (let i = 0; i < n; i++) {
    const denom = (Math.abs(actuals[i]) + Math.abs(preds[i]));
    if (denom !== 0) { s += Math.abs(actuals[i] - preds[i]) / (denom / 2); c++; }
  }
  return c ? r4((s / c) * 100) : 0;
}

/** In-sample naive (period-step) error scale used to normalize MASE. */
function naiveScale(train, period = 1) {
  if (!train || train.length <= period) return null;
  let s = 0; let c = 0;
  for (let i = period; i < train.length; i++) { s += Math.abs(train[i] - train[i - period]); c++; }
  return c ? s / c : null;
}

/**
 * Mean Absolute Scaled Error. < 1 ⇒ beats the naive forecast.
 * @param period seasonal period for the scaling denominator (1 = one-step naive).
 */
function mase(actuals, preds, train, period = 1) {
  const scale = naiveScale(train, period);
  const m = mae(actuals, preds);
  if (scale == null || scale === 0 || m == null) return null;
  return r4(m / scale);
}

/** Pinball (quantile) loss for a single quantile tau ∈ (0,1). */
function pinball(actuals, preds, tau) {
  const n = Math.min(actuals.length, preds.length);
  if (!n) return null;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const d = actuals[i] - preds[i];
    s += d >= 0 ? tau * d : (tau - 1) * d;
  }
  return r4(s / n);
}

/** Fraction of actuals that fall inside [lower, upper] — interval coverage ∈ [0,1]. */
function coverage(actuals, lower, upper) {
  const n = Math.min(actuals.length, lower.length, upper.length);
  if (!n) return null;
  let hit = 0;
  for (let i = 0; i < n; i++) if (actuals[i] >= lower[i] && actuals[i] <= upper[i]) hit++;
  return r4(hit / n);
}

module.exports = { mean, mae, rmse, mape, smape, naiveScale, mase, pinball, coverage };
