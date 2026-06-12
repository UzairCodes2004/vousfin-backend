// services/invoicePdf.service.js
//
// Phase 2 — Server-side PDF generation for invoices AND bills.
//
// Uses PDFKit (lightweight, zero-dependency PDF lib for Node.js).
// Produces a professional, structured document with:
//   - Branded header with the business LOGO (uploaded image) + full contact block
//   - Document title, number, dates and a status pill
//   - "Bill To" (invoice) / "From — Vendor" (bill) party block
//   - Itemised line table ("what was sold") with per-line descriptions
//   - Dynamic totals breakdown (discounts, tax, WHT, shipping, paid, balance)
//   - Bank / payment details, payment terms & notes
//   - Page footer with page numbers, auto page-breaks for long item lists
//
// Public API:
//   generatePdf(document, business, opts)      → Buffer (PDF bytes)
//   streamPdf(document, business, res, opts)   → pipes PDF to an Express response
//     opts = { type: 'invoice' | 'bill' }      (defaults to 'invoice')
//

const logger = require('../config/logger');

// Lazy-load PDFKit to avoid startup cost and allow graceful fallback
let PDFDocument;
try {
  PDFDocument = require('pdfkit');
} catch {
  logger.warn('[invoicePdf] pdfkit not installed — PDF generation unavailable. Run: npm install pdfkit');
}

// ── Layout constants ─────────────────────────────────────────────────────────
const PAGE = { width: 595.28, height: 841.89 }; // A4 points
const M = { top: 50, right: 50, bottom: 60, left: 50 };
const CW = PAGE.width - M.left - M.right; // content width
const PAGE_BOTTOM = PAGE.height - M.bottom;
const COLORS = {
  primary: '#0891B2', // cyan-600
  dark:    '#0F172A',
  text:    '#1E293B',
  muted:   '#64748B',
  border:  '#E2E8F0',
  bg:      '#F8FAFC',
  white:   '#FFFFFF',
};

class InvoicePdfService {
  /**
   * Generate a PDF buffer for an invoice or bill.
   *
   * @param {Object} document  — Mongoose doc or plain object (invoice or bill)
   * @param {Object} business  — { businessName, address, phone, email, website, taxId, regNumber, logoUrl? }
   * @param {Object} [opts]    — { type: 'invoice' | 'bill' }
   * @returns {Promise<Buffer>}
   */
  async generatePdf(document, business = {}, opts = {}) {
    if (!PDFDocument) throw new Error('pdfkit is not installed. Run: npm install pdfkit');
    const cfg = this._docConfig(document, opts.type);

    return new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument({
          size: 'A4',
          margin: M.top,
          bufferPages: true,
          info: { Title: `${cfg.title} ${cfg.number}`, Author: business.businessName || 'VousFin' },
        });
        const chunks = [];
        doc.on('data', (c) => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
        this._render(doc, document, business, cfg);
        doc.end();
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Stream a PDF directly to an Express response (download endpoint).
   */
  async streamPdf(document, business, res, opts = {}) {
    if (!PDFDocument) throw new Error('pdfkit is not installed');
    const cfg = this._docConfig(document, opts.type);
    const doc = new PDFDocument({ size: 'A4', margin: M.top, bufferPages: true });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${cfg.title}-${cfg.number}.pdf"`);
    doc.pipe(res);
    this._render(doc, document, business, cfg);
    doc.end();
  }

  // ── Document-type configuration ──────────────────────────────────────────────
  // Normalises the differences between an invoice and a bill into one shape so
  // the renderer stays type-agnostic.
  _docConfig(d, type = 'invoice') {
    if (type === 'bill') {
      const vs = d.vendorSnapshot || {};
      return {
        type: 'bill',
        title: 'BILL',
        number: d.billNumber || '—',
        numberLabel: 'Bill #',
        partyLabel: 'FROM (VENDOR)',
        party: {
          name:  vs.vendorName,
          email: vs.email,
          phone: vs.phone,
          taxId: vs.taxId || vs.strn,
        },
        secondaryRef: d.vendorReferenceNumber ? { label: 'Vendor Ref #', value: d.vendorReferenceNumber } : null,
        showWht: Number(d.whtAmount) > 0,
      };
    }
    const cs = d.customerSnapshot || {};
    return {
      type: 'invoice',
      title: 'INVOICE',
      number: d.invoiceNumber || '—',
      numberLabel: 'Invoice #',
      partyLabel: 'BILL TO',
      party: {
        name:  cs.businessName || cs.fullName,
        email: cs.email,
        phone: cs.phone,
        taxId: cs.taxId,
      },
      secondaryRef: null,
      showWht: false,
    };
  }

  // ── Internal render ────────────────────────────────────────────────────────
  _render(doc, d, biz, cfg) {
    const r2 = (v) => (Number(v) || 0).toFixed(2);
    const cur = d.currencyCode || d.currency || 'PKR';
    const fmt = (v) => `${cur} ${this._money(v)}`;

    // ── Accent bar across the very top ──────────────────────────────
    doc.rect(0, 0, PAGE.width, 6).fill(COLORS.primary);

    // ── Header band: logo + business (left)  |  title + meta (right) ─
    let leftY = M.top;
    const logo = this._logoBuffer(biz.logoUrl);
    if (logo) {
      try {
        doc.image(logo, M.left, leftY, { fit: [120, 54] });
        leftY += 62;
      } catch {
        // Unsupported image format (e.g. SVG/WebP) — skip silently
      }
    }
    doc.fontSize(15).font('Helvetica-Bold').fillColor(COLORS.dark)
      .text(biz.businessName || 'Your Company', M.left, leftY, { width: CW * 0.55 });
    leftY = doc.y + 2;
    doc.font('Helvetica').fontSize(8.5).fillColor(COLORS.muted);
    const bizLines = [
      biz.address,
      biz.phone   ? `Phone: ${biz.phone}` : null,
      biz.email   || null,
      biz.website || null,
      biz.taxId   ? `Tax ID: ${biz.taxId}` : null,
      biz.regNumber ? `Reg #: ${biz.regNumber}` : null,
    ].filter(Boolean);
    for (const line of bizLines) {
      doc.text(line, M.left, leftY, { width: CW * 0.55 });
      leftY = doc.y + 1;
    }

    // Right side — big title + meta card
    const titleY = M.top;
    doc.font('Helvetica-Bold').fontSize(26).fillColor(COLORS.primary)
      .text(cfg.title, PAGE.width / 2, titleY, { width: CW / 2, align: 'right' });

    const meta = [];
    meta.push([cfg.numberLabel, cfg.number]);
    if (cfg.secondaryRef) meta.push([cfg.secondaryRef.label, cfg.secondaryRef.value]);
    meta.push(['Date', this._fmtDate(d.issueDate)]);
    if (d.dueDate) meta.push(['Due Date', this._fmtDate(d.dueDate)]);
    if (cur && cur !== 'PKR') meta.push(['Currency', `${cur} @ ${d.exchangeRate || 1}`]);

    let metaY = titleY + 34;
    const metaValX = PAGE.width - M.right;
    const metaLabelX = PAGE.width / 2;
    doc.fontSize(9);
    for (const [label, value] of meta) {
      doc.font('Helvetica').fillColor(COLORS.muted)
        .text(`${label}:`, metaLabelX, metaY, { width: CW / 2 - 110, align: 'right' });
      doc.font('Helvetica-Bold').fillColor(COLORS.dark)
        .text(String(value), metaValX - 150, metaY, { width: 150, align: 'right' });
      metaY += 14;
    }

    // Status pill under the meta block
    const status = (d.state || 'draft').toUpperCase();
    doc.font('Helvetica-Bold').fontSize(8);
    const pillW = doc.widthOfString(status) + 16;
    const pillX = PAGE.width - M.right - pillW;
    doc.roundedRect(pillX, metaY + 2, pillW, 16, 8).fill(this._statusColor(d.state));
    doc.fillColor(COLORS.white).text(status, pillX, metaY + 6, { width: pillW, align: 'center' });
    metaY += 24;

    // ── Party block ("Bill To" / "Vendor") ──────────────────────────
    let y = Math.max(leftY, metaY) + 14;
    doc.moveTo(M.left, y).lineTo(PAGE.width - M.right, y).strokeColor(COLORS.border).lineWidth(1).stroke();
    y += 12;

    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(COLORS.primary).text(cfg.partyLabel, M.left, y);
    y += 14;
    const p = cfg.party;
    if (p.name) { doc.font('Helvetica-Bold').fontSize(10.5).fillColor(COLORS.dark).text(p.name, M.left, y); y = doc.y + 2; }
    doc.font('Helvetica').fontSize(8.5).fillColor(COLORS.muted);
    for (const line of [p.email, p.phone, p.taxId ? `Tax ID: ${p.taxId}` : null].filter(Boolean)) {
      doc.text(line, M.left, y); y = doc.y + 1;
    }

    // ── Line items table ─────────────────────────────────────────────
    y += 16;
    const items = d.lineItems || [];
    if (items.length > 0) {
      y = this._renderLineItems(doc, items, y);
    } else {
      // Legacy doc with no structured line items — show a single descriptive row
      y = this._renderLineItems(doc, [{
        name: d.description || `${cfg.title} amount`,
        quantity: 1,
        unitPrice: d.totalAmount || d.amount || 0,
        lineTotal: d.totalAmount || d.amount || 0,
      }], y);
    }

    // ── Totals panel ─────────────────────────────────────────────────
    y += 12;
    if (y > PAGE_BOTTOM - 140) { doc.addPage(); y = M.top; }
    y = this._renderTotals(doc, d, cfg, y, fmt);

    // ── Bank details ─────────────────────────────────────────────────
    if (d.bankDetails && (d.bankDetails.bankName || d.bankDetails.iban)) {
      y += 22;
      if (y > PAGE_BOTTOM - 90) { doc.addPage(); y = M.top; }
      y = this._renderBankDetails(doc, d.bankDetails, y);
    }

    // ── Payment terms & notes ────────────────────────────────────────
    const terms = d.paymentTermsText || d.paymentTerms?.label;
    if (terms || d.notes) {
      y += 16;
      if (y > PAGE_BOTTOM - 80) { doc.addPage(); y = M.top; }
      if (terms) {
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor(COLORS.primary).text('PAYMENT TERMS', M.left, y);
        y += 12;
        doc.font('Helvetica').fillColor(COLORS.muted).fontSize(8.5).text(terms, M.left, y, { width: CW });
        y = doc.y + 8;
      }
      if (d.notes) {
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor(COLORS.primary).text('NOTES', M.left, y);
        y += 12;
        doc.font('Helvetica').fillColor(COLORS.muted).fontSize(8.5).text(d.notes, M.left, y, { width: CW });
      }
    }

    // ── Footer on every page (page numbers + brand) ──────────────────
    this._renderFooters(doc, biz);
  }

  _renderLineItems(doc, items, startY) {
    let y = startY;
    // x positions are absolute; widths chosen to fit A4 content width (CW≈495)
    const cols = [
      { key: '#',     label: '#',          x: M.left,       w: 22,  align: 'left'  },
      { key: 'item',  label: 'Description',x: M.left + 22,  w: 223, align: 'left'  },
      { key: 'qty',   label: 'Qty',        x: 267,          w: 48,  align: 'right' },
      { key: 'price', label: 'Unit Price', x: 315,          w: 70,  align: 'right' },
      { key: 'tax',   label: 'Tax',        x: 385,          w: 50,  align: 'right' },
      { key: 'total', label: 'Amount',     x: 435,          w: PAGE.width - M.right - 435, align: 'right' },
    ];

    const drawHeader = () => {
      doc.rect(M.left, y, CW, 20).fill(COLORS.primary);
      doc.font('Helvetica-Bold').fontSize(8).fillColor(COLORS.white);
      for (const c of cols) doc.text(c.label, c.x + 4, y + 6, { width: c.w - 8, align: c.align });
      y += 20;
    };

    drawHeader();
    const r2 = (v) => (Number(v) || 0).toFixed(2);

    for (let i = 0; i < items.length; i++) {
      const li = items[i];
      const hasDesc = li.description && String(li.description).trim().length > 0;
      const rowH = hasDesc ? 28 : 18;

      // Page break — repeat the header on the new page
      if (y + rowH > PAGE_BOTTOM) {
        doc.addPage();
        y = M.top;
        drawHeader();
      }

      if (i % 2 === 1) doc.rect(M.left, y, CW, rowH).fill(COLORS.bg);

      doc.font('Helvetica').fontSize(8.5).fillColor(COLORS.text);
      doc.text(String(i + 1), cols[0].x + 4, y + 5, { width: cols[0].w - 8 });
      doc.font('Helvetica-Bold').text(li.name || '', cols[1].x + 4, y + 5, { width: cols[1].w - 8 });
      if (hasDesc) {
        doc.font('Helvetica').fontSize(7.5).fillColor(COLORS.muted)
          .text(String(li.description), cols[1].x + 4, y + 16, { width: cols[1].w - 8, ellipsis: true, height: 9 });
        doc.fontSize(8.5).fillColor(COLORS.text);
      }
      const unit = li.unit ? ` ${li.unit}` : '';
      doc.font('Helvetica').fillColor(COLORS.text);
      doc.text(`${this._num(li.quantity)}${unit}`, cols[2].x + 4, y + 5, { width: cols[2].w - 8, align: 'right' });
      doc.text(r2(li.unitPrice), cols[3].x + 4, y + 5, { width: cols[3].w - 8, align: 'right' });
      doc.text(r2(li.taxAmount || 0), cols[4].x + 4, y + 5, { width: cols[4].w - 8, align: 'right' });
      doc.font('Helvetica-Bold').text(r2(li.lineTotal || 0), cols[5].x + 4, y + 5, { width: cols[5].w - 8, align: 'right' });
      y += rowH;
    }

    doc.moveTo(M.left, y).lineTo(PAGE.width - M.right, y).strokeColor(COLORS.border).lineWidth(0.5).stroke();
    return y;
  }

  _renderTotals(doc, d, cfg, startY, fmt) {
    let y = startY;
    const labelX = PAGE.width - M.right - 220;
    const labelW = 120;
    const valX = PAGE.width - M.right - 95;
    const lineH = 16;

    const addRow = (label, value, opts = {}) => {
      const bold = opts.bold;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 10 : 8.5)
        .fillColor(bold ? COLORS.dark : COLORS.muted)
        .text(label, labelX, y, { width: labelW, align: 'right' });
      doc.font('Helvetica-Bold').fontSize(bold ? 10 : 9).fillColor(opts.color || COLORS.dark)
        .text(value, valX, y, { width: 95, align: 'right' });
      y += lineH;
    };

    const hasItems = d.lineItems && d.lineItems.length > 0;
    if (hasItems) addRow('Subtotal', fmt(d.subtotal || 0));
    if (d.totalLineDiscount > 0)     addRow('Line Discounts', `- ${fmt(d.totalLineDiscount)}`);
    if (d.invoiceDiscountAmount > 0) addRow('Discount', `- ${fmt(d.invoiceDiscountAmount)}`);
    if ((d.totalTax || d.taxAmount) > 0) addRow('Tax', fmt(d.totalTax || d.taxAmount || 0));
    if (cfg.showWht && d.whtAmount > 0)  addRow('WHT Withheld', `- ${fmt(d.whtAmount)}`);
    if (d.shippingCharges > 0)       addRow('Shipping', fmt(d.shippingCharges));
    if (d.roundingAdjustment)        addRow('Rounding', fmt(d.roundingAdjustment));

    // Grand-total separator + total
    doc.moveTo(labelX, y).lineTo(PAGE.width - M.right, y).strokeColor(COLORS.primary).lineWidth(1).stroke();
    y += 6;
    addRow('TOTAL', fmt(d.totalAmount || d.amount || 0), { bold: true });

    if (d.paidAmount > 0) {
      addRow('Paid', `- ${fmt(d.paidAmount)}`);
      addRow('Balance Due', fmt(d.remainingBalance ?? ((d.totalAmount || 0) - d.paidAmount)), { bold: true, color: COLORS.primary });
    }
    if (d.totalCredited > 0) addRow('Credited', `- ${fmt(d.totalCredited)}`);

    return y;
  }

  _renderBankDetails(doc, bank, startY) {
    let y = startY;
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(COLORS.primary).text('BANK / PAYMENT DETAILS', M.left, y);
    y += 14;
    doc.font('Helvetica').fontSize(8.5).fillColor(COLORS.muted);
    const rows = [
      bank.bankName      ? `Bank: ${bank.bankName}` : null,
      bank.accountTitle  ? `Account Title: ${bank.accountTitle}` : null,
      bank.accountNumber ? `A/C #: ${bank.accountNumber}` : null,
      bank.iban          ? `IBAN: ${bank.iban}` : null,
      bank.swiftCode     ? `SWIFT: ${bank.swiftCode}` : null,
    ].filter(Boolean);
    for (const r of rows) { doc.text(r, M.left, y); y = doc.y + 1; }
    return y;
  }

  _renderFooters(doc, biz) {
    const range = doc.bufferedPageRange(); // { start, count }
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const footY = PAGE.height - M.bottom + 14;
      doc.moveTo(M.left, footY).lineTo(PAGE.width - M.right, footY)
        .strokeColor(COLORS.border).lineWidth(0.5).stroke();
      doc.font('Helvetica').fontSize(7).fillColor(COLORS.muted);
      doc.text(
        `${biz.businessName || 'VousFin'} · Generated by VousFin Smart Accountant`,
        M.left, footY + 6, { width: CW * 0.7, align: 'left' }
      );
      doc.text(
        `Page ${i - range.start + 1} of ${range.count}`,
        PAGE.width - M.right - 120, footY + 6, { width: 120, align: 'right' }
      );
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────
  /**
   * Decode an uploaded logo (base64 data URI) into a Buffer PDFKit can draw.
   * Only PNG/JPEG are supported by PDFKit's image() — other formats (SVG, WebP,
   * GIF) and remote http(s) URLs are skipped gracefully (returns null).
   */
  _logoBuffer(logoUrl) {
    if (!logoUrl || typeof logoUrl !== 'string') return null;
    const m = /^data:(image\/(?:png|jpe?g));base64,(.+)$/i.exec(logoUrl);
    if (!m) return null;
    try {
      return Buffer.from(m[2], 'base64');
    } catch {
      return null;
    }
  }

  _statusColor(state) {
    switch ((state || '').toLowerCase()) {
      case 'paid':      return '#16A34A'; // green
      case 'approved':
      case 'sent':      return COLORS.primary;
      case 'scheduled': return '#7C3AED'; // violet
      case 'cancelled':
      case 'void':
      case 'rejected':  return '#DC2626'; // red
      case 'overdue':   return '#EA580C'; // orange
      default:          return COLORS.muted; // draft / pending
    }
  }

  _money(v) {
    return (Number(v) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  _num(v) {
    const n = Number(v) || 0;
    return Number.isInteger(n) ? String(n) : n.toString();
  }

  _fmtDate(d) {
    if (!d) return '—';
    const dt = new Date(d);
    if (Number.isNaN(dt.getTime())) return '—';
    return dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  }
}

module.exports = new InvoicePdfService();
