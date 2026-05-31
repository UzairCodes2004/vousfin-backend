// services/forecasting/accuracyBackfill.service.js
//
// Forecast Platform — Stage A2. Backfill realized accuracy from history.
//
// Bootstraps the accuracy/confidence score (A1) for businesses that have history
// but no served forecasts yet — WITHOUT fabricating anything. It replays the
// model walk-forward: at each historical cut-off the ensemble forecasts the next
// period using ONLY data up to that point (no leakage), then compares to the
// actual that genuinely followed. Those are real out-of-sample predictions, so
// the resulting accuracy is honest, just reconstructed.
//
// Also seeds ModelRegistry (backtest skill) via the champion/challenger retrain.
// Idempotent: re-running upserts into a single per-(business,target) backfill run.
//
'use strict';
const mongoose = require('mongoose');
const ForecastRun = require('../../models/ForecastRun.model');
const ForecastAccuracy = require('../../models/ForecastAccuracy.model');
const ensembleForecast = require('./ensembleForecast.service');
const backtest = require('./backtest');
const logger = require('../../config/logger');

const dbReady = () => mongoose.connection && mongoose.connection.readyState === 1;
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const METRIC = { Revenue: 'revenue', Expenses: 'expenses', 'Net Cash Flow': 'profit' };
const BACKFILL_TYPE = 'Backfill (rolling-origin)';

class AccuracyBackfillService {
  /**
   * Pure: reconstruct one-step realized accuracy points by walk-forward replay.
   * Leakage-safe — fold i forecasts series[i] from series[0..i-1] only.
   * @returns {Array<{step,predicted,actual,absError,pctError,withinInterval}>}
   */
  rollingOriginPoints(series, { period = 3, minTrain } = {}) {
    const mt = minTrain || Math.min(6, Math.max(4, series.length - 2));
    const folds = backtest.rollingOriginSplits(series, { minTrain: mt, horizon: 1 });
    const pts = [];
    folds.forEach((f, idx) => {
      const r = ensembleForecast.computeFromSeries(f.train, { horizon: 1, period });
      if (!r || !r.predicted.length) return;
      const predicted = r.predicted[0];
      const lo = r.lower[0]; const hi = r.upper[0];
      const actual = f.test[0];
      pts.push({
        step: idx + 1, predicted, actual,
        absError: r2(Math.abs(actual - predicted)),
        pctError: actual !== 0 ? r2(Math.abs((actual - predicted) / actual) * 100) : null,
        withinInterval: actual >= lo && actual <= hi,
      });
    });
    return pts;
  }

  /** Backfill one tenant across the standard targets. */
  async backfillBusiness(businessId, { targets = ['Revenue', 'Expenses', 'Net Cash Flow'], granularity = 'monthly' } = {}) {
    if (!dbReady()) return { skipped: 'db_unavailable' };
    const lstm = require('./lstmForecastService');
    const championChallenger = require('./championChallenger.service');
    const monthly = await lstm.fetchMonthlyData(businessId, 36);
    const stats = { targets: 0, points: 0, skipped: 0 };

    for (const target of targets) {
      const metric = METRIC[target] || 'revenue';
      const series = monthly.map((m) => m[metric]).filter((v) => v != null);
      if (series.length < 8) { stats.skipped += 1; continue; }
      const period = series.filter((v) => v > 0).length >= 6 ? 3 : 2;

      const pts = this.rollingOriginPoints(series, { period });
      if (!pts.length) { stats.skipped += 1; continue; }

      // Seed the registry (backtest skill) — best-effort.
      try { await championChallenger.retrain(businessId, { target, granularity }); }
      catch (e) { logger.warn(`[accuracyBackfill] retrain ${target} failed: ${e.message}`); }

      // One idempotent synthetic run per (business, target).
      let run = await ForecastRun.findOne({ businessId, target, granularity, modelType: BACKFILL_TYPE });
      if (!run) {
        run = await ForecastRun.create({
          businessId, target, granularity, horizon: 1, modelType: BACKFILL_TYPE,
          dataSource: 'backfill', predicted: pts.map((p) => p.predicted), generatedAt: new Date(),
        });
      }
      for (const p of pts) {
        await ForecastAccuracy.updateOne(
          { businessId, forecastRunId: run._id, horizonStep: p.step },
          { $set: {
            businessId, forecastRunId: run._id, target, granularity, horizonStep: p.step,
            predicted: p.predicted, actual: p.actual, absError: p.absError,
            pctError: p.pctError, withinInterval: p.withinInterval, capturedAt: new Date(),
          } },
          { upsert: true }
        );
        stats.points += 1;
      }
      stats.targets += 1;
    }
    return stats;
  }
}

module.exports = new AccuracyBackfillService();
module.exports.BACKFILL_TYPE = BACKFILL_TYPE;
