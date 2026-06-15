// models/ProposedAction.model.js
//
// Autonomy roadmap Phase 0 — the Action Framework. Every agent emits a uniform
// ProposedAction; the router decides (from policy) whether to log it, queue it
// for approval, or auto-execute it. One inbox, every item carrying its rationale,
// citations and a reversal descriptor for undo.
//
'use strict';
const mongoose = require('mongoose');
const { PROPOSED_ACTION_STATUS } = require('../config/constants');

const proposedActionSchema = new mongoose.Schema(
  {
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    capability: { type: String, required: true },              // bookkeeping | tax | payments | …
    type:       { type: String, required: true },              // e.g. post_journal, send_dunning
    title:      { type: String, default: '' },
    summary:    { type: String, default: '' },

    payload:    { type: mongoose.Schema.Types.Mixed, default: {} },
    confidence: { type: Number, default: 0, min: 0, max: 1 },
    amount:     { type: Number, default: null },               // for the policy limit check

    rationale:  { type: String, default: '' },                 // "why I propose this"
    citations:  { type: mongoose.Schema.Types.Mixed, default: [] },
    reversal:   { type: mongoose.Schema.Types.Mixed, default: null }, // how to undo it

    decision:   { type: String, default: null },               // observe | queue | execute
    status:     { type: String, enum: Object.values(PROPOSED_ACTION_STATUS), default: PROPOSED_ACTION_STATUS.QUEUED, index: true },

    sourceType: { type: String, default: null },               // origin (anomaly, transaction, …)
    sourceId:   { type: String, default: null },

    decidedBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    decidedAt:  { type: Date, default: null },
    executedAt: { type: Date, default: null },
    result:     { type: mongoose.Schema.Types.Mixed, default: null }, // execution result / error
  },
  { timestamps: true, toJSON: { transform: (d, r) => { delete r.__v; return r; } } },
);

proposedActionSchema.index({ businessId: 1, status: 1, createdAt: -1 });
// Dedupe guard for wrapped sources (one action per source item).
proposedActionSchema.index({ businessId: 1, sourceType: 1, sourceId: 1 }, { sparse: true });

module.exports = mongoose.model('ProposedAction', proposedActionSchema);
