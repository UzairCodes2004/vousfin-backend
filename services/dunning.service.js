// services/dunning.service.js
//
// AR/AP Refactor — Milestone M8 (dunning / collections workflow).
//
// A structured collections ladder for overdue receivables that complements the
// existing paymentReminder.service (which sends time-based emails). Dunning
// persists an escalation LEVEL on the invoice and advances it as the debt ages:
//
//   0 none → 1 reminder (1d) → 2 first notice (15d) → 3 second notice (30d)
//          → 4 final notice (45d) → 5 collections (60d)
//
// IMPORTANT — accounting safety:
//   This service NEVER posts to the ledger and never mutates money fields. It
//   only advances dunningLevel + appends to dunningHistory + emits events. AR
//   balances and journal entries are untouched, so ledger integrity is
//   guaranteed regardless of how often the job runs.
//
// Idempotency: an invoice escalates only when the age-derived target level is
// STRICTLY GREATER than its current dunningLevel, so re-running the daily job is
// a no-op once a level has fired.
//
'use strict';
const mongoose = require('mongoose');
const Invoice = require('../models/Invoice.model');
const auditService = require('./audit.service');
const { businessEvents, EVENTS } = require('./businessEventEngine.service');
const { ApiError } = require('../utils/ApiError');
const logger = require('../config/logger');
const { DUNNING_LEVELS, ENTITY_TYPES, AUDIT_ACTIONS } = require('../config/constants');

const MS_PER_DAY = 86400000;

// Ladder sorted ascending by threshold for resolution.
const LADDER = Object.values(DUNNING_LEVELS)
  .filter((l) => l.minDaysOverdue != null)
  .sort((a, b) => a.minDaysOverdue - b.minDaysOverdue);

// Open AR states a dunning notice can apply to.
const OPEN_STATES = ['approved', 'sent', 'partially_paid', 'overdue'];

class DunningService {
  /** Whole days an invoice is past due as of `asOf` (>=0; 0 if not yet due). */
  daysOverdue(dueDate, asOf = new Date()) {
    if (!dueDate) return 0;
    const due = new Date(dueDate); due.setHours(0, 0, 0, 0);
    const now = new Date(asOf);    now.setHours(0, 0, 0, 0);
    return Math.max(0, Math.round((now.getTime() - due.getTime()) / MS_PER_DAY));
  }

  /**
   * Pure: resolve the dunning level for a given days-overdue value.
   * Returns the highest ladder entry whose threshold has been crossed,
   * or DUNNING_LEVELS.NONE.
   */
  resolveLevel(daysOverdue) {
    let chosen = DUNNING_LEVELS.NONE;
    for (const l of LADDER) {
      if (daysOverdue >= l.minDaysOverdue) chosen = l;
    }
    return chosen;
  }

  /**
   * Escalate a single (hydrated) invoice doc to the level its age warrants.
   * Returns the new level entry if it escalated, else null. Pure of the ledger;
   * caller is responsible for persisting (we save here).
   */
  async escalateInvoice(invoice, actor = null, asOf = new Date()) {
    const dOver = this.daysOverdue(invoice.dueDate, asOf);
    const target = this.resolveLevel(dOver);
    const current = invoice.dunningLevel || 0;
    if (target.level <= current) return null; // idempotent — no downgrade, no repeat

    invoice.dunningLevel = target.level;
    invoice.dunningHistory = (invoice.dunningHistory || []).concat([{
      level: target.level, levelKey: target.key, label: target.label,
      daysOverdue: dOver, escalatedAt: new Date(), channel: 'system', note: null,
    }]);
    invoice.lastModifiedBy = actor?._id || invoice.lastModifiedBy;
    await invoice.save();

    try {
      await auditService.log({
        businessId: invoice.businessId, entityType: ENTITY_TYPES.INVOICE, entityId: invoice._id,
        action: AUDIT_ACTIONS.DUNNING_ESCALATED,
        performedBy: actor?._id || invoice.createdBy, performedByName: actor?.fullName || 'Dunning Engine',
        afterState: { dunningLevel: target.level, levelKey: target.key, daysOverdue: dOver },
      });
    } catch (e) {
      logger.warn(`[dunning] audit failed for invoice ${invoice._id}: ${e.message}`);
    }

    businessEvents.emit(EVENTS.DUNNING_ESCALATED, {
      businessId: String(invoice.businessId), userId: actor?._id || invoice.createdBy,
      entityType: ENTITY_TYPES.INVOICE, entityId: invoice._id,
      invoiceNumber: invoice.invoiceNumber, level: target.level, levelKey: target.key, daysOverdue: dOver,
    });
    return target;
  }

  /**
   * Cron entry point: scan every open, overdue, unpaid invoice and escalate the
   * ones whose age has crossed a new threshold. Errors on one invoice never
   * abort the batch.
   * @returns {Promise<{scanned, escalated, byLevel}>}
   */
  async runEscalation(actor = null, asOf = new Date()) {
    const invoices = await Invoice.find({
      state: { $in: OPEN_STATES },
      isArchived: { $ne: true },
      remainingBalance: { $gt: 0 },
      dueDate: { $ne: null, $lt: asOf },
    });

    const stats = { scanned: 0, escalated: 0, byLevel: {} };
    for (const inv of invoices) {
      stats.scanned += 1;
      try {
        const lvl = await this.escalateInvoice(inv, actor, asOf);
        if (lvl) {
          stats.escalated += 1;
          stats.byLevel[lvl.key] = (stats.byLevel[lvl.key] || 0) + 1;
        }
      } catch (err) {
        logger.error(`[dunning] escalate failed for invoice ${inv._id}: ${err.message}`);
      }
    }
    logger.info(`[dunning] runEscalation: escalated ${stats.escalated} of ${stats.scanned} overdue invoices`);
    return stats;
  }

  /** Dashboard helper: invoice counts + exposure grouped by dunning level. */
  async getSummary(businessId) {
    if (!mongoose.Types.ObjectId.isValid(businessId)) throw new ApiError(400, 'Invalid businessId');
    const rows = await Invoice.aggregate([
      { $match: {
        businessId: new mongoose.Types.ObjectId(businessId),
        dunningLevel: { $gt: 0 }, isArchived: { $ne: true },
      } },
      { $group: { _id: '$dunningLevel', count: { $sum: 1 }, outstanding: { $sum: '$remainingBalance' } } },
      { $sort: { _id: 1 } },
    ]);
    const keyByLevel = {};
    for (const l of Object.values(DUNNING_LEVELS)) keyByLevel[l.level] = l;
    return rows.map((r) => ({
      level: r._id,
      levelKey: keyByLevel[r._id]?.key || String(r._id),
      label: keyByLevel[r._id]?.label || null,
      count: r.count,
      outstanding: Math.round(r.outstanding * 100) / 100,
    }));
  }

  /** List the worst offenders (for a collections worklist). */
  async getWorklist(businessId, { minLevel = 1, limit = 50 } = {}) {
    if (!mongoose.Types.ObjectId.isValid(businessId)) throw new ApiError(400, 'Invalid businessId');
    return Invoice.find({
      businessId, dunningLevel: { $gte: minLevel }, isArchived: { $ne: true },
      remainingBalance: { $gt: 0 },
    })
      .select('invoiceNumber customerId customerSnapshot dueDate remainingBalance dunningLevel totalAmount currencyCode')
      .sort({ dunningLevel: -1, dueDate: 1 })
      .limit(Math.min(limit, 200))
      .lean();
  }
}

module.exports = new DunningService();
module.exports.LADDER = LADDER;
