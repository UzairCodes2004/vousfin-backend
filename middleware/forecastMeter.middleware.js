// middleware/forecastMeter.middleware.js — F9 usage metering (fire-and-forget).
'use strict';
const usageMeter = require('../services/forecasting/usageMeter.service');

module.exports = function forecastMeter(req, res, next) {
  try {
    if (req.user && req.user.businessId) {
      usageMeter.record(req.user.businessId, req.baseUrl || req.originalUrl.split('?')[0]).catch(() => {});
    }
  } catch { /* never block the request */ }
  next();
};
