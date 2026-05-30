// controllers/dunning.controller.js — AR/AP M8 (dunning / collections)
'use strict';
const dunningService = require('../services/dunning.service');
const Invoice = require('../models/Invoice.model');
const ApiResponse = require('../utils/ApiResponse');
const { ApiError } = require('../utils/ApiError');

exports.getSummary = async (req, res, next) => {
  try {
    const summary = await dunningService.getSummary(req.user.businessId);
    ApiResponse.success(res, summary);
  } catch (err) { next(err); }
};

exports.getWorklist = async (req, res, next) => {
  try {
    const minLevel = req.query.minLevel != null ? Number(req.query.minLevel) : 1;
    const limit = req.query.limit != null ? Number(req.query.limit) : 50;
    const items = await dunningService.getWorklist(req.user.businessId, { minLevel, limit });
    ApiResponse.success(res, items);
  } catch (err) { next(err); }
};

// Admin-only: manually run the escalation pass (cron does this daily).
exports.run = async (req, res, next) => {
  try {
    const stats = await dunningService.runEscalation(req.user);
    ApiResponse.success(res, stats, `Escalated ${stats.escalated} invoice(s)`);
  } catch (err) { next(err); }
};

// Manually escalate a single invoice.
exports.escalateOne = async (req, res, next) => {
  try {
    const invoice = await Invoice.findOne({ _id: req.params.id, businessId: req.user.businessId });
    if (!invoice) throw new ApiError(404, 'Invoice not found');
    const lvl = await dunningService.escalateInvoice(invoice, req.user);
    ApiResponse.success(res, invoice, lvl ? `Escalated to ${lvl.label}` : 'No escalation needed');
  } catch (err) { next(err); }
};

module.exports = exports;
