// repositories/taxPositionSnapshot.repository.js
//
// FR-04.1 (Phase 2) — persistence for the daily tax-position snapshot.
// Idempotent per (businessId, date) so the cron + on-demand captures converge
// on a single row per business per day.
//
'use strict';
const BaseRepository    = require('./base.repository');
const TaxPositionSnapshot = require('../models/TaxPositionSnapshot.model');

class TaxPositionSnapshotRepository extends BaseRepository {
  constructor() {
    super(TaxPositionSnapshot);
  }

  /**
   * Upsert today's snapshot. Re-running for the same day overwrites the row
   * (the position is "as of now", so the latest read of the day wins).
   * @param {string} businessId
   * @param {string} date    'YYYY-MM-DD'
   * @param {object} payload  { currency, country, taxes, totalPayable, capturedAt }
   * @returns {Promise<object>} the upserted lean document
   */
  async upsertForDate(businessId, date, payload) {
    return this.model.findOneAndUpdate(
      { businessId, date },
      { $set: { businessId, date, ...payload } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();
  }

  /**
   * Snapshots on/after `fromDate`, oldest first — the series a trend chart plots.
   * @param {string} businessId
   * @param {string} fromDate  'YYYY-MM-DD' inclusive lower bound
   * @returns {Promise<object[]>}
   */
  async trend(businessId, fromDate) {
    return this.model.find(
      { businessId, date: { $gte: fromDate } },
      { date: 1, totalPayable: 1, taxes: 1, currency: 1, _id: 0 }
    ).sort({ date: 1 }).lean();
  }
}

module.exports = new TaxPositionSnapshotRepository();
