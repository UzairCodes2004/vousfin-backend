// repositories/proposedAction.repository.js — Autonomy Phase 0
'use strict';
const BaseRepository = require('./base.repository');
const ProposedAction = require('../models/ProposedAction.model');
const { PROPOSED_ACTION_STATUS } = require('../config/constants');

class ProposedActionRepository extends BaseRepository {
  constructor() {
    super(ProposedAction);
  }

  /** The inbox: queued actions awaiting a human decision, newest first. */
  async inbox(businessId, { capability } = {}) {
    const q = { businessId, status: PROPOSED_ACTION_STATUS.QUEUED };
    if (capability) q.capability = capability;
    return this.model.find(q).sort({ createdAt: -1 }).lean();
  }

  /** Recent actions in any state (the activity view). */
  async recent(businessId, limit = 100) {
    return this.model.find({ businessId }).sort({ createdAt: -1 }).limit(limit).lean();
  }

  /** Find a business-scoped action by id (null if not owned). */
  async findOwned(businessId, id) {
    const a = await this.model.findById(id).lean();
    return a && String(a.businessId) === String(businessId) ? a : null;
  }

  /**
   * The most recent action for a (sourceType, sourceId) pair — lets an agent
   * avoid re-proposing something already pending, decided, or done. Returns null
   * if none exists.
   */
  async latestBySource(businessId, sourceType, sourceId) {
    return this.model.findOne({ businessId, sourceType, sourceId }).sort({ createdAt: -1 }).lean();
  }
}

module.exports = new ProposedActionRepository();
