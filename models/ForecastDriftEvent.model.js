// models/ForecastDriftEvent.model.js
//
// Forecast Platform — F5. Append-only log of drift checks: the PSI/severity of
// data drift, the realized accuracy decay, and whether a retrain was triggered.
// Gives an auditable history of "why the model was (or wasn't) retrained".
//
'use strict';
const mongoose = require('mongoose');

const forecastDriftEventSchema = new mongoose.Schema(
  {
    businessId:       { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    key:              { type: String, required: true },          // `${target}-${granularity}`
    target:           { type: String, required: true },
    granularity:      { type: String, default: 'monthly' },

    psi:              { type: Number, default: null },
    driftLevel:       { type: String, enum: ['none', 'moderate', 'severe', 'unknown'], default: 'unknown' },
    klDivergence:     { type: Number, default: null },
    accuracyDecayPct: { type: Number, default: null },
    decayed:          { type: Boolean, default: false },

    shouldRetrain:    { type: Boolean, default: false, index: true },
    points:           { type: Number, default: 0 },
    checkedAt:        { type: Date, default: Date.now },
  },
  { timestamps: true, toJSON: { transform: (d, r) => { delete r.__v; return r; } } }
);

forecastDriftEventSchema.index({ businessId: 1, key: 1, checkedAt: -1 });

module.exports = mongoose.model('ForecastDriftEvent', forecastDriftEventSchema);
