// controllers/arApReport.controller.js — AR/AP Domain Refactor, Milestone M7
'use strict';

const reporting = require('../services/arApReporting.service');
const ApiResponse = require('../utils/ApiResponse');

const sideOf = (q) => (q.type === 'payable' ? 'payable' : 'receivable');

exports.aging = async (req, res, next) => {
  try {
    const data = await reporting.getReport(req.user.businessId, sideOf(req.query));
    ApiResponse.success(res, data, 'AR/AP aging report');
  } catch (err) { next(err); }
};

exports.reconciliation = async (req, res, next) => {
  try {
    const data = await reporting.getReconciliation(req.user.businessId, sideOf(req.query));
    ApiResponse.success(res, data, 'AR/AP reconciliation');
  } catch (err) { next(err); }
};
