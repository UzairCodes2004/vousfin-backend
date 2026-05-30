// controllers/arApReport.controller.js — AR/AP Domain Refactor, Milestone M7
'use strict';

const reporting = require('../services/arApReporting.service');
const customerStatementService = require('../services/customerStatement.service'); // M8
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

// M8 — document-sourced customer statement (opening balance + activity + aging).
// GET /ar-ap/statement?customerId=&from=&to=
exports.customerStatement = async (req, res, next) => {
  try {
    const { customerId, from, to } = req.query;
    const data = await customerStatementService.getStatement(
      req.user.businessId, customerId, { from, to }, req.user
    );
    ApiResponse.success(res, data, 'Customer statement');
  } catch (err) { next(err); }
};
