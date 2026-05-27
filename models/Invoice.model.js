// models/Invoice.model.js
//
// Phase 1 — First-class Accounts Receivable domain entity.
//
// Layered on top of JournalEntry (the ledger source of truth).  Each Invoice
// document carries:
//   • lifecycle state (draft → pending_approval → approved → sent → … → paid)
//   • approval workflow metadata (required, threshold, approvers, approval log)
//   • append-only history of field-level edits
//   • soft-delete flag (invoices are NEVER hard-deleted)
//   • linkedJournalEntryId — pointer to the underlying GAAP journal entry
//
// Invariant: state changes are validated against INVOICE_TRANSITIONS in the
// service layer; the model rejects unknown values via enum validation.
//
const mongoose = require('mongoose');
const {
  INVOICE_STATES,
  INVOICE_TRANSITIONS,
  APPROVAL_STATUS,
  APPROVER_ROLES,
} = require('../config/constants');

// ── Sub-schemas ───────────────────────────────────────────────────────────────

/** One entry per approval event (submit/approve/reject) — append-only. */
const approvalLogEntrySchema = new mongoose.Schema(
  {
    action:      { type: String, enum: ['submitted', 'approved', 'rejected'], required: true },
    actorId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    actorName:   { type: String, required: true },
    actorRole:   { type: String, enum: Object.values(APPROVER_ROLES), default: null },
    note:        { type: String, default: null, maxlength: 500 },
    timestamp:   { type: Date, default: Date.now },
  },
  { _id: false }
);

/** One entry per field-level edit — append-only. */
const fieldChangeSchema = new mongoose.Schema(
  {
    field:     { type: String, required: true },
    before:    { type: mongoose.Schema.Types.Mixed, default: null },
    after:     { type: mongoose.Schema.Types.Mixed, default: null },
    changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    changedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

/** Lifecycle state-change record — captures who/why for the timeline UI. */
const stateChangeSchema = new mongoose.Schema(
  {
    fromState: { type: String, required: true },
    toState:   { type: String, required: true },
    actorId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    actorName: { type: String, required: true },
    reason:    { type: String, default: null, maxlength: 500 },
    timestamp: { type: Date, default: Date.now },
  },
  { _id: false }
);

// ── Main schema ───────────────────────────────────────────────────────────────

const invoiceSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      index: true,
    },

    // ── Identification ────────────────────────────────────────────────────────
    invoiceNumber: {
      type: String,
      required: true,
      trim: true,
      maxlength: 50,
      index: true,
    },

    // ── Link to ledger entry (GAAP source of truth) ──────────────────────────
    // Optional during draft — invoice may exist without a journal posting until approved.
    linkedJournalEntryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JournalEntry',
      default: null,
      index: true,
    },

    // ── Customer side (AR) ────────────────────────────────────────────────────
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      default: null,
    },
    customerSnapshot: {
      // Denormalised copy of customer details at invoice creation time.
      // Protects historic invoices from later customer renames.
      fullName:     { type: String, default: null },
      businessName: { type: String, default: null },
      email:        { type: String, default: null },
      phone:        { type: String, default: null },
      taxId:        { type: String, default: null },
    },

    // ── Money ─────────────────────────────────────────────────────────────────
    amount: {
      type: Number,
      required: true,
      min: 0.01,
    },
    taxAmount:    { type: Number, default: 0, min: 0 },
    totalAmount:  { type: Number, default: 0, min: 0 }, // amount + taxAmount
    currencyCode: { type: String, default: 'PKR', uppercase: true, maxlength: 3 },

    // ── Dates ─────────────────────────────────────────────────────────────────
    issueDate: { type: Date, required: true, index: true },
    dueDate:   { type: Date, default: null, index: true },
    sentAt:    { type: Date, default: null },

    // ── Lifecycle state ───────────────────────────────────────────────────────
    state: {
      type: String,
      enum: Object.values(INVOICE_STATES),
      default: INVOICE_STATES.DRAFT,
      index: true,
    },
    stateHistory: [stateChangeSchema],

    // ── Payment tracking (mirror of JournalEntry for fast UI access) ─────────
    paidAmount:       { type: Number, default: 0, min: 0 },
    remainingBalance: { type: Number, default: null, min: 0 },

    // ── Approval workflow ─────────────────────────────────────────────────────
    approvalRequired: { type: Boolean, default: false },
    approvalStatus: {
      type: String,
      enum: Object.values(APPROVAL_STATUS),
      default: APPROVAL_STATUS.NOT_REQUIRED,
    },
    approvalThreshold: { type: Number, default: null }, // amount at which approval kicked in
    approvers: [{
      // Pre-assigned approvers (optional — empty means anyone with role can approve)
      userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      role:   { type: String, enum: Object.values(APPROVER_ROLES) },
    }],
    approvalLog: [approvalLogEntrySchema],
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    approvedAt: { type: Date, default: null },

    // ── Audit & history ───────────────────────────────────────────────────────
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    lastModifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    fieldHistory: [fieldChangeSchema],

    // ── Soft delete ───────────────────────────────────────────────────────────
    isArchived: { type: Boolean, default: false, index: true },
    archivedAt: { type: Date, default: null },
    archivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    // ── Free-form metadata ────────────────────────────────────────────────────
    description: { type: String, default: null, maxlength: 1000, trim: true },
    notes:       { type: String, default: null, maxlength: 1000, trim: true },
    tags:        [{ type: String, trim: true }],
    metadata:    { type: mongoose.Schema.Types.Mixed, default: {} },

    // ── Dispute / write-off context ───────────────────────────────────────────
    disputeReason: { type: String, default: null, maxlength: 1000 },
    disputedAt:    { type: Date, default: null },
    writeOffReason:{ type: String, default: null, maxlength: 1000 },
    writtenOffAt:  { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (doc, ret) => { delete ret.__v; return ret; },
    },
  }
);

// ── Indexes ───────────────────────────────────────────────────────────────────
invoiceSchema.index({ businessId: 1, invoiceNumber: 1 }, { unique: true, sparse: true });
invoiceSchema.index({ businessId: 1, state: 1, dueDate: 1 });
invoiceSchema.index({ businessId: 1, customerId: 1, state: 1 });
invoiceSchema.index({ businessId: 1, isArchived: 1, state: 1, createdAt: -1 });
invoiceSchema.index({ businessId: 1, approvalStatus: 1, state: 1 });

// ── Statics ───────────────────────────────────────────────────────────────────

/**
 * Check if a transition from `fromState` to `toState` is permitted.
 * Pure function — no DB access, safe for service-layer guards.
 */
invoiceSchema.statics.canTransition = function (fromState, toState) {
  if (fromState === toState) return true;
  const allowed = INVOICE_TRANSITIONS[fromState];
  return Array.isArray(allowed) && allowed.includes(toState);
};

// ── Instance methods ──────────────────────────────────────────────────────────

/** Append a state change to history. Caller is responsible for setting `state`. */
invoiceSchema.methods.recordStateChange = function (toState, actor, reason = null) {
  this.stateHistory.push({
    fromState: this.state,
    toState,
    actorId:   actor._id,
    actorName: actor.fullName || actor.email || 'Unknown',
    reason,
    timestamp: new Date(),
  });
};

/** Append a field-level change. */
invoiceSchema.methods.recordFieldChange = function (field, before, after, actorId) {
  this.fieldHistory.push({
    field,
    before,
    after,
    changedBy: actorId,
    changedAt: new Date(),
  });
};

// ── Pre-save: derive totalAmount + remainingBalance ──────────────────────────
invoiceSchema.pre('save', function () {
  if (this.amount != null && this.taxAmount != null) {
    this.totalAmount = Math.round((this.amount + (this.taxAmount || 0)) * 100) / 100;
  }
  // Initialise remainingBalance on first save if not set
  if (this.isNew && (this.remainingBalance === null || this.remainingBalance === undefined)) {
    this.remainingBalance = this.totalAmount;
  }
});

const Invoice = mongoose.model('Invoice', invoiceSchema);
module.exports = Invoice;
