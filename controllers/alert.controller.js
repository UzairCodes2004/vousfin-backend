// controllers/alert.controller.js
// FR-02.1 / FR-02.3 — financial alerts + per-business threshold config.
'use strict';

const trendMonitor = require('../services/trendMonitor.service');
const ApiResponse = require('../utils/ApiResponse');

const listAlerts = async (req, res, next) => {
  try {
    const items = await trendMonitor.listOpen(req.user.businessId);
    ApiResponse.success(res, { items, count: items.length }, 'Open financial alerts');
  } catch (err) { next(err); }
};

const acknowledgeAlert = async (req, res, next) => {
  try {
    const alert = await trendMonitor.acknowledge(req.user.businessId, req.params.id, req.user.id);
    ApiResponse.success(res, alert, 'Alert acknowledged');
  } catch (err) { next(err); }
};

const getConfig = async (req, res, next) => {
  try {
    const cfg = await trendMonitor.getConfig(req.user.businessId);
    ApiResponse.success(res, cfg, 'Alert thresholds');
  } catch (err) { next(err); }
};

const updateConfig = async (req, res, next) => {
  try {
    const cfg = await trendMonitor.saveConfig(req.user.businessId, req.body || {});
    ApiResponse.success(res, cfg, 'Alert thresholds updated');
  } catch (err) { next(err); }
};

/** On-demand evaluation (the cron does this automatically). */
const runNow = async (req, res, next) => {
  try {
    const result = await trendMonitor.runAll(req.user.businessId);
    const items = await trendMonitor.listOpen(req.user.businessId);
    ApiResponse.success(res, { ...result, items }, 'Trend monitor executed');
  } catch (err) { next(err); }
};

module.exports = { listAlerts, acknowledgeAlert, getConfig, updateConfig, runNow };
