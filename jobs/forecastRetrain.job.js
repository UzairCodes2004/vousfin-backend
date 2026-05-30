// jobs/forecastRetrain.job.js
//
// Forecast Platform — F5. Scheduled + drift-triggered incremental retraining.
//
// Weekly: for every business that has produced forecasts recently, check drift
// per target and retrain (champion/challenger) when drift/decay warrants it — or
// on the weekly cadence regardless, so weights track the latest data. Errors on
// one tenant/target never abort the batch.
//
'use strict';
const ForecastRun = require('../models/ForecastRun.model');
const driftMonitor = require('../services/forecasting/driftMonitor.service');
const championChallenger = require('../services/forecasting/championChallenger.service');
const logger = require('../config/logger');

const TARGETS = ['Revenue', 'Expenses', 'Net Cash Flow'];

async function runRetrainSweep({ force = false } = {}) {
  const since = new Date(); since.setDate(since.getDate() - 60);
  const businessIds = await ForecastRun.distinct('businessId', { generatedAt: { $gte: since } });

  const stats = { businesses: businessIds.length, checked: 0, retrained: 0, promoted: 0 };
  for (const businessId of businessIds) {
    for (const target of TARGETS) {
      try {
        const drift = await driftMonitor.checkDrift(businessId, { target });
        stats.checked++;
        if (force || drift.shouldRetrain) {
          const res = await championChallenger.retrain(businessId, { target });
          if (res.retrained) stats.retrained++;
          if (res.promoted) stats.promoted++;
        }
      } catch (err) {
        logger.warn(`[forecastRetrain] ${businessId}/${target} failed: ${err.message}`);
      }
    }
  }
  logger.info(`[forecastRetrain] sweep: ${stats.retrained} retrained · ${stats.promoted} promoted across ${stats.businesses} businesses`);
  return stats;
}

function scheduleForecastRetrain() {
  const cron = require('node-cron');
  // Weekly, Monday 03:00 — drift check + retrain (weekly cadence forces a refit).
  cron.schedule('0 3 * * 1', async () => {
    try { const r = await runRetrainSweep({ force: true }); logger.info(`[cron] forecast retrain: ${r.promoted} promoted`); }
    catch (err) { logger.error(`[cron] forecastRetrain error: ${err.message}`); }
  });
  logger.info('⏰ Forecast retrain job scheduled (weekly Mon 03:00)');
}

module.exports = { runRetrainSweep, scheduleForecastRetrain };
