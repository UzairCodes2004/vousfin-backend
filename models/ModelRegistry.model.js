// models/ModelRegistry.model.js
//
// Forecast Platform — F3. MODEL REGISTRY (versioning + lineage + gate verdict).
//
// One row per (tenant, key, version). Records the model type, its backtest
// metrics, the seasonal-naive baseline it was measured against, whether it
// passed the BASELINE GATE, the training window, and a code hash — so any served
// forecast is reproducible back to the exact model that produced it.
//
'use strict';
const mongoose = require('mongoose');

const modelRegistrySchema = new mongoose.Schema(
  {
    businessId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    key:         { type: String, required: true },          // `${target}-${granularity}`
    target:      { type: String, required: true },
    granularity: { type: String, enum: ['daily', 'weekly', 'monthly', 'quarterly'], required: true },
    version:     { type: Number, default: 1 },
    modelType:   { type: String, required: true },           // 'Holt-Winters' | 'Bi-LSTM' | 'Ensemble' | baseline name

    backtest:    { type: mongoose.Schema.Types.Mixed, default: {} }, // {mae,rmse,mape,smape,mase,folds,n}
    baselineMase:{ type: Number, default: null },            // seasonal-naive MASE it was measured against
    modelMase:   { type: Number, default: null },
    gatePassed:  { type: Boolean, default: false, index: true },
    gateReason:  { type: String, default: null },

    trainWindow: { start: { type: Date, default: null }, end: { type: Date, default: null }, points: { type: Number, default: 0 } },
    codeHash:    { type: String, default: null },
    status:      { type: String, enum: ['champion', 'challenger', 'baseline', 'retired'], default: 'champion', index: true },
    createdBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, toJSON: { transform: (d, r) => { delete r.__v; return r; } } }
);

modelRegistrySchema.index({ businessId: 1, key: 1, version: -1 });

module.exports = mongoose.model('ModelRegistry', modelRegistrySchema);
