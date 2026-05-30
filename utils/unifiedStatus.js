/**
 * unifiedStatus.js — AR/AP Domain Refactor, Milestone M3.
 *
 * One canonical, consistently-DERIVED status for AR (Invoice) and AP (Bill),
 * replacing the split-brain of: Invoice.state ∪ Bill.state ∪ JournalEntry.paymentStatus
 * with their mixed naming (pending_approval vs awaiting_approval) and dead enum
 * members (a `rejected` referenced by the transition maps but absent from the
 * state enums).
 *
 * Principle: workflow states (draft / pending_approval / rejected / voided) are
 * authoritative; from `approved` onward the status is computed from the money
 * (paidAmount / remainingBalance) so PartiallyPaid / Paid are ALWAYS consistent
 * with the ledger — never a stale stored label.
 *
 * This is a pure, additive layer. It does not change any persisted `state`; it
 * normalizes whatever exists onto the canonical set for APIs, reporting and UI.
 */

'use strict';

// Canonical unified status (the seven). snake_case values keep wire-compatibility
// with the existing state strings; the KEYS are the canonical names.
const UNIFIED_STATUS = Object.freeze({
  DRAFT:            'draft',
  PENDING_APPROVAL: 'pending_approval',
  APPROVED:         'approved',
  PARTIALLY_PAID:   'partially_paid',
  PAID:             'paid',
  VOIDED:           'voided',
  REJECTED:         'rejected',
});

const U = UNIFIED_STATUS;

// Legacy per-entity state → canonical workflow bucket (before the money overlay).
const LEGACY_STATE_MAP = Object.freeze({
  // workflow
  draft:             U.DRAFT,
  rejected:          U.REJECTED,
  pending_approval:  U.PENDING_APPROVAL,
  awaiting_approval: U.PENDING_APPROVAL,   // bill naming → unified
  // terminal-closed (no/!collectible)
  cancelled:         U.VOIDED,
  voided:            U.VOIDED,
  written_off:       U.VOIDED,
  // active (post-approval) — money overlay decides PartiallyPaid / Paid
  approved:          U.APPROVED,
  sent:              U.APPROVED,
  scheduled:         U.APPROVED,
  overdue:           U.APPROVED,
  disputed:          U.APPROVED,
  partially_paid:    U.PARTIALLY_PAID,
  paid:              U.PAID,
});

// Workflow statuses that money must NOT override.
const TERMINAL_OR_PRE_APPROVAL = new Set([U.DRAFT, U.PENDING_APPROVAL, U.REJECTED, U.VOIDED]);

const n = (v) => Number(v) || 0;

/**
 * Derive the canonical unified status from a document's state + money fields.
 * @param {Object} doc { state, paidAmount, remainingBalance, totalAmount }
 * @returns {string} a UNIFIED_STATUS value
 */
function deriveUnifiedStatus(doc = {}) {
  const base = LEGACY_STATE_MAP[doc.state] || U.DRAFT;
  if (TERMINAL_OR_PRE_APPROVAL.has(base)) return base;

  // Approved onward → payment progress is authoritative (consistent with the ledger).
  const total = n(doc.totalAmount);
  const remaining = doc.remainingBalance != null ? n(doc.remainingBalance) : total;
  const paid = n(doc.paidAmount);
  if (total > 0 && remaining <= 0.009) return U.PAID;
  if (paid > 0.009) return U.PARTIALLY_PAID;
  return U.APPROVED;
}

/** Map a raw legacy state string to its canonical workflow status (no money overlay). */
function mapLegacyState(state) {
  return LEGACY_STATE_MAP[state] || U.DRAFT;
}

// Canonical transition map — the single source of truth for "what may follow what".
const UNIFIED_TRANSITIONS = Object.freeze({
  draft:            [U.PENDING_APPROVAL, U.APPROVED, U.REJECTED, U.VOIDED],
  pending_approval: [U.APPROVED, U.REJECTED, U.DRAFT, U.VOIDED],
  rejected:         [U.DRAFT, U.VOIDED],
  approved:         [U.PARTIALLY_PAID, U.PAID, U.VOIDED],
  partially_paid:   [U.PAID, U.VOIDED],
  paid:             [],   // terminal
  voided:           [],   // terminal
});

/** Validate a canonical transition. Same-state is always allowed (idempotent). */
function canTransition(from, to) {
  if (from === to) return true;
  const allowed = UNIFIED_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

module.exports = {
  UNIFIED_STATUS,
  UNIFIED_TRANSITIONS,
  LEGACY_STATE_MAP,
  deriveUnifiedStatus,
  mapLegacyState,
  canTransition,
};
