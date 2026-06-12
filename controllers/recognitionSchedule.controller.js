// controllers/recognitionSchedule.controller.js
//
// Phase 4 — Accrual accounting: HTTP layer over recognitionSchedule.service.
//
const recognitionService = require('../services/recognitionSchedule.service');
const ApiResponse = require('../utils/ApiResponse');

function actor(req) {
  return { _id: req.user.id, fullName: req.user.fullName, email: req.user.email, role: req.user.role };
}

exports.create = async (req, res, next) => {
  try {
    const schedule = await recognitionService.createSchedule(req.user.businessId, req.body, actor(req));
    ApiResponse.created(res, schedule, 'Recognition schedule created');
  } catch (err) { next(err); }
};

exports.list = async (req, res, next) => {
  try {
    const schedules = await recognitionService.list(req.user.businessId, {
      type: req.query.type || null,
      status: req.query.status || null,
    });
    ApiResponse.success(res, schedules, 'Recognition schedules retrieved');
  } catch (err) { next(err); }
};

exports.getById = async (req, res, next) => {
  try {
    const schedule = await recognitionService.getById(req.user.businessId, req.params.id);
    ApiResponse.success(res, schedule, 'Recognition schedule retrieved');
  } catch (err) { next(err); }
};

exports.cancel = async (req, res, next) => {
  try {
    const schedule = await recognitionService.cancelSchedule(req.user.businessId, req.params.id, actor(req));
    ApiResponse.success(res, schedule, 'Recognition schedule cancelled');
  } catch (err) { next(err); }
};

// Manually post any recognition lines that are due now (also runs daily via cron).
exports.postDue = async (req, res, next) => {
  try {
    const result = await recognitionService.postDueRecognitions(req.user.businessId, new Date());
    ApiResponse.success(res, result, `Posted ${result.linesPosted} due recognition entries`);
  } catch (err) { next(err); }
};
