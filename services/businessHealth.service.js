/**
 * Business Health Service — H1
 *
 * A real, auditable, server-side Business Health Score.
 *
 * Replaces the previous client-side heuristic (which hard-coded the tax score to
 * 82 and derived burn rate as `expenses / month-number`). Every sub-score here is
 * computed from the business's actual ledger via the existing report services, so
 * the result is reproducible and explainable:
 *
 *   • Liquidity     — current ratio + cash runway (real trailing burn)
 *   • Profitability — net margin + margin trend
 *   • Efficiency    — DSO (days sales outstanding) + overdue-AR ratio
 *   • Leverage      — debt-to-equity (solvency)
 *   • Tax           — real unremitted/overdue tax (only when tax is enabled)
 *
 * Honest gating: the overall score is a weighted average over ONLY the sub-scores
 * we can actually compute, and the whole result carries a data-sufficiency
 * confidence (insufficient / low / medium / high) driven by months of history.
 *
 * The scoring functions are PURE (numbers in → {score, drivers} out) so they are
 * unit-testable without a database. `getHealthScore` is the DB orchestrator.
 */
'use strict';

const reportService = require('./report.service');

/* ════════════════════════════════════════════════════════════════════════════
   PURE SCORING HELPERS  (no I/O — unit tested directly)
════════════════════════════════════════════════════════════════════════════ */

const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const round = (v, d = 0) => {
  const p = 10 ** d;
  return Math.round((Number(v) || 0) * p) / p;
};

/** Map cash runway (months) to a 0–100 sub-component. */
function runwayPoints(runwayMonths) {
  if (!Number.isFinite(runwayMonths)) return null;
  if (runwayMonths >= 6) return 100;
  if (runwayMonths >= 3) return 80;
  if (runwayMonths >= 2) return 62;
  if (runwayMonths >= 1) return 42;
  return clamp(Math.round(runwayMonths * 36), 6, 42);
}

/** Map current ratio (current assets / current liabilities) to a 0–100 component. */
function currentRatioPoints(currentRatio) {
  if (!Number.isFinite(currentRatio)) return null;
  if (currentRatio >= 2) return 100;
  if (currentRatio >= 1.5) return 85;
  if (currentRatio >= 1) return 65;
  if (currentRatio >= 0.75) return 45;
  return clamp(Math.round(currentRatio * 50), 8, 45);
}

/**
 * Liquidity sub-score.
 * @param {{currentRatio?:number, runwayMonths?:number}} m
 */
function scoreLiquidity({ currentRatio, runwayMonths } = {}) {
  const parts = [];
  const drivers = [];

  const crP = currentRatioPoints(currentRatio);
  if (crP !== null) {
    parts.push(crP);
    drivers.push(
      currentRatio >= 1.5 ? `Current ratio ${round(currentRatio, 2)} — current assets comfortably cover short-term liabilities.`
      : currentRatio >= 1 ? `Current ratio ${round(currentRatio, 2)} — assets cover liabilities but with little buffer.`
      : `Current ratio ${round(currentRatio, 2)} — short-term liabilities exceed current assets.`
    );
  }

  const rwP = runwayPoints(runwayMonths);
  if (rwP !== null) {
    parts.push(rwP);
    const rw = runwayMonths >= 99 ? '6+' : round(runwayMonths, 1);
    drivers.push(
      runwayMonths >= 3 ? `Cash runway ~${rw} months — healthy buffer at the current burn rate.`
      : runwayMonths >= 1 ? `Cash runway ~${rw} months — monitor cash closely.`
      : `Cash runway under 1 month — immediate cash attention required.`
    );
  }

  if (parts.length === 0) return null;
  const score = clamp(Math.round(parts.reduce((a, b) => a + b, 0) / parts.length));
  return { score, level: levelOf(score), drivers };
}

/**
 * Profitability sub-score from net margin (%) and recent trend (% pts/month).
 * @param {{netMarginPct?:number, marginTrendPct?:number}} m
 */
function scoreProfitability({ netMarginPct, marginTrendPct } = {}) {
  if (!Number.isFinite(netMarginPct)) return null;
  let base =
    netMarginPct >= 25 ? 95 :
    netMarginPct >= 15 ? 82 :
    netMarginPct >= 8  ? 68 :
    netMarginPct >= 3  ? 58 :
    netMarginPct >= 0  ? 50 :
    clamp(Math.round(50 + netMarginPct * 1.5), 8, 50);

  const drivers = [
    netMarginPct >= 0
      ? `Net profit margin ${round(netMarginPct, 1)}%.`
      : `Operating at a loss (net margin ${round(netMarginPct, 1)}%).`,
  ];

  if (Number.isFinite(marginTrendPct) && Math.abs(marginTrendPct) >= 0.5) {
    const adj = clamp(marginTrendPct * 1.5, -8, 8);
    base = clamp(base + adj);
    drivers.push(
      marginTrendPct > 0
        ? `Margin improving (+${round(marginTrendPct, 1)} pts/mo recently).`
        : `Margin declining (${round(marginTrendPct, 1)} pts/mo recently).`
    );
  }

  const score = clamp(Math.round(base));
  return { score, level: levelOf(score), drivers };
}

/**
 * Efficiency sub-score from DSO (days) and overdue-AR ratio (0–1).
 * @param {{dso?:number, overdueRatio?:number}} m
 */
function scoreEfficiency({ dso, overdueRatio } = {}) {
  const drivers = [];
  let base = null;

  if (Number.isFinite(dso)) {
    base =
      dso <= 30 ? 92 :
      dso <= 45 ? 80 :
      dso <= 60 ? 66 :
      dso <= 90 ? 50 : 35;
    drivers.push(`Customers take ~${Math.round(dso)} days to pay (DSO).`);
  }

  if (Number.isFinite(overdueRatio)) {
    const penalty = clamp(Math.round(overdueRatio * 40), 0, 40);
    base = base === null ? clamp(85 - penalty) : clamp(base - penalty * 0.5);
    if (overdueRatio > 0.01) {
      drivers.push(`${round(overdueRatio * 100, 0)}% of receivables are overdue.`);
    } else {
      drivers.push('No material overdue receivables.');
    }
  }

  if (base === null) return null;
  const score = clamp(Math.round(base));
  return { score, level: levelOf(score), drivers };
}

/**
 * Leverage / solvency sub-score from debt-to-equity.
 * @param {{debtToEquity?:number, equityPositive?:boolean}} m
 */
function scoreLeverage({ debtToEquity, equityPositive = true } = {}) {
  if (equityPositive === false) {
    return { score: 20, level: 'poor', drivers: ['Negative equity — liabilities exceed assets (technically insolvent).'] };
  }
  if (!Number.isFinite(debtToEquity)) return null;
  const score =
    debtToEquity <= 0.5 ? 92 :
    debtToEquity <= 1   ? 80 :
    debtToEquity <= 2   ? 64 :
    debtToEquity <= 3   ? 48 : 30;
  const drivers = [
    debtToEquity <= 1
      ? `Debt-to-equity ${round(debtToEquity, 2)} — conservative leverage.`
      : `Debt-to-equity ${round(debtToEquity, 2)} — elevated leverage; debt is high relative to equity.`,
  ];
  return { score, level: levelOf(score), drivers };
}

/**
 * Tax-compliance sub-score. Returns null when tax is not enabled (excluded from
 * the overall score rather than faked).
 * @param {{enabled?:boolean, overdueTax?:number, accruingTax?:number}} m
 */
function scoreTax({ enabled, overdueTax = 0, accruingTax = 0 } = {}) {
  if (!enabled) return null;
  if (overdueTax > 0) {
    const score = clamp(60 - Math.min(40, Math.round(overdueTax > 0 ? 25 : 0)));
    return { score, level: levelOf(score), drivers: [`Overdue/unremitted tax outstanding (${round(overdueTax, 0)}).`] };
  }
  if (accruingTax > 0) {
    return { score: 80, level: 'good', drivers: ['Tax is accruing and current — remit before the filing deadline.'] };
  }
  return { score: 90, level: 'excellent', drivers: ['No overdue tax detected.'] };
}

function levelOf(score) {
  return score >= 80 ? 'excellent' : score >= 65 ? 'good' : score >= 50 ? 'fair' : 'poor';
}

/* Weights for the overall blend (renormalised over whatever is available). */
const WEIGHTS = { liquidity: 0.30, profitability: 0.25, efficiency: 0.20, leverage: 0.15, tax: 0.10 };

/**
 * Combine the available sub-scores into one overall 0–100 score, renormalising
 * weights over only the categories that were actually computed (honest gating).
 * @param {Record<string, {score:number}|null>} subScores
 */
function combineOverall(subScores) {
  let wSum = 0;
  let acc = 0;
  for (const [key, sub] of Object.entries(subScores)) {
    if (!sub || !Number.isFinite(sub.score)) continue;
    const w = WEIGHTS[key] || 0;
    acc += sub.score * w;
    wSum += w;
  }
  if (wSum === 0) return null;
  return clamp(Math.round(acc / wSum));
}

/* ════════════════════════════════════════════════════════════════════════════
   DB ORCHESTRATOR
════════════════════════════════════════════════════════════════════════════ */

const sumGroups = (groups, predicate) =>
  (groups || []).filter(predicate).reduce((s, g) => s + Math.abs(g.total || 0), 0);

/**
 * Compute the full Business Health Score for a business.
 * @param {string} businessId
 * @param {{asOfDate?:Date}} [opts]
 */
async function getHealthScore(businessId, opts = {}) {
  if (!businessId) {
    const err = new Error('Business ID is required');
    err.statusCode = 400;
    throw err;
  }
  const lstm = require('./forecasting/lstmForecastService'); // lazy — avoid cycle

  const asOf = opts.asOfDate ? new Date(opts.asOfDate) : new Date();
  const periodStart = new Date(asOf);
  periodStart.setMonth(periodStart.getMonth() - 12);

  const [balanceSheet, kpis, arAging, monthly] = await Promise.allSettled([
    reportService.getBalanceSheet(businessId, asOf),
    reportService.getKPISummary(businessId, periodStart, asOf),
    reportService.getAgingReport(businessId, 'receivable'),
    lstm.fetchMonthlyData(businessId, 12),
  ]).then((r) => r.map((x) => (x.status === 'fulfilled' ? x.value : null)));

  const months = Array.isArray(monthly) ? monthly : [];
  const nonZeroMonths = months.filter((m) => (m.revenue || 0) > 0 || (m.expenses || 0) > 0).length;

  // ── Data sufficiency / confidence ────────────────────────────────────────
  const hasBalanceSheet = !!balanceSheet && (balanceSheet.totalAssets || 0) > 0;
  if (nonZeroMonths === 0 && !hasBalanceSheet) {
    return {
      insufficient: true,
      confidence: 'insufficient',
      message: 'Not enough financial activity yet to score business health. Record a few transactions to unlock this.',
      asOfDate: asOf.toISOString(),
      generatedAt: new Date().toISOString(),
    };
  }
  const confidence =
    nonZeroMonths >= 6 ? 'high' :
    nonZeroMonths >= 3 ? 'medium' :
    'low';

  // ── Liquidity inputs ─────────────────────────────────────────────────────
  let currentRatio;
  let runwayMonths;
  if (balanceSheet) {
    const assetGroups = balanceSheet.assets?.groups || [];
    const liabGroups = balanceSheet.liabilities?.groups || [];
    const currentAssets = sumGroups(assetGroups, (g) =>
      ['Current Assets', 'Bank and Cash'].includes(g.label));
    const currentLiabilities = sumGroups(liabGroups, (g) => g.label === 'Current Liabilities');
    if (currentLiabilities > 0) currentRatio = currentAssets / currentLiabilities;
  }
  // Real burn = trailing-3-month average expense (NOT expenses / month-number).
  const recent = months.slice(-3);
  const avgBurn = recent.length
    ? recent.reduce((s, m) => s + (m.expenses || 0), 0) / recent.length
    : 0;
  const cashBalance = kpis?.cashBalance ?? 0;
  if (avgBurn > 0) runwayMonths = cashBalance / avgBurn;
  else if (cashBalance > 0) runwayMonths = 99; // cash but no burn

  // ── Profitability inputs ─────────────────────────────────────────────────
  const netMarginPct = Number.isFinite(kpis?.profitMargin) ? kpis.profitMargin : undefined;
  const marginTrendPct = marginTrend(months);

  // ── Efficiency inputs ────────────────────────────────────────────────────
  let dso;
  let overdueRatio;
  if (arAging && typeof arAging.grandTotal === 'number' && arAging.grandTotal > 0) {
    overdueRatio = (arAging.overdueTotal || 0) / arAging.grandTotal;
    // DSO ≈ outstanding AR / avg daily revenue (trailing 3 months)
    const avgMonthlyRev = recent.length
      ? recent.reduce((s, m) => s + (m.revenue || 0), 0) / recent.length
      : 0;
    if (avgMonthlyRev > 0) dso = (arAging.grandTotal / avgMonthlyRev) * 30;
  } else if (arAging) {
    overdueRatio = 0; // AR exists path but nothing outstanding → clean
  }

  // ── Leverage inputs ──────────────────────────────────────────────────────
  let debtToEquity;
  let equityPositive = true;
  if (balanceSheet) {
    const totalLiab = Math.abs(balanceSheet.totalLiabilities || 0);
    const totalEquity = balanceSheet.totalEquity || 0;
    equityPositive = totalEquity > 0;
    if (totalEquity > 0) debtToEquity = totalLiab / totalEquity;
  }

  // ── Tax inputs (real, gated) ─────────────────────────────────────────────
  const taxInputs = await taxComplianceInputs(businessId, periodStart, asOf);

  // ── Score ────────────────────────────────────────────────────────────────
  const subScores = {
    liquidity:     scoreLiquidity({ currentRatio, runwayMonths }),
    profitability: scoreProfitability({ netMarginPct, marginTrendPct }),
    efficiency:    scoreEfficiency({ dso, overdueRatio }),
    leverage:      scoreLeverage({ debtToEquity, equityPositive }),
    tax:           scoreTax(taxInputs),
  };
  const overall = combineOverall(subScores);

  return {
    insufficient: false,
    overall,
    level: overall != null ? levelOf(overall) : null,
    confidence,
    monthsOfData: nonZeroMonths,
    categories: subScores,
    metrics: {
      currentRatio: round(currentRatio, 2),
      runwayMonths: runwayMonths >= 99 ? null : round(runwayMonths, 1),
      netMarginPct: round(netMarginPct, 1),
      marginTrendPct: round(marginTrendPct, 2),
      dso: dso != null ? Math.round(dso) : null,
      overdueArPct: overdueRatio != null ? round(overdueRatio * 100, 0) : null,
      debtToEquity: round(debtToEquity, 2),
      monthlyBurn: round(avgBurn, 0),
      cashBalance: round(cashBalance, 0),
    },
    asOfDate: asOf.toISOString(),
    generatedAt: new Date().toISOString(),
  };
}

/** Recent margin trend in percentage-points per month (simple slope over last 4). */
function marginTrend(months) {
  const pts = (months || [])
    .filter((m) => (m.revenue || 0) > 0)
    .slice(-4)
    .map((m) => ((m.revenue - m.expenses) / m.revenue) * 100);
  if (pts.length < 2) return undefined;
  // average consecutive delta
  let sum = 0;
  for (let i = 1; i < pts.length; i++) sum += pts[i] - pts[i - 1];
  return sum / (pts.length - 1);
}

/**
 * Pull real tax-compliance signals. Returns { enabled:false } when tax isn't on,
 * so the tax sub-score is cleanly excluded instead of faked.
 */
async function taxComplianceInputs(businessId, startDate, endDate) {
  try {
    const summary = await reportService.getTaxSummary(businessId, startDate, endDate);
    if (!summary) return { enabled: false };
    const taxActivity = (Number(summary.totalOutputTax) || 0) + (Number(summary.totalInputTax) || 0);
    if (taxActivity <= 0) return { enabled: false }; // business doesn't record tax → exclude
    // getTaxSummary carries no due-date, so we CANNOT label anything "overdue".
    // A positive net liability is tax currently accruing (payable), not overdue.
    const netPayable = Math.max(0, Number(summary.netTaxLiability) || 0);
    return { enabled: true, overdueTax: 0, accruingTax: netPayable };
  } catch (_e) {
    return { enabled: false };
  }
}

module.exports = {
  getHealthScore,
  // pure helpers exported for unit tests
  _pure: {
    scoreLiquidity, scoreProfitability, scoreEfficiency, scoreLeverage, scoreTax,
    combineOverall, runwayPoints, currentRatioPoints, levelOf, marginTrend,
  },
};
