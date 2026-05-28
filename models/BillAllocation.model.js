// models/BillAllocation.model.js
//
// Phase 3.3 — Expense Allocation (cost-centre splitting)
//
// Records how a bill's total cost is distributed across departments,
// branches, projects, or cost-centres.  Each allocation line has a
// pointer to the generated journal entry for that slice.
//
'use strict';
const mongoose = require('mongoose');
const {
  COST_CENTER_TYPES,
  ALLOCATION_METHODS,
} = require('../config/constants');

const allocationLineSchema = new mongoose.Schema(
  {
    costCenterType: {
      type: String,
      enum: Object.values(COST_CENTER_TYPES),
      required: true,
    },
    costCenterId:   { type: String, required: true },   // free-form ID / code
    costCenterName: { type: String, required: true, maxlength: 200 },

    percentage:     { type: Number, default: null, min: 0, max: 100 },
    amount:         { type: Number, required: true, min: 0 },
    accountId:      { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', default: null },

    // Each split can generate its own journal entry segment
    journalEntryId: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', default: null },

    note:           { type: String, default: null, maxlength: 300 },
  },
  { _id: true }
);

const billAllocationSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      index: true,
    },
    billId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Bill',
      required: true,
      index: true,
    },

    method: {
      type: String,
      enum: Object.values(ALLOCATION_METHODS),
      default: ALLOCATION_METHODS.PERCENTAGE,
    },

    totalAllocated: { type: Number, required: true, min: 0 },
    lines:          [allocationLineSchema],

    // Summary journal entry that aggregates the allocation
    summaryJournalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JournalEntry',
      default: null,
    },

    isBalanced:  { type: Boolean, default: false },   // lines sum == totalAllocated
    createdBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    updatedBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    notes:       { type: String, default: null, maxlength: 500 },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (doc, ret) => { delete ret.__v; return ret; },
    },
  }
);

billAllocationSchema.index({ businessId: 1, billId: 1 }, { unique: true });

const BillAllocation = mongoose.model('BillAllocation', billAllocationSchema);
module.exports = BillAllocation;
