/**
 * Trend Monitor — FR-02.1 (balance-equation runtime invariant) and
 * FR-02.3 (proactive trend detection & financial drift alerts).
 *
 * Continuously evaluates rolling-window metrics straight from the GL and
 * persists deduplicated FinancialAlert documents (one per rule per period).
 * Detection thresholds are configurable per business via
 * Business.trendAlertConfig and merged over safe defaults.
 *
 * Rules:
 *   R1 balance_equation           CRITICAL — Assets ≠ Liabilities + Equity (runtime invariant)
 *   R2 revenue_decline            revenue fell for 2+ consecutive 30-day windows
 *   R3 margin_compression         gross margin dropped more than cfg pct (30d vs prior 30d)
 *   R4 expense_outpacing_revenue  an expense category growing faster than revenue
 *   R5 kpi_current_ratio          current ratio below configured safe minimum
 *
 * Every alert includes: what changed, by how much, since when, and a
 * recommended action (FR-02.3 AC).
 */
'use strict';

const mongoose = require('mongoose');
const logger = require('../config/logger');
const reportService = require('./report.service');
const FinancialAlert = require('../models/FinancialAlert.model');
const Business = require('../models/Business.model');

const DEFAULT_CONFIG = {
  enabled: true,
  marginCompressionPct: 5,     // alert when gross margin drops > 5 percentage points
  expenseVsRevenueGapPct: 15,  // expense category growing >15pp faster than revenue
  currentRatioMin: 1.0,        // safe liquidity floor
  revenueDeclineWindows: 2,    // consecutive 30-day windows of decline
  minWindowActivity: 5,        // ignore windows with fewer transactions (noise guard)
};

function monthKey(d = new Date()) {
  return d.toISOString().slice(0, 7);            // '2026-06'
}
function dayKey(d = new Date()) {
  return d.toISOString().slice(0, 10);           // '2026-06-12'
}
const fmt = (n) => `Rs ${Math.round(Number(n) || 0).toLocaleString('en-PK')}`;
const pct = (n) => `${(Number(n) || 0).toFixed(1)}%`;

class TrendMonitorService {
  // ── Config ─────────────────────────────────────────────────────────────────

  async getConfig(businessId) {
    const biz = await Business.findById(businessId).select('trendAlertConfig').lean();
    return { ...DEFAULT_CONFIG, ...(biz?.trendAlertConfig || {}) };
  }

  async saveConfig(businessId, cfg) {
    const clean = {};
    for (const k of Object.keys(DEFAULT_CONFIG)) {
      if (cfg[k] !== undefined && cfg[k] !== null) clean[k] = cfg[k];
    }
    await Business.findByIdAndUpdate(businessId, { $set: { trendAlertConfig: clean } });
    return { ...DEFAULT_CONFIG, ...clean };
  }

  // ── GL window metrics ──────────────────────────────────────────────────────

  /**
   * Revenue / expense totals for a date window, expanded through journalLines
   * (compound entries counted correctly), joined to account types.
   */
  async _windowTotals(businessId, start, end) {
    const JournalEntry = mongoose.model('JournalEntry');
    const biz = new mongoose.Types.ObjectId(String(businessId));

    const rows = await JournalEntry.aggregate([
      { $match: {
          businessId: biz,
          transactionDate: { $gte: start, $lt: end },
          status: { $ne: 'reversed' },
      } },
      // Expand to effective debit/credit lines (compound-safe)
      { $project: {
          lines: {
            $cond: [
              { $gt: [{ $size: { $ifNull: ['$journalLines', []] } }, 0] },
              '$journalLines',
              [
                { accountId: '$debitAccountId',  type: 'debit',  amount: '$amount' },
                { accountId: '$creditAccountId', type: 'credit', amount: '$amount' },
              ],
            ],
          },
      } },
      { $unwind: '$lines' },
      { $lookup: {
          from: 'chartofaccounts', localField: 'lines.accountId',
          foreignField: '_id', as: 'acct',
      } },
      { $unwind: '$acct' },
      { $match: { 'acct.accountType': { $in: ['Revenue', 'Expense'] } } },
      { $group: {
          _id: { type: '$acct.accountType', name: '$acct.accountName', accountId: '$acct._id' },
          debit:  { $sum: { $cond: [{ $eq: ['$lines.type', 'debit'] },  '$lines.amount', 0] } },
          credit: { $sum: { $cond: [{ $eq: ['$lines.type', 'credit'] }, '$lines.amount', 0] } },
          count:  { $sum: 1 },
      } },
    ]);

    let revenue = 0, expense = 0, txCount = 0;
    const expenseByAccount = [];
    const revenueByAccount = [];
    for (const r of rows) {
      txCount += r.count;
      if (r._id.type === 'Revenue') {
        const amt = r.credit - r.debit;            // revenue is credit-normal
        revenue += amt;
        revenueByAccount.push({ name: r._id.name, accountId: r._id.accountId, amount: amt });
      } else {
        const amt = r.debit - r.credit;            // expenses are debit-normal
        expense += amt;
        expenseByAccount.push({ name: r._id.name, accountId: r._id.accountId, amount: amt });
      }
    }
    return { revenue, expense, txCount, expenseByAccount, revenueByAccount };
  }

  /** N consecutive 30-day windows ending now: [w0(current), w1, w2 …oldest]. */
  async _rollingWindows(businessId, n = 3, days = 30) {
    const out = [];
    const now = new Date();
    for (let i = 0; i < n; i++) {
      const end   = new Date(now.getTime() - i * days * 86400000);
      const start = new Date(end.getTime() - days * 86400000);
      out.push({ start, end, ...(await this._windowTotals(businessId, start, end)) });
    }
    return out;
  }

  // ── Alert persistence (dedup at the DB layer) ──────────────────────────────

  async _fire(businessId, alert) {
    try {
      await FinancialAlert.create({ businessId, ...alert });
      logger.warn(`[trend-monitor] ALERT ${alert.ruleKey} business=${businessId}: ${alert.title}`);
      return true;
    } catch (err) {
      if (err.code === 11000) return false;        // already fired this period
      throw err;
    }
  }

  // ── Rules ──────────────────────────────────────────────────────────────────

  /** R1 — FR-02.1: balance-sheet equation as a runtime invariant. */
  async checkBalanceEquation(businessId) {
    const bs = await reportService.getBalanceSheet(businessId, new Date());
    if (bs.equationValid) return null;
    const diff = bs.totalAssets - (bs.totalLiabilities + bs.totalEquity);
    return this._fire(businessId, {
      ruleKey: 'balance_equation', periodKey: dayKey(), level: 'critical',
      title: 'Balance sheet equation broken',
      what: 'Assets no longer equal Liabilities + Equity.',
      howMuch: `Discrepancy of ${fmt(Math.abs(diff))} (Assets ${fmt(bs.totalAssets)} vs L+E ${fmt(bs.totalLiabilitiesAndEquity)}).`,
      sinceWhen: `Detected ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC.`,
      recommendation: 'Open the Balance Sheet and the latest journal entries — a posting may have bypassed double-entry. Contact support if it persists.',
      actionTo: '/financial-reports/balance-sheet',
      data: { totalAssets: bs.totalAssets, totalLiabilities: bs.totalLiabilities, totalEquity: bs.totalEquity, diff },
    });
  }

  /** R2 — revenue declined across consecutive 30-day windows. */
  async checkRevenueDecline(businessId, cfg, windows) {
    const [w0, w1, w2] = windows;
    if (!w0 || !w1 || !w2) return null;
    if (w1.txCount < cfg.minWindowActivity) return null;
    const needed = cfg.revenueDeclineWindows;
    const declines = [w0.revenue < w1.revenue, w1.revenue < w2.revenue].filter(Boolean).length;
    if (declines < needed || w0.revenue >= w1.revenue) return null;
    const dropPct = w1.revenue > 0 ? ((w1.revenue - w0.revenue) / w1.revenue) * 100 : 0;
    return this._fire(businessId, {
      ruleKey: 'revenue_decline', periodKey: monthKey(), level: 'warning',
      title: `Revenue declining ${needed} periods in a row`,
      what: 'Rolling 30-day revenue has fallen for consecutive windows.',
      howMuch: `Down ${pct(dropPct)} vs the prior 30 days (${fmt(w0.revenue)} vs ${fmt(w1.revenue)}).`,
      sinceWhen: `Trend visible since ${w2.start.toISOString().slice(0, 10)}.`,
      recommendation: 'Review your top customers and invoice pipeline; check Receivables for stalled collections.',
      actionTo: '/financial-reports/income-statement',
      data: { windows: windows.map(w => ({ start: w.start, revenue: w.revenue })) },
    });
  }

  /** R3 — gross margin compressed more than cfg.marginCompressionPct points. */
  async checkMarginCompression(businessId, cfg, windows) {
    const [w0, w1] = windows;
    if (!w0 || !w1) return null;
    if (w0.revenue <= 0 || w1.revenue <= 0 || w1.txCount < cfg.minWindowActivity) return null;
    const m0 = ((w0.revenue - w0.expense) / w0.revenue) * 100;
    const m1 = ((w1.revenue - w1.expense) / w1.revenue) * 100;
    const drop = m1 - m0;
    if (drop < cfg.marginCompressionPct) return null;
    return this._fire(businessId, {
      ruleKey: 'margin_compression', periodKey: monthKey(), level: 'warning',
      title: 'Margin compressing',
      what: 'Your margin (revenue minus expenses, as % of revenue) is shrinking.',
      howMuch: `Down ${drop.toFixed(1)} points: ${pct(m1)} → ${pct(m0)} over the last 30 days.`,
      sinceWhen: `Comparing ${w1.start.toISOString().slice(0, 10)} onward.`,
      recommendation: 'Compare expense categories vs last month on the Income Statement — one of them is growing faster than sales.',
      actionTo: '/financial-reports/income-statement',
      data: { currentMarginPct: m0, priorMarginPct: m1 },
    });
  }

  /** R4 — a specific expense category growing faster than revenue. */
  async checkExpenseOutpacingRevenue(businessId, cfg, windows) {
    const [w0, w1] = windows;
    if (!w0 || !w1) return null;
    if (w1.txCount < cfg.minWindowActivity || w1.revenue <= 0) return null;
    const revGrowth = ((w0.revenue - w1.revenue) / w1.revenue) * 100;

    const prior = new Map(w1.expenseByAccount.map(e => [e.name, e]));
    let worst = null;
    for (const e of w0.expenseByAccount) {
      const p = prior.get(e.name);
      if (!p || p.amount < 1000) continue;          // need a meaningful base
      const growth = ((e.amount - p.amount) / p.amount) * 100;
      const gap = growth - revGrowth;
      if (gap > cfg.expenseVsRevenueGapPct && (!worst || gap > worst.gap)) {
        worst = { ...e, prior: p.amount, growth, gap };
      }
    }
    if (!worst) return null;
    return this._fire(businessId, {
      ruleKey: 'expense_outpacing_revenue', periodKey: monthKey(), level: 'warning',
      title: `${worst.name} growing faster than revenue`,
      what: `Spending on "${worst.name}" is rising much faster than sales.`,
      howMuch: `${worst.name} up ${pct(worst.growth)} (${fmt(worst.prior)} → ${fmt(worst.amount)}) while revenue moved ${pct(revGrowth)}.`,
      sinceWhen: `Last 30 days vs the 30 days before (${w1.start.toISOString().slice(0, 10)}).`,
      recommendation: `Open the General Ledger for "${worst.name}" and review the biggest entries this month.`,
      actionTo: '/financial-reports/general-ledger',
      data: { account: worst.name, accountId: worst.accountId, growthPct: worst.growth, revenueGrowthPct: revGrowth },
    });
  }

  /** R5 — current ratio below the configured safe floor. */
  async checkCurrentRatio(businessId, cfg) {
    const bs = await reportService.getBalanceSheet(businessId, new Date());
    // 'current' must not match 'Non-current …' — anchor at the start.
    // Bank/Cash groups are liquid, so they count toward current assets.
    const cur = (groups, extra = []) =>
      (groups || []).filter(g => {
        const l = String(g.label || '').toLowerCase();
        return l.startsWith('current') || extra.some(k => l.includes(k));
      }).reduce((s, g) => s + (g.total || 0), 0);
    const curAssets = cur(bs.assets?.groups, ['bank', 'cash']);
    const curLiab   = cur(bs.liabilities?.groups);
    if (curLiab <= 0) return null;                  // nothing to breach
    const ratio = curAssets / curLiab;
    if (ratio >= cfg.currentRatioMin) return null;
    return this._fire(businessId, {
      ruleKey: 'kpi_current_ratio', periodKey: monthKey(), level: 'critical',
      title: 'Liquidity below safe range',
      what: 'Current ratio (current assets ÷ current liabilities) breached its floor.',
      howMuch: `${ratio.toFixed(2)} vs configured minimum ${cfg.currentRatioMin.toFixed(2)} (${fmt(curAssets)} assets vs ${fmt(curLiab)} liabilities).`,
      sinceWhen: `As of today.`,
      recommendation: 'Accelerate receivable collections and defer non-essential payables; review the cash-flow forecast.',
      actionTo: '/financial-reports/balance-sheet',
      data: { currentRatio: ratio, currentAssets: curAssets, currentLiabilities: curLiab },
    });
  }

  // ── Orchestration ──────────────────────────────────────────────────────────

  /** Run all rules for one business; returns count fired. */
  async runAll(businessId) {
    const cfg = await this.getConfig(businessId);
    if (!cfg.enabled) return { fired: 0, skipped: 'disabled' };

    let fired = 0;
    const safe = async (p) => { try { if (await p) fired++; } catch (e) { logger.warn(`[trend-monitor] rule failed: ${e.message}`); } };

    const windows = await this._rollingWindows(businessId, 3, 30);
    await safe(this.checkBalanceEquation(businessId));
    await safe(this.checkRevenueDecline(businessId, cfg, windows));
    await safe(this.checkMarginCompression(businessId, cfg, windows));
    await safe(this.checkExpenseOutpacingRevenue(businessId, cfg, windows));
    await safe(this.checkCurrentRatio(businessId, cfg));
    // FR-03.2 — 40+ health indicators; red-zone breaches become alerts
    try {
      const h = await require('./healthIndicators.service').evaluateAndAlert(businessId);
      fired += h.fired || 0;
    } catch (e) { logger.warn(`[trend-monitor] health eval failed: ${e.message}`); }
    return { fired };
  }

  /** Cron entry point — every active business, isolated failures. */
  async runAllBusinesses() {
    const ids = await Business.find({}).select('_id').lean();
    let total = 0;
    for (const { _id } of ids) {
      try { total += (await this.runAll(_id)).fired; }
      catch (e) { logger.warn(`[trend-monitor] business ${_id} failed: ${e.message}`); }
    }
    if (total > 0) logger.info(`[trend-monitor] fired ${total} new alert(s)`);
    return total;
  }

  // ── Feed / API ─────────────────────────────────────────────────────────────

  async listOpen(businessId) {
    return FinancialAlert.find({ businessId, status: 'open' })
      .sort({ level: 1, firedAt: -1 }).limit(50).lean();
  }

  async acknowledge(businessId, alertId, userId) {
    const res = await FinancialAlert.findOneAndUpdate(
      { _id: alertId, businessId, status: 'open' },
      { $set: { status: 'acknowledged', ackedAt: new Date(), ackedBy: userId } },
      { returnDocument: 'after' },
    );
    if (!res) { const e = new Error('Alert not found'); e.statusCode = 404; throw e; }
    return res;
  }
}

module.exports = new TrendMonitorService();
