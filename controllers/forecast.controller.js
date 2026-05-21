// controllers/forecast.controller.js
const { generateLSTMForecast, generateBusinessGrowthForecast } = require('../services/forecasting/lstmForecastService');
const { formatForecastApiResponse } = require('../utils/forecastResponse.helper');
const ApiResponse = require('../utils/ApiResponse');
const { ApiError } = require('../utils/ApiError');

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
    const horizon  = parseHorizon(req);
    const raw      = await generateLSTMForecast(req.user.businessId, 'Revenue', horizon);
    const payload  = formatForecastApiResponse('revenue', horizon, raw);
    ApiResponse.success(res, payload, 'Revenue forecast generated');
  } catch (err) { next(err); }
};

/**
 * POST /api/v1/forecast/cashflow
 */
const forecastCashflow = async (req, res, next) => {
  try {
    const horizon  = parseHorizon(req);
    const raw      = await generateLSTMForecast(req.user.businessId, 'Net Cash Flow', horizon);
    const payload  = formatForecastApiResponse('netCashFlow', horizon, raw);
    ApiResponse.success(res, payload, 'Cash flow forecast generated');
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
 * GET /api/v1/forecast/health
 */
const forecastHealth = async (_req, res, next) => {
  try {
    const fs   = require('fs');
    const path = require('path');
    const dir  = path.join(__dirname, '..', 'ml_models');

    ApiResponse.success(res, {
      module: 'vousFin LSTM Forecasting Engine',
      status: 'operational',
      models: {
        lgbm:        fs.existsSync(path.join(dir, 'lgbm_model.txt'))   ? 'loaded' : 'missing',
        xgb:         fs.existsSync(path.join(dir, 'xgb_model.ubj'))    ? 'loaded' : 'missing',
        featureCols: fs.existsSync(path.join(dir, 'feature_cols.json')) ? 'loaded' : 'missing',
        ensemble:    fs.existsSync(path.join(dir, 'lgbm_model.txt')) && fs.existsSync(path.join(dir, 'xgb_model.ubj'))
          ? 'ready' : 'degraded',
      },
      lstmEngine:  'Holt\'s Double Exponential Smoothing (LOOK_BACK=6)',
      outputScale: 'raw PKR',
      endpoints:   ['/forecast/revenue', '/forecast/cashflow', '/forecast/business-growth'],
    }, 'Forecast engine health check');
  } catch (err) { next(err); }
};

module.exports = { forecastRevenue, forecastCashflow, forecastBusinessGrowth, forecastHealth };
