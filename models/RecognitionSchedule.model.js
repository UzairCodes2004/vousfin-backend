// models/RecognitionSchedule.model.js
//
// Phase 4 — Accrual accounting: revenue/expense recognition schedules.
//
// One document represents an amount received or paid up-front that must be
// recognized across several future periods (the accrual/matching principle):
//
//   • deferred_revenue — customer paid up-front (e.g. an annual subscription).
//       Holding account: a LIABILITY (Unearned Revenue, 2170).
//       Each period:  DR Unearned Revenue   CR Revenue        (earn a slice)
//
//   • prepaid_expense — we paid up-front (e.g. annual insurance / rent).
//       Holding account: an ASSET (Prepaid Expenses, 1120).
//       Each period:  DR Expense            CR Prepaid Expenses (consume a slice)
//
// The schedule pre-computes one `line` per period (straight-line). A daily job
// (recognitionSchedule.service.postDueRecognitions) posts each line's journal
// entry once its scheduledDate arrives — atomically, via ledgerPosting — so the
// P&L recognizes income/expense in the correct period instead of when cash moved.
//
'use strict';

const mongoose = require('mongoose');

const RECOGNITION_TYPES   = ['deferred_revenue', 'prepaid_expense'];
const RECOGNITION_STATUS  = ['active', 'completed', 'cancelled'];
const LINE_STATUS         = ['pending', 'posted'];

// One scheduled recognition slice.
const recognitionLineSchema = new mongoose.Schema(
  {
    periodNumber:   { type: Number, required: true, min: 1 },
    scheduledDate:  { type: Date,   required: true },
    amount:         { type: Number, required: true, min: 0 },
    status:         { type: String, enum: LINE_STATUS, default: 'pending', index: true },
    journalEntryId: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', default: null },
    postedAt:       { type: Date,   default: null },
  },
  { _id: true }
);

const recognitionScheduleSchema = new mongoose.Schema(
  {
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },

    type:        { type: String, enum: RECOGNITION_TYPES, required: true, index: true },
    description: { type: String, required: true, trim: true, maxlength: 300 },

    // Optional origin link (an invoice/bill/transaction this schedule was created from).
    sourceType: { type: String, enum: ['manual', 'invoice', 'bill', 'transaction'], default: 'manual' },
    sourceId:   { type: mongoose.Schema.Types.ObjectId, default: null },

    totalAmount:  { type: Number, required: true, min: 0.01 },
    currencyCode: { type: String, default: 'PKR', uppercase: true, trim: true, maxlength: 3 },

    startDate: { type: Date, required: true },
    periods:   { type: Number, required: true, min: 1, max: 600 }, // up to 50 years monthly
    frequency: { type: String, enum: ['monthly'], default: 'monthly' }, // MVP: monthly only
    method:    { type: String, enum: ['straight_line'], default: 'straight_line' },

    // deferralAccountId  = the balance-sheet holding account (liability / asset)
    // recognitionAccountId = the P&L account recognized into (revenue / expense)
    deferralAccountId:    { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', required: true },
    recognitionAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', required: true },

    status: { type: String, enum: RECOGNITION_STATUS, default: 'active', index: true },
    lines:  [recognitionLineSchema],

    recognizedAmount: { type: Number, default: 0, min: 0 },

    createdBy:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    lastModifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  {
    timestamps: true,
    toJSON:   { virtuals: true, transform: (doc, ret) => { delete ret.__v; return ret; } },
    toObject: { virtuals: true },
  }
);

// Outstanding (not-yet-recognized) amount — always derived, never stored.
recognitionScheduleSchema.virtual('remainingAmount').get(function () {
  return Math.round((this.totalAmount - this.recognizedAmount) * 100) / 100;
});

recognitionScheduleSchema.index({ businessId: 1, status: 1, 'lines.status': 1 });
recognitionScheduleSchema.index({ businessId: 1, type: 1, createdAt: -1 });

recognitionScheduleSchema.statics.RECOGNITION_TYPES  = RECOGNITION_TYPES;
recognitionScheduleSchema.statics.RECOGNITION_STATUS = RECOGNITION_STATUS;

const RecognitionSchedule = mongoose.model('RecognitionSchedule', recognitionScheduleSchema);
module.exports = RecognitionSchedule;
module.exports.RECOGNITION_TYPES = RECOGNITION_TYPES;
