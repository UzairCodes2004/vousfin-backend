// controllers/procurementAnalytics.controller.js
//
// Phase 3.4 — Procurement Analytics + Cash Flow Forecast endpoints
//
'use strict';
const analyticsSvc     = require('../services/procurementAnalytics.service');
const forecastSvc      = require('../services/cashFlowForecast.service');
const auditSvc         = require('../services/procurementAudit.service');
const ApiResponse      = require('../utils/ApiResponse');

// ── Procurement Analytics ─────────────────────────────────────────────────────

const getVendorSpend = async (req, res, next) => {
  try {
    const { months = '12', limit = '10' } = req.query;
    const data = await analyticsSvc.vendorSpendAnalysis(req.businessId, {
      months: parseInt(months, 10),
      limit:  parseInt(limit,  10),
    });
    ApiResponse.success(res, data, 'Vendor spend analysis');
  } catch (e) { next(e); }
};

const getCycleTime = async (req, res, next) => {
  try {
    const { months = '6' } = req.query;
    const data = await analyticsSvc.cycleTimeAnalysis(req.businessId, { months: parseInt(months, 10) });
    ApiResponse.success(res, data, 'Cycle time analysis');
  } catch (e) { next(e); }
};

const getOverdueStats = async (req, res, next) => {
  try {
    const data = await analyticsSvc.overdueStats(req.businessId);
    ApiResponse.success(res, data, 'Overdue stats');
  } catch (e) { next(e); }
};

const getPaymentBehavior = async (req, res, next) => {
  try {
    const { months = '6' } = req.query;
    const data = await analyticsSvc.paymentBehaviorStats(req.businessId, { months: parseInt(months, 10) });
    ApiResponse.success(res, data, 'Payment behavior stats');
  } catch (e) { next(e); }
};

const getRecurringExpenses = async (req, res, next) => {
  try {
    const { months = '6' } = req.query;
    const data = await analyticsSvc.recurringExpenses(req.businessId, { months: parseInt(months, 10) });
    ApiResponse.success(res, data, 'Recurring expenses');
  } catch (e) { next(e); }
};

const getPurchasingEfficiency = async (req, res, next) => {
  try {
    const { months = '6' } = req.query;
    const data = await analyticsSvc.purchasingEfficiency(req.businessId, { months: parseInt(months, 10) });
    ApiResponse.success(res, data, 'Purchasing efficiency');
  } catch (e) { next(e); }
};

const getFullAnalytics = async (req, res, next) => {
  try {
    const { months = '6' } = req.query;
    const data = await analyticsSvc.fullAnalytics(req.businessId, { months: parseInt(months, 10) });
    ApiResponse.success(res, data, 'Full procurement analytics');
  } catch (e) { next(e); }
};

// ── Cash Flow Forecast ────────────────────────────────────────────────────────

const getPayableObligations = async (req, res, next) => {
  try {
    const { horizonDays = '90' } = req.query;
    const data = await forecastSvc.payableObligations(req.businessId, { horizonDays: parseInt(horizonDays, 10) });
    ApiResponse.success(res, data, 'Payable obligations');
  } catch (e) { next(e); }
};

const getCashRequirements = async (req, res, next) => {
  try {
    const data = await forecastSvc.cashRequirements(req.businessId);
    ApiResponse.success(res, data, 'Cash requirements');
  } catch (e) { next(e); }
};

const getUpcomingDueBills = async (req, res, next) => {
  try {
    const { days = '14', page = '1', limit = '20' } = req.query;
    const data = await forecastSvc.upcomingDueBills(req.businessId, {
      days:  parseInt(days,  10),
      page:  parseInt(page,  10),
      limit: parseInt(limit, 10),
    });
    ApiResponse.success(res, data, 'Upcoming due bills');
  } catch (e) { next(e); }
};

const getDashboardForecast = async (req, res, next) => {
  try {
    const data = await forecastSvc.dashboardForecast(req.businessId);
    ApiResponse.success(res, data, 'Dashboard forecast');
  } catch (e) { next(e); }
};

// ── Audit Trail ───────────────────────────────────────────────────────────────

const getEntityAuditTrail = async (req, res, next) => {
  try {
    const { entityType, entityId } = req.params;
    const { page = '1', limit = '50' } = req.query;
    const data = await auditSvc.getEntityHistory(req.businessId, entityType, entityId, {
      page:  parseInt(page, 10),
      limit: parseInt(limit, 10),
    });
    ApiResponse.success(res, data, 'Audit trail');
  } catch (e) { next(e); }
};

const getRecentActivity = async (req, res, next) => {
  try {
    const { limit = '30', entityType } = req.query;
    const data = await auditSvc.getRecentActivity(req.businessId, {
      limit: parseInt(limit, 10),
      entityType: entityType || null,
    });
    ApiResponse.success(res, data, 'Recent procurement activity');
  } catch (e) { next(e); }
};

const getActionSummary = async (req, res, next) => {
  try {
    const { days = '30' } = req.query;
    const data = await auditSvc.actionSummary(req.businessId, { days: parseInt(days, 10) });
    ApiResponse.success(res, data, 'Action summary');
  } catch (e) { next(e); }
};

module.exports = {
  // Analytics
  getVendorSpend, getCycleTime, getOverdueStats,
  getPaymentBehavior, getRecurringExpenses, getPurchasingEfficiency, getFullAnalytics,
  // Forecast
  getPayableObligations, getCashRequirements, getUpcomingDueBills, getDashboardForecast,
  // Audit
  getEntityAuditTrail, getRecentActivity, getActionSummary,
};
