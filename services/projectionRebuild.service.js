// services/projectionRebuild.service.js
//
// AR/AP Refactor — Milestone M9 (projection rebuild).
//
// Deterministically rebuilds a document's payment projection (paidAmount /
// remainingBalance / state) from its AUTHORITATIVE recognition JournalEntry +
// settlements, reusing the M1 reconciliation path so live sync and rebuild share
// exactly one code path. Idempotent (absolute values) — safe to run any number
// of times; an already-consistent document is a no-op.
//
// This is how, after retiring the dual-write, a projection can always be
// reconstructed from the ledger of record without trusting prior cached state.
//
'use strict';
const mongoose = require('mongoose');
const Invoice = require('../models/Invoice.model');
const Bill = require('../models/Bill.model');
const arApReconciliation = require('./arApReconciliation.service');
const auditService = require('./audit.service');
const logger = require('../config/logger');
const { ENTITY_TYPES, AUDIT_ACTIONS } = require('../config/constants');

class ProjectionRebuildService {
  /** Recognition-journal id for a document (strong link preferred). @private */
  _recognitionId(kind, doc) {
    return kind === 'invoice'
      ? (doc.arJournalId || doc.linkedJournalEntryId)
      : (doc.apLiabilityJournalId || doc.linkedJournalEntryId);
  }

  /**
   * Rebuild a single document's projection from its ledger recognition entry.
   * @param {string} businessId
   * @param {'invoice'|'bill'} kind
   * @param {string} docId
   */
  async rebuildDocument(businessId, kind, docId, opts = {}) {
    if (!mongoose.Types.ObjectId.isValid(docId)) throw new Error('Invalid document id');
    const Model = kind === 'invoice' ? Invoice : Bill;
    const doc = await Model.findOne({ _id: docId, businessId });
    if (!doc) return { rebuilt: false, reason: 'document_not_found' };

    const recognitionId = this._recognitionId(kind, doc);
    if (!recognitionId) return { rebuilt: false, reason: 'no_recognition_journal', documentId: docId };

    const result = await arApReconciliation.reconcileByJournalEntryId(businessId, recognitionId, opts);

    try {
      await auditService.log({
        businessId, entityType: kind === 'invoice' ? ENTITY_TYPES.INVOICE : ENTITY_TYPES.BILL,
        entityId: docId, action: AUDIT_ACTIONS.PROJECTION_REBUILT,
        performedBy: opts.userId || doc.createdBy, performedByName: 'System · projection rebuild',
        afterState: result,
      });
    } catch (e) {
      logger.warn(`[projectionRebuild] audit failed for ${kind} ${docId}: ${e.message}`);
    }
    return { rebuilt: result.reconciled === true, ...result };
  }

  /**
   * Rebuild every document projection for a tenant (optionally one side).
   * @param {string} businessId
   * @param {Object} [opts] { kind: 'invoice'|'bill', userId }
   * @returns {Promise<{scanned, rebuilt, alreadyInSync, skipped}>}
   */
  async rebuildBusiness(businessId, opts = {}) {
    if (!mongoose.Types.ObjectId.isValid(businessId)) throw new Error('Invalid businessId');
    const stats = { scanned: 0, rebuilt: 0, alreadyInSync: 0, skipped: 0 };

    const sides = opts.kind ? [opts.kind] : ['invoice', 'bill'];
    for (const kind of sides) {
      const Model = kind === 'invoice' ? Invoice : Bill;
      const linkField = kind === 'invoice' ? 'arJournalId' : 'apLiabilityJournalId';
      const docs = await Model.find({
        businessId, isArchived: { $ne: true },
        $or: [{ [linkField]: { $ne: null } }, { linkedJournalEntryId: { $ne: null } }],
      }).select('_id arJournalId apLiabilityJournalId linkedJournalEntryId').lean();

      for (const d of docs) {
        stats.scanned += 1;
        const recognitionId = kind === 'invoice'
          ? (d.arJournalId || d.linkedJournalEntryId)
          : (d.apLiabilityJournalId || d.linkedJournalEntryId);
        if (!recognitionId) { stats.skipped += 1; continue; }
        try {
          const res = await arApReconciliation.reconcileByJournalEntryId(businessId, recognitionId, opts);
          if (res.reconciled) stats.rebuilt += 1;
          else if (res.reason === 'already_in_sync') stats.alreadyInSync += 1;
          else stats.skipped += 1;
        } catch (e) {
          stats.skipped += 1;
          logger.warn(`[projectionRebuild] ${kind} ${d._id} failed: ${e.message}`);
        }
      }
    }
    logger.info(`[projectionRebuild] business=${businessId}: rebuilt ${stats.rebuilt}, in-sync ${stats.alreadyInSync}, skipped ${stats.skipped} of ${stats.scanned}`);
    return stats;
  }
}

module.exports = new ProjectionRebuildService();
