/**
 * audit.controller.js — ERP Integration Refactor, Step 9
 *
 * Exposes the cross-module unified audit / activity trail:
 *   GET /audit/activity                       — merged durable-log + live-event timeline
 *   GET /audit/logs                           — durable audit log (paginated, filterable)
 *   GET /audit/entity/:entityType/:entityId   — full trail for one entity
 */

'use strict';

const auditService = require('../services/audit.service');
const { ApiError } = require('../utils/ApiError');

class AuditController {
  // ── GET /audit/activity ──────────────────────────────────────────────────
  async getActivity(req, res, next) {
    try {
      const { entityType, entityId, limit } = req.query;
      const data = await auditService.getActivityTimeline(req.businessId, {
        entityType: entityType || undefined,
        entityId:   entityId || undefined,
        limit:      limit ? Number(limit) : 50,
      });
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }

  // ── GET /audit/logs ──────────────────────────────────────────────────────
  async getLogs(req, res, next) {
    try {
      const { startDate, endDate, action, performedBy, page, limit } = req.query;
      const result = await auditService.getBusinessLogs(
        req.businessId,
        { startDate, endDate, action, performedBy },
        { page: page ? Number(page) : 1, limit: limit ? Number(limit) : 25 }
      );
      res.json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  }

  // ── GET /audit/entity/:entityType/:entityId ──────────────────────────────
  async getEntityTrail(req, res, next) {
    try {
      const { entityType, entityId } = req.params;
      if (!entityType || !entityId) throw new ApiError(400, 'entityType and entityId are required');
      const { page, limit } = req.query;
      const result = await auditService.getAuditTrail(entityType, entityId, {
        page: page ? Number(page) : 1,
        limit: limit ? Number(limit) : 25,
      });
      res.json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  }
}

module.exports = new AuditController();
