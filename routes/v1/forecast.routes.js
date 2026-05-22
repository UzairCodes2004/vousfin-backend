// routes/v1/forecast.routes.js — v3
const express = require('express');
const router  = express.Router();
const {
  forecastRevenue,
  forecastCashflow,
  forecastExpenses,
  forecastBusinessGrowth,
  forecastScenario,
  getCategoryBreakdown,
  getAnomalyRisk,
  invalidateCache,
  forecastHealth,
} = require('../../controllers/forecast.controller');
const { authMiddleware }   = require('../../middleware/auth.middleware');
const { requireBusiness }  = require('../../middleware/business.middleware');
const validate             = require('../../middleware/validate.middleware');
const Joi                  = require('joi');

const horizonSchema = Joi.object({
  horizon: Joi.number().valid(1, 2, 3, 6, 9, 12).default(6),
});

const scenarioSchema = Joi.object({
  metric:            Joi.string().valid('revenue', 'expenses', 'netCashFlow').default('revenue'),
  horizon:           Joi.number().valid(1, 2, 3, 6, 9, 12).default(6),
  revenueMultiplier: Joi.number().min(0.5).max(2.0).default(1.0),
  expenseMultiplier: Joi.number().min(0.5).max(2.0).default(1.0),
  label:             Joi.string().max(80).optional().allow(''),
});

// All routes require auth + business context
router.use(authMiddleware, requireBusiness);

// Health check
router.get('/health', forecastHealth);

// Core forecasts
router.post('/revenue',          validate(horizonSchema), forecastRevenue);
router.post('/cashflow',         validate(horizonSchema), forecastCashflow);
router.post('/expenses',         validate(horizonSchema), forecastExpenses);
router.post('/business-growth',  validate(horizonSchema), forecastBusinessGrowth);

// New v3 endpoints
router.post('/scenario',          validate(scenarioSchema), forecastScenario);
router.get('/category-breakdown', getCategoryBreakdown);
router.get('/anomaly-risk',       getAnomalyRisk);
router.post('/invalidate-cache',  invalidateCache);

module.exports = router;
