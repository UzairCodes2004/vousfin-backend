// models/AutonomyPolicy.model.js
//
// Autonomy roadmap Phase 0 — the per-business control plane for how much VousFin
// is trusted to act, per capability. Capabilities are stored as a free-form map
// so new capabilities can be added without a migration; the service merges them
// over safe defaults (everything starts at "suggest").
//
'use strict';
const mongoose = require('mongoose');

const autonomyPolicySchema = new mongoose.Schema(
  {
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, unique: true, index: true },
    // { [capability]: { level, confidenceThreshold, maxAutoAmount } }
    capabilities: { type: mongoose.Schema.Types.Mixed, default: {} },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, toJSON: { transform: (d, r) => { delete r.__v; return r; } } },
);

module.exports = mongoose.model('AutonomyPolicy', autonomyPolicySchema);
