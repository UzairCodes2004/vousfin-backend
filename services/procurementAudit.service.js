// services/procurementAudit.service.js
//
// Phase 3.4 — Immutable Procurement Audit Service
//
// Single responsibility: write and query ProcurementAuditLog.
// Never mutates existing records.
//
'use strict';
const mongoose         = require('mongoose');
const ProcurementAuditLog = require('../models/ProcurementAuditLog.model');
const { ApiError }     = require('../utils/ApiError');
const logger           = require('../config/logger');

class ProcurementAuditService {

  /**
   * Append an audit event.  Fire-and-forget safe — errors are logged, not thrown,
   * so a failed audit write never blocks the main operation.
   *
   * @param {Object} params
   * @param {string}  params.businessId
   * @param {string}  params.entityType
   * @param {string}  params.entityId
   * @param {string}  [params.entityRef]
   * @param {string}  params.action
   * @param {string}  [params.fromState]
   * @param {string}  [params.toState]
   * @param {Object}  [params.actor]      — { _id, fullName, email, role }
   * @param {string}  [params.source]     — 'user' | 'system' | 'cron' | 'api'
   * @param {Object}  [params.meta]
   * @param {string}  [params.ipAddress]
   * @param {string}  [params.userAgent]
   * @returns {Promise<void>}
   */
  async log({
    businessId,
    entityType,
    entityId,
    entityRef  = null,
    action,
    fromState  = null,
    toState    = null,
    actor      = null,
    source     = 'user',
    meta       = null,
    ipAddress  = null,
    userAgent  = null,
  }) {
    try {
      await ProcurementAuditLog.create({
        businessId: mongoose.Types.ObjectId.isValid(businessId)
          ? new mongoose.Types.ObjectId(businessId)
          : businessId,
        entityType,
        entityId: mongoose.Types.ObjectId.isValid(entityId)
          ? new mongoose.Types.ObjectId(entityId)
          : entityId,
        entityRef,
        action,
        fromState,
        toState,
        actorId:   actor?._id   ?? null,
        actorName: actor?.fullName ?? actor?.email ?? null,
        actorRole: actor?.role  ?? null,
        source,
        meta,
        ipAddress,
        userAgent,
        occurredAt: new Date(),
      });
    } catch (err) {
      // Never block main flow on audit failure
      logger.error('[procurementAudit] Failed to write audit log', { err: err.message });
    }
  }

  /**
   * Retrieve the audit trail for a specific entity (paginated, newest first).
   *
   * @param {string} businessId
   * @param {string} entityType
   * @param {string} entityId
   * @param {{ page?, limit? }} opts
   */
  async getEntityHistory(businessId, entityType, entityId, { page = 1, limit = 50 } = {}) {
    if (!businessId || !entityId) throw new ApiError(400, 'businessId and entityId are required');

    const skip = (page - 1) * limit;
    const filter = {
      businessId: new mongoose.Types.ObjectId(businessId),
      entityType,
      entityId:   new mongoose.Types.ObjectId(entityId),
    };

    const [docs, total] = await Promise.all([
      ProcurementAuditLog.find(filter)
        .sort({ occurredAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      ProcurementAuditLog.countDocuments(filter),
    ]);

    return { docs, total, page, pages: Math.ceil(total / limit) };
  }

  /**
   * Retrieve recent procurement activity for a business (activity feed).
   *
   * @param {string} businessId
   * @param {{ limit?, entityType?, actorId? }} opts
   */
  async getRecentActivity(businessId, { limit = 30, entityType = null, actorId = null } = {}) {
    if (!businessId) throw new ApiError(400, 'businessId is required');

    const filter = { businessId: new mongoose.Types.ObjectId(businessId) };
    if (entityType) filter.entityType = entityType;
    if (actorId && mongoose.Types.ObjectId.isValid(actorId)) {
      filter.actorId = new mongoose.Types.ObjectId(actorId);
    }

    return ProcurementAuditLog.find(filter)
      .sort({ occurredAt: -1 })
      .limit(limit)
      .lean();
  }

  /**
   * Count events by action type — used for dashboard metrics.
   */
  async actionSummary(businessId, { days = 30 } = {}) {
    if (!businessId) throw new ApiError(400, 'businessId is required');

    const since = new Date(Date.now() - days * 86400000);

    const pipeline = [
      {
        $match: {
          businessId: new mongoose.Types.ObjectId(businessId),
          occurredAt: { $gte: since },
        },
      },
      {
        $group: {
          _id: '$action',
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
    ];

    const rows = await ProcurementAuditLog.aggregate(pipeline);
    return rows.reduce((acc, r) => ({ ...acc, [r._id]: r.count }), {});
  }
}

module.exports = new ProcurementAuditService();
