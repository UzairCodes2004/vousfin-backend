// jobs/forecastAccuracy.job.js
//
// Forecast Platform — F3. EX-POST ACCURACY CAPTURE.
//
// For each persisted ForecastRun whose forecasted months have now elapsed,
// fetch the realized monthly actuals and record predicted-vs-actual per horizon
// step (ForecastAccuracy). Idempotent: already-captured steps are skipped.
// Runs daily; also callable on demand from the API.
//
'use strict';
const ForecastRun = require('../models/ForecastRun.model');
const forecastStore = require('../services/forecasting/forecastStore.service');
const lstm = require('../services/forecasting/lstmForecastService');
const logger = require('../config/logger');

const METRIC_KEY = { Revenue: 'revenue', Expenses: 'expenses', 'Net Cash Flow': 'profit' };

function monthKey(date) {
  const d = new Date(date);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Capture realized accuracy for monthly runs older than one month. */
async function runAccuracyCapture() {
  const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - 1);
  const runs = await ForecastRun.find({
    granularity: 'monthly', generatedAt: { $lte: cutoff },
  }).sort({ generatedAt: -1 }).limit(2000);

  // Cache realized monthly actuals per business so we fetch once.
  const actualsCache = new Map();
  let processed = 0; let capturedTotal = 0;

  for (const run of runs) {
    processed++;
    const metric = METRIC_KEY[run.target] || 'revenue';
    const bizKey = String(run.businessId);
    if (!actualsCache.has(bizKey)) {
      try {
        const monthly = await lstm.fetchMonthlyData(run.businessId, 36);
        const map = {};
        for (const m of monthly) map[m.monthKey] = m;
        actualsCache.set(bizKey, map);
      } catch { actualsCache.set(bizKey, {}); }
    }
    const actualsByMonth = actualsCache.get(bizKey);

    // Map each horizon step to the month it forecast (generation month + step).
    const gen = new Date(run.generatedAt);
    const actualByStep = {};
    const now = Date.now();
    for (let step = 1; step <= (run.predicted || []).length; step++) {
      const target = new Date(Date.UTC(gen.getUTCFullYear(), gen.getUTCMonth() + step, 1));
      const endOfTarget = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 1));
      if (endOfTarget.getTime() > now) break;          // period not yet fully elapsed
      const mk = monthKey(target);
      const actual = actualsByMonth[mk] ? actualsByMonth[mk][metric] : null;
      if (actual != null) actualByStep[step] = Math.round(actual);
    }
    if (Object.keys(actualByStep).length) {
      capturedTotal += await forecastStore.captureAccuracy(run.businessId, run, actualByStep);
    }
  }
  logger.info(`[forecastAccuracy] processed ${processed} runs · captured ${capturedTotal} realized points`);
  return { processed, captured: capturedTotal };
}

function scheduleForecastAccuracy() {
  const cron = require('node-cron');
  // Daily at 09:00 — capture realized actuals for elapsed forecasts.
  cron.schedule('0 9 * * *', async () => {
    try { const r = await runAccuracyCapture(); logger.info(`[cron] forecast accuracy capture: ${r.captured} points`); }
    catch (err) { logger.error(`[cron] forecastAccuracy error: ${err.message}`); }
  });
  logger.info('⏰ Forecast accuracy capture job scheduled (daily 09:00)');
}

module.exports = { runAccuracyCapture, scheduleForecastAccuracy };
