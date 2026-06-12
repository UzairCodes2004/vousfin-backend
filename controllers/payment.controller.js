/**
 * payment.controller.js — AR/AP Domain Refactor, Milestone M2.
 *   POST /payments        record + apply a payment (multi-allocation)
 *   GET  /payments        list payments (filterable)
 *   GET  /payments/:id     one payment
 */
'use strict';

const paymentService = require('../services/payment.service');
const ApiResponse = require('../utils/ApiResponse');

class PaymentController {
  async record(req, res, next) {
    try {
      const payment = await paymentService.recordPayment(req.user.businessId, req.body, req.user.id, req.ip);
      ApiResponse.created(res, payment, 'Payment recorded');
    } catch (err) {
      next(err);
    }
  }

  async autoAllocate(req, res, next) {
    try {
      const { partyType, partyId } = req.body;
      const payment = await paymentService.autoAllocatePayment(req.user.businessId, partyType, partyId, req.body, req.user.id, req.ip);
      ApiResponse.created(res, payment, 'Payment auto-allocated successfully');
    } catch (err) {
      next(err);
    }
  }

  async list(req, res, next) {
    try {
      const { direction, partyId, status, startDate, endDate, page, limit } = req.query;
      const result = await paymentService.list(
        req.user.businessId,
        { direction, partyId, status, startDate, endDate },
        { page: page ? Number(page) : 1, limit: limit ? Number(limit) : 25 }
      );
      ApiResponse.success(res, result, 'Payments fetched');
    } catch (err) {
      next(err);
    }
  }

  async getById(req, res, next) {
    try {
      const payment = await paymentService.getById(req.params.id, req.user.businessId);
      ApiResponse.success(res, payment, 'Payment fetched');
    } catch (err) {
      next(err);
    }
  }
}

module.exports = new PaymentController();
