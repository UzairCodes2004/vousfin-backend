/**
 * Financial Health Indicators — FR-03.2.
 *
 * Computes 42 indicators across five dimensions (Liquidity, Profitability,
 * Solvency, Efficiency, Growth) straight from the live GL, classifies each
 * into green/amber/red zones (industry-norm defaults, per-business overrides
 * via Business.trendAlertConfig.health), and turns red-zone breaches into
 * plain-language FinancialAlert advisories with root-cause transactions and
 * a recommended action. Delivered in-app (alerts feed) + email (best-effort);
 * WhatsApp goes live automatically once Twilio creds are configured.
 *
 * "Real-time": evaluated in the 5-second post-posting debounce hook (see
 * JournalEntry.model) and every 30 minutes by the trend-monitor cron.
 */
'use strict';

const mongoose = require('mongoose');
const logger = require('../config/logger');
const reportService = require('./report.service');
const FinancialAlert = require('../models/FinancialAlert.model');
const Business = require('../models/Business.model');

const fmt = (n) => `Rs ${Math.round(Math.abs(Number(n) || 0)).toLocaleString('en-PK')}`;
const dayKey = () => new Date().toISOString().slice(0, 10);
const safeDiv = (a, b) => (b && Math.abs(b) > 1e-9 ? a / b : null);

/* Zone classification: direction 'low' = bad when BELOW thresholds,
   'high' = bad when ABOVE thresholds. */
function zoneOf(value, { amber, red, direction = 'low' }) {
  if (value === null || value === undefined || !isFinite(value)) return 'na';
  if (direction === 'low')  return value < red ? 'red' : value < amber ? 'amber' : 'green';
  return value > red ? 'red' : value > amber ? 'amber' : 'green';
}

/* Industry-norm default thresholds (SME trading/services, Pakistan). */
const DEFAULT_THRESHOLDS = {
  // ── Liquidity ──
  current_ratio:        { amber: 1.2,  red: 1.0,  direction: 'low'  },
  quick_ratio:          { amber: 1.0,  red: 0.7,  direction: 'low'  },
  cash_ratio:           { amber: 0.3,  red: 0.15, direction: 'low'  },
  cash_coverage_days:   { amber: 30,   red: 14,   direction: 'low'  },
  working_capital:      { amber: 0,    red: -1,   direction: 'low'  },
  ar_to_current_assets: { amber: 0.6,  red: 0.8,  direction: 'high' },
  cash_to_monthly_expense: { amber: 1.0, red: 0.5, direction: 'low' },
  net_working_capital_ratio: { amber: 0.1, red: 0, direction: 'low' },
  // ── Profitability ──
  gross_margin_pct:     { amber: 20,   red: 10,   direction: 'low'  },
  net_margin_pct:       { amber: 5,    red: 0,    direction: 'low'  },
  operating_margin_pct: { amber: 8,    red: 2,    direction: 'low'  },
  ebitda_margin_pct:    { amber: 10,   red: 3,    direction: 'low'  },
  return_on_equity_pct: { amber: 8,    red: 0,    direction: 'low'  },
  return_on_assets_pct: { amber: 4,    red: 0,    direction: 'low'  },
  revenue_per_expense:  { amber: 1.1,  red: 1.0,  direction: 'low'  },
  break_even_coverage:  { amber: 1.1,  red: 1.0,  direction: 'low'  },
  profit_growth_pct:    { amber: 0,    red: -20,  direction: 'low'  },
  expense_ratio_pct:    { amber: 90,   red: 100,  direction: 'high' },
  // ── Solvency ──
  debt_to_equity:       { amber: 1.5,  red: 2.5,  direction: 'high' },
  debt_to_assets:       { amber: 0.6,  red: 0.8,  direction: 'high' },
  equity_ratio:         { amber: 0.3,  red: 0.15, direction: 'low'  },
  interest_coverage:    { amber: 3,    red: 1.5,  direction: 'low'  },
  liability_growth_pct: { amber: 15,   red: 35,   direction: 'high' },
  long_term_debt_ratio: { amber: 0.4,  red: 0.6,  direction: 'high' },
  net_worth:            { amber: 1,    red: 0,    direction: 'low'  },
  // ── Efficiency ──
  dso_days:             { amber: 45,   red: 75,   direction: 'high' },
  dpo_days:             { amber: 60,   red: 90,   direction: 'high' },
  cash_conversion_days: { amber: 60,   red: 90,   direction: 'high' },
  inventory_turnover:   { amber: 4,    red: 2,    direction: 'low'  },
  inventory_days:       { amber: 90,   red: 180,  direction: 'high' },
  asset_turnover:       { amber: 0.5,  red: 0.2,  direction: 'low'  },
  ar_turnover:          { amber: 6,    red: 3,    direction: 'low'  },
  ap_to_expense_ratio:  { amber: 0.5,  red: 0.8,  direction: 'high' },
  opex_to_revenue_pct:  { amber: 70,   red: 90,   direction: 'high' },
  // ── Growth ──
  revenue_growth_30d_pct:  { amber: 0,   red: -15, direction: 'low'  },
  revenue_growth_90d_pct:  { amber: 0,   red: -10, direction: 'low'  },
  expense_growth_30d_pct:  { amber: 20,  red: 40,  direction: 'high' },
  expense_vs_revenue_gap:  { amber: 10,  red: 25,  direction: 'high' },
  customer_concentration_pct: { amber: 40, red: 60, direction: 'high' },
  receivable_growth_pct:   { amber: 25,  red: 50,  direction: 'high' },
  cash_flow_growth_pct:    { amber: 0,   red: -25, direction: 'low'  },
  profit_trend_3m:         { amber: 0,   red: -1,  direction: 'low'  },
};

/* Plain-language advisory builders for red/amber breaches. */
const ADVISORY = {
  current_ratio: (v, d) => ({
    what: 'You may struggle to pay near-term bills — current liabilities are close to or above current assets.',
    howMuch: `Current ratio ${v.toFixed(2)} — current liabilities exceed comfortable coverage by ${fmt(Math.max(0, d.curLiab - d.curAssets))}.`,
    recommendation: 'Accelerate receivable collections and delay non-essential purchases; review the Payables schedule.',
    actionTo: '/financial-reports/balance-sheet',
  }),
  cash_coverage_days: (v) => ({
    what: 'Your cash runway is getting short at the current spending pace.',
    howMuch: `Only ${Math.round(v)} days of expenses covered by available cash.`,
    recommendation: 'Chase overdue invoices today and defer discretionary spend; see the cash-flow forecast.',
    actionTo: '/ai-analyst/forecast',
  }),
  net_margin_pct: (v) => ({
    what: 'The business is keeping very little (or nothing) of each rupee earned.',
    howMuch: `Net margin is ${v.toFixed(1)}%.`,
    recommendation: 'Compare expense categories to last month on the Income Statement — find the category outpacing revenue.',
    actionTo: '/financial-reports/income-statement',
  }),
  dso_days: (v) => ({
    what: 'Customers are taking too long to pay you.',
    howMuch: `Average collection time is ${Math.round(v)} days.`,
    recommendation: 'Enable invoice reminders/dunning and offer early-payment incentives to your slowest payers.',
    actionTo: '/sales/receivables',
  }),
  customer_concentration_pct: (v, d) => ({
    what: 'Too much of your business depends on a single customer.',
    howMuch: `${d.topCustomer || 'Your top customer'} represents ${v.toFixed(0)}% of outstanding receivables.`,
    recommendation: 'Diversify the client base; consider credit limits for concentrated exposure.',
    actionTo: '/customers',
  }),
  debt_to_equity: (v) => ({
    what: 'The business is carrying heavy debt relative to owner equity.',
    howMuch: `Debt-to-equity is ${v.toFixed(2)}.`,
    recommendation: 'Avoid new borrowing; prioritise paying down the costliest liabilities first.',
    actionTo: '/financial-reports/balance-sheet',
  }),
};
function advisoryFor(key, value, data) {
  const fn = ADVISORY[key];
  if (fn) return fn(value, data);
  return {
    what: `${key.replace(/_/g, ' ')} moved out of its safe range.`,
    howMuch: `Current value: ${typeof value === 'number' ? value.toFixed(2) : value}.`,
    recommendation: 'Open the linked report to inspect the underlying accounts.',
    actionTo: '/financial-reports',
  };
}

class HealthIndicatorsService {
  async _thresholds(businessId) {
    const biz = await Business.findById(businessId).select('trendAlertConfig').lean();
    const overrides = biz?.trendAlertConfig?.health || {};
    const merged = {};
    for (const [k, def] of Object.entries(DEFAULT_THRESHOLDS)) {
      merged[k] = { ...def, ...(overrides[k] || {}) };
    }
    return merged;
  }

  /** All inputs in parallel — one pass, then 42 pure computations. */
  async _gather(businessId) {
    const now = new Date();
    const d30 = new Date(now.getTime() - 30 * 86400000);
    const d60 = new Date(now.getTime() - 60 * 86400000);
    const d90 = new Date(now.getTime() - 90 * 86400000);
    const d180 = new Date(now.getTime() - 180 * 86400000);
    const Customer = mongoose.model('Customer');

    const [bs, is30, is30p, is90, is90p, is3mPrev, customers] = await Promise.all([
      reportService.getBalanceSheet(businessId, now),
      reportService.getIncomeStatement(businessId, d30, now),
      reportService.getIncomeStatement(businessId, d60, d30),
      reportService.getIncomeStatement(businessId, d90, now),
      reportService.getIncomeStatement(businessId, d180, d90),
      reportService.getIncomeStatement(businessId, d90, d60),
      Customer.find({ businessId, currentReceivableBalance: { $gt: 0 } })
        .sort({ currentReceivableBalance: -1 }).limit(5)
        .select('name currentReceivableBalance').lean().catch(() => []),
    ]);

    const grp = (groups, startsWith, extra = []) =>
      (groups || []).filter(g => {
        const l = String(g.label || '').toLowerCase();
        return l.startsWith(startsWith) || extra.some(k => l.includes(k));
      }).reduce((s, g) => s + (g.total || 0), 0);

    const acct = (accounts, re) =>
      (accounts || []).filter(a => re.test(a.accountName)).reduce((s, a) => s + (a.balance || 0), 0);

    const cash      = acct(bs.assets?.accounts, /cash|bank/i);
    const ar        = acct(bs.assets?.accounts, /receivab/i);
    const inventory = acct(bs.assets?.accounts, /inventor|stock/i);
    const ap        = acct(bs.liabilities?.accounts, /payab/i);
    const curAssets = grp(bs.assets?.groups, 'current', ['bank', 'cash']);
    const curLiab   = grp(bs.liabilities?.groups, 'current');
    const ltLiab    = grp(bs.liabilities?.groups, 'non-current');
    const topCust   = customers[0];
    const totalAR   = customers.reduce((s, c) => s + c.currentReceivableBalance, 0);

    return {
      bs, is30, is30p, is90, is90p, is3mPrev,
      cash, ar, inventory, ap, curAssets, curLiab, ltLiab,
      totalAssets: bs.totalAssets, totalLiab: bs.totalLiabilities, equity: bs.totalEquity,
      topCustomer: topCust?.name,
      topCustomerShare: totalAR > 0 && topCust ? (topCust.currentReceivableBalance / totalAR) * 100 : null,
    };
  }

  /** Compute all 42 indicators with zones. */
  async compute(businessId) {
    const t0 = Date.now();
    const [thr, d] = await Promise.all([this._thresholds(businessId), this._gather(businessId)]);
    const { is30, is30p, is90, is90p, is3mPrev } = d;
    const monthlyExpense = is30.totalExpenses;
    const dailyRevenue30 = is30.totalRevenue / 30;
    const dailyExpense30 = monthlyExpense / 30;
    const growth = (cur, prev) => (prev > 0 ? ((cur - prev) / prev) * 100 : null);

    const defs = [
      // ── Liquidity (8) ──
      ['liquidity', 'current_ratio',        'Current ratio',          safeDiv(d.curAssets, d.curLiab), 'x'],
      ['liquidity', 'quick_ratio',          'Quick ratio',            safeDiv(d.curAssets - d.inventory, d.curLiab), 'x'],
      ['liquidity', 'cash_ratio',           'Cash ratio',             safeDiv(d.cash, d.curLiab), 'x'],
      ['liquidity', 'cash_coverage_days',   'Cash coverage (days)',   safeDiv(d.cash, dailyExpense30), 'days'],
      ['liquidity', 'working_capital',      'Working capital',        d.curAssets - d.curLiab, 'PKR'],
      ['liquidity', 'ar_to_current_assets', 'AR share of current assets', safeDiv(d.ar, d.curAssets), 'x'],
      ['liquidity', 'cash_to_monthly_expense', 'Cash ÷ monthly expenses', safeDiv(d.cash, monthlyExpense), 'x'],
      ['liquidity', 'net_working_capital_ratio', 'Working capital ÷ assets', safeDiv(d.curAssets - d.curLiab, d.totalAssets), 'x'],
      // ── Profitability (10) ──
      ['profitability', 'gross_margin_pct',     'Gross margin',       safeDiv(is30.grossProfit, is30.totalRevenue) * 100 || null, '%'],
      ['profitability', 'net_margin_pct',       'Net margin',         safeDiv(is30.netIncome, is30.totalRevenue) * 100 || null, '%'],
      ['profitability', 'operating_margin_pct', 'Operating margin',   safeDiv(is30.operatingProfit, is30.totalRevenue) * 100 || null, '%'],
      ['profitability', 'ebitda_margin_pct',    'EBITDA margin',      safeDiv(is30.ebitda, is30.totalRevenue) * 100 || null, '%'],
      ['profitability', 'return_on_equity_pct', 'Return on equity (30d ann.)', safeDiv(is30.netIncome * 12, d.equity) * 100 || null, '%'],
      ['profitability', 'return_on_assets_pct', 'Return on assets (30d ann.)', safeDiv(is30.netIncome * 12, d.totalAssets) * 100 || null, '%'],
      ['profitability', 'revenue_per_expense',  'Revenue ÷ expenses', safeDiv(is30.totalRevenue, is30.totalExpenses), 'x'],
      ['profitability', 'break_even_coverage',  'Revenue ÷ break-even', safeDiv(is30.totalRevenue, is30.totalExpenses), 'x'],
      ['profitability', 'profit_growth_pct',    'Profit growth (30d)', growth(is30.netIncome, is30p.netIncome), '%'],
      ['profitability', 'expense_ratio_pct',    'Expenses ÷ revenue', safeDiv(is30.totalExpenses, is30.totalRevenue) * 100 || null, '%'],
      // ── Solvency (7) ──
      ['solvency', 'debt_to_equity',       'Debt-to-equity',          safeDiv(d.totalLiab, d.equity), 'x'],
      ['solvency', 'debt_to_assets',       'Debt-to-assets',          safeDiv(d.totalLiab, d.totalAssets), 'x'],
      ['solvency', 'equity_ratio',         'Equity ratio',            safeDiv(d.equity, d.totalAssets), 'x'],
      ['solvency', 'interest_coverage',    'Interest coverage',       safeDiv(is30.operatingProfit, is30.interestExpense?.total || 0), 'x'],
      ['solvency', 'liability_growth_pct', 'Liability level vs equity', safeDiv(d.totalLiab, Math.max(d.equity, 1)) * 100 || null, '%'],
      ['solvency', 'long_term_debt_ratio', 'Long-term debt ÷ assets', safeDiv(d.ltLiab, d.totalAssets), 'x'],
      ['solvency', 'net_worth',            'Net worth',               d.equity, 'PKR'],
      // ── Efficiency (9) ──
      ['efficiency', 'dso_days',             'Days sales outstanding',   safeDiv(d.ar, dailyRevenue30), 'days'],
      ['efficiency', 'dpo_days',             'Days payables outstanding', safeDiv(d.ap, dailyExpense30), 'days'],
      ['efficiency', 'cash_conversion_days', 'Cash conversion cycle',
        (safeDiv(d.ar, dailyRevenue30) || 0) + (safeDiv(d.inventory, dailyExpense30) || 0) - (safeDiv(d.ap, dailyExpense30) || 0), 'days'],
      ['efficiency', 'inventory_turnover',   'Inventory turnover (ann.)', safeDiv((is30.cogs?.total || is30.totalExpenses) * 12, d.inventory), 'x'],
      ['efficiency', 'inventory_days',       'Inventory days',            safeDiv(d.inventory, dailyExpense30), 'days'],
      ['efficiency', 'asset_turnover',       'Asset turnover (ann.)',     safeDiv(is30.totalRevenue * 12, d.totalAssets), 'x'],
      ['efficiency', 'ar_turnover',          'Receivable turnover (ann.)', safeDiv(is30.totalRevenue * 12, d.ar), 'x'],
      ['efficiency', 'ap_to_expense_ratio',  'Payables ÷ monthly expenses', safeDiv(d.ap, monthlyExpense), 'x'],
      ['efficiency', 'opex_to_revenue_pct',  'Opex ÷ revenue',            safeDiv(is30.operatingExpenses?.total, is30.totalRevenue) * 100 || null, '%'],
      // ── Growth (8) ──
      ['growth', 'revenue_growth_30d_pct', 'Revenue growth (30d)',   growth(is30.totalRevenue, is30p.totalRevenue), '%'],
      ['growth', 'revenue_growth_90d_pct', 'Revenue growth (90d)',   growth(is90.totalRevenue, is90p.totalRevenue), '%'],
      ['growth', 'expense_growth_30d_pct', 'Expense growth (30d)',   growth(is30.totalExpenses, is30p.totalExpenses), '%'],
      ['growth', 'expense_vs_revenue_gap', 'Expense growth − revenue growth',
        (growth(is30.totalExpenses, is30p.totalExpenses) ?? 0) - (growth(is30.totalRevenue, is30p.totalRevenue) ?? 0), 'pp'],
      ['growth', 'customer_concentration_pct', 'Top-customer concentration', d.topCustomerShare, '%'],
      ['growth', 'receivable_growth_pct',  'Receivables vs monthly revenue', safeDiv(d.ar, is30.totalRevenue) * 100 || null, '%'],
      ['growth', 'cash_flow_growth_pct',   'Net income growth (90d)', growth(is90.netIncome, is90p.netIncome), '%'],
      ['growth', 'profit_trend_3m',        'Profit trend (this vs 3mo ago)',
        is30.netIncome >= (is3mPrev.netIncome || 0) ? 1 : -1, 'trend'],
    ];

    const indicators = defs.map(([dimension, key, label, value, unit]) => ({
      dimension, key, label, unit,
      value: value === null || value === undefined || !isFinite(value) ? null : Math.round(value * 100) / 100,
      zone: zoneOf(value, thr[key] || { amber: 0, red: -1 }),
      thresholds: thr[key],
    }));

    return {
      indicators,
      count: indicators.length,
      byZone: {
        red:   indicators.filter(i => i.zone === 'red').length,
        amber: indicators.filter(i => i.zone === 'amber').length,
        green: indicators.filter(i => i.zone === 'green').length,
        na:    indicators.filter(i => i.zone === 'na').length,
      },
      context: { topCustomer: d.topCustomer, curAssets: d.curAssets, curLiab: d.curLiab },
      computedInMs: Date.now() - t0,
      computedAt: new Date().toISOString(),
    };
  }

  /** Root-cause: largest recent entries relevant to the breached dimension. */
  async _rootCause(businessId, dimension) {
    const JournalEntry = mongoose.model('JournalEntry');
    const biz = new mongoose.Types.ObjectId(String(businessId));
    const since = new Date(Date.now() - 30 * 86400000);
    const docs = await JournalEntry.find({
      businessId: biz, transactionDate: { $gte: since }, status: { $ne: 'reversed' },
    }).sort({ amount: -1 }).limit(3)
      .select('amount transactionDate description').lean();
    return docs.map(j => ({
      id: String(j._id), amount: j.amount,
      date: j.transactionDate?.toISOString?.()?.slice(0, 10),
      description: (j.description || '').slice(0, 80),
    }));
  }

  /** Evaluate + persist alerts for red-zone indicators (in-app + email). */
  async evaluateAndAlert(businessId) {
    const result = await this.compute(businessId);
    const reds = result.indicators.filter(i => i.zone === 'red' && i.value !== null);
    let fired = 0;
    const firedAlerts = [];

    for (const ind of reds) {
      const adv = advisoryFor(ind.key, ind.value, result.context);
      const rootCause = await this._rootCause(businessId, ind.dimension);
      try {
        const alert = await FinancialAlert.create({
          businessId,
          ruleKey: `health_${ind.key}`,
          periodKey: dayKey(),
          level: 'critical',
          title: `${ind.label} in the red zone`,
          what: adv.what,
          howMuch: `${adv.howMuch} Threshold: ${ind.thresholds.direction === 'low' ? 'minimum' : 'maximum'} ${ind.thresholds.red}${ind.unit === '%' ? '%' : ''}.`,
          sinceWhen: `Breached as of ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC.`,
          recommendation: adv.recommendation,
          actionTo: adv.actionTo,
          data: { indicator: ind, rootCause },
        });
        fired++; firedAlerts.push(alert);
      } catch (e) {
        if (e.code !== 11000) logger.warn(`[health] alert persist failed: ${e.message}`);
      }
    }

    // Email delivery (one digest per run, best-effort, within the 2-min AC)
    if (firedAlerts.length > 0) {
      try {
        const { sendEmail } = require('../utils/email.utils');
        const biz = await Business.findById(businessId).select('email businessName').lean();
        if (biz?.email) {
          await sendEmail({
            to: biz.email,
            subject: `⚠ ${firedAlerts.length} financial health alert${firedAlerts.length > 1 ? 's' : ''} — ${biz.businessName}`,
            html: firedAlerts.map(a =>
              `<h3>${a.title}</h3><p>${a.what}</p><p><b>${a.howMuch}</b></p><p>Recommended: ${a.recommendation}</p>`
            ).join('<hr/>'),
          });
        }
        // WhatsApp: fires automatically once TWILIO_* creds are configured in
        // bot-adapter (.env) — intentionally silent until then.
      } catch (e) {
        logger.warn(`[health] email delivery failed (non-fatal): ${e.message}`);
      }
    }

    return { ...result, fired };
  }
}

module.exports = new HealthIndicatorsService();
