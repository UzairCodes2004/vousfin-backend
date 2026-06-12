// models/TransactionTemplate.model.js
//
// Feature #5 — Recurring / Template transactions.
//
// A TransactionTemplate is a saved blueprint of a transaction the user records
// often (rent, salaries, subscriptions, a standing client invoice, etc.).
//
//   • As a TEMPLATE  → the user applies it with one click; the normal create
//                      form / endpoint posts a real journal entry from it.
//   • As RECURRING   → when isRecurring = true, a daily cron generates a real
//                      transaction from the template on each recurrence date,
//                      advancing nextRunDate and incrementing runCount.
//
// The template NEVER touches the ledger itself. Generated transactions go
// through transactionService.createTransaction (the one authoritative posting
// path) so tax, AR/AP, period-locks and the approval gate all still apply.
//
'use strict';
const mongoose = require('mongoose');
const { RECURRENCE_PATTERNS } = require('../config/constants');

const transactionTemplateSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true,
    },

    // ── Template identity ─────────────────────────────────────────────────────
    name:        { type: String, required: true, trim: true, maxlength: 120 },

    // ── Transaction blueprint (mirrors the fields createTransaction accepts) ──
    description:     { type: String, required: true, trim: true, maxlength: 500 },
    transactionType: { type: String, default: null },   // optional; engine auto-infers when null
    amount:          { type: Number, required: true, min: 0.01 },
    debitAccountId:  { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', required: true },
    creditAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', required: true },

    // Party — stored by NAME so the template survives a customer/vendor rename
    // or delete; createTransaction find-or-creates the party on each run.
    partyType:  { type: String, enum: ['customer', 'vendor', null], default: null },
    partyName:  { type: String, default: null, trim: true, maxlength: 150 },

    // Optional extras carried onto each generated transaction
    paymentMethod:        { type: String, default: null },
    transactionReference: { type: String, default: null, trim: true, maxlength: 100 },
    notes:                { type: String, default: null, trim: true, maxlength: 1000 },
    currencyCode:         { type: String, default: null, uppercase: true, maxlength: 3 },

    // ── Recurrence (only used when isRecurring = true) ────────────────────────
    isRecurring:       { type: Boolean, default: false, index: true },
    recurrencePattern: { type: String, enum: [...Object.values(RECURRENCE_PATTERNS), null], default: null },
    startDate:         { type: Date, default: null },
    endDate:           { type: Date, default: null },   // null = run forever
    nextRunDate:       { type: Date, default: null, index: true },
    lastRunDate:       { type: Date, default: null },
    runCount:          { type: Number, default: 0, min: 0 },

    // ── Status / ownership ────────────────────────────────────────────────────
    isActive:  { type: Boolean, default: true, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    lastModifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  {
    timestamps: true,
    toJSON: { transform: (doc, ret) => { delete ret.__v; return ret; } },
  }
);

// Cron query: active recurring templates that are due.
transactionTemplateSchema.index({ businessId: 1, isActive: 1, isRecurring: 1, nextRunDate: 1 });

const TransactionTemplate = mongoose.model('TransactionTemplate', transactionTemplateSchema);
module.exports = TransactionTemplate;
