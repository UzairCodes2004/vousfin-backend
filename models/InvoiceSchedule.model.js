// models/InvoiceSchedule.model.js
//
// AR/AP Refactor — Milestone M8 (recurring invoices).
//
// AR mirror of BillSchedule: a recurring invoice template. The invoiceScheduler
// service generates Invoice documents from this template on each recurrence
// date (cron-driven), advancing nextRunDate and incrementing runCount.
//
'use strict';
const mongoose = require('mongoose');
const { RECURRENCE_PATTERNS } = require('../config/constants');

const lineItemTemplateSchema = new mongoose.Schema(
  {
    name:      { type: String, required: true, trim: true, maxlength: 300 },
    quantity:  { type: Number, required: true, min: 0.0001 },
    unitPrice: { type: Number, required: true, min: 0 },
    unit:      { type: String, default: 'pcs', maxlength: 20 },
    taxRate:   { type: Number, default: 0, min: 0, max: 100 },
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', default: null },
  },
  { _id: false }
);

const invoiceScheduleSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true,
    },
    customerId: {
      type: mongoose.Schema.Types.ObjectId, ref: 'Customer', default: null, index: true,
    },

    // ── Schedule definition ───────────────────────────────────────────────────
    name:        { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, default: null, maxlength: 500 },

    recurrencePattern: {
      type: String, enum: Object.values(RECURRENCE_PATTERNS), required: true,
    },

    startDate:   { type: Date, required: true },
    endDate:     { type: Date, default: null },           // null = run forever
    nextRunDate: { type: Date, required: true, index: true },
    lastRunDate: { type: Date, default: null },
    runCount:    { type: Number, default: 0, min: 0 },

    // ── Template data for generated invoices ──────────────────────────────────
    lineItems:       [lineItemTemplateSchema],
    currencyCode:    { type: String, default: 'PKR', uppercase: true, maxlength: 3 },
    // M8 — structured payment terms code applied to each generated invoice.
    paymentTermsCode:{ type: String, default: 'NET_30' },
    invoicePrefix:   { type: String, default: 'REC', maxlength: 12 },

    // ── Auto-actions ───────────────────────────────────────────────────────────
    autoSubmit:  { type: Boolean, default: false }, // auto-submit for approval on generation
    notifyEmail: { type: String, default: null },

    // ── Status ───────────────────────────────────────────────────────────────
    isActive:  { type: Boolean, default: true, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  {
    timestamps: true,
    toJSON: { transform: (doc, ret) => { delete ret.__v; return ret; } },
  }
);

invoiceScheduleSchema.index({ businessId: 1, isActive: 1, nextRunDate: 1 });

const InvoiceSchedule = mongoose.model('InvoiceSchedule', invoiceScheduleSchema);
module.exports = InvoiceSchedule;
