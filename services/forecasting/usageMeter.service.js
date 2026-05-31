// services/forecasting/usageMeter.service.js
//
// Forecast Platform — F9. Usage metering for SaaS billing/quotas.
// Fire-and-forget + DB-guarded: counting usage can never slow or break a request.
//
'use strict';
const mongoose = require('mongoose');
const UsageMeter = require('../../models/UsageMeter.model');
const { ApiError } = require('../../utils/ApiError');
const logger = require('../../config/logger');

const dbReady = () => mongoose.connection && mongoose.connection.readyState === 1;
const today = () => new Date().toISOString().slice(0, 10);

class UsageMeterService {
  /** Increment the call count for (business, today, endpoint). Never throws. */
  async record(businessId, endpoint) {
    if (!dbReady() || !businessId || !endpoint) return;
    try {
      await UsageMeter.updateOne(
        { businessId, day: today(), endpoint },
        { $inc: { count: 1 }, $setOnInsert: { businessId, day: today(), endpoint } },
        { upsert: true }
      );
    } catch (e) { logger.warn(`[usageMeter] record failed: ${e.message}`); }
  }

  /** Usage rollup for a tenant over a date window. */
  async usage(businessId, { from, to } = {}) {
    if (!mongoose.Types.ObjectId.isValid(businessId)) throw new ApiError(400, 'Invalid businessId');
    const q = { businessId: new mongoose.Types.ObjectId(businessId) };
    if (from || to) {
      q.day = {};
      if (from) q.day.$gte = new Date(from).toISOString().slice(0, 10);
      if (to)   q.day.$lte = new Date(to).toISOString().slice(0, 10);
    }
    const rows = await UsageMeter.aggregate([
      { $match: q },
      { $group: { _id: '$endpoint', calls: { $sum: '$count' } } },
      { $sort: { calls: -1 } },
    ]);
    const total = rows.reduce((s, r) => s + r.calls, 0);
    return { total, byEndpoint: rows.map((r) => ({ endpoint: r._id, calls: r.calls })), window: { from: from || null, to: to || null } };
  }
}

module.exports = new UsageMeterService();
