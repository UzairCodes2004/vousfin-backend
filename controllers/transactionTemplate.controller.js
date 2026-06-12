// controllers/transactionTemplate.controller.js
const templateService = require('../services/transactionTemplate.service');
const ApiResponse = require('../utils/ApiResponse');

/** GET /api/v1/transaction-templates */
const list = async (req, res, next) => {
  try {
    const isActive = req.query.isActive === undefined ? undefined : req.query.isActive === 'true';
    const templates = await templateService.list(req.user.businessId, { isActive });
    ApiResponse.success(res, templates, 'Templates retrieved');
  } catch (error) { next(error); }
};

/** GET /api/v1/transaction-templates/:id */
const getById = async (req, res, next) => {
  try {
    const tpl = await templateService.getById(req.params.id, req.user.businessId);
    ApiResponse.success(res, tpl, 'Template retrieved');
  } catch (error) { next(error); }
};

/** POST /api/v1/transaction-templates */
const create = async (req, res, next) => {
  try {
    const tpl = await templateService.create(req.user.businessId, req.body, req.user);
    ApiResponse.created(res, tpl, 'Template saved');
  } catch (error) { next(error); }
};

/** PUT /api/v1/transaction-templates/:id */
const update = async (req, res, next) => {
  try {
    const tpl = await templateService.update(req.params.id, req.user.businessId, req.body, req.user);
    ApiResponse.success(res, tpl, 'Template updated');
  } catch (error) { next(error); }
};

/** DELETE /api/v1/transaction-templates/:id */
const remove = async (req, res, next) => {
  try {
    const result = await templateService.remove(req.params.id, req.user.businessId);
    ApiResponse.success(res, result, 'Template deleted');
  } catch (error) { next(error); }
};

/**
 * POST /api/v1/transaction-templates/:id/apply
 * Post a real transaction from the template (subject to the approval gate).
 * Body (optional): { transactionDate, amount, description, partyName }
 */
const apply = async (req, res, next) => {
  try {
    const result = await templateService.applyTemplate(
      req.params.id, req.user.businessId, req.user, req.ip, req.body || {}
    );
    if (result.pendingApproval) {
      return ApiResponse.created(res, result.pendingTransaction,
        `Submitted for approval (amount exceeds the ${result.threshold} limit)`);
    }
    ApiResponse.created(res, result.transaction, 'Transaction posted from template');
  } catch (error) { next(error); }
};

/**
 * POST /api/v1/transaction-templates/run-due
 * Manually trigger the recurring generator (also runs on a daily cron).
 */
const runDue = async (req, res, next) => {
  try {
    const result = await templateService.generateDueRecurring(new Date());
    ApiResponse.success(res, result,
      `Recurring run complete: ${result.generated} posted, ${result.pending} pending approval`);
  } catch (error) { next(error); }
};

module.exports = { list, getById, create, update, remove, apply, runDue };
