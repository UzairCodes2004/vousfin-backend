/**
 * Scenario Modeler — FR-03.3: business decision financial impact.
 *
 * Baseline = the business's OWN trailing 3 full months from the live GL
 * (never sample data). A decision is a set of parameter deltas; the model
 * projects monthly P&L, cumulative cash impact, break-even position and key
 * ratios across 1 / 6 / 12-month horizons. Pure arithmetic over one report
 * read — comfortably inside the < 4s AC. Simulations only: no records.
 */
'use strict';

const reportService = require('./report.service');
const Scenario = require('../models/Scenario.model');

class ScenarioModelerService {
  /** Trailing-3-full-months monthly averages from the live GL. */
  async baseline(businessId) {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth() - 3, 1);
    const end   = new Date(now.getFullYear(), now.getMonth(), 1);
    const is = await reportService.getIncomeStatement(businessId, start, end);
    const bs = await reportService.getBalanceSheet(businessId, now);
    const cash = (bs.assets?.accounts || [])
      .filter(a => /cash|bank/i.test(a.accountName))
      .reduce((s, a) => s + (a.balance || 0), 0);
    return {
      monthlyRevenue: is.totalRevenue / 3,
      monthlyExpense: is.totalExpenses / 3,
      monthlyNet:     is.netIncome / 3,
      startingCash:   cash,
      basedOn: { start, end, source: 'live GL — trailing 3 full months' },
    };
  }

  /** Project a parameter-change decision across 1/6/12 months. */
  project(base, params = {}) {
    const p = {
      extraMonthlyExpense: Number(params.extraMonthlyExpense) || 0,
      extraMonthlyRevenue: Number(params.extraMonthlyRevenue) || 0,
      revenueChangePct:    Number(params.revenueChangePct) || 0,
      expenseChangePct:    Number(params.expenseChangePct) || 0,
      oneOffCost:          Number(params.oneOffCost) || 0,
    };

    const monthlyRevenue = base.monthlyRevenue * (1 + p.revenueChangePct / 100) + p.extraMonthlyRevenue;
    const monthlyExpense = base.monthlyExpense * (1 + p.expenseChangePct / 100) + p.extraMonthlyExpense;
    const monthlyNet     = monthlyRevenue - monthlyExpense;

    const horizon = (months) => {
      const revenue = monthlyRevenue * months;
      const expense = monthlyExpense * months + p.oneOffCost;
      const net     = revenue - expense;
      const baseNet = base.monthlyNet * months;
      const endCash = base.startingCash + net;
      return {
        months,
        projected: {
          revenue:  Math.round(revenue),
          expense:  Math.round(expense),
          netProfit: Math.round(net),
          endingCash: Math.round(endCash),
          netMarginPct: revenue > 0 ? Math.round((net / revenue) * 1000) / 10 : null,
        },
        vsBaseline: {
          netProfitDelta: Math.round(net - baseNet),
          monthlyNetDelta: Math.round(monthlyNet - base.monthlyNet),
        },
        breakEven: {
          monthlyRevenueNeeded: Math.round(monthlyExpense),
          achieved: monthlyRevenue >= monthlyExpense,
          gapPerMonth: Math.round(monthlyRevenue - monthlyExpense),
          // Months until the one-off cost is recovered by the monthly delta
          paybackMonths: p.oneOffCost > 0 && (monthlyNet - base.monthlyNet) > 0
            ? Math.ceil(p.oneOffCost / (monthlyNet - base.monthlyNet)) : null,
        },
        cashRunwayMonths: monthlyNet < 0 ? Math.floor(base.startingCash / Math.abs(monthlyNet)) : null,
      };
    };

    return {
      simulation: true,           // FR-03.3 AC: clearly marked — never real data
      params: p,
      baseline: {
        monthlyRevenue: Math.round(base.monthlyRevenue),
        monthlyExpense: Math.round(base.monthlyExpense),
        monthlyNet:     Math.round(base.monthlyNet),
        startingCash:   Math.round(base.startingCash),
        basedOn: base.basedOn,
      },
      horizons: [horizon(1), horizon(6), horizon(12)],
    };
  }

  async simulate(businessId, params) {
    const t0 = Date.now();
    const base = await this.baseline(businessId);
    const out = this.project(base, params);
    out.computedInMs = Date.now() - t0;
    return out;
  }

  // ── Saved scenarios (named, comparable) ────────────────────────────────────
  async save(businessId, userId, { name, params }) {
    if (!name?.trim()) { const e = new Error('Scenario name is required'); e.statusCode = 400; throw e; }
    return Scenario.create({ businessId, createdBy: userId, name: name.trim(), params: params || {} });
  }

  async list(businessId) {
    return Scenario.find({ businessId }).sort({ createdAt: -1 }).limit(50).lean();
  }

  async remove(businessId, id) {
    const res = await Scenario.findOneAndDelete({ _id: id, businessId });
    if (!res) { const e = new Error('Scenario not found'); e.statusCode = 404; throw e; }
    return { deleted: true };
  }

  /** Side-by-side comparison of saved scenarios against one shared baseline. */
  async compare(businessId, ids) {
    const base = await this.baseline(businessId);
    const scenarios = await Scenario.find({ businessId, _id: { $in: ids } }).lean();
    return {
      simulation: true,
      baseline: this.project(base, {}).baseline,
      scenarios: scenarios.map(s => ({
        id: String(s._id), name: s.name, params: s.params,
        result: this.project(base, s.params),
      })),
    };
  }
}

module.exports = new ScenarioModelerService();
