// repositories/taxReturn.repository.js — FR-04.3
'use strict';
const BaseRepository = require('./base.repository');
const TaxReturn = require('../models/TaxReturn.model');

class TaxReturnRepository extends BaseRepository {
  constructor() {
    super(TaxReturn);
  }

  /** Find the single return for a business/type/period (the unique key). */
  async findByPeriod(businessId, returnType, period = {}) {
    return this.model.findOne({
      businessId,
      returnType,
      'period.year':  period.year,
      'period.month': period.month ?? null,
    }).lean();
  }

  /**
   * Upsert the draft for a period — re-preparing overwrites data + resets
   * validation, but never clobbers a return already past draft unless forced.
   */
  async upsertDraft(businessId, returnType, period, data, createdBy = null) {
    return this.model.findOneAndUpdate(
      { businessId, returnType, 'period.year': period.year, 'period.month': period.month ?? null },
      {
        $set: { data, period: { year: period.year, month: period.month ?? null },
                'validation.passed': false, 'validation.errors': [], 'validation.checkedAt': null },
        $setOnInsert: { businessId, returnType, status: 'draft', createdBy },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean();
  }

  /** Recent returns for a business, newest period first. */
  async listForBusiness(businessId, limit = 50) {
    return this.model.find({ businessId })
      .sort({ 'period.year': -1, 'period.month': -1, updatedAt: -1 })
      .limit(limit)
      .lean();
  }
}

module.exports = new TaxReturnRepository();
