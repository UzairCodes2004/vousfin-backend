// services/returnBuilders/wht165.builder.js — FR-04.3
//
// Compiles a Withholding Statement u/s 165 from the per-vendor WHT the engine
// already records on posted journal entries.
//
'use strict';
const taxReport = require('../taxReport.service');

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

async function buildWHT165(businessId, range) {
  const wht = await taxReport.getWhtSummary(businessId, range);
  const vendors = Array.isArray(wht.vendors) ? wht.vendors : [];

  const lines = vendors.map((v, i) => ({
    serial:       i + 1,
    vendorName:   v.vendorName,
    taxId:        v.taxId || null,                // NTN / CNIC
    section:      '153',                          // payments for goods/services (default)
    grossAmount:  r2(v.totalGross),
    taxWithheld:  r2(v.totalWht),
  }));

  return {
    returnType: 'WHT-165',
    form: 'Withholding Statement u/s 165',
    fields: {
      totalGross:    r2(lines.reduce((s, l) => s + l.grossAmount, 0)),
      totalWithheld: r2(wht.totalWht),
      vendorCount:   lines.length,
      entryCount:    wht.entryCount || 0,
    },
    lines,
  };
}

module.exports = { buildWHT165 };
