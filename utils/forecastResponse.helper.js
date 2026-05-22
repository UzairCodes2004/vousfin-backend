/**
 * forecastResponse.helper.js — v3
 *
 * Transforms lstmForecastService output into the API response shape
 * consumed by the frontend. All monetary values stay in raw PKR.
 *
 * v3 additions:
 *  - scenarios (optimistic/base/pessimistic)
 *  - featureImportance
 *  - riskIndicators
 *  - anomalyRisk in kpiSummary
 *  - momentum object
 *  - categoryBreakdown
 */

const METRIC_API_TO_TARGET = {
  revenue:     'Revenue',
  expenses:    'Expenses',
  netCashFlow: 'Net Cash Flow',
};

/* ── Label → ISO date ── */
const MONTH_IDX = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };

function labelToIsoDate(label, fallbackIndex) {
  const mIdx = MONTH_IDX[label] ?? (fallbackIndex % 12);
  const now  = new Date();
  let year   = now.getFullYear();
  if (mIdx < now.getMonth() && fallbackIndex >= 6) year += 1;
  return new Date(year, mIdx, 1).toISOString();
}

/* ── Parallel value/label arrays → chart-point objects ── */
function seriesToChartPoints(values, labels, startIndex) {
  return values.map((value, i) => {
    const label = labels[startIndex + i] || `M${startIndex + i + 1}`;
    return {
      period: label,
      date:   labelToIsoDate(label, startIndex + i),
      value:  value ?? 0,
    };
  });
}

/* ── Rich interpretation → flat insight list ── */
function interpretationToList(interp) {
  if (!interp) return [];
  return [
    interp.trend          && { type: 'trend',          text: interp.trend          },
    interp.growth         && { type: 'growth',         text: interp.growth         },
    interp.risk           && { type: 'risk',           text: interp.risk           },
    interp.recommendation && { type: 'recommendation', text: interp.recommendation },
    interp.sourceNote     && { type: 'info',           text: interp.sourceNote     },
  ].filter(Boolean);
}

/**
 * Main formatter — called by ai.controller and forecast.controller.
 *
 * @param {string} metric  – 'revenue'|'expenses'|'netCashFlow'
 * @param {number} horizon – months
 * @param {object} result  – raw output from generateLSTMForecast()
 */
function formatForecastApiResponse(metric, horizon, result) {
  const {
    historical        = [],
    predicted         = [],
    upper             = [],
    lower             = [],
    labels            = [],
    confidence        = [],
    target,
    interpretation,
    kpiSummary,
    dataSource,
    modelType,
    lookBack,
    sequencesUsed,
    // v3 fields
    scenarios,
    anomalyRisk,
    featureImportance,
    riskIndicators,
    momentum,
    categoryBreakdown,
  } = result;

  const historicalPoints = seriesToChartPoints(historical, labels, 0);
  const predictedPoints  = seriesToChartPoints(predicted,  labels, historical.length);

  const confLabel  = confidence[0] ?? 'Medium';
  const baseScore  = confLabel === 'High' ? 92 : confLabel === 'Medium' ? 85 : 74;
  const penalty    = anomalyRisk?.confidencePenalty || 0;
  const confScore  = Math.max(50, baseScore - penalty);

  const confidenceIntervals = predicted.map((_, i) => ({
    upper: upper[i] ?? predicted[i],
    lower: lower[i] ?? predicted[i],
  }));

  const insights = interpretationToList(interpretation);

  // Scenario chart points
  const scenarioPoints = scenarios ? {
    optimistic:  seriesToChartPoints(scenarios.optimistic,  labels, historical.length),
    base:        seriesToChartPoints(scenarios.base,         labels, historical.length),
    pessimistic: seriesToChartPoints(scenarios.pessimistic,  labels, historical.length),
  } : null;

  const normSource = dataSource || 'static';
  const normModel  = modelType  || 'LSTM';

  return {
    metric: metric || target,
    target,
    months: horizon,

    // Backward-compat shortcuts
    dataSource: normSource,
    modelType:  normModel,

    // Chart series (raw PKR)
    historical: historicalPoints,
    predicted:  predictedPoints,
    forecast:   predictedPoints,  // alias

    // Confidence
    confidenceIntervals,
    confidenceScore:   `${confScore}%`,
    confidenceNumeric: confScore,
    confidenceLabel:   confLabel,

    // KPI summary (enriched with anomalyRisk)
    kpiSummary: kpiSummary
      ? { ...kpiSummary, anomalyRisk: anomalyRisk?.riskScore || kpiSummary.anomalyRisk || 0 }
      : null,

    // Insights
    insights,

    // Model metadata
    modelMeta: {
      modelType:     normModel,
      lookBack:      lookBack      ?? 6,
      sequencesUsed: sequencesUsed ?? 0,
      dataSource:    normSource,
    },

    // ── v3 additions ──
    scenarios:         scenarioPoints,
    rawScenarios:      scenarios   || null,
    anomalyRisk:       anomalyRisk || null,
    featureImportance: featureImportance || [],
    riskIndicators:    riskIndicators    || [],
    momentum:          momentum          || null,
    categoryBreakdown: categoryBreakdown || [],
  };
}

module.exports = { METRIC_API_TO_TARGET, formatForecastApiResponse };
