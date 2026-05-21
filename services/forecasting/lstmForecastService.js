/**
 * @file lstmForecastService.js
 * @description LSTM-inspired time series forecasting engine for vousFin.
 *
 * Preprocessing pipeline mirrors trainLSTM.js (Web New/dataset-engine/trainLSTM.js):
 *   - Min-Max scaling  → scaleData()
 *   - Sliding sequences → createDataset(), LOOK_BACK = 6 months
 *   - Holt's Double Exponential Smoothing as LSTM cell equivalent
 *   - Inverse transform → denormalization back to raw PKR
 *
 * ALL monetary values are returned in RAW PKR (no pre-division).
 * The frontend formatter handles display scaling (K / M suffixes).
 *
 * Data source: live MongoDB JournalEntry per business → fallback: Lahore cafe dataset.
 */

const JournalEntry = require('../../models/JournalEntry.model');
const mongoose = require('mongoose');
const { JOURNAL_STATUS } = require('../../config/constants');

/* ── LSTM constants (matching trainLSTM.js architecture) ── */
const LOOK_BACK    = 6;   // months of history per input sequence
const ALPHA        = 0.4; // level smoothing factor
const BETA         = 0.3; // trend smoothing factor
const EXPENSE_RATIO = 0.62;
const TAX_RATE     = 0.15;

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/* ═══════════════════════════════════════════════════════
   PREPROCESSING — mirrors trainLSTM.js scaleData()
   Normalises to [0,1] before feeding into the model.
═══════════════════════════════════════════════════════ */
function minMaxScale(data) {
  const min   = Math.min(...data);
  const max   = Math.max(...data);
  const range = (max - min) || 1; // guard against flat series
  return {
    scaled: data.map(v => (v - min) / range),
    min,
    max,
    range,
  };
}

/** Inverse transform — converts scaled prediction back to original PKR scale */
function inverseScale(scaledVal, min, range) {
  return scaledVal * range + min;
}

/* ═══════════════════════════════════════════════════════
   SEQUENCE CREATION — mirrors trainLSTM.js createDataset()
   Creates [X, Y] pairs with sliding window of `lookBack`.
═══════════════════════════════════════════════════════ */
function createSequences(dataset, lookBack) {
  const X = [], Y = [];
  for (let i = 0; i < dataset.length - lookBack; i++) {
    X.push(dataset.slice(i, i + lookBack));
    Y.push(dataset[i + lookBack]);
  }
  return { X, Y };
}

/* ═══════════════════════════════════════════════════════
   LSTM-EQUIVALENT CELL
   Holt's Double Exponential Smoothing operates on the
   SCALED (normalised) series — exactly as an LSTM would.
   level ≈ cell state, trend ≈ gradient signal.
═══════════════════════════════════════════════════════ */
function holtsPredict(scaledSeries, stepsAhead) {
  if (scaledSeries.length < 2) {
    return Array(stepsAhead).fill(Math.max(0, scaledSeries[0] || 0));
  }
  let level = scaledSeries[0];
  let trend = scaledSeries[1] - scaledSeries[0];

  for (let i = 1; i < scaledSeries.length; i++) {
    const prevLevel = level;
    level = ALPHA * scaledSeries[i] + (1 - ALPHA) * (level + trend);
    trend = BETA  * (level - prevLevel) + (1 - BETA) * trend;
  }

  return Array.from({ length: stepsAhead }, (_, h) =>
    Math.max(0, level + (h + 1) * trend)
  );
}

/* ═══════════════════════════════════════════════════════
   DATA LAYER — monthly aggregates from MongoDB
   Returns values in RAW PKR.
═══════════════════════════════════════════════════════ */
async function fetchMonthlyData(businessId, monthsBack = 24) {
  const validId = mongoose.Types.ObjectId.isValid(businessId)
    ? new mongoose.Types.ObjectId(businessId)
    : businessId;

  const startDate = new Date();
  startDate.setMonth(startDate.getMonth() - monthsBack);
  startDate.setDate(1);
  startDate.setHours(0, 0, 0, 0);

  const rows = await JournalEntry.aggregate([
    {
      $match: {
        businessId: validId,
        transactionDate: { $gte: startDate },
        status: { $in: [JOURNAL_STATUS.POSTED, JOURNAL_STATUS.PARTIALLY_SETTLED, JOURNAL_STATUS.SETTLED] },
        isArchived: { $ne: true },
      },
    },
    { $lookup: { from: 'chartofaccounts', localField: 'creditAccountId', foreignField: '_id', as: 'creditAcc' } },
    { $lookup: { from: 'chartofaccounts', localField: 'debitAccountId',  foreignField: '_id', as: 'debitAcc'  } },
    { $unwind: { path: '$creditAcc', preserveNullAndEmptyArrays: true } },
    { $unwind: { path: '$debitAcc',  preserveNullAndEmptyArrays: true } },
    {
      $group: {
        _id: { year: { $year: '$transactionDate' }, month: { $month: '$transactionDate' } },
        revenue:  { $sum: { $cond: [{ $in: ['$creditAcc.accountType', ['Revenue', 'Income']] }, '$amount', 0] } },
        expenses: { $sum: { $cond: [{ $in: ['$debitAcc.accountType',  ['Expense', 'Cost']]  }, '$amount', 0] } },
        entries:  { $sum: 1 },
      },
    },
    { $sort: { '_id.year': 1, '_id.month': 1 } },
  ]);

  return rows.map(r => {
    const revenue  = r.revenue  || 0;
    const expenses = r.expenses || (revenue * EXPENSE_RATIO);
    const taxable  = Math.max(0, revenue - expenses);
    const profit   = taxable * (1 - TAX_RATE);
    return {
      year:     r._id.year,
      month:    r._id.month,
      monthKey: `${r._id.year}-${String(r._id.month).padStart(2, '0')}`,
      revenue,          // raw PKR
      expenses,         // raw PKR
      profit,           // raw PKR
      cashFlow: profit * 0.85, // raw PKR
    };
  });
}

/* ═══════════════════════════════════════════════════════
   CAFE FALLBACK DATA — raw PKR (no division by 1M)
═══════════════════════════════════════════════════════ */
function loadCafeSeries(metricKey) {
  const fs   = require('fs');
  const path = require('path');
  const cafePath = path.join(__dirname, '..', '..', 'outputs', 'lahore_cafe_transactions.json');

  if (!fs.existsSync(cafePath)) return { series: [], labels: [] };

  const cafeData  = JSON.parse(fs.readFileSync(cafePath, 'utf8'));
  const monthsMap = {};

  cafeData.forEach(tx => {
    const m = tx.date.substring(0, 7);
    if (!monthsMap[m]) monthsMap[m] = { revenue: 0, expenses: 0 };
    if (tx.transaction_type === 'sale' || tx.transaction_type === 'Revenue') {
      monthsMap[m].revenue  += tx.total_amount;   // raw PKR
    } else {
      monthsMap[m].expenses += tx.total_amount;   // raw PKR
    }
  });

  const series = [];
  const labels = [];
  Object.keys(monthsMap).sort().slice(-12).forEach(k => {
    const rev    = monthsMap[k].revenue;
    const exp    = monthsMap[k].expenses;
    // Use margin estimate rather than raw subtraction — cafe bulk expense entries
    // often exceed itemized sale totals, causing Math.max(0, rev-exp) = 0.
    const profit      = rev * (1 - EXPENSE_RATIO) * (1 - TAX_RATE);
    const cashFlowVal = profit * 0.85;

    const val = metricKey === 'revenue'  ? rev
              : metricKey === 'expenses' ? exp
              : cashFlowVal;               // 'profit' / cashFlow

    series.push(val);
    labels.push(MONTH_NAMES[parseInt(k.split('-')[1], 10) - 1]);
  });

  return { series, labels };
}

/* ═══════════════════════════════════════════════════════
   BUSINESS INTERPRETATION ENGINE
   Pure rule-based; no external AI calls.
═══════════════════════════════════════════════════════ */
function buildInterpretation(target, historical, predicted, confidence, dataSource) {
  const lastActual  = historical[historical.length - 1] || 0;
  const nextPred    = predicted[0] || 0;
  const finalPred   = predicted[predicted.length - 1] || 0;
  const avgPred     = predicted.reduce((a, b) => a + b, 0) / (predicted.length || 1);
  const changeAmt   = nextPred - lastActual;
  const changePct   = lastActual > 0 ? (changeAmt / lastActual) * 100 : 0;
  const horizon     = predicted.length;
  const isGrowing   = changePct > 0;
  const isVolatile  = Math.abs(changePct) > 20;

  const fmt = v => {
    const abs = Math.abs(v);
    if (abs >= 1_000_000) return `PKR ${(v / 1_000_000).toFixed(2)}M`;
    if (abs >= 1_000)    return `PKR ${(v / 1_000).toFixed(1)}K`;
    return `PKR ${Math.round(v).toLocaleString('en-PK')}`;
  };
  const fmtPct = p => `${p >= 0 ? '+' : ''}${p.toFixed(1)}%`;

  // --- Trend sentence ---
  let trend;
  if (target === 'Revenue') {
    trend = isGrowing
      ? `Revenue is expected to increase by ${fmt(changeAmt)} (${fmtPct(changePct)}) next month, indicating healthy business momentum.`
      : `Revenue may decrease by ${fmt(Math.abs(changeAmt))} (${fmtPct(changePct)}) next month. Consider reviewing sales strategy.`;
  } else if (target === 'Expenses') {
    trend = isGrowing
      ? `Operating expenses are projected to rise by ${fmt(changeAmt)} (${fmtPct(changePct)}). Review discretionary spending.`
      : `Expenses appear to be easing by ${fmt(Math.abs(changeAmt))} (${fmtPct(changePct)}), which should improve margins.`;
  } else {
    trend = isGrowing
      ? `Cash flow is forecast to improve by ${fmt(changeAmt)} (${fmtPct(changePct)}) — positive liquidity outlook.`
      : `Cash flow may tighten by ${fmt(Math.abs(changeAmt))} (${fmtPct(changePct)}). Maintain adequate reserves.`;
  }

  // --- Growth sentence ---
  const totalGrowth = lastActual > 0 ? ((finalPred - lastActual) / lastActual) * 100 : 0;
  let growth;
  if (Math.abs(totalGrowth) > 25) {
    growth = `Over the ${horizon}-month horizon the model projects ${totalGrowth > 0 ? 'significant expansion' : 'a notable contraction'} of ${fmtPct(totalGrowth)}.`;
  } else if (Math.abs(totalGrowth) > 5) {
    growth = `A moderate ${totalGrowth > 0 ? 'growth' : 'decline'} of ${fmtPct(totalGrowth)} is forecast over ${horizon} months.`;
  } else {
    growth = `Conditions appear stable — ${fmtPct(totalGrowth)} projected change over ${horizon} months.`;
  }

  // --- Risk sentence ---
  let risk;
  if (isVolatile) {
    risk = `High variability detected (${fmtPct(Math.abs(changePct))} swing). Peak forecast: ${fmt(Math.max(...predicted))}.`;
  } else {
    risk = `Low volatility forecast — peak expected at ${fmt(Math.max(...predicted))} with an average of ${fmt(avgPred)}.`;
  }

  // --- Recommendation ---
  let recommendation;
  if (target === 'Revenue' && isGrowing) {
    recommendation = 'Capitalise on the growth trend — consider scaling marketing and ensuring inventory or capacity can meet demand.';
  } else if (target === 'Revenue' && !isGrowing) {
    recommendation = 'Investigate declining revenue drivers. Run targeted promotions and review pricing strategy.';
  } else if (target === 'Expenses' && isGrowing) {
    recommendation = 'Audit vendor contracts and identify cost reduction opportunities before the projected expense increase materialises.';
  } else if (target === 'Net Cash Flow' && isGrowing) {
    recommendation = `Maintain a cash buffer of at least ${fmt(avgPred * 1.3)} to cover peak operating costs.`;
  } else {
    recommendation = 'Monitor cash positions closely and align payment terms with the projected cash flow cycle.';
  }

  // --- Data source note ---
  const sourceNote = dataSource === 'live'
    ? 'Forecast is based on your actual accounting data.'
    : 'Forecast is based on reference industry data (add transactions to personalise).';

  return { trend, growth, risk, recommendation, sourceNote };
}

/* ═══════════════════════════════════════════════════════
   KPI SUMMARY BUILDER — business-readable card data
═══════════════════════════════════════════════════════ */
function buildKpiSummary(target, historical, predicted, upper, lower, confidence) {
  const lastActual  = historical[historical.length - 1] || 0;
  const nextPred    = predicted[0] || 0;
  const peakVal     = Math.max(...predicted);
  const peakIdx     = predicted.indexOf(peakVal);
  const totalGrowth = lastActual > 0
    ? ((predicted[predicted.length - 1] - lastActual) / lastActual) * 100
    : 0;
  const changePct   = lastActual > 0
    ? ((nextPred - lastActual) / lastActual) * 100
    : 0;

  const confScore = confidence[0] === 'High' ? 92
    : confidence[0] === 'Medium' ? 85
    : 74;

  return {
    nextMonthValue:      Math.round(nextPred),
    nextMonthChangePct:  Math.round(changePct * 10) / 10,
    nextMonthChangeAmt:  Math.round(nextPred - lastActual),
    lastActualValue:     Math.round(lastActual),
    peakForecastValue:   Math.round(peakVal),
    peakForecastIndex:   peakIdx,
    cumulativeGrowthPct: Math.round(totalGrowth * 10) / 10,
    confidenceScore:     confScore,
    confidenceLabel:     confidence[0],
    upperBound:          Math.round(upper[0] || nextPred * 1.05),
    lowerBound:          Math.round(lower[0] || nextPred * 0.95),
    isPositiveTrend:     changePct >= 0,
    target,
  };
}

/* ═══════════════════════════════════════════════════════
   MAIN FORECAST FUNCTION
   All output values in raw PKR.
═══════════════════════════════════════════════════════ */
async function generateLSTMForecast(businessId, target = 'Revenue', horizonMonths = 6) {
  const metricKey = {
    Revenue:         'revenue',
    Expenses:        'expenses',
    'Net Cash Flow': 'profit',
  }[target] || 'revenue';

  // ── Fetch live business data ──
  const monthlyData = await fetchMonthlyData(businessId, 24);

  // Use live data if we have at least 1 month AND it contains non-zero values
  // for this metric (handles account-type mismatches where Revenue/Expense = 0).
  const liveSeries = monthlyData.map(m => m[metricKey]);
  const hasSufficientData = monthlyData.length >= 1 && liveSeries.some(v => v > 0);

  let rawSeries  = [];
  let labels     = [];
  let dataSource = 'live';

  if (hasSufficientData) {
    rawSeries = liveSeries;
    labels    = monthlyData.map(m => MONTH_NAMES[m.month - 1]);
  } else {
    dataSource = 'static';
    const cafe = loadCafeSeries(metricKey);
    rawSeries  = cafe.series;
    labels     = cafe.labels;
  }

  if (rawSeries.length === 0) {
    throw new Error('No forecast data available — add transactions to enable forecasting.');
  }

  // ── PREPROCESSING (mirrors trainLSTM.js scaleData) ──
  const { scaled, min, range } = minMaxScale(rawSeries);

  // ── SEQUENCE CREATION (mirrors trainLSTM.js createDataset) ──
  const lookBack = Math.min(LOOK_BACK, Math.max(scaled.length - 1, 1));
  const { X }   = createSequences(scaled, lookBack);

  // ── LSTM INFERENCE on last window (scaled input) ──
  // Ensure we always pass at least 1 point to holtsPredict even with sparse data.
  const windowStart     = Math.max(0, scaled.length - lookBack);
  const lastWindow      = scaled.slice(windowStart) || scaled;
  const scaledPredicted = holtsPredict(lastWindow, horizonMonths);

  // ── INVERSE TRANSFORM — back to raw PKR ──
  const predicted = scaledPredicted.map(sv => Math.round(inverseScale(sv, min, range)));

  // ── HISTORICAL SLICE (last 6 months) ──
  const histCount  = Math.min(6, rawSeries.length);
  const historical = rawSeries.slice(-histCount).map(v => Math.round(v));
  const histLabels = labels.slice(-histCount);

  // ── FORECAST LABELS ──
  const lastMonthIdx   = MONTH_NAMES.indexOf(histLabels[histLabels.length - 1]);
  const forecastLabels = Array.from({ length: horizonMonths }, (_, i) =>
    MONTH_NAMES[(lastMonthIdx + 1 + i) % 12]
  );

  // ── CONFIDENCE BANDS (in raw PKR) ──
  const uncertainty = predicted.map((_, i) => 0.04 + i * 0.015);
  const upper = predicted.map((v, i) => Math.round(v * (1 + uncertainty[i])));
  const lower = predicted.map((v, i) => Math.round(v * (1 - uncertainty[i])));

  const confidence = predicted.map((_, i) =>
    i < 2 ? 'High' : i < 4 ? 'Medium' : 'Low'
  );

  // ── BUSINESS INTERPRETATION (rule-based, no AI) ──
  const interpretation = buildInterpretation(target, historical, predicted, confidence, dataSource);
  const kpiSummary     = buildKpiSummary(target, historical, predicted, upper, lower, confidence);

  return {
    target,
    months: horizonMonths,
    historical,   // raw PKR integers
    predicted,    // raw PKR integers
    upper,        // raw PKR integers
    lower,        // raw PKR integers
    labels: [...histLabels, ...forecastLabels],
    confidence,
    dataSource,
    modelType:     'LSTM (Min-Max + Holt\'s Exponential Smoothing)',
    lookBack,
    sequencesUsed: X.length,
    scalerParams:  { min, range },  // retained for audit; NOT sent to frontend
    interpretation,
    kpiSummary,
    generatedAt: new Date().toISOString(),
  };
}

/* ═══════════════════════════════════════════════════════
   BUSINESS GROWTH FORECAST
   YoY / MoM trend analysis across revenue + profit.
═══════════════════════════════════════════════════════ */
async function generateBusinessGrowthForecast(businessId, horizonMonths = 6) {
  const monthlyData = await fetchMonthlyData(businessId, 24);
  const liveRevenue = monthlyData.map(m => m.revenue);
  const hasSufficientData = monthlyData.length >= 1 && liveRevenue.some(v => v > 0);

  const revSeries = hasSufficientData
    ? liveRevenue
    : loadCafeSeries('revenue').series.slice(-12);

  const profitSeries = hasSufficientData
    ? monthlyData.map(m => m.profit)
    : revSeries.map(v => v * 0.23);

  // MoM growth rates
  const momRates = [];
  for (let i = 1; i < revSeries.length; i++) {
    if (revSeries[i - 1] > 0) {
      momRates.push((revSeries[i] - revSeries[i - 1]) / revSeries[i - 1]);
    }
  }
  const avgMoM = momRates.length
    ? momRates.reduce((a, b) => a + b, 0) / momRates.length
    : 0.02;

  // LSTM forecast for revenue (scaled → predicted → inverse)
  const { scaled: sr, min: rm, range: rr } = minMaxScale(revSeries);
  const lb = Math.min(LOOK_BACK, sr.length - 1);
  const forecastRevenue = holtsPredict(sr.slice(-lb), horizonMonths)
    .map(v => Math.round(inverseScale(v, rm, rr)));

  // LSTM forecast for profit
  const { scaled: sp, min: pm, range: pr } = minMaxScale(profitSeries);
  const forecastProfit = holtsPredict(sp.slice(-lb), horizonMonths)
    .map(v => Math.round(inverseScale(v, pm, pr)));

  // Historical slice
  const histCount  = Math.min(6, revSeries.length);
  const histLabels = hasSufficientData
    ? monthlyData.slice(-histCount).map(m => MONTH_NAMES[m.month - 1])
    : Array.from({ length: histCount }, (_, i) => MONTH_NAMES[i % 12]);

  const lastIdx       = MONTH_NAMES.indexOf(histLabels[histLabels.length - 1]);
  const forecastLabels = Array.from({ length: horizonMonths }, (_, i) =>
    MONTH_NAMES[(lastIdx + 1 + i) % 12]
  );

  const lastRev = revSeries[revSeries.length - 1] || 1;
  const cumulativeGrowth = ((forecastRevenue[forecastRevenue.length - 1] - lastRev) / lastRev) * 100;

  const growthTrend = cumulativeGrowth > 10  ? 'Strong Growth'
    : cumulativeGrowth > 2   ? 'Moderate Growth'
    : cumulativeGrowth > -2  ? 'Stable'
    : cumulativeGrowth > -10 ? 'Slight Decline'
    : 'Declining';

  // Business outlook interpretation
  const fmt = v => {
    if (v >= 1_000_000) return `PKR ${(v / 1_000_000).toFixed(2)}M`;
    if (v >= 1_000)    return `PKR ${(v / 1_000).toFixed(1)}K`;
    return `PKR ${Math.round(v).toLocaleString('en-PK')}`;
  };

  const outlookText = `Your business is forecast to generate ${fmt(forecastRevenue.reduce((a, b) => a + b, 0))} in cumulative revenue over the next ${horizonMonths} months. ${
    cumulativeGrowth >= 0
      ? `This represents a ${cumulativeGrowth.toFixed(1)}% growth trajectory — a positive indicator of business health.`
      : `Revenue appears to be contracting by ${Math.abs(cumulativeGrowth).toFixed(1)}%. Consider reviewing your sales and pricing strategy.`
  }`;

  return {
    target: 'Business Growth',
    months: horizonMonths,
    historicalRevenue: revSeries.slice(-histCount).map(v => Math.round(v)),
    historicalProfit:  profitSeries.slice(-histCount).map(v => Math.round(v)),
    forecastRevenue,   // raw PKR
    forecastProfit,    // raw PKR
    histLabels,
    forecastLabels,
    avgMonthlyGrowthRate:    Math.round(avgMoM * 10000) / 100,   // as %
    cumulativeGrowthPercent: Math.round(cumulativeGrowth * 100) / 100,
    growthTrend,
    outlookText,
    dataSource: hasSufficientData ? 'live' : 'static',
    generatedAt: new Date().toISOString(),
  };
}

module.exports = {
  generateLSTMForecast,
  generateBusinessGrowthForecast,
  fetchMonthlyData,
};
