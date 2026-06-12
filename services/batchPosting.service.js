// services/batchPosting.service.js
//
// Feature #9 — Server-side batch posting.
//
// Post many transactions in ONE call instead of N round-trips. Every item flows
// through the same approval gate as a single entry, so over-threshold items are
// parked for approval rather than posted. Optional per-item idempotency keys make
// retries safe — a re-sent batch never double-posts.
//
'use strict';
const crypto = require('crypto');
const logger = require('../config/logger');

const CHUNK = 10; // bounded concurrency — protects Mongo/Atlas under large imports

class BatchPostingService {
  /**
   * @param {string} businessId
   * @param {Array<Object>} items  transaction payloads (same shape as createTransaction)
   *        Optional per item: idempotencyKey (string), originalRow (for error mapping)
   * @param {Object} actor  { id, fullName, role }
   * @param {string} ipAddress
   * @param {Object} opts   { source?: string }
   * @returns {Promise<{batchId, total, posted, pending, skipped, failed, postedIds}>}
   */
  async postBatch(businessId, items, actor, ipAddress, opts = {}) {
    const approvalService = require('./approval.service');
    const JournalEntry = require('../models/JournalEntry.model');
    const batchId = crypto.randomUUID();
    const source  = opts.source || 'batch';

    const results = {
      batchId, total: items.length,
      posted: 0, pending: 0, skipped: 0,
      failed: [], postedIds: [],
    };

    for (let i = 0; i < items.length; i += CHUNK) {
      const chunk = items.slice(i, i + CHUNK);
      const settled = await Promise.allSettled(chunk.map(async (raw) => {
        const item = { ...raw, businessId, inputMethod: raw.inputMethod || source };

        // Idempotency: if this key already posted, skip (safe retries).
        if (raw.idempotencyKey) {
          const existing = await JournalEntry.findOne(
            { businessId, 'metadata.idempotencyKey': raw.idempotencyKey },
            { _id: 1 }
          ).lean();
          if (existing) return { kind: 'skipped' };
          item.metadata = { ...(item.metadata || {}), idempotencyKey: raw.idempotencyKey };
        }
        // Strip control fields the engine shouldn't see.
        delete item.idempotencyKey;
        delete item.originalRow;

        const res = await approvalService.submitOrPost(item, actor, ipAddress, { source });
        if (res.pendingApproval) return { kind: 'pending' };
        return { kind: 'posted', id: res.transaction?._id };
      }));

      for (let j = 0; j < settled.length; j++) {
        const s = settled[j];
        if (s.status === 'fulfilled') {
          const v = s.value;
          if (v.kind === 'posted')      { results.posted++; if (v.id) results.postedIds.push(v.id); }
          else if (v.kind === 'pending')  results.pending++;
          else if (v.kind === 'skipped')  results.skipped++;
        } else {
          results.failed.push({
            index: i + j,
            row:   chunk[j]?.originalRow,
            error: s.reason?.message || 'Unknown error',
          });
        }
      }
    }

    logger.info(`[batch] ${batchId}: ${results.posted} posted, ${results.pending} pending-approval, ${results.skipped} skipped, ${results.failed.length} failed (of ${results.total})`);
    return results;
  }
}

module.exports = new BatchPostingService();
