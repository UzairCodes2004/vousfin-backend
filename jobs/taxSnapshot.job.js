// jobs/taxSnapshot.job.js
//
// FR-04.1 (Phase 2) — daily cron that captures a tax-position snapshot for every
// tax-tracking business, building the 6-month liability trend over time.
//
// "Tax-tracking" is the UNION of two signals, because a business accrues tax in
// the GL the moment it posts a taxable transaction — long before (and whether or
// not) it ever flips the taxConfig flags in settings:
//   1. it has tax accounts in its chart (codes 1170–1177, 2120–2130), or
//   2. it has explicitly enabled tax in taxConfig.
// Each business is wrapped in try/catch so one failure never aborts the sweep.
//
'use strict';

const cron           = require('node-cron');
const Business       = require('../models/Business.model');
const ChartOfAccount = require('../models/ChartOfAccount.model');
const taxSnapshot    = require('../services/taxSnapshot.service');
const logger         = require('../config/logger');

// Tax CoA codes (mirrors the set in tax.controller.listTaxAccounts).
const TAX_ACCOUNT_CODES = [
  '2120', '2121', '2122', '2123', '2124', '2125', '2126', '2127', '2128', '2129', '2130',
  '1170', '1171', '1172', '1173', '1174', '1175', '1176', '1177',
];

// Businesses that have explicitly switched on a tax in settings.
const FLAG_FILTER = {
  isActive: { $ne: false },
  $or: [
    { 'taxConfig.registeredForTax': true },
    { 'taxConfig.gstEnabled':       true },
    { 'taxConfig.vatEnabled':       true },
    { 'taxConfig.whtEnabled':       true },
  ],
};

/**
 * The deduped set of business ids that track tax (accounts ∪ flags).
 * @returns {Promise<Array>} business ids
 */
async function resolveTargetBusinessIds() {
  const [withAccounts, flagged] = await Promise.all([
    ChartOfAccount.distinct('businessId', { accountCode: { $in: TAX_ACCOUNT_CODES } }),
    Business.find(FLAG_FILTER).select('_id').lean(),
  ]);

  const byKey = new Map();
  for (const id of withAccounts) byKey.set(String(id), id);
  for (const b of flagged)       byKey.set(String(b._id), b._id);
  return [...byKey.values()];
}

/**
 * Capture a snapshot for every tax-tracking business. Public so tests + manual
 * triggers can call it directly.
 * @param {Date} [asOf]
 * @returns {Promise<{businesses:number, captured:number, errors:number}>}
 */
async function runOnce(asOf = new Date()) {
  const ids = await resolveTargetBusinessIds();
  const stats = { businesses: ids.length, captured: 0, errors: 0 };

  for (const id of ids) {
    try {
      await taxSnapshot.captureSnapshot(id, asOf);
      stats.captured += 1;
    } catch (err) {
      stats.errors += 1;
      logger.error(`[tax-snapshot-cron] Business ${id} failed: ${err.message}`);
    }
  }

  logger.info(`[tax-snapshot-cron] Captured ${stats.captured}/${stats.businesses} (${stats.errors} errors)`);
  return stats;
}

/** Register the daily schedule. Call once at app startup. */
function scheduleTaxSnapshots() {
  // 30 0 * * *  → every day at 00:30 server/Karachi time
  cron.schedule('30 0 * * *', () => {
    runOnce().catch(err => logger.error(`[tax-snapshot-cron] Top-level: ${err.message}`));
  }, { timezone: process.env.CRON_TIMEZONE || 'Asia/Karachi' });

  logger.info('⏰ Tax-position snapshot cron scheduled (daily 00:30)');
}

module.exports = { scheduleTaxSnapshots, runOnce, resolveTargetBusinessIds, FLAG_FILTER, TAX_ACCOUNT_CODES };
