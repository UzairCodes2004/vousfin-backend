// services/forecasting/forecastStore.service.js
//
// Forecast Platform — F3. The institutional layer over any forecaster:
//   • backtest the model + seasonal-naive baseline on the SAME walk-forward folds
//   • apply the BASELINE GATE (model must beat seasonal-naive, else fall back)
//   • register the model version (ModelRegistry) + persist every run (ForecastRun)
//   • capture ex-post realized accuracy (ForecastAccuracy)
//
// SAFETY: all persistence is DB-readyState-guarded + try/caught, so the registry
// can never block, slow, or break a served forecast (it is pure governance).
//
'use strict';
const crypto = require('crypto');
const mongoose = require('mongoose');
const ModelRegistry = require('../../models/ModelRegistry.model');
const ForecastRun = require('../../models/ForecastRun.model');
const ForecastAccuracy = require('../../models/ForecastAccuracy.model');
const backtest = require('./backtest');
const baselines = require('./baselines');
const logger = require('../../config/logger');

const dbReady = () => mongoose.connection && mongoose.connection.readyState === 1;
const r4 = (v) => (v == null ? null : Math.round(v * 10000) / 10000);
const hash = (obj) => crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex');

class ForecastStoreService {
  /**
   * Pure baseline gate. Model passes if its backtest MASE is finite AND beats
   * the seasonal-naive baseline (or, when no seasonal baseline exists on a short
   * series, beats the naive floor MASE < 1).
   */
  applyGate(modelMase, baselineMase) {
    if (modelMase == null || !Number.isFinite(modelMase)) {
      return { gatePassed: false, reason: 'model_backtest_unavailable' };
    }
    if (baselineMase == null || !Number.isFinite(baselineMase)) {
      const passed = modelMase < 1;
      return { gatePassed: passed, reason: passed ? 'beats_naive_floor' : 'loses_to_naive_floor' };
    }
    const passed = modelMase <= baselineMase;
    return { gatePassed: passed, reason: passed ? 'beats_seasonal_naive' : 'loses_to_seasonal_naive' };
  }

  /** Backtest a forecaster + the seasonal-naive baseline on identical folds. */
  backtestModel(series, forecastFn, { period = 1, horizon = 1, minTrain } = {}) {
    const mt = minTrain || Math.max(period * 2, 4);
    const model = backtest.evaluateForecaster(series, forecastFn, { minTrain: mt, horizon, period });
    const snaive = backtest.evaluateForecaster(
      series, (tr, h) => baselines.seasonalNaive(tr, h, { period }), { minTrain: mt, horizon, period });
    const gate = this.applyGate(model.mase, snaive.mase);
    return { model, seasonalNaive: snaive, ...gate };
  }

  /** Backtest + register a model version; returns the verdict for the run. */
  async evaluateAndRegister(businessId, { target, granularity = 'monthly', series, period = 1, horizon = 1, forecastFn, modelType = 'Holt-Winters', codeHash = null, createdBy = null }) {
    const bt = this.backtestModel(series, forecastFn, { period, horizon });
    const verdict = {
      modelType, modelMase: bt.model.mase, baselineMase: bt.seasonalNaive.mase,
      gatePassed: bt.gatePassed, gateReason: bt.reason, backtest: bt.model, modelVersion: null, registryId: null,
    };
    if (!dbReady()) return verdict;
    try {
      const key = `${target}-${granularity}`;
      const prior = await ModelRegistry.findOne({ businessId, key }).sort({ version: -1 }).select('version').lean();
      const reg = await ModelRegistry.create({
        businessId, key, target, granularity, version: (prior?.version || 0) + 1, modelType,
        backtest: bt.model, baselineMase: r4(bt.seasonalNaive.mase), modelMase: r4(bt.model.mase),
        gatePassed: bt.gatePassed, gateReason: bt.reason,
        trainWindow: { points: series.length },
        codeHash, status: bt.gatePassed ? 'champion' : 'baseline', createdBy,
      });
      verdict.modelVersion = reg.version;
      verdict.registryId = reg._id;
    } catch (e) { logger.warn(`[forecastStore] register failed: ${e.message}`); }
    return verdict;
  }

  /** Persist one served forecast run (auditable, accuracy-trackable). */
  async persistForecastRun(businessId, run = {}) {
    if (!dbReady()) return null;
    try {
      return await ForecastRun.create({
        businessId,
        target: run.target, granularity: run.granularity || 'monthly', horizon: run.horizon,
        modelType: run.modelType, modelVersion: run.modelVersion || null, modelRegistryId: run.registryId || null,
        dataSource: run.dataSource || null,
        inputsHash: hash({ series: run.inputs || [], target: run.target, horizon: run.horizon }),
        periodLabels: run.periodLabels || [], predicted: run.predicted || [],
        lower: run.lower || [], upper: run.upper || [],
        baselineMase: r4(run.baselineMase), modelMase: r4(run.modelMase),
        gatePassed: run.gatePassed != null ? run.gatePassed : null,
        servedBaseline: !!run.servedBaseline,
        generatedAt: new Date(),
      });
    } catch (e) { logger.warn(`[forecastStore] persistForecastRun failed: ${e.message}`); return null; }
  }

  /**
   * High-level: backtest+register (cached daily) then persist the served run.
   * Called fire-and-forget by the forecaster wrapper — never throws.
   * @returns {Promise<{gatePassed, modelMase, baselineMase, modelVersion, registryId} | null>}
   */
  async recordForecast(businessId, { target, granularity = 'monthly', horizon, series, period = 1, forecastFn, modelType, predicted, lower, upper, periodLabels, dataSource }) {
    try {
      let verdict = { gatePassed: null, modelMase: null, baselineMase: null, modelVersion: null, registryId: null };
      if (dbReady() && Array.isArray(series) && series.length >= 4 && typeof forecastFn === 'function') {
        // Re-register at most once per 24h per key (cheap day-cache).
        const key = `${target}-${granularity}`;
        const recent = await ModelRegistry.findOne({
          businessId, key, createdAt: { $gte: new Date(Date.now() - 24 * 3600 * 1000) },
        }).sort({ version: -1 }).lean();
        verdict = recent
          ? { gatePassed: recent.gatePassed, modelMase: recent.modelMase, baselineMase: recent.baselineMase, modelVersion: recent.version, registryId: recent._id }
          : await this.evaluateAndRegister(businessId, { target, granularity, series, period, horizon, forecastFn, modelType });
      }
      await this.persistForecastRun(businessId, {
        target, granularity, horizon, modelType, dataSource,
        modelVersion: verdict.modelVersion, registryId: verdict.registryId,
        inputs: series, periodLabels, predicted, lower, upper,
        baselineMase: verdict.baselineMase, modelMase: verdict.modelMase, gatePassed: verdict.gatePassed,
      });
      return verdict;
    } catch (e) {
      logger.warn(`[forecastStore] recordForecast failed (non-fatal): ${e.message}`);
      return null;
    }
  }

  /** Ex-post: capture realized actuals against a past run's predictions. Idempotent. */
  async captureAccuracy(businessId, runDoc, actualByStep) {
    if (!dbReady() || !runDoc) return 0;
    let captured = 0;
    for (let step = 1; step <= (runDoc.predicted || []).length; step++) {
      const actual = actualByStep[step];
      if (actual == null) continue;
      const predicted = runDoc.predicted[step - 1];
      const lo = (runDoc.lower || [])[step - 1];
      const hi = (runDoc.upper || [])[step - 1];
      try {
        await ForecastAccuracy.updateOne(
          { businessId, forecastRunId: runDoc._id, horizonStep: step },
          { $setOnInsert: {
            businessId, forecastRunId: runDoc._id, target: runDoc.target, granularity: runDoc.granularity,
            horizonStep: step, periodKey: (runDoc.periodLabels || [])[step - 1] || null,
            predicted, actual, absError: Math.abs(actual - predicted),
            pctError: actual !== 0 ? Math.round(Math.abs((actual - predicted) / actual) * 10000) / 100 : null,
            withinInterval: (lo != null && hi != null) ? (actual >= lo && actual <= hi) : null,
          } },
          { upsert: true }
        );
        captured++;
      } catch (e) { logger.warn(`[forecastStore] captureAccuracy step ${step} failed: ${e.message}`); }
    }
    return captured;
  }
}

module.exports = new ForecastStoreService();
