/**
 * tests/unit/services/forecasting.drift.test.js
 *
 * Forecast Platform — F5. Drift science: PSI, KL, severity bands, accuracy decay.
 */
'use strict';
const d = require('../../../services/forecasting/drift');

describe('population stability index', () => {
  it('is ~0 for identical distributions', () => {
    const ref = [10, 12, 11, 13, 12, 14, 11, 13, 12, 10];
    expect(d.populationStabilityIndex(ref, ref.slice(), { bins: 5 })).toBeLessThan(0.05);
  });
  it('is large for a clearly shifted distribution', () => {
    const ref = [10, 11, 12, 13, 14, 10, 11, 12];
    const rec = [40, 41, 42, 43, 44, 40, 41, 42];
    expect(d.populationStabilityIndex(ref, rec, { bins: 5 })).toBeGreaterThan(0.25);
  });
});

describe('classifyPSI bands', () => {
  it('maps to none / moderate / severe', () => {
    expect(d.classifyPSI(0.05)).toBe('none');
    expect(d.classifyPSI(0.15)).toBe('moderate');
    expect(d.classifyPSI(0.40)).toBe('severe');
  });
});

describe('KL divergence', () => {
  it('is ~0 for identical and positive for divergent', () => {
    const ref = [1, 2, 3, 4, 5, 1, 2, 3];
    expect(d.klDivergence(ref, ref.slice(), { bins: 4 })).toBeLessThan(0.05);
    expect(d.klDivergence(ref, [20, 21, 22, 23, 24, 20, 21, 22], { bins: 4 })).toBeGreaterThan(0.5);
  });
});

describe('accuracy decay', () => {
  it('flags decay when recent error is materially worse than the baseline window', () => {
    const errs = [5, 6, 5, 6, 20, 22, 21, 23]; // earlier ~5.5%, recent ~21.5%
    const r = d.accuracyDecay(errs, { window: 3, threshold: 0.2 });
    expect(r.decayed).toBe(true);
    expect(r.decayPct).toBeGreaterThan(0.2);
  });
  it('does not flag a stable error series', () => {
    const errs = [10, 11, 9, 10, 11, 9, 10, 11];
    expect(d.accuracyDecay(errs, { window: 3 }).decayed).toBe(false);
  });
  it('is safe on too-few points', () => {
    expect(d.accuracyDecay([5, 6], { window: 3 }).decayed).toBe(false);
  });
});
