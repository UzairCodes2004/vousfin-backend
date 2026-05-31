// services/forecasting/governance.service.js
//
// Forecast Platform — F9. MLOps governance: champion model dashboard + automatic
// rollback on realized-accuracy regression.
//
// A champion is registered with a backtest promise (its expected error). As real
// forecasts elapse, ForecastAccuracy records the *realized* error. If realized
// error materially exceeds the promise, the model is silently underperforming in
// production — so we ROLL BACK: restore the best prior gated version, or, if none
// exists, retrain a fresh champion. Every decision is versioned + audited.
//
'use strict';
const mongoose = require('mongoose');
const ModelRegistry = require('../../models/ModelRegistry.model');
const ForecastAccuracy = require('../../models/ForecastAccuracy.model');
const ForecastDriftEvent = require('../../models/ForecastDriftEvent.model');
const accuracyScore = require('./accuracyScore.service');
const auditService = require('../audit.service');
const logger = require('../../config/logger');
const { AUDIT_ACTIONS } = require('../../config/constants');

const dbReady = () => mongoose.connection && mongoose.connection.readyState === 1;
const oid = (id) => new mongoose.Types.ObjectId(id);
const TARGETS = ['Revenue', 'Expenses', 'Net Cash Flow'];

class GovernanceService {
  /**
   * Pure rollback decision. Roll back when realized MAPE is finite, above a floor,
   * AND exceeds the champion's promised (backtest) error by `factor`.
   */
  shouldRollback(realizedMape, backtestMape, { factor = 1.5, floor = 15 } = {}) {
    if (realizedMape == null || !Number.isFinite(realizedMape)) return { rollback: false, reason: 'no_realized' };
    if (realizedMape <= floor) return { rollback: false, reason: 'within_tolerance' };
    const ref = (backtestMape != null && backtestMape > 0) ? backtestMape : floor;
    if (realizedMape > ref * factor) return { rollback: true, reason: 'accuracy_regression' };
    return { rollback: false, reason: 'within_tolerance' };
  }

  /** Per-target model-health overview: champion, measured accuracy, drift. */
  async championDashboard(businessId, targets = TARGETS, granularity = 'monthly') {
    const out = [];
    for (const target of targets) {
      const key = `${target}-${granularity}`;
      const [champion, drift, acc] = await Promise.all([
        dbReady() ? ModelRegistry.findOne({ businessId, key, status: 'champion' }).sort({ version: -1 }).lean() : null,
        dbReady() ? ForecastDriftEvent.findOne({ businessId, key }).sort({ checkedAt: -1 }).lean() : null,
        accuracyScore.score(businessId, target, granularity).catch(() => null),
      ]);
      out.push({
        target,
        champion: champion ? { version: champion.version, modelType: champion.modelType, modelMase: champion.modelMase, gatePassed: champion.gatePassed } : null,
        accuracy: acc ? { accuracyPct: acc.accuracyPct, confidence: acc.confidence, label: acc.label } : null,
        drift: drift ? { level: drift.driftLevel, shouldRetrain: drift.shouldRetrain, checkedAt: drift.checkedAt } : null,
      });
    }
    return out;
  }

  /** Evaluate + (if needed) execute an automatic rollback for one target. */
  async autoRollback(businessId, target = 'Revenue', granularity = 'monthly') {
    if (!dbReady()) return { rolledBack: false, reason: 'db_unavailable' };
    const key = `${target}-${granularity}`;
    const champion = await ModelRegistry.findOne({ businessId, key, status: 'champion' }).sort({ version: -1 });
    if (!champion) return { rolledBack: false, reason: 'no_champion' };

    const accRows = await ForecastAccuracy.aggregate([
      { $match: { businessId: oid(businessId), target } },
      { $group: { _id: null, mape: { $avg: '$pctError' }, points: { $sum: 1 } } },
    ]);
    const realizedMape = accRows[0]?.mape;
    const points = accRows[0]?.points || 0;
    const backtestMape = champion.backtest?.mape ?? null;
    if (points < 4 || realizedMape == null) return { rolledBack: false, reason: 'insufficient_realized', points };

    const decision = this.shouldRollback(realizedMape, backtestMape);
    if (!decision.rollback) return { rolledBack: false, reason: decision.reason, realizedMape, backtestMape };

    // Prefer restoring the best prior gated version; else retrain fresh.
    const prior = await ModelRegistry.findOne({
      businessId, key, status: 'retired', gatePassed: true, version: { $lt: champion.version },
    }).sort({ modelMase: 1 });

    champion.status = 'retired';
    champion.gateReason = 'rolled_back_accuracy_regression';
    await champion.save();

    let result;
    if (prior) {
      prior.status = 'champion';
      prior.gateReason = 'restored_by_rollback';
      await prior.save();
      result = { rolledBack: true, action: 'restored_prior', from: champion.version, to: prior.version, realizedMape, backtestMape };
    } else {
      const championChallenger = require('./championChallenger.service');
      const r = await championChallenger.retrain(businessId, { target, granularity });
      result = { rolledBack: true, action: 'retrained', from: champion.version, retrain: r, realizedMape, backtestMape };
    }

    try {
      await auditService.log({
        businessId, entityType: 'forecast_model', entityId: champion._id,
        action: AUDIT_ACTIONS.PROJECTION_REBUILT, performedByName: 'System · auto-rollback',
        afterState: result,
      });
    } catch (e) { logger.warn(`[governance] rollback audit failed: ${e.message}`); }
    logger.info(`[governance] ${key} auto-rollback: ${result.action} (realized MAPE ${realizedMape} vs backtest ${backtestMape})`);
    return result;
  }

  /** Sweep all targets for a tenant (called by the retrain job). */
  async runRollbackSweep(businessId, { targets = TARGETS } = {}) {
    const stats = { checked: 0, rolledBack: 0 };
    for (const target of targets) {
      try {
        const r = await this.autoRollback(businessId, target);
        stats.checked += 1;
        if (r.rolledBack) stats.rolledBack += 1;
      } catch (e) { logger.warn(`[governance] rollback sweep ${target} failed: ${e.message}`); }
    }
    return stats;
  }
}

module.exports = new GovernanceService();
