// repositories/bankStatement.repository.js
const BaseRepository = require('./base.repository');
const BankStatement = require('../models/BankStatement.model');

class BankStatementRepository extends BaseRepository {
  constructor() {
    super(BankStatement);
  }

  findOneByBusinessAndId(businessId, id) {
    return this.model.findOne({ _id: id, businessId });
  }

  /** List statements (lightweight — omits the heavy lines array). */
  listByBusiness(businessId, { bankAccountId } = {}) {
    const filter = { businessId };
    if (bankAccountId) filter.bankAccountId = bankAccountId;
    return this.model.find(filter)
      .select('-lines')
      .sort({ createdAt: -1 })
      .lean();
  }

  /**
   * Every journal-entry id already linked to a statement line for this bank
   * account (so matching never double-claims a ledger entry).
   */
  async matchedJournalEntryIds(businessId, bankAccountId, excludeStatementId = null) {
    const match = { businessId, bankAccountId };
    if (excludeStatementId) match._id = { $ne: excludeStatementId };
    const rows = await this.model.aggregate([
      { $match: match },
      { $unwind: '$lines' },
      { $match: { 'lines.matchedJournalEntryId': { $ne: null } } },
      { $group: { _id: null, ids: { $addToSet: '$lines.matchedJournalEntryId' } } },
    ]);
    return new Set((rows[0]?.ids || []).map((id) => String(id)));
  }
}

module.exports = new BankStatementRepository();
