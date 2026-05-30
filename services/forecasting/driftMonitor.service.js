// services/forecasting/driftMonitor.service.js
//
// Forecast Platform — F5. Drift monitor — decides when a model needs retraining.
//
// Combines DATA drift (PSI on a reference vs recent window of the target series)
// with ACCURACY decay (realized error trend from ForecastAccuracy). A 'severe'
// PSI or a material accuracy decay sets shouldRetrain=true; the result is logged
// to ForecastDriftEvent for an auditable retrain rationale.
//
'use strict';
const mongoose = require('mongoose');
const ForecastAccuracy = require('../../models/ForecastAccuracy.model');
const ForecastDriftEvent = require('../../models/ForecastDriftEvent.model');
const drift = require('./drift');
const logger = require('../../config/logger');

const dbReady = () => mongoose.connection && mongoose.connection.readyState === 1;
const METRIC_KEY = { Revenue: 'revenue', Expenses: 'expenses', 'Net Cash Flow': 'profit' };

class DriftMonitorService {
  /**
   * Check a target for data drift + accuracy decay.
   * @returns {{ target, granularity, psi, driftLevel, klDivergence, accuracyDecayPct, decayed, shouldRetrain, points }}
   */
  async checkDrift(businessId, { target = 'Revenue', granularity = 'monthly' } = {}) {
    const lstm = require('./lstmForecastService'); // lazy — avoid require cycle
    const metric = METRIC_KEY[target] || 'revenue';
    const monthly = await lstm.fetchMonthlyData(businessId, 24);
    const series = monthly.map((m) => m[metric]).filter((v) => v != null);

    // ── Data drift: reference (older half) vs recent (newer half) ──
    let psi = null; let kl = null; let driftLevel = 'unknown';
    if (series.length >= 8) {
      const mid = Math.floor(series.length / 2);
      const ref = series.slice(0, mid);
      const rec = series.slice(mid);
      // Adaptive bins — too many bins on a small window makes PSI noisy (sparse
      // histograms manufacture spurious drift). ~3 points/bin, capped at 5.
      const bins = Math.max(2, Math.min(5, Math.floor(Math.min(ref.length, rec.length) / 3)));
      psi = drift.populationStabilityIndex(ref, rec, { bins });
      kl = drift.klDivergence(ref, rec, { bins });
      driftLevel = drift.classifyPSI(psi);
    }

    // ── Accuracy decay: realized pctError trend from ForecastAccuracy ──
    let accuracyDecayPct = null; let decayed = false;
    if (dbReady()) {
      try {
        const rows = await ForecastAccuracy.find({ businessId, target }).sort({ capturedAt: 1 }).select('pctError').lean();
        const errs = rows.map((r) => r.pctError).filter((v) => v != null);
        if (errs.length >= 6) {
          const dr = drift.accuracyDecay(errs, { window: Math.max(2, Math.floor(errs.length / 3)) });
          accuracyDecayPct = dr.decayPct; decayed = dr.decayed;
        }
      } catch (e) { logger.warn(`[driftMonitor] accuracy read failed: ${e.message}`); }
    }

    const shouldRetrain = driftLevel === 'severe' || decayed === true;
    const result = { target, granularity, psi, klDivergence: kl, driftLevel, accuracyDecayPct, decayed, shouldRetrain, points: series.length };

    if (dbReady()) {
      try {
        await ForecastDriftEvent.create({
          businessId, key: `${target}-${granularity}`, target, granularity,
          psi, driftLevel, klDivergence: kl, accuracyDecayPct, decayed, shouldRetrain, points: series.length,
        });
      } catch (e) { logger.warn(`[driftMonitor] drift event write failed: ${e.message}`); }
    }
    return result;
  }
}

module.exports = new DriftMonitorService();
