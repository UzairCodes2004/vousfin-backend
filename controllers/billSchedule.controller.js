// controllers/billSchedule.controller.js — Phase 3.3
'use strict';
const billSchedulerService = require('../services/billScheduler.service');
const { ApiResponse }      = require('../utils/ApiResponse');

exports.create = async (req, res, next) => {
  try {
    const schedule = await billSchedulerService.create(req.user.businessId, req.body, req.user);
    ApiResponse.created(res, schedule, 'Bill schedule created');
  } catch (err) { next(err); }
};

exports.list = async (req, res, next) => {
  try {
    const { isActive } = req.query;
    const opts = {};
    if (isActive !== undefined) opts.isActive = isActive === 'true';
    const schedules = await billSchedulerService.list(req.user.businessId, opts);
    ApiResponse.success(res, schedules);
  } catch (err) { next(err); }
};

exports.getById = async (req, res, next) => {
  try {
    const s = await billSchedulerService.getById(req.params.id, req.user.businessId);
    ApiResponse.success(res, s);
  } catch (err) { next(err); }
};

exports.update = async (req, res, next) => {
  try {
    const s = await billSchedulerService.update(req.params.id, req.user.businessId, req.body);
    ApiResponse.success(res, s, 'Schedule updated');
  } catch (err) { next(err); }
};

exports.deactivate = async (req, res, next) => {
  try {
    const s = await billSchedulerService.deactivate(req.params.id, req.user.businessId);
    ApiResponse.success(res, s, 'Schedule deactivated');
  } catch (err) { next(err); }
};

exports.getReminderSummary = async (req, res, next) => {
  try {
    const summary = await billSchedulerService.getReminderSummary(req.user.businessId);
    ApiResponse.success(res, summary);
  } catch (err) { next(err); }
};

// Admin-only: manually trigger the cron job
exports.triggerGenerate = async (req, res, next) => {
  try {
    const ids = await billSchedulerService.generateDueBills(req.user);
    ApiResponse.success(res, { generated: ids.length, ids }, `${ids.length} bills generated`);
  } catch (err) { next(err); }
};
