// models/PendingTransaction.model.js
//
// Feature #6 — Approval workflow.
//
// A PendingTransaction is a *request* to post a journal entry, parked in a
// review queue because its amount exceeded the business approval threshold.
//
// IMPORTANT (accounting integrity): a pending transaction is NOT a ledger
// record. No balances move while it sits here. Only when it is APPROVED does
// approvalService call transactionService.createTransaction to produce the one
// authoritative, immutable JournalEntry — at which point postedJournalEntryId
// links the two. Rejected / cancelled requests never post. This guarantees the
// ledger stays the single source of truth and journal entries stay immutable.
//
'use strict';
const mongoose = require('mongoose');
const {
  PENDING_TRANSACTION_STATUS, PENDING_TRANSACTION_TRANSITIONS,
  TRANSACTION_ENTRY_SOURCES,
} = require('../config/constants');

const pendingTransactionSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true,
    },

    // ── Denormalised summary fields (for the queue list + threshold display) ──
    description:     { type: String, required: true, trim: true, maxlength: 500 },
    amount:          { type: Number, required: true, min: 0.01, index: true },
    transactionDate: { type: Date, required: true },
    transactionType: { type: String, default: null },
    debitAccountId:  { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', default: null },
    creditAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', default: null },

    // ── The full transaction payload to hand to createTransaction on approval ──
    payload: { type: mongoose.Schema.Types.Mixed, required: true },

    source: {
      type: String,
      enum: Object.values(TRANSACTION_ENTRY_SOURCES),
      default: TRANSACTION_ENTRY_SOURCES.FORM,
    },
    // Set when this request was generated from a recurring template.
    recurringTemplateId: {
      type: mongoose.Schema.Types.ObjectId, ref: 'TransactionTemplate', default: null,
    },

    // ── Approval lifecycle ────────────────────────────────────────────────────
    status: {
      type: String,
      enum: Object.values(PENDING_TRANSACTION_STATUS),
      default: PENDING_TRANSACTION_STATUS.PENDING,
      index: true,
    },
    submittedBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    submittedAt:   { type: Date, default: Date.now },
    reviewedBy:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt:    { type: Date, default: null },
    decisionNote:  { type: String, default: null, trim: true, maxlength: 500 },

    // Set once approved + posted — the immutable JournalEntry this request became.
    postedJournalEntryId: {
      type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', default: null,
    },
  },
  {
    timestamps: true,
    toJSON: { transform: (doc, ret) => { delete ret.__v; return ret; } },
  }
);

pendingTransactionSchema.index({ businessId: 1, status: 1, createdAt: -1 });

/**
 * State-machine guard — mirrors the procurement-domain convention
 * (PENDING_TRANSACTION_TRANSITIONS lives in config/constants.js).
 */
pendingTransactionSchema.statics.canTransition = function (from, to) {
  const allowed = PENDING_TRANSACTION_TRANSITIONS[from] || [];
  return allowed.includes(to);
};

const PendingTransaction = mongoose.model('PendingTransaction', pendingTransactionSchema);
module.exports = PendingTransaction;
