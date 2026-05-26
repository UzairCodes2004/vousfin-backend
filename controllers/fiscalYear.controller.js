// controllers/fiscalYear.controller.js — Phase 5.1 Accounting Period Engine
'use strict';

const svc          = require('../services/fiscalYear.service');
const ApiResponse  = require('../utils/ApiResponse');
const { ApiError } = require('../utils/ApiError');

const _uid = (req) => req.user._id || req.user.id;
const _bid = (req) => req.user.businessId;

/* ── Fiscal Years ─────────────────────────────────────────────────────────── */

const createFiscalYear = async (req, res, next) => {
  try {
    const { name, startDate, endDate } = req.body;
    if (!name || !startDate || !endDate) throw new ApiError(400, 'name, startDate, endDate required');
    const fy = await svc.createFiscalYear(_bid(req), { name, startDate, endDate }, _uid(req));
    ApiResponse.success(res, fy, 'Fiscal year created with 12 monthly periods', 201);
  } catch (err) { next(err); }
};

const listFiscalYears = async (req, res, next) => {
  try {
    const years = await svc.listFiscalYears(_bid(req));
    ApiResponse.success(res, years, 'Fiscal years retrieved');
  } catch (err) { next(err); }
};

const getCurrentPeriod = async (req, res, next) => {
  try {
    const period = await svc.getCurrentPeriod(_bid(req));
    ApiResponse.success(res, period ?? null, 'Current accounting period');
  } catch (err) { next(err); }
};

/** POST /:fiscalYearId/close — run closing entries */
const runClosingEntries = async (req, res, next) => {
  try {
    const { reason = '' } = req.body || {};
    const result = await svc.closeFiscalYear(_bid(req), req.params.fiscalYearId, _uid(req), { reason });
    ApiResponse.success(res, result, 'Fiscal year closed and closing entries generated');
  } catch (err) { next(err); }
};

/** POST /:fiscalYearId/opening-balances — carry forward BS balances */
const createOpeningBalances = async (req, res, next) => {
  try {
    const result = await svc.createOpeningBalances(_bid(req), req.params.fiscalYearId, _uid(req));
    ApiResponse.success(res, result, `Opening balances created (${result.entriesCreated} entries)`, 201);
  } catch (err) { next(err); }
};

/** POST /:fiscalYearId/lock */
const lockFiscalYear = async (req, res, next) => {
  try {
    const { reason = '' } = req.body || {};
    const result = await svc.lockFiscalYear(_bid(req), req.params.fiscalYearId, _uid(req), { reason });
    ApiResponse.success(res, result, 'Fiscal year permanently locked');
  } catch (err) { next(err); }
};

/* ── Accounting Periods ───────────────────────────────────────────────────── */

const listPeriods = async (req, res, next) => {
  try {
    const periods = await svc.getPeriodsForYear(_bid(req), req.params.fiscalYearId);
    ApiResponse.success(res, periods, 'Accounting periods retrieved');
  } catch (err) { next(err); }
};

const closePeriod = async (req, res, next) => {
  try {
    const { reason = '' } = req.body || {};
    const result = await svc.closePeriod(_bid(req), req.params.periodId, _uid(req), { reason });
    ApiResponse.success(res, result, 'Period closed');
  } catch (err) { next(err); }
};

const lockPeriod = async (req, res, next) => {
  try {
    const { reason = '' } = req.body || {};
    const result = await svc.lockPeriod(_bid(req), req.params.periodId, _uid(req), { reason });
    ApiResponse.success(res, result, 'Period locked');
  } catch (err) { next(err); }
};

const reopenPeriod = async (req, res, next) => {
  try {
    const { reason = '' } = req.body || {};
    const result = await svc.reopenPeriod(_bid(req), req.params.periodId, _uid(req), { reason, isAdminOverride: true });
    ApiResponse.success(res, result, 'Period reopened');
  } catch (err) { next(err); }
};

/* ── Adjusting Entries ────────────────────────────────────────────────────── */

const createAdjustingEntry = async (req, res, next) => {
  try {
    const { adjustingType, periodId, description, amount, debitAccountId, creditAccountId, memo } = req.body;
    if (!adjustingType || !periodId || !amount || !debitAccountId || !creditAccountId) {
      throw new ApiError(400, 'adjustingType, periodId, amount, debitAccountId, creditAccountId required');
    }
    const entry = await svc.postAdjustingEntry(
      _bid(req),
      { adjustingType, periodId, description, amount, debitAccountId, creditAccountId, memo },
      _uid(req)
    );
    ApiResponse.success(res, entry, 'Adjusting entry posted', 201);
  } catch (err) { next(err); }
};

module.exports = {
  createFiscalYear,
  listFiscalYears,
  getCurrentPeriod,
  runClosingEntries,
  createOpeningBalances,
  lockFiscalYear,
  listPeriods,
  closePeriod,
  lockPeriod,
  reopenPeriod,
  createAdjustingEntry,
};
