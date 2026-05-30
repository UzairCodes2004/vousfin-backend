// services/forecasting/championChallenger.service.js
//
// Forecast Platform — F5. Incremental retraining with champion/challenger promotion.
//
// "Retraining" in this stack = rebuild the ensemble's skill weights on the
// freshest data, backtest it, and register a new ModelRegistry version as a
// CHALLENGER. The challenger only becomes CHAMPION if it (a) passes the baseline
// gate and (b) beats the current champion's backtest MASE — otherwise the
// champion stays. Safe promotion, fully versioned, auditable.
//
'use strict';
const mongoose = require('mongoose');
const ModelRegistry = require('../../models/ModelRegistry.model');
const ensemble = require('./ensemble');
const forecastStore = require('./forecastStore.service');
const auditService = require('../audit.service');
const { businessEvents } = require('../businessEventEngine.service');
const logger = require('../../config/logger');
const { AUDIT_ACTIONS } = require('../../config/constants');

const dbReady = () => mongoose.connection && mongoose.connection.readyState === 1;
const METRIC_KEY = { Revenue: 'revenue', Expenses: 'expenses', 'Net Cash Flow': 'profit' };

class ChampionChallengerService {
  async getChampion(businessId, key) {
    if (!dbReady()) return null;
    return ModelRegistry.findOne({ businessId, key, status: 'champion' }).sort({ version: -1 });
  }

  /**
   * Retrain a target's ensemble and decide champion/challenger.
   * @returns {Promise<{retrained, promoted, decision, challengerVersion, modelMase, championMase, gatePassed}>}
   */
  async retrain(businessId, { target = 'Revenue', granularity = 'monthly' } = {}) {
    const lstm = require('./lstmForecastService'); // lazy — avoid require cycle
    const metric = METRIC_KEY[target] || 'revenue';
    const monthly = await lstm.fetchMonthlyData(businessId, 24);
    const series = monthly.map((m) => m[metric]).filter((v) => v != null && v >= 0);
    if (series.length < 6) return { retrained: false, reason: 'insufficient_history', points: series.length };

    const period = series.filter((v) => v > 0).length >= 6 ? 3 : 2;
    const { forecastFn, weights } = ensemble.buildEnsemble(series, { horizon: 1, period });
    const bt = forecastStore.backtestModel(series, forecastFn, { period, horizon: 1 });
    const modelType = `Ensemble (${Object.keys(weights).filter((n) => weights[n] > 0).length}-model)`;
    const key = `${target}-${granularity}`;

    if (!dbReady()) {
      return { retrained: false, reason: 'db_unavailable', modelMase: bt.model.mase, gatePassed: bt.gatePassed };
    }

    const prior = await ModelRegistry.findOne({ businessId, key }).sort({ version: -1 }).select('version').lean();
    const challenger = await ModelRegistry.create({
      businessId, key, target, granularity, version: (prior?.version || 0) + 1, modelType,
      backtest: bt.model, baselineMase: bt.seasonalNaive.mase, modelMase: bt.model.mase,
      gatePassed: bt.gatePassed, gateReason: bt.reason, trainWindow: { points: series.length }, status: 'challenger',
    });

    const champion = await this.getChampion(businessId, key);
    const beatsChampion = !champion ||
      (challenger.modelMase != null && (champion.modelMase == null || challenger.modelMase < champion.modelMase));

    let promoted = false; let decision = 'kept_challenger';
    if (bt.gatePassed && beatsChampion) {
      challenger.status = 'champion'; await challenger.save();
      if (champion) { champion.status = 'retired'; await champion.save(); }
      promoted = true;
      decision = champion ? 'promoted_over_champion' : 'promoted_first_champion';
    } else if (!bt.gatePassed) {
      decision = 'rejected_failed_gate';
    }

    try {
      await auditService.log({
        businessId, entityType: 'forecast_model', entityId: challenger._id,
        action: AUDIT_ACTIONS.PROJECTION_REBUILT, performedByName: 'System · forecast retrain',
        afterState: { key, decision, challengerVersion: challenger.version, modelMase: bt.model.mase, championMase: champion?.modelMase ?? null },
      });
    } catch (e) { logger.warn(`[championChallenger] audit failed: ${e.message}`); }

    try {
      businessEvents.emit('forecast.retrained', {
        businessId: String(businessId), entityType: 'forecast_model', entityId: challenger._id, key, decision, promoted,
      });
    } catch { /* non-fatal */ }

    logger.info(`[championChallenger] ${key} retrain: ${decision} (challenger MASE ${bt.model.mase} vs champion ${champion?.modelMase ?? '—'})`);
    return {
      retrained: true, promoted, decision, challengerVersion: challenger.version,
      modelMase: bt.model.mase, championMase: champion?.modelMase ?? null,
      gatePassed: bt.gatePassed, weights,
    };
  }
}

module.exports = new ChampionChallengerService();
