// controllers/forecast.controller.js — v3
const {
  generateLSTMForecast,
  generateBusinessGrowthForecast,
  simulateForecastScenario,
  fetchAnomalyRisk,
  fetchCategoryBreakdown,
  clearForecastCache,
} = require('../services/forecasting/lstmForecastService');
const { formatForecastApiResponse } = require('../utils/forecastResponse.helper');
const ApiResponse = require('../utils/ApiResponse');
const { ApiError } = require('../utils/ApiError');
const { lstmStatus } = require('../utils/lstmService');

const METRIC_API_TO_TARGET = {
  revenue:     'Revenue',
  expenses:    'Expenses',
  netCashFlow: 'Net Cash Flow',
};

const VALID_HORIZONS = [1, 2, 3, 6, 9, 12];

function parseHorizon(req) {
  const h = parseInt(req.body?.horizon ?? req.query?.months ?? 6, 10);
  if (!VALID_HORIZONS.includes(h)) {
    throw new ApiError(400, `horizon must be one of: ${VALID_HORIZONS.join(', ')}`);
  }
  return h;
}

/**
 * POST /api/v1/forecast/revenue
 */
const forecastRevenue = async (req, res, next) => {
  try {
    const horizon = parseHorizon(req);
    const raw     = await generateLSTMForecast(req.user.businessId, 'Revenue', horizon);
    const payload = formatForecastApiResponse('revenue', horizon, raw);
    ApiResponse.success(res, payload, 'Revenue forecast generated');
  } catch (err) { next(err); }
};

/**
 * POST /api/v1/forecast/cashflow
 */
const forecastCashflow = async (req, res, next) => {
  try {
    const horizon = parseHorizon(req);
    const raw     = await generateLSTMForecast(req.user.businessId, 'Net Cash Flow', horizon);
    const payload = formatForecastApiResponse('netCashFlow', horizon, raw);
    ApiResponse.success(res, payload, 'Cash flow forecast generated');
  } catch (err) { next(err); }
};

/**
 * POST /api/v1/forecast/expenses
 */
const forecastExpenses = async (req, res, next) => {
  try {
    const horizon = parseHorizon(req);
    const raw     = await generateLSTMForecast(req.user.businessId, 'Expenses', horizon);
    const payload = formatForecastApiResponse('expenses', horizon, raw);
    ApiResponse.success(res, payload, 'Expense forecast generated');
  } catch (err) { next(err); }
};

/**
 * POST /api/v1/forecast/business-growth
 */
const forecastBusinessGrowth = async (req, res, next) => {
  try {
    const horizon = parseHorizon(req);
    const data    = await generateBusinessGrowthForecast(req.user.businessId, horizon);
    ApiResponse.success(res, data, 'Business growth forecast generated');
  } catch (err) { next(err); }
};

/**
 * POST /api/v1/forecast/scenario
 * What-if simulation — applies multipliers to base forecast.
 * Body: { metric, horizon, revenueMultiplier, expenseMultiplier, label }
 */
const forecastScenario = async (req, res, next) => {
  try {
    const {
      metric             = 'revenue',
      revenueMultiplier  = 1.0,
      expenseMultiplier  = 1.0,
      label              = 'Custom Scenario',
    } = req.body || {};

    const horizon = parseHorizon(req);
    const target  = METRIC_API_TO_TARGET[metric] || 'Revenue';

    // Clamp multipliers to safe range [0.5, 2.0]
    const revMult  = Math.max(0.5, Math.min(2.0, Number(revenueMultiplier)  || 1));
    const expMult  = Math.max(0.5, Math.min(2.0, Number(expenseMultiplier) || 1));

    const raw     = await simulateForecastScenario(
      req.user.businessId, target, horizon,
      { revenueMultiplier: revMult, expenseMultiplier: expMult, label }
    );
    const payload = formatForecastApiResponse(metric, horizon, raw);
    payload.scenarioLabel  = label;
    payload.scenarioParams = { revenueMultiplier: revMult, expenseMultiplier: expMult };
    ApiResponse.success(res, payload, `Scenario "${label}" generated`);
  } catch (err) { next(err); }
};

/**
 * GET /api/v1/forecast/category-breakdown
 * Top spending/revenue categories for last 3 months.
 */
const getCategoryBreakdown = async (req, res, next) => {
  try {
    const months = parseInt(req.query?.months || '3', 10);
    const data   = await fetchCategoryBreakdown(req.user.businessId, Math.min(months, 12));
    ApiResponse.success(res, { categories: data, months }, 'Category breakdown retrieved');
  } catch (err) { next(err); }
};

/**
 * GET /api/v1/forecast/anomaly-risk
 * Standalone anomaly risk score for forecast confidence.
 */
const getAnomalyRisk = async (req, res, next) => {
  try {
    const data = await fetchAnomalyRisk(req.user.businessId);
    ApiResponse.success(res, data, 'Anomaly risk retrieved');
  } catch (err) { next(err); }
};

/**
 * POST /api/v1/forecast/invalidate-cache
 * Force cache invalidation for this business (admin / after new transactions).
 */
const invalidateCache = async (req, res, next) => {
  try {
    clearForecastCache(req.user.businessId);
    ApiResponse.success(res, { cleared: true }, 'Forecast cache cleared');
  } catch (err) { next(err); }
};

/**
 * GET /api/v1/forecast/health
 */
const forecastHealth = async (_req, res, next) => {
  try {
    let lstmReady = false;
    const LSTM_API_URL = process.env.LSTM_API_URL || 'http://localhost:8000';
    try {
      const ctrl = new AbortController();
      const tid  = setTimeout(() => ctrl.abort(), 2500);
      const r    = await fetch(`${LSTM_API_URL}/api/v1/vousfin/health`, { signal: ctrl.signal });
      clearTimeout(tid);
      if (r.ok) { const b = await r.json(); lstmReady = b.ready === true; }
    } catch { /* Python service not running */ }

    const svc = lstmStatus();
    ApiResponse.success(res, {
      module:  'vousFin Forecasting Engine v3',
      status:  'operational',
      lstmReady,
      lstmProcess: { running: svc.running, ready: svc.ready, starting: svc.starting, autoStart: svc.autoStart },
      lstmEngine: lstmReady
        ? 'Bi-LSTM + Multi-Scale Attention v2 (Python microservice)'
        : 'Holt-Winters Triple ES (JS fallback)',
      outputScale: 'raw PKR',
      endpoints:   ['/forecast/revenue', '/forecast/cashflow', '/forecast/expenses', '/forecast/business-growth', '/forecast/scenario', '/forecast/category-breakdown'],
    }, 'Forecast engine health check');
  } catch (err) { next(err); }
};

module.exports = {
  forecastRevenue,
  forecastCashflow,
  forecastExpenses,
  forecastBusinessGrowth,
  forecastScenario,
  getCategoryBreakdown,
  getAnomalyRisk,
  invalidateCache,
  forecastHealth,
};
