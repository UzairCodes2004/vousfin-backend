// models/Payment.model.js
//
// AR/AP Domain Refactor — Milestone M2: first-class Payment entity.
//
// A Payment is the business record of money received from a customer (inbound)
// or paid to a vendor (outbound). It can be APPLIED across one or many open
// documents (invoices for inbound, bills for outbound) with partial amounts, and
// any excess is held as `unappliedAmount` (overpayment / on-account credit).
//
// The Payment is NOT a ledger source of truth. Each allocation delegates to the
// existing settlement primitive (transaction.recordPartialPayment) which posts
// the balanced JournalEntry; the overpayment posts an advance JE. The Payment
// merely groups those ledger effects into one auditable receipt/remittance.

'use strict';

const mongoose = require('mongoose');

const allocationSchema = new mongoose.Schema(
  {
    documentType:         { type: String, enum: ['invoice', 'bill'], required: true },
    // Optional: legacy payments may settle a journal entry that has no first-class
    // Invoice/Bill document. The parentJournalEntryId is the authoritative target.
    documentId:           { type: mongoose.Schema.Types.ObjectId, default: null },
    documentNumber:       { type: String, default: null },
    // The recognition JournalEntry (CREDIT_SALE / CREDIT_PURCHASE) this allocation settles.
    parentJournalEntryId: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', required: true },
    amount:               { type: Number, required: true, min: 0.01 },
    // The child settlement JournalEntry produced when this allocation is applied.
    settlementTransactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', default: null },
  },
  { _id: false }
);

const paymentSchema = new mongoose.Schema(
  {
    businessId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    paymentNumber: { type: String, required: true, trim: true },

    // inbound = customer receipt (AR), outbound = vendor disbursement (AP)
    direction:  { type: String, enum: ['inbound', 'outbound'], required: true, index: true },
    partyType:  { type: String, enum: ['customer', 'vendor'], required: true },
    // Nullable: an unlinked AR/AP entry (e.g. a manual credit-sale journal with no
    // customer) can still be settled. The cash + outstanding move; there is simply
    // no party subledger to update.
    partyId:    { type: mongoose.Schema.Types.ObjectId, required: false, default: null, index: true },
    partySnapshot: {
      name:  { type: String, default: null },
      email: { type: String, default: null },
    },

    paymentDate:  { type: Date, required: true, index: true },
    amount:       { type: Number, required: true, min: 0.01 },
    currencyCode: { type: String, default: 'PKR', uppercase: true, maxlength: 3 },
    exchangeRate: { type: Number, default: 1 },

    method:    { type: String, enum: ['cash', 'bank_transfer', 'cheque', 'card', 'other'], default: 'bank_transfer' },
    reference: { type: String, default: null, trim: true, maxlength: 100 },
    // The Cash/Bank Chart-of-Account the money moved through.
    cashAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', required: true },

    allocations:     { type: [allocationSchema], default: [] },
    allocatedAmount: { type: Number, default: 0, min: 0 },        // Σ allocations.amount
    unappliedAmount: { type: Number, default: 0, min: 0 },        // amount − allocatedAmount
    // Advance JE (DR Cash / CR Advance-from-Customers | DR Advance-to-Suppliers / CR Cash) for overpayment.
    unappliedJournalEntryId: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', default: null },

    status: {
      type: String,
      enum: ['completed', 'partially_allocated', 'unallocated', 'void'],
      default: 'completed',
      index: true,
    },
    voidReason: { type: String, default: null },

    notes:          { type: String, default: null, maxlength: 1000, trim: true },
    isArchived:     { type: Boolean, default: false, index: true },
    createdBy:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    lastModifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, toJSON: { transform: (doc, ret) => { delete ret.__v; return ret; } } }
);

// ── Indexes ─────────────────────────────────────────────────────────────────
paymentSchema.index({ businessId: 1, paymentNumber: 1 }, { unique: true, sparse: true });
paymentSchema.index({ businessId: 1, direction: 1, paymentDate: -1 });
paymentSchema.index({ businessId: 1, partyId: 1, paymentDate: -1 });
// Fast "which payment settled this transaction?" lookup (idempotent backfill).
paymentSchema.index({ businessId: 1, 'allocations.settlementTransactionId': 1 });
paymentSchema.index({ businessId: 1, 'allocations.documentId': 1 });

// ── Derived totals + status (recomputed on every save) ──────────────────────
paymentSchema.pre('save', function () {
  const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
  this.allocatedAmount = r2((this.allocations || []).reduce((s, a) => s + (a.amount || 0), 0));
  this.unappliedAmount = r2((this.amount || 0) - this.allocatedAmount);
  if (this.status !== 'void') {
    if (this.allocatedAmount <= 0)        this.status = 'unallocated';
    else if (this.unappliedAmount > 0.009) this.status = 'partially_allocated';
    else                                   this.status = 'completed';
  }
});

// ── Sequential, business-scoped payment number: PAY-YYYYMM-XXXXX ─────────────
paymentSchema.statics.nextPaymentNumber = async function (businessId) {
  const now = new Date();
  const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
  const prefix = `PAY-${ym}-`;
  const last = await this.findOne(
    { businessId, paymentNumber: { $regex: `^${prefix}` } },
    { paymentNumber: 1 }
  ).sort({ paymentNumber: -1 }).lean();
  const seq = last ? parseInt(last.paymentNumber.slice(prefix.length), 10) + 1 : 1;
  return `${prefix}${String(seq).padStart(5, '0')}`;
};

module.exports = mongoose.model('Payment', paymentSchema);
