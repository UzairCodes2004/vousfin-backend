// models/TaxPositionSnapshot.model.js
//
// FR-04.1 (Phase 2) — daily snapshot of the live tax position, so liability is
// trendable over time ("your GST went Rs 1.8M → Rs 2.1M this month"). One
// snapshot per business per calendar day (idempotent upsert on { businessId, date }).
//
'use strict';
const mongoose = require('mongoose');

// A slimmed per-tax line — only what the trend needs (no transient display fields).
const taxLineSchema = new mongoose.Schema(
  {
    taxType:    { type: String, required: true },          // GST | WHT | INCOME_TAX | EOBI | SESSI
    liability:  { type: Number, default: 0 },              // payable on the snapshot day
    refundable: { type: Boolean, default: false },         // true when net input > output (GST refund)
    status:     { type: String, default: 'tracked' },      // tracked | not_tracked
  },
  { _id: false }
);

const taxPositionSnapshotSchema = new mongoose.Schema(
  {
    businessId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    date:         { type: String, required: true },        // 'YYYY-MM-DD' (local business day)
    currency:     { type: String, default: 'PKR' },
    country:      { type: String, default: 'PK' },
    taxes:        { type: [taxLineSchema], default: [] },
    totalPayable: { type: Number, default: 0 },
    capturedAt:   { type: Date, default: Date.now },
  },
  { timestamps: true, toJSON: { transform: (d, r) => { delete r.__v; return r; } } }
);

// One row per business per day — re-runs upsert the same row.
taxPositionSnapshotSchema.index({ businessId: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('TaxPositionSnapshot', taxPositionSnapshotSchema);
