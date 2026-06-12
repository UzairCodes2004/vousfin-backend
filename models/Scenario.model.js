// models/Scenario.model.js — FR-03.3: saved decision-impact scenarios.
// Pure simulations: nothing here ever creates or touches a journal entry.
const mongoose = require('mongoose');

const scenarioSchema = new mongoose.Schema(
  {
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    name:       { type: String, required: true, trim: true, maxlength: 120 },

    // Decision expressed as parameter changes vs the live baseline
    params: {
      extraMonthlyExpense: { type: Number, default: 0 },   // e.g. 3 hires × 80k = 240000
      extraMonthlyRevenue: { type: Number, default: 0 },   // e.g. new contract income
      revenueChangePct:    { type: Number, default: 0 },   // e.g. −15 for a discount
      expenseChangePct:    { type: Number, default: 0 },
      oneOffCost:          { type: Number, default: 0 },   // e.g. branch setup cost (month 1)
      note:                { type: String, default: '', maxlength: 500 },
    },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

scenarioSchema.index({ businessId: 1, createdAt: -1 });

module.exports = mongoose.model('Scenario', scenarioSchema);
