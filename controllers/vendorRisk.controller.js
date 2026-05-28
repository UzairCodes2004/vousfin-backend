// controllers/vendorRisk.controller.js — Phase 3.3
'use strict';
const vendorRiskService = require('../services/vendorRisk.service');
const { ApiResponse }   = require('../utils/ApiResponse');

exports.computeForVendor = async (req, res, next) => {
  try {
    const result = await vendorRiskService.computeForVendor(
      req.params.vendorId, req.user.businessId
    );
    ApiResponse.success(res, result, `Risk score: ${result.riskLevel ?? 'insufficient data'}`);
  } catch (err) { next(err); }
};

exports.refreshAll = async (req, res, next) => {
  try {
    const results = await vendorRiskService.refreshAllForBusiness(req.user.businessId);
    ApiResponse.success(res, results, `${results.length} vendor risk scores refreshed`);
  } catch (err) { next(err); }
};

exports.listByRisk = async (req, res, next) => {
  try {
    const { level, limit } = req.query;
    const vendors = await vendorRiskService.listByRisk(
      req.user.businessId, { level, limit: limit ? Number(limit) : 20 }
    );
    ApiResponse.success(res, vendors);
  } catch (err) { next(err); }
};

exports.riskLevelSummary = async (req, res, next) => {
  try {
    const summary = await vendorRiskService.riskLevelSummary(req.user.businessId);
    ApiResponse.success(res, summary);
  } catch (err) { next(err); }
};
