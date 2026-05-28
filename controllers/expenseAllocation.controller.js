// controllers/expenseAllocation.controller.js — Phase 3.3
'use strict';
const expenseAllocationService = require('../services/expenseAllocation.service');
const { ApiResponse }          = require('../utils/ApiResponse');

exports.create = async (req, res, next) => {
  try {
    const allocation = await expenseAllocationService.create(
      req.params.billId, req.user.businessId, req.body, req.user
    );
    ApiResponse.created(res, allocation, 'Expense allocation created');
  } catch (err) { next(err); }
};

exports.getByBill = async (req, res, next) => {
  try {
    const allocation = await expenseAllocationService.getByBill(
      req.params.billId, req.user.businessId
    );
    ApiResponse.success(res, allocation);
  } catch (err) { next(err); }
};

exports.delete = async (req, res, next) => {
  try {
    const result = await expenseAllocationService.delete(
      req.params.billId, req.user.businessId
    );
    ApiResponse.success(res, result, 'Allocation deleted');
  } catch (err) { next(err); }
};

exports.getAgingReport = async (req, res, next) => {
  try {
    const report = await expenseAllocationService.getAgingReport(req.user.businessId);
    ApiResponse.success(res, report);
  } catch (err) { next(err); }
};
