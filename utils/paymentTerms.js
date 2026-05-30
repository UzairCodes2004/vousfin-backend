// utils/paymentTerms.js
//
// AR/AP Refactor — Milestone M8.
//
// Pure, side-effect-free payment-terms engine. Resolves a structured payment
// term (PAYMENT_TERMS in constants) into:
//   • the document due date            (issueDate + netDays)
//   • the early-payment discount window (issueDate + discountDays)
//   • the discount amount available     (remaining × discountPct, if within window)
//
// Design notes:
//   • No DB, no I/O — trivially unit-testable and safe to call from models,
//     services, the scheduler and the frontend-facing controllers alike.
//   • A "terms snapshot" is what gets stored on the Invoice/Bill so historic
//     documents are immune to later edits of the PAYMENT_TERMS table.
//   • All money is rounded to 2 dp; never returns negative amounts.
//
'use strict';

const { PAYMENT_TERMS } = require('../config/constants');

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const MS_PER_DAY = 86400000;

/** Normalize any input to a UTC-midnight Date (date-only comparisons,
 *  timezone-independent so derived due dates land on the intended calendar day). */
function dayStart(d) {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}

/**
 * Resolve a terms code (or a partial/snapshot object) into a full terms object.
 * Falls back to NET_30 when the code is unknown, and accepts a raw object with
 * { netDays, discountPct, discountDays } for ad-hoc custom terms.
 *
 * @param {string|object|null} input
 * @returns {{code,label,netDays,discountPct,discountDays}}
 */
function resolveTerms(input) {
  if (input && typeof input === 'object') {
    // Already a terms-like object (e.g. a stored snapshot or custom terms).
    if (input.code && PAYMENT_TERMS[input.code]) {
      return { ...PAYMENT_TERMS[input.code], ...sanitize(input) };
    }
    return {
      code:         input.code || 'CUSTOM',
      label:        input.label || 'Custom',
      ...sanitize(input),
    };
  }
  if (typeof input === 'string' && PAYMENT_TERMS[input]) {
    return { ...PAYMENT_TERMS[input] };
  }
  return { ...PAYMENT_TERMS.NET_30 };
}

/** Coerce numeric term fields to safe, non-negative integers/numbers. */
function sanitize(o) {
  return {
    netDays:      Math.max(0, Math.trunc(Number(o.netDays) || 0)),
    discountPct:  Math.max(0, Number(o.discountPct) || 0),
    discountDays: Math.max(0, Math.trunc(Number(o.discountDays) || 0)),
  };
}

/**
 * Build the immutable terms snapshot to store on a document.
 * @param {string|object} input  — a PAYMENT_TERMS code or terms-like object
 */
function buildSnapshot(input) {
  const t = resolveTerms(input);
  return {
    code:         t.code,
    label:        t.label,
    netDays:      t.netDays,
    discountPct:  t.discountPct,
    discountDays: t.discountDays,
  };
}

/**
 * Compute the due date from an issue date and terms.
 * @returns {Date}
 */
function computeDueDate(issueDate, input) {
  const t = resolveTerms(input);
  const base = dayStart(issueDate || new Date());
  return new Date(base.getTime() + t.netDays * MS_PER_DAY);
}

/**
 * The last date on which the early-payment discount can still be taken.
 * @returns {Date|null} null when the terms carry no discount.
 */
function computeDiscountDeadline(issueDate, input) {
  const t = resolveTerms(input);
  if (!(t.discountPct > 0) || !(t.discountDays >= 0)) return null;
  const base = dayStart(issueDate || new Date());
  return new Date(base.getTime() + t.discountDays * MS_PER_DAY);
}

/**
 * Whole-day difference (asOf − reference). Positive = asOf is later.
 */
function daysBetween(reference, asOf) {
  return Math.round((dayStart(asOf).getTime() - dayStart(reference).getTime()) / MS_PER_DAY);
}

/**
 * Is the early-payment discount still available on `asOf`?
 */
function isDiscountAvailable(issueDate, input, asOf = new Date()) {
  const deadline = computeDiscountDeadline(issueDate, input);
  if (!deadline) return false;
  return dayStart(asOf).getTime() <= deadline.getTime();
}

/**
 * The discount amount available against an outstanding balance on `asOf`.
 * Returns 0 when no discount applies or the window has passed.
 * The discount is capped at the outstanding balance.
 *
 * @param {number} outstanding   — remaining balance to settle
 * @param {Date}   issueDate
 * @param {string|object} input  — terms
 * @param {Date}   asOf
 * @returns {number}
 */
function computeDiscount(outstanding, issueDate, input, asOf = new Date()) {
  const t = resolveTerms(input);
  const bal = r2(outstanding);
  if (!(bal > 0) || !(t.discountPct > 0)) return 0;
  if (!isDiscountAvailable(issueDate, input, asOf)) return 0;
  return r2(Math.min(bal, bal * (t.discountPct / 100)));
}

/**
 * A full settlement preview: what it costs to clear `outstanding` on `asOf`
 * given the terms — used by the UI ("pay $980 now and save $20") and by the
 * early-payment-discount service.
 *
 * @returns {{
 *   terms, dueDate, discountDeadline, discountAvailable,
 *   discountAmount, netDueIfDiscounted, outstanding, daysUntilDue, isOverdue
 * }}
 */
function settlementPreview(outstanding, issueDate, input, asOf = new Date()) {
  const terms = resolveTerms(input);
  const dueDate = computeDueDate(issueDate, input);
  const discountDeadline = computeDiscountDeadline(issueDate, input);
  const discountAvailable = isDiscountAvailable(issueDate, input, asOf);
  const discountAmount = computeDiscount(outstanding, issueDate, input, asOf);
  const bal = r2(outstanding);
  const daysUntilDue = daysBetween(asOf, dueDate);
  return {
    terms,
    dueDate,
    discountDeadline,
    discountAvailable,
    discountAmount,
    netDueIfDiscounted: r2(bal - discountAmount),
    outstanding: bal,
    daysUntilDue,
    isOverdue: daysUntilDue < 0,
  };
}

module.exports = {
  resolveTerms,
  buildSnapshot,
  computeDueDate,
  computeDiscountDeadline,
  isDiscountAvailable,
  computeDiscount,
  settlementPreview,
  daysBetween,
  dayStart,
};
