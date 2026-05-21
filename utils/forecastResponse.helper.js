/**
 * forecastResponse.helper.js
 *
 * Transforms the raw lstmForecastService output into the API response shape
 * consumed by the frontend. All monetary values stay in raw PKR — the frontend
 * formatter (formatCurrency / Y-axis tick) handles display scaling.
 */

const METRIC_API_TO_TARGET = {
  revenue:     'Revenue',
  expenses:    'Expenses',
  netCashFlow: 'Net Cash Flow',
};

/* ── Label → ISO date (first day of that calendar month) ── */
const MONTH_IDX = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };

function labelToIsoDate(label, fallbackIndex) {
  const mIdx  = MONTH_IDX[label] ?? (fallbackIndex % 12);
  // If the label month is earlier than today, put it in next year (it's a forecast label)
  const now   = new Date();
  let   year  = now.getFullYear();
  if (mIdx < now.getMonth() && fallbackIndex >= 6) year += 1;
  return new Date(year, mIdx, 1).toISOString();
}

/* ── Convert parallel value/label arrays into chart-point objects ── */
function seriesToChartPoints(values, labels, startIndex) {
  return values.map((value, i) => {
    const label = labels[startIndex + i] || `M${startIndex + i + 1}`;
    return {
      period: label,
      date:   labelToIsoDate(label, startIndex + i),
      value:  value ?? 0,   // raw PKR — never null/undefined
    };
  });
}

/* ── Convert the rich interpretation object to a flat list of insight items ── */
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
 * Main formatter — called by both ai.controller and forecast.controller.
 *
 * @param {string} metric  – API metric key ('revenue'|'expenses'|'netCashFlow')
 * @param {number} horizon – months
 * @param {object} result  – raw output from generateLSTMForecast()
 */
function formatForecastApiResponse(metric, horizon, result) {
  const {
    historical  = [],
    predicted   = [],
    upper       = [],
    lower       = [],
    labels      = [],
    confidence  = [],
    target,
    interpretation,
    kpiSummary,
    dataSource,
    modelType,
    lookBack,
    sequencesUsed,
  } = result;

  const historicalPoints = seriesToChartPoints(historical, labels, 0);
  const predictedPoints  = seriesToChartPoints(predicted,  labels, historical.length);

  // Confidence score as human-readable string + numeric
  const confLabel  = confidence[0] ?? 'Medium';
  const confScore  = confLabel === 'High' ? 92 : confLabel === 'Medium' ? 85 : 74;
  const confString = `${confScore}%`;

  // Confidence bands as chart-friendly [lo, hi] pairs
  const confidenceIntervals = predicted.map((_, i) => ({
    upper: upper[i] ?? predicted[i],
    lower: lower[i] ?? predicted[i],
  }));

  // Insight items — prefer the rich interpretation from lstmForecastService,
  // fall back to the legacy generateInsights() shape when using static service.
  const insights = interpretationToList(interpretation);

  return {
    metric: metric || target,
    target,
    months: horizon,

    // Chart series — raw PKR values in {period, date, value} format
    historical: historicalPoints,
    predicted:  predictedPoints,
    forecast:   predictedPoints,   // alias kept for backward compat

    // Confidence bands
    confidenceIntervals,
    confidenceScore: confString,
    confidenceNumeric: confScore,
    confidenceLabel: confLabel,

    // Business-readable KPI summary (all monetary values raw PKR)
    kpiSummary: kpiSummary || null,

    // Human-readable text insights (no raw ML values)
    insights,

    // Model metadata (non-sensitive)
    modelMeta: {
      modelType:     modelType     || 'LSTM',
      lookBack:      lookBack      ?? 6,
      sequencesUsed: sequencesUsed ?? 0,
      dataSource:    dataSource    || 'static',
    },
  };
}

module.exports = { METRIC_API_TO_TARGET, formatForecastApiResponse };
