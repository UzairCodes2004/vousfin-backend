// models/BillSchedule.model.js
//
// Phase 3.3 — Bill Scheduling & Recurring Bills
//
// Defines a recurring bill template.  The scheduler service generates
// Bill documents from this template on each recurrence date.
//
'use strict';
const mongoose = require('mongoose');
const { RECURRENCE_PATTERNS } = require('../config/constants');

const lineItemTemplateSchema = new mongoose.Schema(
  {
    name:       { type: String, required: true, trim: true, maxlength: 300 },
    quantity:   { type: Number, required: true, min: 0.0001 },
    unitPrice:  { type: Number, required: true, min: 0 },
    unit:       { type: String, default: 'pcs', maxlength: 20 },
    taxRate:    { type: Number, default: 0, min: 0, max: 100 },
    accountId:  { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', default: null },
  },
  { _id: false }
);

const billScheduleSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      index: true,
    },
    vendorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Vendor',
      default: null,
      index: true,
    },

    // ── Schedule definition ───────────────────────────────────────────────────
    name:        { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, default: null, maxlength: 500 },

    recurrencePattern: {
      type: String,
      enum: Object.values(RECURRENCE_PATTERNS),
      required: true,
    },

    startDate:    { type: Date, required: true },
    endDate:      { type: Date, default: null },         // null = run forever
    nextRunDate:  { type: Date, required: true, index: true },
    lastRunDate:  { type: Date, default: null },
    runCount:     { type: Number, default: 0, min: 0 },  // how many bills generated

    // ── Template data for generated bills ────────────────────────────────────
    lineItems:       [lineItemTemplateSchema],
    currencyCode:    { type: String, default: 'PKR', uppercase: true, maxlength: 3 },
    paymentTermsDays:{ type: Number, default: 30, min: 0 }, // dueDate = issueDate + N days

    // ── Auto-actions ──────────────────────────────────────────────────────────
    autoSubmit:  { type: Boolean, default: false }, // auto-submit for approval on generation
    notifyEmail: { type: String, default: null },   // send notification to this email

    // ── Status ────────────────────────────────────────────────────────────────
    isActive: { type: Boolean, default: true, index: true },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (doc, ret) => { delete ret.__v; return ret; },
    },
  }
);

billScheduleSchema.index({ businessId: 1, isActive: 1, nextRunDate: 1 });

const BillSchedule = mongoose.model('BillSchedule', billScheduleSchema);
module.exports = BillSchedule;
