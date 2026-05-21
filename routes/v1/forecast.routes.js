// routes/v1/forecast.routes.js
const express = require('express');
const router = express.Router();
const { forecastRevenue, forecastCashflow, forecastBusinessGrowth, forecastHealth } = require('../../controllers/forecast.controller');
const { authMiddleware } = require('../../middleware/auth.middleware');
const { requireBusiness } = require('../../middleware/business.middleware');
const validate = require('../../middleware/validate.middleware');
const Joi = require('joi');

const horizonSchema = Joi.object({
  horizon: Joi.number().valid(1, 2, 3, 6, 9, 12).default(6),
});

// All forecast routes require auth + business context
router.use(authMiddleware, requireBusiness);

// Health check (no body validation needed)
router.get('/health', forecastHealth);

// Revenue forecast
router.post('/revenue', validate(horizonSchema), forecastRevenue);

// Cash flow forecast
router.post('/cashflow', validate(horizonSchema), forecastCashflow);

// Business growth forecast
router.post('/business-growth', validate(horizonSchema), forecastBusinessGrowth);

module.exports = router;
