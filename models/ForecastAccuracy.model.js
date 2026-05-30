// models/ForecastAccuracy.model.js
//
// Forecast Platform — F3. EX-POST REALIZED ACCURACY.
//
// As each forecasted period elapses, the accuracy job captures the realized
// actual against what was predicted (per horizon step), so the platform can
// report true out-of-sample error, monitor interval coverage, and (in F5) drive
// drift-triggered retraining. Idempotent per (run, horizonStep).
//
'use strict';
const mongoose = require('mongoose');

const forecastAccuracySchema = new mongoose.Schema(
  {
    businessId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    forecastRunId: { type: mongoose.Schema.Types.ObjectId, ref: 'ForecastRun', required: true, index: true },
    target:        { type: String, required: true },
    granularity:   { type: String, default: 'monthly' },

    horizonStep:   { type: Number, required: true },        // 1-based step into the forecast
    periodKey:     { type: String, default: null },
    predicted:     { type: Number, required: true },
    actual:        { type: Number, required: true },
    absError:      { type: Number, required: true },
    pctError:      { type: Number, default: null },
    withinInterval:{ type: Boolean, default: null },        // actual ∈ [lower,upper] ?

    capturedAt:    { type: Date, default: Date.now },
  },
  { timestamps: true, toJSON: { transform: (d, r) => { delete r.__v; return r; } } }
);

forecastAccuracySchema.index({ businessId: 1, forecastRunId: 1, horizonStep: 1 }, { unique: true });
forecastAccuracySchema.index({ businessId: 1, target: 1, capturedAt: -1 });

module.exports = mongoose.model('ForecastAccuracy', forecastAccuracySchema);
