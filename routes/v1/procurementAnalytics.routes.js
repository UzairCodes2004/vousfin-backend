// routes/v1/procurementAnalytics.routes.js
// Phase 3.4 — Procurement Analytics + Cash Flow Forecast + Audit Trail
'use strict';
const express = require('express');
const router  = express.Router();
const { authMiddleware } = require('../../middleware/auth.middleware');
const { requireBusiness } = require('../../middleware/procurementPermissions');
const ctrl = require('../../controllers/procurementAnalytics.controller');

router.use(authMiddleware);
router.use(requireBusiness);

// ── Procurement Analytics ─────────────────────────────────────────────────────
router.get('/vendor-spend',          ctrl.getVendorSpend);
router.get('/cycle-time',            ctrl.getCycleTime);
router.get('/overdue-stats',         ctrl.getOverdueStats);
router.get('/payment-behavior',      ctrl.getPaymentBehavior);
router.get('/recurring-expenses',    ctrl.getRecurringExpenses);
router.get('/purchasing-efficiency', ctrl.getPurchasingEfficiency);
router.get('/full',                  ctrl.getFullAnalytics);

// ── Cash Flow Forecast ────────────────────────────────────────────────────────
router.get('/forecast/obligations',    ctrl.getPayableObligations);
router.get('/forecast/requirements',   ctrl.getCashRequirements);
router.get('/forecast/upcoming-bills', ctrl.getUpcomingDueBills);
router.get('/forecast/dashboard',      ctrl.getDashboardForecast);

// ── Audit Trail ───────────────────────────────────────────────────────────────
router.get('/audit/:entityType/:entityId', ctrl.getEntityAuditTrail);
router.get('/audit/activity',              ctrl.getRecentActivity);
router.get('/audit/summary',               ctrl.getActionSummary);

module.exports = router;
