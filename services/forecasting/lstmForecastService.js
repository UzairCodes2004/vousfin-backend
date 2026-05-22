/**
 * @file lstmForecastService.js
 * @description Advanced LSTM forecasting engine for vousFin — v3.
 *
 * Execution strategy:
 *  1. PRIMARY  — Real Bi-LSTM (Python FastAPI at LSTM_API_URL).
 *  2. FALLBACK — Holt-Winters Triple Exponential Smoothing (built-in, always available).
 *               Superior to the previous Holt's Double ES: handles seasonality explicitly.
 *
 * New in v3:
 *  - Holt-Winters with quarterly seasonality (period = 3)
 *  - Anomaly-aware confidence adjustment (queries AnomalyAlert collection)
 *  - Optimistic / Base / Pessimistic scenario projections
 *  - Rolling statistics & trend momentum analysis
 *  - Feature importance proxies (explainability layer)
 *  - Smart risk indicators (cash shortage, volatility, data sparsity)
 *  - Per-category transaction breakdown
 *  - In-memory forecast cache (5-minute TTL)
 *  - Better business intelligence in buildInterpretation()
 *
 * ALL monetary values returned in RAW PKR.
 */

const JournalEntry  = require('../../models/JournalEntry.model');
const mongoose      = require('mongoose');
const { JOURNAL_STATUS } = require('../../config/constants');

/* ── Python LSTM microservice config ── */
const LSTM_API_URL          = process.env.LSTM_API_URL  || 'http://localhost:8000';
const LSTM_TIMEOUT_MS       = parseInt(process.env.LSTM_TIMEOUT_MS || '15000', 10);
const MIN_LSTM_TRANSACTIONS = parseInt(process.env.LSTM_MIN_ROWS   || '38',    10);
const LSTM_ENABLED          = process.env.LSTM_ENABLED !== 'false';

/* ── In-memory forecast cache (5-minute TTL) ── */
const _cache     = new Map();
const CACHE_TTL  = 5 * 60 * 1000; // ms

function _cacheKey(businessId, target, horizon) {
  return `${businessId}::${target}::${horizon}`;
}
function _cacheGet(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { _cache.delete(key); return null; }
  return entry.data;
}
function _cacheSet(key, data) {
  _cache.set(key, { data, ts: Date.now() });
}
function clearForecastCache(businessId) {
  for (const k of _cache.keys()) {
    if (k.startsWith(String(businessId))) _cache.delete(k);
  }
}

/* ── VousFin type → LSTM vocabulary mapper ── */
const VOUSFIN_TYPE_MAP = {
  'income':               'Income',     'expense':              'Expense',
  'transfer':             'Transfer',   'credit sale':          'Sale',
  'credit purchase':      'Purchase',   'payment received':     'Receipt',
  'payment made':         'Payment',    'installment payment':  'Payment',
  'loan disbursement':    'Income',     'loan repayment':       'Payment',
  'owner investment':     'Deposit',    'owner withdrawal':     'Expense',
  'asset purchase':       'Purchase',   'sale':                 'Sale',
  'purchase':             'Purchase',   'deposit':              'Deposit',
  'payment':              'Payment',    'refund':               'Refund',
  'receipt':              'Receipt',    'fee':                  'Fee',
  'tax':                  'Tax',
};
function _mapTxnType(rawType) {
  if (!rawType) return 'Income';
  return VOUSFIN_TYPE_MAP[rawType.toLowerCase().trim()] || rawType;
}

/* ── Python service probe ── */
async function _lstmServiceReady() {
  try {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), 3000);
    const res  = await fetch(`${LSTM_API_URL}/api/v1/vousfin/health`, { signal: ctrl.signal });
    clearTimeout(tid);
    if (!res.ok) return false;
    const body = await res.json();
    return body.ready === true;
  } catch { return false; }
}

/* ── Call Python LSTM microservice ── */
async function _callPythonLSTM(businessId, target, horizonMonths, journalEntries) {
  const payload = {
    businessId:        String(businessId),
    businessType:      'retail',
    target,
    horizonMonths,
    currentBalance:    0,
    returnUncertainty: true,
    transactions:      journalEntries.map(e => ({
      transactionDate:   e.transactionDate instanceof Date
                           ? e.transactionDate.toISOString()
                           : String(e.transactionDate),
      amount:            Number(e.amount) || 0,
      transactionType:   _mapTxnType(e.transactionType),
      description:       e.description   || '',
      transactionMode:   e.transactionMode || 'cash',
      status:            e.status         || 'posted',
      creditAccountType: e.creditAccountType || 'Revenue',
      debitAccountType:  e.debitAccountType  || 'Expense',
      taxAmount:         Number(e.taxAmount)  || 0,
      balanceAfter:      0,
    })),
  };
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), LSTM_TIMEOUT_MS);
  const res  = await fetch(`${LSTM_API_URL}/api/v1/vousfin/forecast`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
    signal:  ctrl.signal,
  });
  clearTimeout(tid);
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`LSTM API ${res.status}: ${errText.slice(0, 200)}`);
  }
  return res.json();
}

/* ── Raw journal entry fetch for Python LSTM ── */
async function _fetchRawEntriesForLSTM(businessId, daysBack = 730) {
  const validId = mongoose.Types.ObjectId.isValid(businessId)
    ? new mongoose.Types.ObjectId(businessId)
    : businessId;
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - daysBack);
  try {
    return await JournalEntry.aggregate([
      { $match: { businessId: validId, transactionDate: { $gte: startDate }, isArchived: { $ne: true } } },
      { $lookup: { from: 'chartofaccounts', localField: 'creditAccountId', foreignField: '_id', as: '_creditAcc' } },
      { $lookup: { from: 'chartofaccounts', localField: 'debitAccountId',  foreignField: '_id', as: '_debitAcc'  } },
      {
        $project: {
          transactionDate: 1, amount: 1, transactionType: 1, description: 1,
          transactionMode: 1, status: 1,
          taxAmount:         { $ifNull: ['$taxAmount', 0] },
          creditAccountType: { $ifNull: [{ $arrayElemAt: ['$_creditAcc.accountType', 0] }, 'Revenue'] },
          debitAccountType:  { $ifNull: [{ $arrayElemAt: ['$_debitAcc.accountType',  0] }, 'Expense'] },
        },
      },
      { $sort: { transactionDate: 1 } },
    ]);
  } catch (err) {
    console.warn('[lstmForecastService] _fetchRawEntriesForLSTM error:', err.message);
    return [];
  }
}

/* ════════════════════════════════════════════════════════════════════════════
   MATH UTILITIES
════════════════════════════════════════════════════════════════════════════ */
function mean(arr)         { return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0; }
function std(arr, mu)      { if (arr.length < 2) return 0; const m = mu ?? mean(arr); return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length); }
function clamp(v, lo, hi)  { return Math.max(lo, Math.min(hi, v)); }
function safeDiv(a, b)     { return b ? a / b : 0; }

/* Rolling N-period mean */
function rollingMean(arr, n) {
  return arr.map((_, i) => {
    const slice = arr.slice(Math.max(0, i - n + 1), i + 1);
    return mean(slice);
  });
}

/* Rolling N-period std */
function rollingStd(arr, n) {
  return arr.map((_, i) => {
    const slice = arr.slice(Math.max(0, i - n + 1), i + 1);
    return std(slice);
  });
}

/* ════════════════════════════════════════════════════════════════════════════
   NORMALISATION
════════════════════════════════════════════════════════════════════════════ */
function minMaxScale(data) {
  const min   = Math.min(...data);
  const max   = Math.max(...data);
  const range = (max - min) || 1;
  return { scaled: data.map(v => (v - min) / range), min, max, range };
}
function inverseScale(scaledVal, min, range) { return scaledVal * range + min; }

/* ════════════════════════════════════════════════════════════════════════════
   HOLT-WINTERS TRIPLE EXPONENTIAL SMOOTHING
   Handles: level + trend + seasonal component (period = 3 months = quarterly)
   Significantly better than Holt's Double ES for business cycles.
════════════════════════════════════════════════════════════════════════════ */
function holtsWinters(series, stepsAhead, opts = {}) {
  const { alpha = 0.45, beta = 0.20, gamma = 0.15, period = 3 } = opts;

  if (series.length < 2) {
    return Array(stepsAhead).fill(Math.max(0, series[0] || 0));
  }
  // Use basic Holt's if insufficient data for seasonal decomposition
  if (series.length < period * 2) {
    return _holtsDouble(series, stepsAhead, { alpha, beta });
  }

  const n = series.length;
  const m = period; // seasonal period (quarterly = 3)

  // ── Initialize components ──
  // Initial level: mean of first full period
  let level = series.slice(0, m).reduce((s, v) => s + v, 0) / m;
  // Initial trend: slope between first and second period means
  const secondMean = series.slice(m, 2 * m).reduce((s, v) => s + v, 0) / m;
  let trend = (secondMean - level) / m;

  // Initial seasonal indices (ratio-to-moving-average method)
  const seasonal = Array(m).fill(1);
  for (let i = 0; i < Math.min(m, n); i++) {
    seasonal[i] = (series[i] / (level || 1));
  }

  // ── Smooth all observations ──
  for (let t = 0; t < n; t++) {
    const si        = seasonal[t % m];
    const prevLevel = level;
    level           = alpha  * safeDiv(series[t], si) + (1 - alpha) * (level + trend);
    trend           = beta   * (level - prevLevel)    + (1 - beta)  * trend;
    seasonal[t % m] = gamma  * safeDiv(series[t], level) + (1 - gamma) * si;
  }

  // ── Forecast ──
  return Array.from({ length: stepsAhead }, (_, h) => {
    const si = seasonal[(n + h) % m];
    return Math.max(0, (level + (h + 1) * trend) * (si || 1));
  });
}

/* Holt's Double Exponential Smoothing — fallback for very short series */
function _holtsDouble(series, stepsAhead, { alpha = 0.45, beta = 0.25 } = {}) {
  if (series.length < 2) return Array(stepsAhead).fill(Math.max(0, series[0] || 0));
  let level = series[0];
  let trend = series[1] - series[0];
  for (let i = 1; i < series.length; i++) {
    const prev = level;
    level = alpha * series[i] + (1 - alpha) * (level + trend);
    trend = beta  * (level - prev) + (1 - beta) * trend;
  }
  return Array.from({ length: stepsAhead }, (_, h) => Math.max(0, level + (h + 1) * trend));
}

/* ════════════════════════════════════════════════════════════════════════════
   TREND MOMENTUM ANALYSIS
   Computes short-term (3m) vs long-term (6m) velocity.
════════════════════════════════════════════════════════════════════════════ */
function computeTrendMomentum(series) {
  if (series.length < 2) return { short: 0, long: 0, acceleration: 0 };
  const n = series.length;
  // 3-month short-term MoM average
  const shortSlice = series.slice(Math.max(0, n - 3));
  const longSlice  = series.slice(Math.max(0, n - 6));
  const shortMoM = shortSlice.length < 2 ? 0
    : (shortSlice[shortSlice.length - 1] - shortSlice[0]) / (shortSlice[0] || 1) / (shortSlice.length - 1);
  const longMoM  = longSlice.length < 2 ? 0
    : (longSlice[longSlice.length - 1] - longSlice[0]) / (longSlice[0] || 1) / (longSlice.length - 1);
  return {
    short:        Math.round(shortMoM * 1000) / 10,   // %
    long:         Math.round(longMoM  * 1000) / 10,   // %
    acceleration: Math.round((shortMoM - longMoM) * 1000) / 10, // % — positive = accelerating
  };
}

/* ════════════════════════════════════════════════════════════════════════════
   ANOMALY AWARENESS
   Queries AnomalyAlert collection to adjust forecast confidence and
   generate anomaly-risk score. Non-critical — fails silently.
════════════════════════════════════════════════════════════════════════════ */
async function fetchAnomalyRisk(businessId) {
  try {
    const AnomalyAlert = require('../../models/AnomalyAlert.model');
    const validId = mongoose.Types.ObjectId.isValid(businessId)
      ? new mongoose.Types.ObjectId(businessId)
      : businessId;
    const since = new Date();
    since.setDate(since.getDate() - 90);

    const results = await AnomalyAlert.aggregate([
      { $match: { businessId: validId, detectedAt: { $gte: since } } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);

    const counts = { pending: 0, confirmed_fraud: 0, ignored: 0, marked_legit: 0, total: 0 };
    for (const r of results) {
      const s = r._id || 'unknown';
      counts[s]   = (counts[s] || 0) + r.count;
      counts.total += r.count;
    }
    // Also count legacy status keys
    const pending = (counts.pending || 0) + (counts.pending_review || 0) + (counts.rescanned || 0);
    const fraud   = counts.confirmed_fraud || 0;
    const total   = counts.total || 0;

    // Risk score 0→1: fraud alerts drive it most, unreviewed drive uncertainty
    const riskScore = total > 0
      ? clamp((fraud * 0.7 + pending * 0.3) / Math.max(total, 1), 0, 1)
      : 0;

    return {
      total,
      pending,
      fraud,
      riskScore: Math.round(riskScore * 100) / 100,
      hasFraud:       fraud > 0,
      hasUnreviewed:  pending > 0,
      confidencePenalty: Math.round(riskScore * 15), // up to -15% on confidence score
    };
  } catch {
    return { total: 0, pending: 0, fraud: 0, riskScore: 0, hasFraud: false, hasUnreviewed: false, confidencePenalty: 0 };
  }
}

/* ════════════════════════════════════════════════════════════════════════════
   SCENARIO SIMULATION
   Generates optimistic / base / pessimistic projections.
   anomalyRiskScore increases uncertainty band.
════════════════════════════════════════════════════════════════════════════ */
function generateScenarios(predicted, anomalyRiskScore = 0) {
  const volatility = 1 + anomalyRiskScore * 0.15; // anomalies widen the spread
  return {
    optimistic:  predicted.map((v, i) => Math.round(v * (1.12 + i * 0.015) * volatility)),
    base:        predicted.map(v => Math.round(v)),
    pessimistic: predicted.map((v, i) => Math.round(v * Math.max(0.70, 0.90 - i * 0.02) / volatility)),
  };
}

/* ════════════════════════════════════════════════════════════════════════════
   FEATURE IMPORTANCE PROXIES (Explainability)
   Rule-based proxies since we're in the Holt-Winters path (no attention weights).
   Returns the top drivers in descending importance order.
════════════════════════════════════════════════════════════════════════════ */
function computeFeatureImportance(series, target, momentum, anomalyRisk, dataPoints) {
  const n     = series.length;
  const mu    = mean(series);
  const sigma = std(series, mu);
  const cv    = mu > 0 ? sigma / mu : 0;  // coefficient of variation

  // Importance scores — heuristic proxies
  const historicalTrend = Math.abs(momentum.long) > 3
    ? clamp(Math.abs(momentum.long) / 20, 0.1, 0.5) : 0.15;
  const seasonalStrength = n >= 6
    ? clamp(cv * 0.8, 0.05, 0.40) : 0.10;
  const recentMomentum = Math.abs(momentum.short) > 1
    ? clamp(Math.abs(momentum.short) / 15, 0.05, 0.35) : 0.10;
  const anomalyImpact = clamp(anomalyRisk.riskScore * 0.5, 0, 0.30);
  const dataVolume = clamp(Math.log(dataPoints + 1) / Math.log(24), 0.05, 0.25);

  const raw = [
    { name: 'Historical trend',     value: historicalTrend,  description: 'Long-run MoM direction' },
    { name: 'Seasonal pattern',     value: seasonalStrength, description: 'Quarterly business cycle strength' },
    { name: 'Recent momentum',      value: recentMomentum,   description: 'Short-term acceleration' },
    { name: 'Data volume',          value: dataVolume,        description: 'Months of accounting history' },
    { name: 'Anomaly impact',       value: anomalyImpact,    description: 'Fraud / irregular transactions detected' },
  ];

  const total = raw.reduce((s, f) => s + f.value, 0);
  return raw
    .map(f => ({ ...f, pct: Math.round((f.value / (total || 1)) * 100) }))
    .sort((a, b) => b.value - a.value);
}

/* ════════════════════════════════════════════════════════════════════════════
   RISK INDICATORS (Smart business intelligence)
════════════════════════════════════════════════════════════════════════════ */
function buildRiskIndicators(target, predicted, historical, anomalyRisk, momentum) {
  const indicators = [];
  const mu    = mean(predicted);
  const sigma = std(predicted, mu);
  const cv    = mu > 0 ? sigma / mu : 0;
  const lastActual = historical[historical.length - 1] || 0;
  const firstPred  = predicted[0] || 0;
  const fmt = v => {
    const abs = Math.abs(v);
    if (abs >= 1_000_000) return `PKR ${(v / 1_000_000).toFixed(1)}M`;
    if (abs >= 1_000)    return `PKR ${(v / 1_000).toFixed(0)}K`;
    return `PKR ${Math.round(v).toLocaleString()}`;
  };

  // Cash shortage risk (cashflow going negative or too low)
  if (target === 'Net Cash Flow' && predicted.some(v => v < 0)) {
    const negMonth = predicted.findIndex(v => v < 0) + 1;
    indicators.push({
      id: 'cash_shortage', level: 'critical',
      title: 'Cash Shortage Risk',
      message: `Cash flow projected to turn negative in month ${negMonth}. Immediate liquidity action required.`,
    });
  }

  // High volatility risk
  if (cv > 0.25) {
    indicators.push({
      id: 'high_volatility', level: 'warning',
      title: 'High Forecast Volatility',
      message: `Forecast variance is ${Math.round(cv * 100)}% — predictions may be less reliable. Widen your planning buffer.`,
    });
  }

  // Accelerating decline
  if (momentum.acceleration < -5 && momentum.short < 0) {
    indicators.push({
      id: 'accelerating_decline', level: 'critical',
      title: 'Accelerating Decline Detected',
      message: `${target} is declining faster than the long-term trend (acceleration: ${momentum.acceleration.toFixed(1)}%). Investigate root cause.`,
    });
  }

  // Anomaly contamination
  if (anomalyRisk.hasFraud) {
    indicators.push({
      id: 'anomaly_fraud', level: 'critical',
      title: 'Fraud Alerts Affecting Forecast',
      message: `${anomalyRisk.fraud} confirmed fraud transaction${anomalyRisk.fraud > 1 ? 's' : ''} detected in recent 90 days. Forecast accuracy may be reduced.`,
    });
  } else if (anomalyRisk.hasUnreviewed) {
    indicators.push({
      id: 'anomaly_unreviewed', level: 'warning',
      title: 'Unreviewed Anomalies Present',
      message: `${anomalyRisk.pending} suspicious transaction${anomalyRisk.pending > 1 ? 's' : ''} pending review. Resolve these to improve forecast accuracy.`,
    });
  }

  // Strong growth opportunity
  if (target === 'Revenue' && firstPred > lastActual * 1.15) {
    indicators.push({
      id: 'growth_opportunity', level: 'info',
      title: 'Growth Opportunity',
      message: `Revenue forecast shows ${Math.round((firstPred - lastActual) / (lastActual || 1) * 100)}% growth next month. Peak projected at ${fmt(Math.max(...predicted))}.`,
    });
  }

  // Spending spike
  if (target === 'Expenses' && firstPred > lastActual * 1.10) {
    indicators.push({
      id: 'expense_spike', level: 'warning',
      title: 'Expense Spike Projected',
      message: `Operating costs are forecast to rise ${Math.round((firstPred / (lastActual || 1) - 1) * 100)}% next month. Review vendor contracts.`,
    });
  }

  return indicators;
}

/* ════════════════════════════════════════════════════════════════════════════
   DATA LAYER — monthly aggregates from MongoDB
════════════════════════════════════════════════════════════════════════════ */
const EXPENSE_RATIO = 0.62;
const TAX_RATE      = 0.15;
const MONTH_NAMES   = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

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
      revenue,
      expenses,
      profit,
      cashFlow: profit * 0.85,
      entries:  r.entries || 0,
    };
  });
}

/* ── Per-category transaction breakdown (for category insights) ── */
async function fetchCategoryBreakdown(businessId, monthsBack = 3) {
  const validId = mongoose.Types.ObjectId.isValid(businessId)
    ? new mongoose.Types.ObjectId(businessId)
    : businessId;
  const startDate = new Date();
  startDate.setMonth(startDate.getMonth() - monthsBack);
  try {
    const results = await JournalEntry.aggregate([
      {
        $match: {
          businessId: validId,
          transactionDate: { $gte: startDate },
          isArchived: { $ne: true },
        },
      },
      {
        $group: {
          _id:   '$transactionType',
          total: { $sum: '$amount' },
          count: { $sum: 1 },
          avgAmount: { $avg: '$amount' },
        },
      },
      { $sort: { total: -1 } },
      { $limit: 8 },
    ]);
    return results.map(r => ({
      name:      r._id || 'Unknown',
      total:     Math.round(r.total || 0),
      count:     r.count || 0,
      avgAmount: Math.round(r.avgAmount || 0),
    }));
  } catch {
    return [];
  }
}

/* ── Cafe fallback data (raw PKR) ── */
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
      monthsMap[m].revenue  += tx.total_amount;
    } else {
      monthsMap[m].expenses += tx.total_amount;
    }
  });

  const series = [];
  const labels = [];
  Object.keys(monthsMap).sort().slice(-12).forEach(k => {
    const rev      = monthsMap[k].revenue;
    const exp      = monthsMap[k].expenses;
    const profit   = rev * (1 - EXPENSE_RATIO) * (1 - TAX_RATE);
    const cashFlow = profit * 0.85;
    const val = metricKey === 'revenue'  ? rev
              : metricKey === 'expenses' ? exp
              : cashFlow;
    series.push(val);
    labels.push(MONTH_NAMES[parseInt(k.split('-')[1], 10) - 1]);
  });
  return { series, labels };
}

/* ════════════════════════════════════════════════════════════════════════════
   BUSINESS INTERPRETATION ENGINE (v3 — smarter reasoning)
════════════════════════════════════════════════════════════════════════════ */
function buildInterpretation(target, historical, predicted, confidence, dataSource, momentum, anomalyRisk) {
  const lastActual = historical[historical.length - 1] || 0;
  const firstPred  = predicted[0]                    || 0;
  const finalPred  = predicted[predicted.length - 1] || 0;
  const avgPred    = mean(predicted);
  const changeAmt  = firstPred - lastActual;
  const changePct  = lastActual > 0 ? (changeAmt / lastActual) * 100 : 0;
  const horizon    = predicted.length;
  const isGrowing  = changePct > 0;

  const fmt = v => {
    const abs = Math.abs(v);
    if (abs >= 1_000_000) return `PKR ${(v / 1_000_000).toFixed(2)}M`;
    if (abs >= 1_000)    return `PKR ${(v / 1_000).toFixed(1)}K`;
    return `PKR ${Math.round(v).toLocaleString('en-PK')}`;
  };
  const fmtPct = p => `${p >= 0 ? '+' : ''}${p.toFixed(1)}%`;
  const pct = Math.abs(changePct);

  // ── Trend sentence ──
  let trend;
  const momentumWord = momentum.acceleration > 3 ? ' — accelerating' : momentum.acceleration < -3 ? ' — decelerating' : '';
  if (target === 'Revenue') {
    trend = isGrowing
      ? `Revenue is projected to grow ${fmt(changeAmt)} (${fmtPct(changePct)}) next month${momentumWord}. Seasonal momentum and historical patterns support this outlook.`
      : `Revenue faces headwinds — a ${fmt(Math.abs(changeAmt))} decline (${fmtPct(changePct)}) is forecast next month. Review sales pipeline and pricing strategy.`;
  } else if (target === 'Expenses') {
    trend = isGrowing
      ? `Operating costs are forecast to rise ${fmt(changeAmt)} (${fmtPct(changePct)}) — ${pct > 15 ? 'a significant increase warranting vendor contract review' : 'a moderate increase to plan for'}.`
      : `Expenses are easing ${fmt(Math.abs(changeAmt))} (${fmtPct(changePct)}) next month — positive margin signal.`;
  } else {
    trend = isGrowing
      ? `Net cash flow is projected to improve ${fmt(changeAmt)} (${fmtPct(changePct)}) — healthy liquidity outlook.`
      : `Cash flow may tighten by ${fmt(Math.abs(changeAmt))} (${fmtPct(changePct)}). Ensure adequate reserves of at least ${fmt(avgPred * 1.5)}.`;
  }

  // ── Growth sentence ──
  const totalGrowth = lastActual > 0 ? ((finalPred - lastActual) / lastActual) * 100 : 0;
  let growth;
  if (Math.abs(totalGrowth) > 30) {
    growth = `A ${totalGrowth > 0 ? 'major expansion' : 'sharp contraction'} of ${fmtPct(totalGrowth)} is projected over the ${horizon}-month window — high conviction.`;
  } else if (Math.abs(totalGrowth) > 10) {
    growth = `Moderate ${totalGrowth > 0 ? 'growth' : 'decline'} of ${fmtPct(totalGrowth)} is expected over ${horizon} months. Short-term MoM rate: ${fmtPct(momentum.short)}.`;
  } else {
    growth = `Stable conditions forecast — ${fmtPct(totalGrowth)} net change over ${horizon} months. Volatility is low.`;
  }

  // ── Risk sentence ──
  const maxPred = Math.max(...predicted);
  const minPred = Math.min(...predicted);
  const range   = maxPred - (minPred || 0);
  const relRange = avgPred > 0 ? (range / avgPred) * 100 : 0;
  let risk;
  if (anomalyRisk.hasFraud) {
    risk = `⚠ Confirmed fraud in recent transactions reduces forecast confidence. Review flagged alerts before acting on projections.`;
  } else if (relRange > 30) {
    risk = `High forecast range (${Math.round(relRange)}% spread between ${fmt(minPred)} and ${fmt(maxPred)}). Build in a 20–30% buffer.`;
  } else {
    risk = `Low-to-moderate forecast variance (${Math.round(relRange)}% range). Peak: ${fmt(maxPred)} · Average: ${fmt(avgPred)}.`;
  }

  // ── Recommendation ──
  let recommendation;
  if (target === 'Revenue' && isGrowing && momentum.short > 3) {
    recommendation = `Strong growth momentum detected. Scale marketing, review inventory capacity, and consider locking in supplier contracts now to protect margins during peak demand.`;
  } else if (target === 'Revenue' && !isGrowing) {
    recommendation = `Revenue contraction signals a need for intervention. Launch targeted promotions, review pricing, and investigate top customer churn.`;
  } else if (target === 'Expenses' && isGrowing && pct > 10) {
    recommendation = `Audit all recurring vendor contracts. Identify fixed vs. variable costs and negotiate better terms before the projected expense rise materialises.`;
  } else if (target === 'Net Cash Flow' && !isGrowing) {
    recommendation = `Tighten collection cycles — reduce debtor days by 5–10. Align supplier payment terms with cash inflow peaks to maintain liquidity.`;
  } else if (target === 'Net Cash Flow' && isGrowing) {
    recommendation = `Healthy cash flow forecast. Maintain a buffer of ${fmt(avgPred * 1.3)} and consider deploying surplus into short-term instruments.`;
  } else {
    recommendation = `Monitor KPIs weekly. Set alert thresholds at ${fmt(avgPred * 0.85)} (warning) and ${fmt(avgPred * 0.70)} (critical) for cash management.`;
  }

  const sourceNote = dataSource === 'live'
    ? 'Forecast calibrated on your live accounting transactions.'
    : 'Forecast uses reference industry data — add transactions to personalise.';

  return { trend, growth, risk, recommendation, sourceNote, momentum };
}

/* ════════════════════════════════════════════════════════════════════════════
   KPI SUMMARY BUILDER
════════════════════════════════════════════════════════════════════════════ */
function buildKpiSummary(target, historical, predicted, upper, lower, confidence, anomalyRisk) {
  const lastActual  = historical[historical.length - 1] || 0;
  const nextPred    = predicted[0] || 0;
  const peakVal     = Math.max(...predicted);
  const peakIdx     = predicted.indexOf(peakVal);
  const totalGrowth = lastActual > 0
    ? ((predicted[predicted.length - 1] - lastActual) / lastActual) * 100 : 0;
  const changePct   = lastActual > 0
    ? ((nextPred - lastActual) / lastActual) * 100 : 0;

  const confLabel  = confidence[0] || 'Medium';
  const baseScore  = confLabel === 'High' ? 92 : confLabel === 'Medium' ? 85 : 74;
  const confScore  = Math.max(50, baseScore - (anomalyRisk?.confidencePenalty || 0));

  return {
    nextMonthValue:       Math.round(nextPred),
    nextMonthChangePct:   Math.round(changePct * 10) / 10,
    nextMonthChangeAmt:   Math.round(nextPred - lastActual),
    lastActualValue:      Math.round(lastActual),
    peakForecastValue:    Math.round(peakVal),
    peakForecastIndex:    peakIdx,
    cumulativeGrowthPct:  Math.round(totalGrowth * 10) / 10,
    confidenceScore:      confScore,
    confidenceLabel:      confLabel,
    upperBound:           Math.round(upper[0] || nextPred * 1.07),
    lowerBound:           Math.round(lower[0] || nextPred * 0.93),
    isPositiveTrend:      changePct >= 0,
    target,
    // NEW: anomaly risk for AnomalyRiskChip component
    anomalyRisk:          anomalyRisk?.riskScore || 0,
    anomalyCount:         anomalyRisk?.total     || 0,
  };
}

/* ════════════════════════════════════════════════════════════════════════════
   MAIN FORECAST FUNCTION — generateLSTMForecast
════════════════════════════════════════════════════════════════════════════ */
async function generateLSTMForecast(businessId, target = 'Revenue', horizonMonths = 6) {
  const metricKey = {
    Revenue:         'revenue',
    Expenses:        'expenses',
    'Net Cash Flow': 'profit',
  }[target] || 'revenue';

  // ── Check cache first ──
  const cacheKey     = _cacheKey(businessId, target, horizonMonths);
  const cachedResult = _cacheGet(cacheKey);
  if (cachedResult) return cachedResult;

  // ── PRIMARY: Python LSTM ──
  if (LSTM_ENABLED) {
    try {
      const recentEntries = await _fetchRawEntriesForLSTM(businessId);
      if (recentEntries.length >= MIN_LSTM_TRANSACTIONS) {
        const isReady = await _lstmServiceReady();
        if (isReady) {
          const lstmResult = await _callPythonLSTM(businessId, target, horizonMonths, recentEntries);
          if (lstmResult?.predicted?.length > 0) {
            lstmResult.modelType  = 'Bi-LSTM + Attention (Real ML)';
            lstmResult.dataSource = 'lstm_live';
            // Enrich Python result with anomaly awareness + scenarios
            const anomalyRisk = await fetchAnomalyRisk(businessId);
            const scenarios   = generateScenarios(lstmResult.predicted, anomalyRisk.riskScore);
            lstmResult.scenarios   = scenarios;
            lstmResult.anomalyRisk = anomalyRisk;
            _cacheSet(cacheKey, lstmResult);
            return lstmResult;
          }
        }
      }
    } catch (lstmErr) {
      console.warn('[lstmForecastService] Python LSTM unavailable:', lstmErr.message);
    }
  }

  // ── FALLBACK: Holt-Winters on live MongoDB data ──
  const [monthlyData, anomalyRisk] = await Promise.all([
    fetchMonthlyData(businessId, 24),
    fetchAnomalyRisk(businessId),
  ]);

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

  if (!rawSeries.length) {
    throw new Error('No forecast data available — add transactions to enable forecasting.');
  }

  // ── Preprocessing ──
  const { scaled, min, range } = minMaxScale(rawSeries);

  // ── Holt-Winters on scaled series ──
  const LOOK_BACK      = Math.min(6, Math.max(scaled.length - 1, 1));
  const scaledWindow   = scaled.slice(Math.max(0, scaled.length - LOOK_BACK));
  const scaledPredicted = holtsWinters(scaledWindow, horizonMonths, {
    alpha: 0.45, beta: 0.20, gamma: 0.15,
    period: Math.min(3, Math.max(2, scaledWindow.length - 1)),
  });

  // ── Inverse transform ──
  const predicted = scaledPredicted.map(sv => Math.round(inverseScale(sv, min, range)));

  // ── Historical slice ──
  const histCount  = Math.min(6, rawSeries.length);
  const historical = rawSeries.slice(-histCount).map(v => Math.round(v));
  const histLabels = labels.slice(-histCount);

  // ── Forecast labels ──
  const lastMonthIdx   = MONTH_NAMES.indexOf(histLabels[histLabels.length - 1]);
  const forecastLabels = Array.from({ length: horizonMonths }, (_, i) =>
    MONTH_NAMES[(lastMonthIdx + 1 + i) % 12]
  );

  // ── Confidence bands — wider with anomaly risk ──
  const baseUncertainty = 0.04 + anomalyRisk.riskScore * 0.04;
  const uncertainty = predicted.map((_, i) => baseUncertainty + i * 0.018);
  const upper       = predicted.map((v, i) => Math.round(v * (1 + uncertainty[i])));
  const lower       = predicted.map((v, i) => Math.round(v * (1 - uncertainty[i])));

  const confidence = predicted.map((_, i) =>
    i < 2 ? 'High' : i < 4 ? 'Medium' : 'Low'
  );

  // ── Momentum + feature importance + risk ──
  const momentum         = computeTrendMomentum(rawSeries);
  const featureImportance = computeFeatureImportance(rawSeries, target, momentum, anomalyRisk, rawSeries.length);
  const riskIndicators   = buildRiskIndicators(target, predicted, historical, anomalyRisk, momentum);
  const scenarios        = generateScenarios(predicted, anomalyRisk.riskScore);

  // ── Category breakdown (async, non-blocking) ──
  const categoryBreakdown = await fetchCategoryBreakdown(businessId, 3);

  // ── Business interpretation ──
  const interpretation = buildInterpretation(target, historical, predicted, confidence, dataSource, momentum, anomalyRisk);
  const kpiSummary     = buildKpiSummary(target, historical, predicted, upper, lower, confidence, anomalyRisk);

  // ── Rolling statistics (for chart overlay) ──
  const rollingMeans = rollingMean(rawSeries, 3);
  const rollingStds  = rollingStd(rawSeries, 3);
  const rollingBounds = {
    upper: rawSeries.map((v, i) => Math.round((rollingMeans[i] + rollingStds[i]) * 1.1)),
    lower: rawSeries.map((v, i) => Math.round(Math.max(0, rollingMeans[i] - rollingStds[i] * 0.8))),
  };

  const result = {
    target,
    months:          horizonMonths,
    historical,
    predicted,
    upper,
    lower,
    labels:          [...histLabels, ...forecastLabels],
    confidence,
    dataSource,
    modelType:       'Holt-Winters Seasonal ES (Tri-exponential)',
    lookBack:        LOOK_BACK,
    sequencesUsed:   scaled.length,
    scalerParams:    { min, range },
    interpretation,
    kpiSummary,
    // NEW v3 fields
    scenarios,
    anomalyRisk,
    featureImportance,
    riskIndicators,
    momentum,
    categoryBreakdown,
    rollingBounds,
    generatedAt: new Date().toISOString(),
  };

  _cacheSet(cacheKey, result);
  return result;
}

/* ════════════════════════════════════════════════════════════════════════════
   BUSINESS GROWTH FORECAST
════════════════════════════════════════════════════════════════════════════ */
async function generateBusinessGrowthForecast(businessId, horizonMonths = 6) {
  const [monthlyData, anomalyRisk] = await Promise.all([
    fetchMonthlyData(businessId, 24),
    fetchAnomalyRisk(businessId),
  ]);

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
    if (revSeries[i - 1] > 0) momRates.push((revSeries[i] - revSeries[i - 1]) / revSeries[i - 1]);
  }
  const avgMoM = momRates.length ? mean(momRates) : 0.02;

  // Holt-Winters for revenue
  const { scaled: sr, min: rm, range: rr } = minMaxScale(revSeries);
  const lb = Math.min(6, sr.length - 1);
  const forecastRevenue = holtsWinters(sr.slice(-lb), horizonMonths, {
    period: Math.min(3, Math.max(2, lb - 1)),
  }).map(v => Math.round(inverseScale(v, rm, rr)));

  // Holt-Winters for profit
  const { scaled: sp, min: pm, range: pr } = minMaxScale(profitSeries);
  const forecastProfit = holtsWinters(sp.slice(-lb), horizonMonths, {
    period: Math.min(3, Math.max(2, lb - 1)),
  }).map(v => Math.round(inverseScale(v, pm, pr)));

  // Scenarios
  const revenueScenarios = generateScenarios(forecastRevenue, anomalyRisk.riskScore);
  const momentum         = computeTrendMomentum(revSeries);

  // Historical slice
  const histCount  = Math.min(6, revSeries.length);
  const histLabels = hasSufficientData
    ? monthlyData.slice(-histCount).map(m => MONTH_NAMES[m.month - 1])
    : Array.from({ length: histCount }, (_, i) => MONTH_NAMES[i % 12]);

  const lastIdx       = MONTH_NAMES.indexOf(histLabels[histLabels.length - 1]);
  const forecastLabels = Array.from({ length: horizonMonths }, (_, i) =>
    MONTH_NAMES[(lastIdx + 1 + i) % 12]
  );

  const lastRev         = revSeries[revSeries.length - 1] || 1;
  const cumulativeGrowth = ((forecastRevenue[forecastRevenue.length - 1] - lastRev) / lastRev) * 100;

  const growthTrend = cumulativeGrowth > 10  ? 'Strong Growth'
    : cumulativeGrowth > 2   ? 'Moderate Growth'
    : cumulativeGrowth > -2  ? 'Stable'
    : cumulativeGrowth > -10 ? 'Slight Decline'
    : 'Declining';

  const fmt = v => {
    if (v >= 1_000_000) return `PKR ${(v / 1_000_000).toFixed(2)}M`;
    if (v >= 1_000)    return `PKR ${(v / 1_000).toFixed(1)}K`;
    return `PKR ${Math.round(v).toLocaleString('en-PK')}`;
  };

  const totalForecastRev = forecastRevenue.reduce((a, b) => a + b, 0);
  let outlookText = `Your business is forecast to generate ${fmt(totalForecastRev)} in cumulative revenue over the next ${horizonMonths} months. `;
  if (cumulativeGrowth >= 0) {
    outlookText += `This represents a ${cumulativeGrowth.toFixed(1)}% growth trajectory`;
    if (momentum.acceleration > 2) outlookText += ` with accelerating momentum (+${momentum.acceleration.toFixed(1)}% acceleration)`;
    outlookText += ` — a positive indicator of business health.`;
  } else {
    outlookText += `Revenue appears to be contracting by ${Math.abs(cumulativeGrowth).toFixed(1)}%. Consider reviewing your sales and pricing strategy.`;
    if (anomalyRisk.hasUnreviewed) {
      outlookText += ` Note: ${anomalyRisk.pending} unreviewed anomalies may be affecting data quality.`;
    }
  }

  return {
    target: 'Business Growth',
    months: horizonMonths,
    historicalRevenue: revSeries.slice(-histCount).map(v => Math.round(v)),
    historicalProfit:  profitSeries.slice(-histCount).map(v => Math.round(v)),
    forecastRevenue,
    forecastProfit,
    histLabels,
    forecastLabels,
    avgMonthlyGrowthRate:    Math.round(avgMoM * 10000) / 100,
    cumulativeGrowthPercent: Math.round(cumulativeGrowth * 100) / 100,
    growthTrend,
    outlookText,
    dataSource: hasSufficientData ? 'live' : 'static',
    momentum,
    anomalyRisk,
    revenueScenarios,
    generatedAt: new Date().toISOString(),
  };
}

/* ════════════════════════════════════════════════════════════════════════════
   SCENARIO SIMULATION ENDPOINT HELPER
   Used by the new /forecast/scenario API.
════════════════════════════════════════════════════════════════════════════ */
async function simulateForecastScenario(businessId, target, horizonMonths, params = {}) {
  const {
    revenueMultiplier  = 1.0,  // e.g. 1.2 = 20% more revenue
    expenseMultiplier  = 1.0,  // e.g. 1.15 = 15% more expenses
    label              = 'Custom Scenario',
  } = params;

  // Get base forecast (cached)
  const base = await generateLSTMForecast(businessId, target, horizonMonths);

  const metricMultiplier = target === 'Expenses' ? expenseMultiplier : revenueMultiplier;

  const scenarioPredicted = base.predicted.map(v => Math.round(v * metricMultiplier));
  const scenarios = generateScenarios(scenarioPredicted, base.anomalyRisk?.riskScore || 0);

  return {
    ...base,
    label,
    predicted:       scenarioPredicted,
    scenarios,
    scenarioParams:  params,
    upper:           base.upper.map(v  => Math.round(v * metricMultiplier * 1.05)),
    lower:           base.lower.map(v  => Math.round(v * metricMultiplier * 0.95)),
    kpiSummary: buildKpiSummary(
      target, base.historical, scenarioPredicted,
      base.upper, base.lower, base.confidence, base.anomalyRisk
    ),
  };
}

module.exports = {
  generateLSTMForecast,
  generateBusinessGrowthForecast,
  fetchMonthlyData,
  simulateForecastScenario,
  fetchAnomalyRisk,
  fetchCategoryBreakdown,
  clearForecastCache,
};
