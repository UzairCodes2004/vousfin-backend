/**
 * tests/unit/services/businessHealth.service.test.js
 *
 * H1 — Business Health Score. Tests the PURE scoring helpers: monotonicity,
 * honest gating (null when uncomputable), and the renormalised overall blend.
 */
'use strict';

const { _pure } = require('../../../services/businessHealth.service');
const {
  scoreLiquidity, scoreProfitability, scoreEfficiency, scoreLeverage, scoreTax,
  combineOverall, runwayPoints, currentRatioPoints, levelOf, marginTrend,
} = _pure;

describe('runwayPoints / currentRatioPoints', () => {
  it('runway is monotonic non-decreasing in months', () => {
    const xs = [0, 0.5, 1, 2, 3, 6, 12].map(runwayPoints);
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThanOrEqual(xs[i - 1]);
  });
  it('current ratio is monotonic non-decreasing', () => {
    const xs = [0.2, 0.75, 1, 1.5, 2, 4].map(currentRatioPoints);
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThanOrEqual(xs[i - 1]);
  });
  it('returns null for non-finite input (honest gating)', () => {
    expect(runwayPoints(undefined)).toBeNull();
    expect(currentRatioPoints(NaN)).toBeNull();
  });
});

describe('scoreLiquidity', () => {
  it('strong liquidity scores high', () => {
    const r = scoreLiquidity({ currentRatio: 2.5, runwayMonths: 8 });
    expect(r.score).toBeGreaterThanOrEqual(90);
    expect(r.level).toBe('excellent');
    expect(r.drivers.length).toBe(2);
  });
  it('weak liquidity scores low', () => {
    const r = scoreLiquidity({ currentRatio: 0.6, runwayMonths: 0.4 });
    expect(r.score).toBeLessThan(50);
    expect(r.level).toBe('poor');
  });
  it('works with only one input present', () => {
    expect(scoreLiquidity({ runwayMonths: 6 }).drivers.length).toBe(1);
    expect(scoreLiquidity({ currentRatio: 2 }).drivers.length).toBe(1);
  });
  it('returns null when nothing is computable', () => {
    expect(scoreLiquidity({})).toBeNull();
  });
});

describe('scoreProfitability', () => {
  it('high margin → high score', () => {
    expect(scoreProfitability({ netMarginPct: 30 }).score).toBeGreaterThanOrEqual(90);
  });
  it('loss → low score', () => {
    expect(scoreProfitability({ netMarginPct: -20 }).score).toBeLessThan(50);
  });
  it('declining trend lowers score vs improving trend', () => {
    const up = scoreProfitability({ netMarginPct: 10, marginTrendPct: 4 }).score;
    const down = scoreProfitability({ netMarginPct: 10, marginTrendPct: -4 }).score;
    expect(up).toBeGreaterThan(down);
  });
  it('returns null without a margin', () => {
    expect(scoreProfitability({})).toBeNull();
  });
});

describe('scoreEfficiency', () => {
  it('fast collection + no overdue scores high', () => {
    expect(scoreEfficiency({ dso: 20, overdueRatio: 0 }).score).toBeGreaterThanOrEqual(85);
  });
  it('slow collection + heavy overdue scores low', () => {
    expect(scoreEfficiency({ dso: 120, overdueRatio: 0.6 }).score).toBeLessThan(50);
  });
  it('null when neither input present', () => {
    expect(scoreEfficiency({})).toBeNull();
  });
});

describe('scoreLeverage', () => {
  it('low debt scores high', () => {
    expect(scoreLeverage({ debtToEquity: 0.3 }).score).toBeGreaterThanOrEqual(90);
  });
  it('negative equity is treated as near-insolvent', () => {
    const r = scoreLeverage({ equityPositive: false });
    expect(r.score).toBeLessThanOrEqual(25);
    expect(r.drivers[0]).toMatch(/insolvent|negative equity/i);
  });
  it('null without debt-to-equity (and positive equity)', () => {
    expect(scoreLeverage({ equityPositive: true })).toBeNull();
  });
});

describe('scoreTax (honest gating)', () => {
  it('excluded (null) when tax not enabled — never faked', () => {
    expect(scoreTax({ enabled: false })).toBeNull();
    expect(scoreTax(undefined)).toBeNull();
  });
  it('clean tax scores high', () => {
    expect(scoreTax({ enabled: true, overdueTax: 0, accruingTax: 0 }).score).toBeGreaterThanOrEqual(85);
  });
  it('accruing-but-current scores moderate', () => {
    const r = scoreTax({ enabled: true, overdueTax: 0, accruingTax: 5000 });
    expect(r.score).toBe(80);
  });
});

describe('combineOverall (renormalised, honest gating)', () => {
  it('returns null when no sub-scores are available', () => {
    expect(combineOverall({ liquidity: null, tax: null })).toBeNull();
  });
  it('ignores missing categories and weights the rest', () => {
    const overall = combineOverall({
      liquidity: { score: 80 },
      profitability: { score: 60 },
      efficiency: null,
      leverage: null,
      tax: null,
    });
    // weighted by 0.30 and 0.25, renormalised → (80*.3 + 60*.25)/(.55)
    expect(overall).toBe(Math.round((80 * 0.3 + 60 * 0.25) / 0.55));
  });
  it('a uniformly strong business scores high overall', () => {
    const overall = combineOverall({
      liquidity: { score: 90 }, profitability: { score: 88 },
      efficiency: { score: 85 }, leverage: { score: 90 }, tax: { score: 90 },
    });
    expect(overall).toBeGreaterThanOrEqual(85);
  });
});

describe('levelOf / marginTrend', () => {
  it('levelOf thresholds', () => {
    expect(levelOf(85)).toBe('excellent');
    expect(levelOf(70)).toBe('good');
    expect(levelOf(55)).toBe('fair');
    expect(levelOf(40)).toBe('poor');
  });
  it('marginTrend detects improvement', () => {
    const months = [
      { revenue: 100, expenses: 90 }, // 10%
      { revenue: 100, expenses: 80 }, // 20%
      { revenue: 100, expenses: 70 }, // 30%
    ];
    expect(marginTrend(months)).toBeGreaterThan(0);
  });
  it('marginTrend undefined with <2 revenue months', () => {
    expect(marginTrend([{ revenue: 0, expenses: 5 }])).toBeUndefined();
  });
});
