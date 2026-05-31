// models/UsageMeter.model.js
//
// Forecast Platform — F9. Per-tenant usage metering for SaaS billing.
// One row per (business, day, endpoint) with a running call count. Append/inc
// only; never blocks a request.
//
'use strict';
const mongoose = require('mongoose');

const usageMeterSchema = new mongoose.Schema(
  {
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    day:        { type: String, required: true },   // YYYY-MM-DD (UTC)
    endpoint:   { type: String, required: true },   // e.g. /api/v1/forecast-registry
    count:      { type: Number, default: 0 },
  },
  { timestamps: true, toJSON: { transform: (d, r) => { delete r.__v; return r; } } }
);

usageMeterSchema.index({ businessId: 1, day: 1, endpoint: 1 }, { unique: true });
usageMeterSchema.index({ businessId: 1, day: -1 });

module.exports = mongoose.model('UsageMeter', usageMeterSchema);
