// repositories/pendingTransaction.repository.js
const BaseRepository = require('./base.repository');
const PendingTransaction = require('../models/PendingTransaction.model');

class PendingTransactionRepository extends BaseRepository {
  constructor() {
    super(PendingTransaction);
  }

  findOneByBusinessAndId(businessId, id) {
    return this.model.findOne({ _id: id, businessId });
  }

  /** Queue list, optionally filtered by status. */
  findByBusiness(businessId, { status, page = 1, limit = 50 } = {}) {
    const filter = { businessId };
    if (status) filter.status = status;
    const skip = (page - 1) * limit;
    return Promise.all([
      this.model.find(filter)
        .populate('debitAccountId', 'accountName accountType')
        .populate('creditAccountId', 'accountName accountType')
        .populate('submittedBy', 'fullName email')
        .populate('reviewedBy', 'fullName email')
        .sort({ createdAt: -1 })
        .skip(skip).limit(limit).lean(),
      this.model.countDocuments(filter),
    ]).then(([data, total]) => ({ data, total, page, limit }));
  }

  countByStatus(businessId, status) {
    return this.model.countDocuments({ businessId, status });
  }
}

module.exports = new PendingTransactionRepository();
