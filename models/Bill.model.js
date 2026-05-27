// models/Bill.model.js
//
// Phase 1 — First-class Accounts Payable domain entity.
//
// Symmetric to Invoice.model.js but on the vendor / AP side.  Each Bill
// document carries:
//   • lifecycle state (draft → awaiting_approval → approved → scheduled → … → paid)
//   • approval workflow metadata (required, threshold, approvers, approval log)
//   • append-only history of field-level edits
//   • soft-delete flag
//   • linkedJournalEntryId — pointer to the underlying GAAP journal entry
//
const mongoose = require('mongoose');
const {
  BILL_STATES,
  BILL_TRANSITIONS,
  APPROVAL_STATUS,
  APPROVER_ROLES,
} = require('../config/constants');

// ── Sub-schemas ───────────────────────────────────────────────────────────────

const approvalLogEntrySchema = new mongoose.Schema(
  {
    action:    { type: String, enum: ['submitted', 'approved', 'rejected'], required: true },
    actorId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    actorName: { type: String, required: true },
    actorRole: { type: String, enum: Object.values(APPROVER_ROLES), default: null },
    note:      { type: String, default: null, maxlength: 500 },
    timestamp: { type: Date, default: Date.now },
  },
  { _id: false }
);

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

const billSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      index: true,
    },

    billNumber: {
      type: String,
      required: true,
      trim: true,
      maxlength: 50,
      index: true,
    },

    /**
     * Vendor's external reference number (the number printed on the vendor's
     * invoice when they sent it to us).  Useful for matching incoming bills.
     */
    vendorReferenceNumber: { type: String, default: null, trim: true, maxlength: 100 },

    linkedJournalEntryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JournalEntry',
      default: null,
      index: true,
    },

    vendorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Vendor',
      default: null,
    },
    vendorSnapshot: {
      vendorName: { type: String, default: null },
      email:      { type: String, default: null },
      phone:      { type: String, default: null },
      taxId:      { type: String, default: null },
      strn:       { type: String, default: null },
    },

    amount:       { type: Number, required: true, min: 0.01 },
    taxAmount:    { type: Number, default: 0, min: 0 },
    whtAmount:    { type: Number, default: 0, min: 0 }, // withholding tax deducted at source
    totalAmount:  { type: Number, default: 0, min: 0 }, // amount + taxAmount (net of WHT for net-payable use)
    currencyCode: { type: String, default: 'PKR', uppercase: true, maxlength: 3 },

    issueDate:        { type: Date, required: true, index: true },
    dueDate:          { type: Date, default: null, index: true },
    scheduledPayDate: { type: Date, default: null }, // when AP plans to pay this bill

    state: {
      type: String,
      enum: Object.values(BILL_STATES),
      default: BILL_STATES.DRAFT,
      index: true,
    },
    stateHistory: [stateChangeSchema],

    paidAmount:       { type: Number, default: 0, min: 0 },
    remainingBalance: { type: Number, default: null, min: 0 },

    approvalRequired:  { type: Boolean, default: false },
    approvalStatus: {
      type: String,
      enum: Object.values(APPROVAL_STATUS),
      default: APPROVAL_STATUS.NOT_REQUIRED,
    },
    approvalThreshold: { type: Number, default: null },
    approvers: [{
      userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      role:   { type: String, enum: Object.values(APPROVER_ROLES) },
    }],
    approvalLog: [approvalLogEntrySchema],
    approvedBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    approvedAt:  { type: Date, default: null },

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

    isArchived: { type: Boolean, default: false, index: true },
    archivedAt: { type: Date, default: null },
    archivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    description: { type: String, default: null, maxlength: 1000, trim: true },
    notes:       { type: String, default: null, maxlength: 1000, trim: true },
    tags:        [{ type: String, trim: true }],
    metadata:    { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (doc, ret) => { delete ret.__v; return ret; },
    },
  }
);

// ── Indexes ───────────────────────────────────────────────────────────────────
billSchema.index({ businessId: 1, billNumber: 1 }, { unique: true, sparse: true });
billSchema.index({ businessId: 1, state: 1, dueDate: 1 });
billSchema.index({ businessId: 1, vendorId: 1, state: 1 });
billSchema.index({ businessId: 1, isArchived: 1, state: 1, createdAt: -1 });
billSchema.index({ businessId: 1, approvalStatus: 1, state: 1 });

// ── Statics ───────────────────────────────────────────────────────────────────
billSchema.statics.canTransition = function (fromState, toState) {
  if (fromState === toState) return true;
  const allowed = BILL_TRANSITIONS[fromState];
  return Array.isArray(allowed) && allowed.includes(toState);
};

// ── Instance methods ──────────────────────────────────────────────────────────
billSchema.methods.recordStateChange = function (toState, actor, reason = null) {
  this.stateHistory.push({
    fromState: this.state,
    toState,
    actorId:   actor._id,
    actorName: actor.fullName || actor.email || 'Unknown',
    reason,
    timestamp: new Date(),
  });
};

billSchema.methods.recordFieldChange = function (field, before, after, actorId) {
  this.fieldHistory.push({ field, before, after, changedBy: actorId, changedAt: new Date() });
};

// ── Pre-save ──────────────────────────────────────────────────────────────────
billSchema.pre('save', function () {
  if (this.amount != null && this.taxAmount != null) {
    this.totalAmount = Math.round((this.amount + (this.taxAmount || 0)) * 100) / 100;
  }
  if (this.isNew && (this.remainingBalance === null || this.remainingBalance === undefined)) {
    this.remainingBalance = this.totalAmount;
  }
});

const Bill = mongoose.model('Bill', billSchema);
module.exports = Bill;
