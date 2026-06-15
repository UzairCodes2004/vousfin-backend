// models/TaxReturn.model.js
//
// FR-04.3 — a prepared tax return (GST-01 / WHT-165 / income-tax) compiled from
// the GL, validated against FBR rejection rules, and submitted (IRIS or XML).
// Lifecycle is governed by RETURN_TRANSITIONS (config/constants.js).
//
'use strict';
const mongoose = require('mongoose');
const { TAX_RETURN_STATUS, TAX_RETURN_TYPES, RETURN_TRANSITIONS } = require('../config/constants');

const validationErrorSchema = new mongoose.Schema(
  { code: String, field: String, message: String, fix: String, severity: { type: String, default: 'error' } },
  { _id: false },
);

const taxReturnSchema = new mongoose.Schema(
  {
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    returnType: { type: String, enum: Object.values(TAX_RETURN_TYPES), required: true },

    // Period the return covers. Monthly returns set month (1–12); annual set year only.
    period: {
      year:  { type: Number, required: true },
      month: { type: Number, default: null },   // null = annual
    },

    status: { type: String, enum: Object.values(TAX_RETURN_STATUS), default: TAX_RETURN_STATUS.DRAFT, index: true },

    // The mapped FBR field set + annexes (shape varies by returnType).
    data: { type: mongoose.Schema.Types.Mixed, default: {} },

    validation: {
      passed:    { type: Boolean, default: false },
      checkedAt: { type: Date, default: null },
      errors:    { type: [validationErrorSchema], default: [] },
    },

    fbr: {
      mode:        { type: String, default: null },   // 'iris' | 'xml'
      ackNumber:   { type: String, default: null },
      submittedAt: { type: Date, default: null },
    },

    exportPath: { type: String, default: null },       // last XML/PDF export
    createdBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, toJSON: { transform: (d, r) => { delete r.__v; return r; } } },
);

// One return per business per type per period.
taxReturnSchema.index({ businessId: 1, returnType: 1, 'period.year': 1, 'period.month': 1 }, { unique: true });

/** Guard every status change through the transition map (mirrors PO/GRN pattern). */
taxReturnSchema.statics.canTransition = function (fromState, toState) {
  if (fromState === toState) return true;
  const allowed = RETURN_TRANSITIONS[fromState];
  return Array.isArray(allowed) && allowed.includes(toState);
};

module.exports = mongoose.model('TaxReturn', taxReturnSchema);
