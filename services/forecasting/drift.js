// services/forecasting/drift.js
//
// Forecast Platform — F5. Drift detection science (pure, no I/O).
//
// Two complementary signals decide when a model must be retrained:
//   1. DATA/CONCEPT DRIFT — Population Stability Index (PSI) + KL divergence
//      between a reference window and a recent window of the series.
//   2. ACCURACY DECAY — the model's realized error (from ForecastAccuracy) has
//      worsened materially vs an earlier window.
// Either crossing its threshold triggers a retrain (see driftMonitor).
//
'use strict';

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const r4 = (v) => Math.round((Number(v) || 0) * 10000) / 10000;

/** Bin a sample into `bins` equal-width buckets over [min,max] → probabilities. */
function histogram(data, min, max, bins) {
  const counts = Array(bins).fill(0);
  const span = max - min || 1;
  for (const v of data) {
    let b = Math.floor(((v - min) / span) * bins);
    if (b < 0) b = 0; if (b >= bins) b = bins - 1;
    counts[b] += 1;
  }
  const n = data.length || 1;
  return counts.map((c) => c / n);
}

/**
 * Population Stability Index between a reference and recent sample.
 * 0 ⇒ identical distribution; grows as they diverge.
 */
function populationStabilityIndex(reference, recent, { bins = 10 } = {}) {
  if (!reference.length || !recent.length) return 0;
  const all = [...reference, ...recent];
  const min = Math.min(...all); const max = Math.max(...all);
  if (max === min) return 0;
  const p = histogram(reference, min, max, bins);
  const q = histogram(recent, min, max, bins);
  const eps = 1e-6;
  let psi = 0;
  for (let i = 0; i < bins; i++) {
    const pi = Math.max(p[i], eps); const qi = Math.max(q[i], eps);
    psi += (qi - pi) * Math.log(qi / pi);
  }
  return r4(psi);
}

/** KL divergence D(ref || recent) over equal-width bins (nats). */
function klDivergence(reference, recent, { bins = 10 } = {}) {
  if (!reference.length || !recent.length) return 0;
  const all = [...reference, ...recent];
  const min = Math.min(...all); const max = Math.max(...all);
  if (max === min) return 0;
  const p = histogram(reference, min, max, bins);
  const q = histogram(recent, min, max, bins);
  const eps = 1e-6;
  let kl = 0;
  for (let i = 0; i < bins; i++) {
    const pi = Math.max(p[i], eps); const qi = Math.max(q[i], eps);
    kl += pi * Math.log(pi / qi);
  }
  return r4(kl);
}

/** Standard PSI severity bands. */
function classifyPSI(psi) {
  if (psi == null) return 'unknown';
  if (psi < 0.1) return 'none';
  if (psi < 0.25) return 'moderate';
  return 'severe';
}

/**
 * Accuracy decay: compares the model's realized error in an earlier window vs a
 * recent window (errors in chronological order). decayPct > threshold ⇒ decayed.
 * @returns {{ decayPct, decayed, baselineError, recentError }}
 */
function accuracyDecay(errorsChrono, { window, threshold = 0.2 } = {}) {
  const errs = (errorsChrono || []).filter((v) => v != null && Number.isFinite(v));
  const w = window || Math.max(2, Math.floor(errs.length / 3));
  if (errs.length < 2 * w) return { decayPct: 0, decayed: false, baselineError: null, recentError: null };
  const baselineError = mean(errs.slice(0, w));
  const recentError = mean(errs.slice(-w));
  const decayPct = baselineError > 0 ? r4((recentError - baselineError) / baselineError) : 0;
  return { decayPct, decayed: decayPct > threshold, baselineError: r4(baselineError), recentError: r4(recentError) };
}

module.exports = { populationStabilityIndex, klDivergence, classifyPSI, accuracyDecay, histogram };
