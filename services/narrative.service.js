/**
 * Narrative Service — FR-02.2: AI-narrated financial statements.
 *
 * Generates a CFO-style plain-language briefing in BOTH English and Urdu for
 * the selected period. Every sentence is COMPUTED from actual GL aggregates —
 * the narrative is grounded by construction, so hallucinated values are
 * impossible (FR-02.2 AC: zero hallucinated values; every figure traceable).
 *
 * Each cited figure is returned in `figures[]` with a drill-down link into
 * the General Ledger / report tab it came from.
 *
 * Structure of the briefing:
 *   1. Headline   — net profit vs prior period (direction + %)
 *   2. Driver     — the account with the largest swing, incl. its single
 *                   biggest transaction (the "your electricity bill on the
 *                   12th was X vs Y" sentence)
 *   3. Trend      — is the driver a one-off or a trend vs its 3-month average
 *   4. Stability  — how many categories stayed within ±5%
 *   5. Position   — cash + equation health from the live balance sheet
 */
'use strict';

const mongoose = require('mongoose');
const reportService = require('./report.service');

const fmt = (n) => `Rs ${Math.round(Math.abs(Number(n) || 0)).toLocaleString('en-PK')}`;
const pctAbs = (n) => `${Math.abs(Number(n) || 0).toFixed(1)}%`;

/* Urdu digits stay Western for clarity; labels translated. */
const UR = {
  roseBy:   (x) => `میں ${x} اضافہ ہوا`,
  fellBy:   (x) => `میں ${x} کمی ہوئی`,
  netProfit: 'خالص منافع',
  thisPeriod: 'اس مدت میں',
  vsPrior:  'پچھلی مدت کے مقابلے',
};

function periodRanges(period = 'month') {
  const now = new Date();
  if (period === 'quarter') {
    const qStart = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
    const prevQStart = new Date(qStart); prevQStart.setMonth(prevQStart.getMonth() - 3);
    return { currentStart: qStart, currentEnd: now, priorStart: prevQStart, priorEnd: qStart };
  }
  // month-to-date vs the SAME span of the previous month (fair comparison)
  const mStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const span = now.getTime() - mStart.getTime();
  const pStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const pEnd = new Date(pStart.getTime() + span);
  return { currentStart: mStart, currentEnd: now, priorStart: pStart, priorEnd: pEnd };
}

class NarrativeService {
  /** Largest single JE inside an account+period — the concrete receipt to cite. */
  async _biggestEntry(businessId, accountName, start, end) {
    const JournalEntry = mongoose.model('JournalEntry');
    const ChartOfAccount = mongoose.model('ChartOfAccount');
    const biz = new mongoose.Types.ObjectId(String(businessId));
    const acct = await ChartOfAccount.findOne({ businessId: biz, accountName }).select('_id').lean();
    if (!acct) return null;
    const [doc] = await JournalEntry.find({
      businessId: biz,
      transactionDate: { $gte: start, $lt: end },
      status: { $ne: 'reversed' },
      $or: [
        { debitAccountId: acct._id }, { creditAccountId: acct._id },
        { 'journalLines.accountId': acct._id },
      ],
    }).sort({ amount: -1 }).limit(1).select('amount transactionDate description').lean();
    return doc || null;
  }

  async getNarrative(businessId, { period = 'month' } = {}) {
    const t0 = Date.now();
    const { currentStart, currentEnd, priorStart, priorEnd } = periodRanges(period);

    const [cmp, bs] = await Promise.all([
      reportService.getComparativeIncomeStatement(businessId, currentStart, currentEnd, priorStart, priorEnd),
      reportService.getBalanceSheet(businessId, new Date()),
    ]);

    const cur = cmp.currentPeriod.data;
    const pri = cmp.priorPeriod.data;
    const figures = [];
    const en = [];
    const ur = [];
    const cite = (label, value, link) => {
      figures.push({ label, value: Math.round(value), link });
      return fmt(value);
    };

    const glLink = '/financial-reports/general-ledger';
    const isLink = '/financial-reports/income-statement';
    const bsLink = '/financial-reports/balance-sheet';

    // ── 1. Headline: net profit direction ────────────────────────────────────
    const np = cmp.netIncome;
    const dir = np.change >= 0 ? 'rose' : 'fell';
    const dirUr = np.change >= 0 ? UR.roseBy : UR.fellBy;
    const npPct = np.changePct === null ? null : Math.abs(np.changePct);
    en.push(
      `Your net profit ${dir} ${npPct === null ? '' : pctAbs(npPct) + ' '}this period — ` +
      `${cite('Net profit (current)', np.current, isLink)} vs ${cite('Net profit (prior)', np.prior, isLink)} in the comparable prior period.`
    );
    ur.push(
      `${UR.thisPeriod} آپ کے ${UR.netProfit} ${dirUr(npPct === null ? '' : pctAbs(npPct))} — ` +
      `${fmt(np.current)} ${UR.vsPrior} ${fmt(np.prior)}۔`
    );

    // ── 2. Driver: account with the largest swing ─────────────────────────────
    const deltas = [];
    const collect = (currArr, priArr, kind) => {
      const prevMap = new Map((priArr || []).map(a => [a.accountName, a.balance]));
      for (const a of (currArr || [])) {
        const before = prevMap.get(a.accountName) ?? 0;
        deltas.push({ name: a.accountName, kind, current: a.balance, prior: before, delta: a.balance - before });
      }
      for (const [name, before] of prevMap) {
        if (!(currArr || []).some(a => a.accountName === name)) {
          deltas.push({ name, kind, current: 0, prior: before, delta: -before });
        }
      }
    };
    collect(cur.revenue.accounts, pri.revenue.accounts, 'revenue');
    collect(cur.operatingExpenses.accounts, pri.operatingExpenses.accounts, 'expense');
    collect(cur.cogs.accounts, pri.cogs.accounts, 'expense');

    deltas.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    const driver = deltas[0];

    if (driver && Math.abs(driver.delta) > 0) {
      const moved = driver.delta > 0 ? 'increased' : 'decreased';
      const movedUr = driver.delta > 0 ? 'بڑھ کر' : 'گھٹ کر';
      const drvPct = driver.prior !== 0 ? (driver.delta / Math.abs(driver.prior)) * 100 : null;
      en.push(
        `The primary driver was "${driver.name}", which ${moved} ` +
        `${drvPct === null ? '' : pctAbs(drvPct) + ' '}from ${cite(`${driver.name} (prior)`, driver.prior, glLink)} ` +
        `to ${cite(`${driver.name} (current)`, driver.current, glLink)}.`
      );
      ur.push(
        `سب سے بڑا اثر "${driver.name}" کا تھا، جو ${fmt(driver.prior)} سے ${movedUr} ${fmt(driver.current)} ہو گیا۔`
      );

      // The concrete transaction behind the swing
      const big = await this._biggestEntry(businessId, driver.name, currentStart, currentEnd);
      if (big) {
        const d = new Date(big.transactionDate);
        const dateStr = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });
        en.push(
          `The largest single entry there was ${cite('Largest entry', big.amount, '/transactions')} on ${dateStr}` +
          (big.description ? ` ("${String(big.description).slice(0, 70)}")` : '') + '.'
        );
        ur.push(`اس میں سب سے بڑی انٹری ${fmt(big.amount)} کی تھی (${dateStr})۔`);
      }

      // ── 3. Trend vs one-off: driver vs its 3-month average ─────────────────
      const threeMoStart = new Date(currentStart); threeMoStart.setMonth(threeMoStart.getMonth() - 3);
      const hist = await reportService.getIncomeStatement(businessId, threeMoStart, currentStart);
      const histAccts = [...(hist.operatingExpenses?.accounts || []), ...(hist.cogs?.accounts || []), ...(hist.revenue?.accounts || [])];
      const histAvg = (histAccts.find(a => a.accountName === driver.name)?.balance || 0) / 3;
      if (histAvg > 0) {
        const vsAvg = ((driver.current - histAvg) / histAvg) * 100;
        const oneOff = Math.abs(vsAvg) > 50;
        en.push(
          oneOff
            ? `This looks like a one-off: the month is ${pctAbs(vsAvg)} ${vsAvg > 0 ? 'above' : 'below'} the account's 3-month average of ${cite('3-month average', histAvg, glLink)}.`
            : `This is consistent with the recent trend (within ${pctAbs(vsAvg)} of the 3-month average of ${cite('3-month average', histAvg, glLink)}).`
        );
        ur.push(oneOff ? 'یہ ایک غیر معمولی (one-off) تبدیلی لگتی ہے۔' : 'یہ حالیہ رجحان کے مطابق ہے۔');
      }
    }

    // ── 4. Stability: categories within ±5% ──────────────────────────────────
    const stable = deltas.filter(d => d.prior > 0 && Math.abs((d.delta / d.prior) * 100) <= 5).length;
    const total = deltas.filter(d => d.prior > 0).length;
    if (total > 1) {
      en.push(`${stable} of ${total} active categories stayed within 5% of the prior period.`);
      ur.push(`${total} میں سے ${stable} زمرے پچھلی مدت کے 5% کے اندر مستحکم رہے۔`);
    }

    // ── 5. Position: cash + equation health ──────────────────────────────────
    const cashNames = ['cash', 'bank'];
    const cash = (bs.assets?.accounts || [])
      .filter(a => cashNames.some(k => String(a.accountName || '').toLowerCase().includes(k)))
      .reduce((s, a) => s + (a.balance || 0), 0);
    en.push(
      `Your current cash and bank position is ${cite('Cash & bank', cash, bsLink)}; ` +
      `the balance sheet equation is ${bs.equationValid ? 'in balance' : 'OUT OF BALANCE — review immediately'}.`
    );
    ur.push(`آپ کے نقد اور بینک کی موجودہ پوزیشن ${fmt(cash)} ہے۔`);

    return {
      period: { start: currentStart, end: currentEnd, priorStart, priorEnd, label: period },
      english: en,
      urdu: ur,
      figures,
      equationValid: bs.equationValid,
      generatedInMs: Date.now() - t0,
      generatedAt: new Date().toISOString(),
    };
  }
}

module.exports = new NarrativeService();
