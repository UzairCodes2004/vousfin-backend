// repositories/anomaly.repository.js
const BaseRepository = require('./base.repository');
const AnomalyAlert = require('../models/AnomalyAlert.model');
const {
  ANOMALY_STATUS,
  ANOMALY_SUPPRESS_STATUSES,
  ANOMALY_REVIEWED_STATUSES,
} = require('../config/constants');
const { sanitizeAndValidateId } = require('../utils/sanitize.helper');
const logger = require('../config/logger');

class AnomalyRepository extends BaseRepository {
  constructor() {
    super(AnomalyAlert);
  }

  /**
   * Upsert an alert keyed on (businessId, journalEntryId).
   *
   * If the alert already exists:
   *   - User REVIEWED it → DO NOT downgrade their decision.  Only refresh the
   *     score, fingerprint, lastScannedAt fields.  If fingerprint differs from
   *     the stored one AND status is suppress-eligible, mark status='rescanned'
   *     to re-surface in the UI.
   *   - Still pending → update score, reason, breakdown.  Increment scanCount.
   *
   * If new:
   *   - Insert fresh with status=pending.
   *
   * @param {Object} alertData - must include businessId, journalEntryId, anomalyScore, reason, scanId
   * @returns {Promise<{ alert: Object, action: 'created'|'updated'|'suppressed'|'rescanned' }>}
   */
  async upsertAlert(alertData) {
    if (!alertData.businessId || !alertData.journalEntryId ||
        alertData.anomalyScore == null || !alertData.scanId) {
      throw new Error('upsertAlert: missing required fields');
    }

    const existing = await this.model.findOne({
      businessId:     alertData.businessId,
      journalEntryId: alertData.journalEntryId,
    });

    if (!existing) {
      const created = await this.model.create({
        ...alertData,
        status:     ANOMALY_STATUS.PENDING,
        scanCount:  1,
      });
      return { alert: created.toObject(), action: 'created' };
    }

    const wasReviewed = ANOMALY_REVIEWED_STATUSES.includes(existing.status);
    const isSuppressed = ANOMALY_SUPPRESS_STATUSES.includes(existing.status);
    const fingerprintChanged = alertData.transactionFingerprint &&
      existing.transactionFingerprint &&
      alertData.transactionFingerprint !== existing.transactionFingerprint;

    // Build update payload — never overwrite reviewer's verdict unless txn changed
    const update = {
      anomalyScore:           alertData.anomalyScore,
      reason:                 alertData.reason,
      triggeredRules:         alertData.triggeredRules || [],
      explanation:            alertData.explanation     || '',
      featureVector:          alertData.featureVector   || null,
      scoreBreakdown:         alertData.scoreBreakdown  || existing.scoreBreakdown,
      confidence:             alertData.confidence      || existing.confidence,
      lastScannedAt:          new Date(),
      scanId:                 alertData.scanId,
      scanCount:              (existing.scanCount || 1) + 1,
      transactionFingerprint: alertData.transactionFingerprint || existing.transactionFingerprint,
    };

    let action = 'updated';

    if (wasReviewed && fingerprintChanged) {
      // Transaction changed materially → re-surface as 'rescanned' for review
      update.status      = ANOMALY_STATUS.RESCANNED;
      update.reviewedBy  = null;
      update.reviewedAt  = null;
      update.reviewNotes = '';
      action = 'rescanned';
    } else if (isSuppressed) {
      // User already cleared this → keep status, just refresh metadata
      action = 'suppressed';
    }
    // else: pending or confirmed_fraud → just update fields, keep status

    const updated = await this.model.findOneAndUpdate(
      { _id: existing._id },
      { $set: update },
      { new: true }
    );

    return { alert: updated.toObject(), action };
  }

  /**
   * Bulk version of upsertAlert.  Returns counts by action type.
   */
  async bulkUpsertAlerts(alertsArray) {
    if (!alertsArray || !alertsArray.length) {
      return { created: 0, updated: 0, suppressed: 0, rescanned: 0, alerts: [] };
    }
    const counts = { created: 0, updated: 0, suppressed: 0, rescanned: 0 };
    const alerts = [];
    for (const data of alertsArray) {
      try {
        const { alert, action } = await this.upsertAlert(data);
        counts[action]++;
        alerts.push(alert);
      } catch (e) {
        logger.warn(`bulkUpsertAlerts: skipping one (${e.message})`);
      }
    }
    return { ...counts, alerts };
  }

  /**
   * Look up existing decisions (any non-pending status) for the given
   * journalEntryIds.  Used by the scanner to filter out suppressed transactions
   * before running the model.
   *
   * @returns {Map<journalEntryId(string), { status, transactionFingerprint, reviewedAt }>}
   */
  async getDecisionsForJournalEntries(businessId, journalEntryIds) {
    const validBizId = sanitizeAndValidateId(businessId);
    if (!journalEntryIds || !journalEntryIds.length) return new Map();
    const docs = await this.model.find({
      businessId:     validBizId,
      journalEntryId: { $in: journalEntryIds },
      status:         { $in: ANOMALY_REVIEWED_STATUSES },
    }).select('journalEntryId status transactionFingerprint reviewedAt').lean();

    const map = new Map();
    for (const d of docs) {
      map.set(String(d.journalEntryId), {
        status:                 d.status,
        transactionFingerprint: d.transactionFingerprint,
        reviewedAt:             d.reviewedAt,
      });
    }
    return map;
  }

  /**
   * Legacy: keep this method name for backward-compatibility with any callers
   * that haven't been migrated to upsertAlert yet.
   * Delegates to bulkUpsertAlerts.
   */
  async bulkCreateAlerts(alertsArray) {
    const r = await this.bulkUpsertAlerts(alertsArray);
    return r.alerts;
  }

  async createAlert(data) {
    const { alert } = await this.upsertAlert(data);
    return alert;
  }

  async getPendingAlerts(businessId, pagination = {}) {
    const validBusinessId = sanitizeAndValidateId(businessId);
    const { page = 1, limit = 25 } = pagination;
    const skip = (page - 1) * limit;
    const query = {
      businessId: validBusinessId,
      status: { $in: [
        ANOMALY_STATUS.PENDING,
        ANOMALY_STATUS.PENDING_REVIEW,
        ANOMALY_STATUS.RESCANNED,
      ] },
    };
    const [data, total] = await Promise.all([
      this.model.find(query)
        .populate('journalEntryId', 'description amount transactionDate transactionType')
        .sort({ detectedAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      this.count(query),
    ]);
    return { data, total, page, limit };
  }

  async getByBusiness(businessId, status = null, pagination = {}) {
    const validBusinessId = sanitizeAndValidateId(businessId);
    const { page = 1, limit = 25 } = pagination;
    const skip = (page - 1) * limit;
    const query = { businessId: validBusinessId };
    if (status) {
      // Translate legacy aliases on the way in
      const aliasMap = {
        legit:           ANOMALY_STATUS.MARKED_LEGIT,
        fraud:           ANOMALY_STATUS.CONFIRMED_FRAUD,
      };
      const normalised = aliasMap[status] || status;
      if (Object.values(ANOMALY_STATUS).includes(normalised)) {
        // For "pending" filter, include the rescanned variants as well
        if (normalised === ANOMALY_STATUS.PENDING) {
          query.status = { $in: [
            ANOMALY_STATUS.PENDING,
            ANOMALY_STATUS.PENDING_REVIEW,
            ANOMALY_STATUS.RESCANNED,
          ] };
        } else if (normalised === ANOMALY_STATUS.MARKED_LEGIT) {
          query.status = { $in: [ANOMALY_STATUS.MARKED_LEGIT, ANOMALY_STATUS.VALID] };
        } else if (normalised === ANOMALY_STATUS.CONFIRMED_FRAUD) {
          query.status = { $in: [ANOMALY_STATUS.CONFIRMED_FRAUD, ANOMALY_STATUS.CONFIRMED_ISSUE] };
        } else {
          query.status = normalised;
        }
      }
    }
    const [data, total] = await Promise.all([
      this.model.find(query)
        .populate('journalEntryId', 'description amount transactionDate transactionType')
        .populate('reviewedBy', 'fullName email')
        .sort({ detectedAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      this.count(query),
    ]);
    return { data, total, page, limit };
  }

  /**
   * Update an alert's status (called from user-review UI).
   * Idempotent — calling twice with same status produces same result.
   */
  async updateAlertStatus(alertId, status, reviewedBy, notes = '') {
    const validAlertId = sanitizeAndValidateId(alertId);
    if (!Object.values(ANOMALY_STATUS).includes(status)) {
      throw new Error(`Invalid status: ${status}`);
    }
    if (status === ANOMALY_STATUS.PENDING || status === ANOMALY_STATUS.PENDING_REVIEW) {
      throw new Error('Cannot set status back to pending');
    }
    const validReviewer = sanitizeAndValidateId(reviewedBy);
    const update = {
      status,
      reviewedBy: validReviewer,
      reviewedAt: new Date(),
    };
    if (notes) update.reviewNotes = String(notes).substring(0, 1000);
    return this.update(validAlertId, update);
  }

  async getByScanId(scanId, businessId) {
    const validBusinessId = sanitizeAndValidateId(businessId);
    return this.model.find({
      scanId,
      businessId: validBusinessId,
    })
      .populate('journalEntryId')
      .sort({ anomalyScore: -1 })  // highest score first
      .lean();
  }

  async getStalePendingAlerts(businessId, hoursOld = 24) {
    const validBusinessId = sanitizeAndValidateId(businessId);
    const cutoff = new Date();
    cutoff.setHours(cutoff.getHours() - hoursOld);
    return this.model.find({
      businessId: validBusinessId,
      status: { $in: [
        ANOMALY_STATUS.PENDING,
        ANOMALY_STATUS.PENDING_REVIEW,
      ] },
      detectedAt: { $lte: cutoff },
    })
      .populate('journalEntryId')
      .sort({ detectedAt: 1 })
      .lean();
  }

  /**
   * Counts by status — merges legacy aliases with new statuses.
   */
  async countByBusinessAndStatus(businessId) {
    const validBusinessId = sanitizeAndValidateId(businessId);
    const result = await this.model.aggregate([
      { $match: { businessId: validBusinessId } },
      { $group:  { _id: '$status', count: { $sum: 1 } } },
    ]);
    const counts = {
      pending:          0,
      pending_review:   0,
      marked_legit:     0,
      confirmed_fraud:  0,
      ignored:          0,
      rescanned:        0,
      // Legacy aliases (kept for backward compat with frontend)
      valid:            0,
      confirmed_issue:  0,
    };
    result.forEach(item => {
      if (item._id in counts) counts[item._id] = item.count;
    });
    // Surface a "total reviewed" convenience field
    counts.totalReviewed = counts.marked_legit + counts.confirmed_fraud +
                           counts.ignored + counts.valid + counts.confirmed_issue;
    counts.totalPending  = counts.pending + counts.pending_review + counts.rescanned;
    return counts;
  }

  async deleteOlderThan(olderThan) {
    const result = await this.model.deleteMany({ detectedAt: { $lt: olderThan } });
    logger.warn(`Deleted ${result.deletedCount} anomaly alerts older than ${olderThan}`);
    return result.deletedCount;
  }
}

module.exports = new AnomalyRepository();
