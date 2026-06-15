// services/returnBuilders/gst01.builder.js — FR-04.3
//
// Compiles a Pakistan GST-01 (Sales Tax Return) entirely from the GL: header
// boxes from the reconciled filing summary, and invoice-wise annexes from the
// tax ledger. Zero manual entry.
//
'use strict';
const taxReport = require('../taxReport.service');

const r2  = (v) => Math.round((Number(v) || 0) * 100) / 100;
const sum = (arr) => r2(arr.reduce((s, v) => s + (Number(v) || 0), 0));

// Same split the tax summary uses (sales = output / Annex-C, purchases = input / Annex-A).
const OUTPUT_TYPES = ['Cash Sale', 'Credit Sale', 'Inventory Sale', 'GST Collection', 'VAT Collection'];
const INPUT_TYPES  = ['Cash Purchase', 'Credit Purchase', 'Inventory Purchase', 'GST Payment', 'VAT Payment'];

/**
 * @param {string} businessId
 * @param {{startDate:Date, endDate:Date}} range
 * @param {string} [country]
 */
async function buildGST01(businessId, range, country = 'PK') {
  const [filing, ledger] = await Promise.all([
    taxReport.getFilingSummary(businessId, range, country),
    taxReport.getTaxLedger(businessId, range),
  ]);

  const sales     = ledger.filter(e => OUTPUT_TYPES.includes(e.transactionType));
  const purchases = ledger.filter(e => INPUT_TYPES.includes(e.transactionType));

  // Annex-C: invoice-wise domestic sales. Annex-A: invoice-wise purchases.
  const annexC = sales.map((e, i) => ({
    serial: i + 1, date: e.date, description: e.description,
    value: r2(e.netAmount), taxRate: e.taxRate, salesTax: r2(e.taxAmount),
  }));
  const annexA = purchases.map((e, i) => ({
    serial: i + 1, date: e.date, description: e.description,
    value: r2(e.netAmount), taxRate: e.taxRate, inputTax: r2(e.taxAmount),
  }));

  // The GL reconciliation is authoritative (it reads the tax control accounts —
  // the same source as the live position), so the return ties out to the books
  // with zero variance even when entry-level taxType tags are sparse. Fall back
  // to the transaction-derived summary only when the reconciliation is absent.
  const recon = filing.reconciliation;
  const outputTax  = r2(recon && recon.glOutputTax  != null ? recon.glOutputTax  : filing.outputTax);
  const inputTax   = r2(recon && recon.glInputTax   != null ? recon.glInputTax   : filing.inputTax);
  const netPayable = r2(recon && recon.glNetPayable != null ? recon.glNetPayable : filing.netPayable);

  const fields = {
    totalTaxableSales:     sum(sales.map(e => e.netAmount)),
    outputTax,
    totalTaxablePurchases: sum(purchases.map(e => e.netAmount)),
    inputTax,
    netPayable,
    status:                netPayable > 0 ? 'payable' : netPayable < 0 ? 'refundable' : 'nil',
  };

  return {
    returnType: 'GST-01',
    form: 'GST-01 (FBR Sales Tax Return)',
    fields,
    annexes: { A: annexA, B: [], C: annexC },             // B (credit/debit notes) reserved
    reconciliation: filing.reconciliation,                // GL ↔ summary tie-out
  };
}

module.exports = { buildGST01, OUTPUT_TYPES, INPUT_TYPES };
