// repositories/transactionTemplate.repository.js
const BaseRepository = require('./base.repository');
const TransactionTemplate = require('../models/TransactionTemplate.model');

class TransactionTemplateRepository extends BaseRepository {
  constructor() {
    super(TransactionTemplate);
  }

  /** All templates for a business, newest first. */
  findByBusiness(businessId, { isActive } = {}) {
    const filter = { businessId };
    if (isActive != null) filter.isActive = isActive;
    return this.model.find(filter).sort({ updatedAt: -1 }).lean();
  }

  findOneByBusinessAndId(businessId, id) {
    return this.model.findOne({ _id: id, businessId });
  }

  /** Active recurring templates whose nextRunDate has arrived (cron). */
  findDueRecurring(now = new Date()) {
    return this.model.find({
      isActive: true,
      isRecurring: true,
      nextRunDate: { $ne: null, $lte: now },
      $or: [{ endDate: null }, { endDate: { $gte: now } }],
    });
  }
}

module.exports = new TransactionTemplateRepository();
