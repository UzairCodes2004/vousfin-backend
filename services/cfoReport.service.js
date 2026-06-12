/**
 * CFO Monthly Report — FR-03.4.
 *
 * Auto-generates a board-ready monthly summary for the PRIOR month with zero
 * human action: executive summary, revenue vs prior, top-5 expense movements,
 * cash-flow summary, KPI trends, 3-month run-rate forecast (labelled
 * estimate) and top-3 risks (from live FinancialAlerts). English + Urdu,
 * rendered to PDF (pdfkit), emailed to the business owner + configured
 * recipients on the first business day of the month by 09:00.
 *
 * Optional commentary can be attached any time before (or after) delivery —
 * it regenerates the PDF but never blocks the automated send.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const logger = require('../config/logger');
const reportService = require('./report.service');
const FinancialAlert = require('../models/FinancialAlert.model');
const Business = require('../models/Business.model');

const fmt = (n) => `Rs ${Math.round(Math.abs(Number(n) || 0)).toLocaleString('en-PK')}`;
const OUT_DIR = path.join(__dirname, '..', 'outputs', 'cfo-reports');

/* Persisted report record */
const cfoReportSchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  month:      { type: String, required: true },          // '2026-05' (the month reported on)
  status:     { type: String, enum: ['generated', 'sent'], default: 'generated' },
  pdfPath:    { type: String },
  commentary: { type: String, default: '' },
  sections:   { type: mongoose.Schema.Types.Mixed },     // full structured content (EN+UR)
  sentTo:     [String],
  sentAt:     Date,
}, { timestamps: true });
cfoReportSchema.index({ businessId: 1, month: 1 }, { unique: true });
const CfoReport = mongoose.models.CfoReport || mongoose.model('CfoReport', cfoReportSchema);

function monthRange(monthDate) {
  const start = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
  const end   = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 1);
  const prevS = new Date(monthDate.getFullYear(), monthDate.getMonth() - 1, 1);
  // Local fields, NOT toISOString — local midnight serialises to the prior
  // month's last day in UTC, which shifted the key off by one.
  const key = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`;
  return { start, end, prevS, prevE: start, key };
}

/** First WEEKDAY of the month (simple business-day rule). */
function isFirstBusinessDay(d = new Date()) {
  const day = d.getDay();
  if (day === 0 || day === 6) return false;
  for (let i = 1; i < d.getDate(); i++) {
    const e = new Date(d.getFullYear(), d.getMonth(), i);
    if (e.getDay() !== 0 && e.getDay() !== 6) return false; // an earlier weekday existed
  }
  return true;
}

class CfoReportService {
  /** Build all report sections (EN + UR) from the live GL for the given month. */
  async buildSections(businessId, { start, end, prevS, prevE }) {
    const [cmp, cf, kpi, alerts] = await Promise.all([
      reportService.getComparativeIncomeStatement(businessId, start, end, prevS, prevE),
      reportService.getCashFlowStatement(businessId, start, end).catch(() => null),
      reportService.getKPISummary(businessId, start, end).catch(() => null),
      FinancialAlert.find({ businessId, status: 'open' }).sort({ level: 1, firedAt: -1 }).limit(3).lean(),
    ]);

    const cur = cmp.currentPeriod.data, pri = cmp.priorPeriod.data;
    const np = cmp.netIncome, rev = cmp.revenue;

    /* Top-5 expense movements */
    const prevMap = new Map(
      [...(pri.operatingExpenses?.accounts || []), ...(pri.cogs?.accounts || [])]
        .map(a => [a.accountName, a.balance]));
    const movements = [...(cur.operatingExpenses?.accounts || []), ...(cur.cogs?.accounts || [])]
      .map(a => ({ name: a.accountName, current: a.balance, prior: prevMap.get(a.accountName) ?? 0 }))
      .map(m => ({ ...m, delta: m.current - m.prior }))
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
      .slice(0, 5);

    /* 3-month run-rate forecast (clearly an estimate) */
    const run = cur.netIncome;
    const forecast = [1, 2, 3].map(i => ({
      monthOffset: i,
      revenue: Math.round(cur.totalRevenue),
      netProfit: Math.round(run),
      basis: 'estimate — last-month run-rate',
    }));

    const dir = np.change >= 0 ? 'up' : 'down';
    const execEn = [
      `Net ${np.current >= 0 ? 'profit' : 'loss'} for the month was ${fmt(np.current)}, ${dir} ${fmt(np.change)} vs the prior month.`,
      `Revenue came in at ${fmt(rev.current)} (${rev.changePct === null ? 'n/a' : (rev.changePct >= 0 ? '+' : '') + rev.changePct + '%'} vs prior); total expenses were ${fmt(cur.totalExpenses)}.`,
      movements[0]
        ? `The largest expense movement was "${movements[0].name}" (${movements[0].delta >= 0 ? '+' : '−'}${fmt(movements[0].delta)}).`
        : 'Expense categories were broadly stable.',
    ];
    const execUr = [
      `اس ماہ خالص ${np.current >= 0 ? 'منافع' : 'نقصان'} ${fmt(np.current)} رہا — پچھلے ماہ کے مقابلے ${fmt(np.change)} ${np.change >= 0 ? 'زیادہ' : 'کم'}۔`,
      `آمدنی ${fmt(rev.current)} رہی اور کل اخراجات ${fmt(cur.totalExpenses)}۔`,
      movements[0] ? `سب سے بڑی تبدیلی "${movements[0].name}" میں ہوئی۔` : 'اخراجات مجموعی طور پر مستحکم رہے۔',
    ];

    return {
      executiveSummary: { en: execEn, ur: execUr },
      revenue: { current: rev.current, prior: rev.prior, changePct: rev.changePct },
      netIncome: { current: np.current, prior: np.prior, changePct: np.changePct },
      topExpenseMovements: movements,
      cashFlow: cf ? {
        operating: cf.operating?.total ?? cf.operatingActivities?.total ?? null,
        investing: cf.investing?.total ?? cf.investingActivities?.total ?? null,
        financing: cf.financing?.total ?? cf.financingActivities?.total ?? null,
        netChange: cf.netChange ?? cf.netCashFlow ?? null,
      } : null,
      kpi: kpi || null,
      forecast,
      risks: alerts.map(a => ({
        title: a.title, what: a.what, recommendation: a.recommendation, level: a.level,
      })),
      glReferences: [
        { label: 'Income Statement', link: '/financial-reports/income-statement' },
        { label: 'Balance Sheet',    link: '/financial-reports/balance-sheet' },
        { label: 'Cash Flow',        link: '/financial-reports/cash-flow' },
        { label: 'General Ledger',   link: '/financial-reports/general-ledger' },
      ],
    };
  }

  /** Render the structured sections to a PDF file. Returns the path. */
  async renderPdf(business, monthKey, sections, commentary = '') {
    const PDFDocument = require('pdfkit');
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const file = path.join(OUT_DIR, `cfo-${business._id}-${monthKey}.pdf`);
    const doc = new PDFDocument({ margin: 50 });
    const stream = fs.createWriteStream(file);
    doc.pipe(stream);

    const h = (t) => doc.moveDown(0.8).fontSize(13).fillColor('#1a3c6e').text(t).moveDown(0.2).fontSize(10).fillColor('#222');
    doc.fontSize(18).fillColor('#0b1f3a').text(`CFO Monthly Report — ${business.businessName}`);
    doc.fontSize(11).fillColor('#555').text(`Period: ${monthKey} · Generated ${new Date().toISOString().slice(0, 10)} · vousFin`);
    doc.moveDown(0.5).fontSize(8).fillColor('#888')
       .text('All figures computed from the live general ledger. Forecast lines are estimates and labelled as such.');

    h('Executive Summary');
    sections.executiveSummary.en.forEach(s => doc.text(`• ${s}`));
    if (commentary) { h('Management Commentary'); doc.text(commentary); }

    h('Revenue Performance');
    doc.text(`This month: ${fmt(sections.revenue.current)}   Prior: ${fmt(sections.revenue.prior)}   Change: ${sections.revenue.changePct ?? 'n/a'}%`);

    h('Top 5 Expense Movements');
    sections.topExpenseMovements.forEach(m =>
      doc.text(`• ${m.name}: ${fmt(m.prior)} → ${fmt(m.current)}  (${m.delta >= 0 ? '+' : '−'}${fmt(m.delta)})`));

    if (sections.cashFlow) {
      h('Cash Flow Summary');
      doc.text(`Operating: ${fmt(sections.cashFlow.operating)}   Investing: ${fmt(sections.cashFlow.investing)}   Financing: ${fmt(sections.cashFlow.financing)}`);
    }

    h('3-Month Outlook (ESTIMATE — run-rate based)');
    sections.forecast.forEach(f => doc.text(`• Month +${f.monthOffset}: projected net ${fmt(f.netProfit)} (${f.basis})`));

    h('Top Risks & Action Items');
    if (sections.risks.length === 0) doc.text('• No open financial alerts — books are healthy.');
    sections.risks.forEach(r => doc.text(`• [${r.level.toUpperCase()}] ${r.title} — ${r.recommendation}`));

    h('خلاصہ (Urdu Summary)');
    sections.executiveSummary.ur.forEach(s => doc.text(s, { align: 'right' }));

    doc.moveDown(1).fontSize(8).fillColor('#888')
       .text('Verify any figure in vousFin → Financial Reports. This report was generated autonomously.');
    doc.end();
    await new Promise((res, rej) => { stream.on('finish', res); stream.on('error', rej); });
    return file;
  }

  /** Generate (idempotent per business+month). */
  async generate(businessId, monthDate = null) {
    // Default: the PRIOR month
    const target = monthDate || new Date(new Date().getFullYear(), new Date().getMonth() - 1, 15);
    const range = monthRange(target);
    const business = await Business.findById(businessId).select('businessName email cfoReportRecipients').lean();
    if (!business) { const e = new Error('Business not found'); e.statusCode = 404; throw e; }

    const sections = await this.buildSections(businessId, range);
    const existing = await CfoReport.findOne({ businessId, month: range.key });
    const commentary = existing?.commentary || '';
    const pdfPath = await this.renderPdf(business, range.key, sections, commentary);

    const doc = await CfoReport.findOneAndUpdate(
      { businessId, month: range.key },
      { $set: { sections, pdfPath }, $setOnInsert: { status: 'generated' } },
      { upsert: true, returnDocument: 'after' },
    );
    return doc;
  }

  /** Email the PDF to the owner + configured recipients. */
  async deliver(businessId, month) {
    const report = await CfoReport.findOne({ businessId, month });
    if (!report?.pdfPath) { const e = new Error('Report not generated'); e.statusCode = 404; throw e; }
    const business = await Business.findById(businessId).select('businessName email cfoReportRecipients').lean();
    const recipients = [business?.email, ...(business?.cfoReportRecipients || [])].filter(Boolean);
    if (recipients.length === 0) {
      logger.warn(`[cfo-report] business=${businessId}: no recipients configured — report kept in-app only`);
      return report;
    }
    try {
      const { sendEmail } = require('../utils/email.utils');
      await sendEmail({
        to: recipients.join(','),
        subject: `CFO Monthly Report — ${business.businessName} — ${month}`,
        html: `<p>Attached is the autonomous monthly CFO report for <b>${month}</b>.</p>` +
              `<p>${(report.sections?.executiveSummary?.en || []).join('<br/>')}</p>`,
        attachments: [{ filename: path.basename(report.pdfPath), path: report.pdfPath }],
      });
      report.status = 'sent'; report.sentTo = recipients; report.sentAt = new Date();
      await report.save();
    } catch (e) {
      logger.warn(`[cfo-report] email failed (kept in-app): ${e.message}`);
    }
    return report;
  }

  /** Cron entry: on the first business day, generate+send for every business. */
  async runMonthly(now = new Date()) {
    if (!isFirstBusinessDay(now)) return { skipped: 'not first business day' };
    const month = new Date(now.getFullYear(), now.getMonth() - 1, 15)
      .toISOString().slice(0, 7);
    const businesses = await Business.find({}).select('_id').lean();
    let generated = 0;
    for (const { _id } of businesses) {
      try {
        const existing = await CfoReport.findOne({ businessId: _id, month, status: 'sent' });
        if (existing) continue;                       // idempotent across reruns
        await this.generate(_id);
        await this.deliver(_id, month);
        generated++;
      } catch (e) { logger.warn(`[cfo-report] business=${_id} failed: ${e.message}`); }
    }
    logger.info(`[cfo-report] monthly run: ${generated} report(s) generated/delivered`);
    return { generated };
  }

  async list(businessId) {
    return CfoReport.find({ businessId }).sort({ month: -1 }).limit(24)
      .select('-sections.kpi -pdfPath').lean();
  }

  async addCommentary(businessId, month, commentary) {
    const report = await CfoReport.findOneAndUpdate(
      { businessId, month },
      { $set: { commentary: String(commentary || '').slice(0, 4000) } },
      { returnDocument: 'after' },
    );
    if (!report) { const e = new Error('Report not found'); e.statusCode = 404; throw e; }
    // Regenerate the PDF with commentary embedded — automation unaffected.
    await this.generate(businessId, new Date(`${month}-15`));
    return report;
  }

  async pdfPathFor(businessId, month) {
    const r = await CfoReport.findOne({ businessId, month }).select('pdfPath').lean();
    return r?.pdfPath || null;
  }
}

module.exports = new CfoReportService();
module.exports._isFirstBusinessDay = isFirstBusinessDay;
