// models/CurrencyRate.model.js
// Stores daily exchange rates per business (manual entry or imported).
// Used by fx.service.js for historical rate lookup during reporting and
// transaction creation.
const mongoose = require('mongoose');

const currencyRateSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      index: true,
    },
    // The "priced" currency, e.g. USD when rate says 1 USD = 280 PKR
    fromCurrency: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      maxlength: 3,
    },
    // The "base" reporting currency, e.g. PKR
    toCurrency: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      maxlength: 3,
    },
    // Units of toCurrency per 1 unit of fromCurrency
    rate: {
      type: Number,
      required: true,
      min: 0.000001,
    },
    // The calendar date this rate is valid from (daily granularity)
    rateDate: {
      type: Date,
      required: true,
    },
    source: {
      type: String,
      enum: ['manual', 'imported'],
      default: 'manual',
    },
    notes: {
      type: String,
      maxlength: 200,
      default: null,
      trim: true,
    },
  },
  { timestamps: true }
);

// Fast lookup: given a pair, find the most recent rate on or before a date
currencyRateSchema.index(
  { businessId: 1, fromCurrency: 1, toCurrency: 1, rateDate: -1 }
);

// One rate per pair per day per business
currencyRateSchema.index(
  { businessId: 1, fromCurrency: 1, toCurrency: 1, rateDate: 1 },
  { unique: true }
);

module.exports = mongoose.model('CurrencyRate', currencyRateSchema);
