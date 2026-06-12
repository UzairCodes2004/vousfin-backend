// models/FinancialAlert.model.js
//
// FR-02.1 / FR-02.3 — persisted financial alerts.
//
// One document per (business, rule, period) so an alert fires ONCE per period
// instead of spamming on every monitor run, and survives restarts so the
// "Needs attention" feed and notification badge stay consistent. The unique
// compound index is the dedup enforcement layer.
const mongoose = require('mongoose');

const financialAlertSchema = new mongoose.Schema(
  {
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },

    // Stable rule identifier, e.g. 'balance_equation', 'revenue_decline',
    // 'margin_compression', 'expense_outpacing_revenue', 'kpi_current_ratio'
    ruleKey:   { type: String, required: true },
    // Dedup window: trends fire once per ISO month; the balance-equation
    // invariant fires once per day while broken.
    periodKey: { type: String, required: true },

    level: { type: String, enum: ['critical', 'warning', 'info'], default: 'warning' },
    title: { type: String, required: true },

    // FR-02.3 AC: every alert says what changed, by how much, since when,
    // and what to do about it.
    what:           { type: String, default: '' },
    howMuch:        { type: String, default: '' },
    sinceWhen:      { type: String, default: '' },
    recommendation: { type: String, default: '' },

    actionTo: { type: String, default: '' },  // frontend route for the CTA
    data:     { type: mongoose.Schema.Types.Mixed, default: {} }, // raw numbers driving the alert

    status:  { type: String, enum: ['open', 'acknowledged'], default: 'open', index: true },
    firedAt: { type: Date, default: Date.now },
    ackedAt: { type: Date, default: null },
    ackedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

// Dedup: one alert per business+rule+period regardless of monitor cadence.
financialAlertSchema.index({ businessId: 1, ruleKey: 1, periodKey: 1 }, { unique: true });
financialAlertSchema.index({ businessId: 1, status: 1, firedAt: -1 });

module.exports = mongoose.model('FinancialAlert', financialAlertSchema);
