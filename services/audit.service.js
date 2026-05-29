// services/audit.service.js
const auditLogRepository = require('../repositories/auditLog.repository');
const userRepository = require('../repositories/user.repository');
const { businessEvents } = require('./businessEventEngine.service'); // ERP Step 9 — unified trail
const { ApiError } = require('../utils/ApiError');
const { AUDIT_ACTIONS, ENTITY_TYPES, USER_STATUS } = require('../config/constants');
const logger = require('../config/logger');

class AuditService {
  /**
   * Core logging method – creates an audit log entry.
   * Automatically fills performedByName if missing.
   * @param {Object} logData - { businessId, entityType, entityId, action, performedBy, performedByName, beforeState, afterState, ipAddress }
   * @returns {Promise<Object>}
   */
  async log(logData) {
    // Validate required fields
    const required = ['entityType', 'entityId', 'action', 'performedBy'];
    for (const field of required) {
      if (!logData[field]) {
        throw new ApiError(500, `Audit log missing required field: ${field}`);
      }
    }
    const businessScoped = !['user'].includes(logData.entityType);
    if (businessScoped && !logData.businessId) {
      throw new ApiError(500, 'Audit log missing required field: businessId');
    }

    // Ensure performedByName is present
    if (!logData.performedByName || !String(logData.performedByName).trim()) {
      const user = await userRepository.findById(logData.performedBy);
      logData.performedByName = user ? user.fullName : 'Unknown User';
    }

    // Ensure timestamp is set (repository will set default if not provided)
    const entry = await auditLogRepository.log(logData);
    logger.debug(`Audit log created: ${logData.action} on ${logData.entityType}/${logData.entityId}`);
    return entry;
  }

  /**
   * Log a creation action.
   * @param {string} entityType - e.g., 'journalEntry', 'user', 'business'
   * @param {string} entityId
   * @param {string} businessId
   * @param {string} performedBy - User ID
   * @param {Object} afterState - The created object (sanitised)
   * @param {string} ipAddress
   * @returns {Promise<Object>}
   */
  async logCreate(entityType, entityId, businessId, performedBy, afterState, ipAddress) {
    return this.log({
      businessId,
      entityType,
      entityId,
      action: AUDIT_ACTIONS.CREATED,
      performedBy,
      beforeState: null,
      afterState,
      ipAddress,
    });
  }

  /**
   * Log an update action.
   * @param {string} entityType
   * @param {string} entityId
   * @param {string} businessId
   * @param {string} performedBy
   * @param {Object} beforeState
   * @param {Object} afterState
   * @param {string} ipAddress
   * @returns {Promise<Object>}
   */
  async logUpdate(entityType, entityId, businessId, performedBy, beforeState, afterState, ipAddress) {
    return this.log({
      businessId,
      entityType,
      entityId,
      action: AUDIT_ACTIONS.EDITED,
      performedBy,
      beforeState,
      afterState,
      ipAddress,
    });
  }

  /**
   * Log a deletion or reversal action.
   * @param {string} entityType
   * @param {string} entityId
   * @param {string} businessId
   * @param {string} performedBy
   * @param {Object} beforeState
   * @param {string} ipAddress
   * @returns {Promise<Object>}
   */
  async logDelete(entityType, entityId, businessId, performedBy, beforeState, ipAddress) {
    return this.log({
      businessId,
      entityType,
      entityId,
      action: AUDIT_ACTIONS.DELETED,
      performedBy,
      beforeState,
      afterState: null,
      ipAddress,
    });
  }

  /**
   * Log a reversal (specialised delete for journal entries).
   * @param {string} entityType
   * @param {string} entityId
   * @param {string} businessId
   * @param {string} performedBy
   * @param {Object} beforeState
   * @param {Object} reversalInfo - { reversalId, reversalEntry }
   * @param {string} ipAddress
   * @returns {Promise<Object>}
   */
  async logReversal(entityType, entityId, businessId, performedBy, beforeState, reversalInfo, ipAddress) {
    return this.log({
      businessId,
      entityType,
      entityId,
      action: AUDIT_ACTIONS.REVERSED,
      performedBy,
      beforeState,
      afterState: reversalInfo,
      ipAddress,
    });
  }

  /**
   * Log an export action (PDF/Excel).
   * @param {string} entityType - e.g., 'report'
   * @param {string} entityId - Report type or export ID
   * @param {string} businessId
   * @param {string} performedBy
   * @param {Object} exportDetails - { reportName, format, dateRange }
   * @param {string} ipAddress
   * @returns {Promise<Object>}
   */
  async logExport(entityType, entityId, businessId, performedBy, exportDetails, ipAddress) {
    return this.log({
      businessId,
      entityType,
      entityId,
      action: AUDIT_ACTIONS.EXPORTED,
      performedBy,
      beforeState: null,
      afterState: exportDetails,
      ipAddress,
    });
  }

  /**
   * Log a user or account status change (suspend/reinstate).
   * @param {string} entityType
   * @param {string} entityId
   * @param {string} businessId
   * @param {string} performedBy
   * @param {string} oldStatus
   * @param {string} newStatus
   * @param {string} ipAddress
   * @returns {Promise<Object>}
   */
  async logStatusChange(entityType, entityId, businessId, performedBy, oldStatus, newStatus, ipAddress) {
    const action =
      newStatus === USER_STATUS.SUSPENDED ? AUDIT_ACTIONS.SUSPENDED : AUDIT_ACTIONS.EDITED;
    const entry = {
      entityType,
      entityId,
      action,
      performedBy,
      beforeState: { status: oldStatus },
      afterState: { status: newStatus },
      ipAddress,
    };
    if (businessId) entry.businessId = businessId;
    return this.log(entry);
  }

  /**
   * Retrieve audit trail for a specific entity.
   * @param {string} entityType
   * @param {string} entityId
   * @param {Object} pagination - { page, limit }
   * @returns {Promise<Object>}
   */
  async getAuditTrail(entityType, entityId, pagination = {}) {
    return auditLogRepository.getForEntity(entityType, entityId, pagination);
  }

  /**
   * Get all audit logs for a business with filtering.
   * @param {string} businessId
   * @param {Object} filters - { startDate, endDate, action, performedBy }
   * @param {Object} pagination
   * @returns {Promise<Object>}
   */
  async getBusinessLogs(businessId, filters = {}, pagination = {}) {
    return auditLogRepository.getByBusiness(businessId, filters, pagination);
  }

  /**
   * Get export logs specifically (for compliance).
   * @param {string} businessId
   * @param {Date} startDate
   * @param {Date} endDate
   * @returns {Promise<Array>}
   */
  async getExportLogs(businessId, startDate, endDate) {
    return auditLogRepository.getExportLogs(businessId, startDate, endDate);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // ERP Step 9 — Cross-module unified activity timeline
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * One chronological feed that stitches together two sources of truth:
   *   1. Durable AuditLog entries — the persisted who-did-what record of state
   *      changes, creates, edits, deletes across EVERY module.
   *   2. The live business-event history — the cross-module signal flow emitted
   *      by the event engine (inventory moves, AR/AP balance changes, valuation
   *      shifts, goods received, …) that may not each have a dedicated audit row.
   *
   * Both are normalized to a common shape and merged newest-first, optionally
   * scoped to a single entity. Business-isolated throughout. (Rule 10)
   *
   * @param {string} businessId
   * @param {Object} [opts]
   * @param {string} [opts.entityType]  filter to one entity type
   * @param {string} [opts.entityId]    filter to one entity (requires entityType for audit rows)
   * @param {number} [opts.limit=50]
   * @returns {Promise<{ items: Array, auditCount: number, eventCount: number }>}
   */
  async getActivityTimeline(businessId, { entityType, entityId, limit = 50 } = {}) {
    const cap = Math.min(Math.max(Number(limit) || 50, 1), 200);

    // 1. Durable audit log (entity-scoped when an entity is given)
    const logsRes = entityType && entityId
      ? await auditLogRepository.getForEntity(entityType, entityId, { page: 1, limit: cap })
      : await auditLogRepository.getByBusiness(businessId, {}, { page: 1, limit: cap });

    const auditItems = (logsRes.data || []).map((l) => ({
      source:     'audit',
      timestamp:  l.timestamp,
      action:     l.action,
      entityType: l.entityType,
      entityId:   l.entityId != null ? String(l.entityId) : null,
      actorName:  l.performedByName || l.performedBy?.fullName || 'System',
      summary:    this._summarizeAudit(l),
    }));

    // 2. Live event history (in-memory ring buffer, business-scoped)
    let eventRows = businessEvents.getHistory(businessId, cap);
    if (entityType) eventRows = eventRows.filter((e) => e.entityType === entityType);
    if (entityId)   eventRows = eventRows.filter((e) => String(e.entityId) === String(entityId));

    const eventItems = eventRows.map((e) => ({
      source:     'event',
      timestamp:  e.occurredAt,
      action:     e.eventName,
      entityType: e.entityType || null,
      entityId:   e.entityId != null ? String(e.entityId) : null,
      actorName:  'system',
      summary:    String(e.eventName || '').replace(/[._]/g, ' '),
    }));

    // 3. Merge → newest-first → cap
    const items = [...auditItems, ...eventItems]
      .filter((x) => x.timestamp)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, cap);

    return { items, auditCount: auditItems.length, eventCount: eventItems.length };
  }

  /** Build a short human summary for an audit-log row. @private */
  _summarizeAudit(l) {
    const verb = String(l.action || 'changed').replace(/_/g, ' ');
    const noun = String(l.entityType || 'record').replace(/_/g, ' ');
    const toState = l.afterState?.state;
    return toState ? `${verb} ${noun} → ${toState}` : `${verb} ${noun}`;
  }
}

module.exports = new AuditService();