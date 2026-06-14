/**
 * taxSnapshot.service.js — FR-04.1 (Phase 2: trend)
 *
 * Captures a daily point of the live tax position so liability becomes
 * trendable, and serves the 6-month series back to the dashboard.
 *
 * It does NOT compute tax — it reads taxPosition.getLivePosition (the GL read
 * model) and slims it to the few fields a trend needs, then upserts one row
 * per business per local calendar day (idempotent).
 */
'use strict';

const taxPosition = require('./taxPosition.service');
const repo        = require('../repositories/taxPositionSnapshot.repository');

/** Local 'YYYY-MM-DD' — uses local date parts so the business day never drifts to UTC. */
function toDateKey(d) {
  const y  = d.getFullYear();
  const m  = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/**
 * Read the live position and persist today's snapshot.
 * @param {string} businessId
 * @param {Date}   [asOf]
 * @returns {Promise<object>} the upserted snapshot
 */
async function captureSnapshot(businessId, asOf = new Date()) {
  const position = await taxPosition.getLivePosition(businessId, asOf);

  const payload = {
    currency:     position.currency,
    country:      position.country,
    totalPayable: position.totalPayable,
    taxes: (position.taxes || []).map((t) => ({
      taxType:    t.taxType,
      liability:  t.liability,
      refundable: !!t.refundable,
      status:     t.status,
    })),
    capturedAt: new Date(),
  };

  return repo.upsertForDate(businessId, toDateKey(asOf), payload);
}

/**
 * The last `months` (inclusive of the current month) of snapshots.
 * @param {string} businessId
 * @param {number} [months=6]   clamped to 1..24
 * @param {Date}   [asOf]
 * @returns {Promise<{months:number, from:string, points:object[]}>}
 */
async function getTrend(businessId, months = 6, asOf = new Date()) {
  const n    = clamp(Math.round(Number(months) || 6), 1, 24);
  const from = new Date(asOf.getFullYear(), asOf.getMonth() - (n - 1), 1);
  const fromKey = toDateKey(from);

  const rows = await repo.trend(businessId, fromKey);
  const points = rows.map((r) => ({
    date:         r.date,
    totalPayable: r.totalPayable,
    taxes:        r.taxes,
  }));

  return { months: n, from: fromKey, points };
}

module.exports = { captureSnapshot, getTrend, toDateKey };
