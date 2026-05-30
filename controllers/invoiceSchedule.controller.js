// controllers/invoiceSchedule.controller.js — AR/AP M8 (recurring invoices)
'use strict';
const invoiceSchedulerService = require('../services/invoiceScheduler.service');
const ApiResponse = require('../utils/ApiResponse');

exports.create = async (req, res, next) => {
  try {
    const schedule = await invoiceSchedulerService.create(req.user.businessId, req.body, req.user);
    ApiResponse.created(res, schedule, 'Invoice schedule created');
  } catch (err) { next(err); }
};

exports.list = async (req, res, next) => {
  try {
    const { isActive } = req.query;
    const opts = {};
    if (isActive !== undefined) opts.isActive = isActive === 'true';
    const schedules = await invoiceSchedulerService.list(req.user.businessId, opts);
    ApiResponse.success(res, schedules);
  } catch (err) { next(err); }
};

exports.getById = async (req, res, next) => {
  try {
    const s = await invoiceSchedulerService.getById(req.params.id, req.user.businessId);
    ApiResponse.success(res, s);
  } catch (err) { next(err); }
};

exports.update = async (req, res, next) => {
  try {
    const s = await invoiceSchedulerService.update(req.params.id, req.user.businessId, req.body);
    ApiResponse.success(res, s, 'Schedule updated');
  } catch (err) { next(err); }
};

exports.deactivate = async (req, res, next) => {
  try {
    const s = await invoiceSchedulerService.deactivate(req.params.id, req.user.businessId);
    ApiResponse.success(res, s, 'Schedule deactivated');
  } catch (err) { next(err); }
};

// Admin-only: manually trigger generation (cron does this daily).
exports.triggerGenerate = async (req, res, next) => {
  try {
    const ids = await invoiceSchedulerService.generateDueInvoices(req.user);
    ApiResponse.success(res, { generated: ids.length, ids }, `${ids.length} invoices generated`);
  } catch (err) { next(err); }
};
