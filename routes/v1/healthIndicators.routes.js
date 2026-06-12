// routes/v1/healthIndicators.routes.js — FR-03.2 (40+ live health indicators)
'use strict';

const express = require('express');
const router = express.Router();
const { authMiddleware }  = require('../../middleware/auth.middleware');
const { requireBusiness } = require('../../middleware/business.middleware');
const healthIndicators = require('../../services/healthIndicators.service');
const ApiResponse = require('../../utils/ApiResponse');

router.use(authMiddleware, requireBusiness);

/** All 42 indicators with zones — computed live from the GL. */
router.get('/', async (req, res, next) => {
  try {
    const data = await healthIndicators.compute(req.user.businessId);
    ApiResponse.success(res, data, 'Health indicators computed');
  } catch (err) { next(err); }
});

/** Evaluate + fire alerts for red-zone breaches (cron + posting hook do this automatically). */
router.post('/evaluate', async (req, res, next) => {
  try {
    const data = await healthIndicators.evaluateAndAlert(req.user.businessId);
    ApiResponse.success(res, data, 'Health evaluation complete');
  } catch (err) { next(err); }
});

module.exports = router;
