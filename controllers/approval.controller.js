// controllers/approval.controller.js
const approvalService = require('../services/approval.service');
const ApiResponse = require('../utils/ApiResponse');

/** GET /api/v1/approvals/settings */
const getSettings = async (req, res, next) => {
  try {
    const settings = await approvalService.getSettings(req.user.businessId);
    ApiResponse.success(res, settings, 'Approval settings retrieved');
  } catch (error) { next(error); }
};

/** PUT /api/v1/approvals/settings */
const updateSettings = async (req, res, next) => {
  try {
    const settings = await approvalService.updateSettings(req.user.businessId, req.body, req.user);
    ApiResponse.success(res, settings, 'Approval settings updated');
  } catch (error) { next(error); }
};

/** GET /api/v1/approvals?status=pending&page=&limit= */
const list = async (req, res, next) => {
  try {
    const result = await approvalService.list(req.user.businessId, {
      status: req.query.status,
      page:  parseInt(req.query.page, 10)  || 1,
      limit: parseInt(req.query.limit, 10) || 50,
    });
    ApiResponse.success(res, result, 'Pending transactions retrieved');
  } catch (error) { next(error); }
};

/** GET /api/v1/approvals/count — pending count for the nav badge */
const count = async (req, res, next) => {
  try {
    const pending = await approvalService.pendingCount(req.user.businessId);
    ApiResponse.success(res, { pending }, 'Pending count retrieved');
  } catch (error) { next(error); }
};

/** GET /api/v1/approvals/:id */
const getById = async (req, res, next) => {
  try {
    const p = await approvalService.getById(req.params.id, req.user.businessId);
    ApiResponse.success(res, p, 'Pending transaction retrieved');
  } catch (error) { next(error); }
};

/** POST /api/v1/approvals/:id/approve  Body: { note? } */
const approve = async (req, res, next) => {
  try {
    const result = await approvalService.approve(
      req.params.id, req.user.businessId, req.user, req.ip, req.body?.note
    );
    ApiResponse.success(res, result, 'Approved and posted to the ledger');
  } catch (error) { next(error); }
};

/** POST /api/v1/approvals/:id/reject  Body: { reason? } */
const reject = async (req, res, next) => {
  try {
    const p = await approvalService.reject(
      req.params.id, req.user.businessId, req.user, req.ip, req.body?.reason
    );
    ApiResponse.success(res, p, 'Transaction rejected');
  } catch (error) { next(error); }
};

/** POST /api/v1/approvals/:id/cancel */
const cancel = async (req, res, next) => {
  try {
    const p = await approvalService.cancel(req.params.id, req.user.businessId, req.user);
    ApiResponse.success(res, p, 'Request cancelled');
  } catch (error) { next(error); }
};

module.exports = { getSettings, updateSettings, list, count, getById, approve, reject, cancel };
