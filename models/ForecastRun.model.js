// models/ForecastRun.model.js
//
// Forecast Platform — F3. FORECAST PERSISTENCE.
//
// Every served forecast is persisted here with the exact inputs hash, the model
// version that produced it, the prediction + interval, and the baseline-gate
// verdict — making the forecast auditable and enabling ex-post accuracy capture
// (ForecastAccuracy) once the forecasted periods elapse.
//
'use strict';
const mongoose = require('mongoose');

const forecastRunSchema = new mongoose.Schema(
  {
    businessId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    target:       { type: String, required: true },
    granularity:  { type: String, default: 'monthly' },
    horizon:      { type: Number, required: true },

    modelType:    { type: String, required: true },
    modelVersion: { type: Number, default: null },
    modelRegistryId: { type: mongoose.Schema.Types.ObjectId, ref: 'ModelRegistry', default: null },
    dataSource:   { type: String, default: null },          // 'live' | 'lstm_live' | 'baseline' | 'none'

    inputsHash:   { type: String, default: null, index: true }, // sha256 of the input series + params
    periodLabels: [{ type: String }],
    predicted:    [{ type: Number }],
    lower:        [{ type: Number }],
    upper:        [{ type: Number }],

    baselineMase: { type: Number, default: null },
    modelMase:    { type: Number, default: null },
    gatePassed:   { type: Boolean, default: null },
    servedBaseline:{ type: Boolean, default: false },        // true if the gate forced a baseline fallback

    generatedAt:  { type: Date, default: Date.now, index: true },
  },
  { timestamps: true, toJSON: { transform: (d, r) => { delete r.__v; return r; } } }
);

forecastRunSchema.index({ businessId: 1, target: 1, granularity: 1, generatedAt: -1 });

module.exports = mongoose.model('ForecastRun', forecastRunSchema);
