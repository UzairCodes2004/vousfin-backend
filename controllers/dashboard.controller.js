// controllers/dashboard.controller.js
const dashboardService = require('../services/dashboard.service');
const ApiResponse = require('../utils/ApiResponse');
const { ApiError } = require('../utils/ApiError');

// ─── Date helpers ─────────────────────────────────────────────────────────────
// Plain date strings from <input type="date"> ("2026-06-03") parse to midnight
// UTC, silently excluding every same-day transaction from balance queries.
// We shift end/as-of dates to 23:59:59.999 UTC so "today" means "all of today".
function toEndOfDay(dateStr) {
  const d = new Date(dateStr);
  if (
    d.getUTCHours()        === 0 &&
    d.getUTCMinutes()      === 0 &&
    d.getUTCSeconds()      === 0 &&
    d.getUTCMilliseconds() === 0
  ) {
    d.setUTCHours(23, 59, 59, 999);
  }
  return d;
}
const toStartOfDay = (dateStr) => new Date(dateStr);

// ─── Shared: resolve effective date window ────────────────────────────────────
function resolveDateWindow(startDate, endDate) {
  if (!startDate || !endDate) {
    // Default: current month YTD (end = right now so real-time cash is correct)
    const now = new Date();
    return {
      effectiveStart: new Date(now.getFullYear(), now.getMonth(), 1),
      effectiveEnd:   now,
    };
  }
  return {
    effectiveStart: toStartOfDay(startDate),
    effectiveEnd:   toEndOfDay(endDate),
  };
}

/**
 * Get KPI widget values.
 * GET /api/v1/dashboard/kpis
 * Query: startDate, endDate (optional, ISO date strings)
 */
const getKPIs = async (req, res, next) => {
  try {
    const { startDate, endDate } = req.query;
    const { effectiveStart, effectiveEnd } = resolveDateWindow(startDate, endDate);
    const kpis = await dashboardService.getKPIs(req.user.businessId, effectiveStart, effectiveEnd);
    ApiResponse.success(res, kpis, 'Dashboard KPIs retrieved');
  } catch (error) {
    next(error);
  }
};

/**
 * Get revenue vs expenses chart data.
 * GET /api/v1/dashboard/revenue-vs-expenses
 * Query: startDate, endDate, interval (day/week/month, default month)
 */
const getRevenueVsExpenses = async (req, res, next) => {
  try {
    const { startDate, endDate, interval = 'month' } = req.query;
    const { effectiveStart, effectiveEnd } = resolveDateWindow(startDate, endDate);
    const chartData = await dashboardService.getRevenueVsExpensesChart(
      req.user.businessId, effectiveStart, effectiveEnd, interval
    );
    ApiResponse.success(res, chartData, 'Revenue vs expenses chart data retrieved');
  } catch (error) {
    next(error);
  }
};

/**
 * Get cash flow trend chart data.
 * GET /api/v1/dashboard/cash-flow-trend
 * Query: startDate, endDate, interval (day/week/month, default month)
 */
const getCashFlowTrend = async (req, res, next) => {
  try {
    const { startDate, endDate, interval = 'month' } = req.query;
    const { effectiveStart, effectiveEnd } = resolveDateWindow(startDate, endDate);
    const chartData = await dashboardService.getCashFlowTrend(
      req.user.businessId, effectiveStart, effectiveEnd, interval
    );
    ApiResponse.success(res, chartData, 'Cash flow trend chart data retrieved');
  } catch (error) {
    next(error);
  }
};

/**
 * Get all dashboard data in one call (KPIs + both charts).
 * GET /api/v1/dashboard/all
 * Query: startDate, endDate, interval (optional)
 */
const getAllDashboardData = async (req, res, next) => {
  try {
    const { startDate, endDate, interval = 'month' } = req.query;
    const { effectiveStart, effectiveEnd } = resolveDateWindow(startDate, endDate);
    const data = await dashboardService.getAllDashboardData(
      req.user.businessId, effectiveStart, effectiveEnd, interval
    );
    ApiResponse.success(res, data, 'Dashboard data retrieved');
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getKPIs,
  getRevenueVsExpenses,
  getCashFlowTrend,
  getAllDashboardData,
};