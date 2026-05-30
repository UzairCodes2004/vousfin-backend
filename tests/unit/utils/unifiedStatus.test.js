/**
 * tests/unit/utils/unifiedStatus.test.js
 *
 * AR/AP Domain Refactor — Milestone M3 (unified status model).
 * Validates the canonical derivation for EVERY legacy state and the validity of
 * EVERY canonical transition.
 */
'use strict';

const {
  UNIFIED_STATUS: S, UNIFIED_TRANSITIONS, LEGACY_STATE_MAP,
  deriveUnifiedStatus, mapLegacyState, canTransition,
} = require('../../../utils/unifiedStatus');

describe('UNIFIED_STATUS — the canonical seven', () => {
  it('has exactly the seven canonical statuses', () => {
    expect(Object.keys(S).sort()).toEqual(
      ['APPROVED', 'DRAFT', 'PAID', 'PARTIALLY_PAID', 'PENDING_APPROVAL', 'REJECTED', 'VOIDED'].sort()
    );
  });
});

describe('deriveUnifiedStatus — workflow buckets for EVERY legacy state', () => {
  const cases = {
    draft: S.DRAFT,
    pending_approval: S.PENDING_APPROVAL,
    awaiting_approval: S.PENDING_APPROVAL, // bill naming unified
    rejected: S.REJECTED,
    cancelled: S.VOIDED,
    voided: S.VOIDED,
    written_off: S.VOIDED,
    // active (unpaid) → APPROVED
    approved: S.APPROVED,
    sent: S.APPROVED,
    scheduled: S.APPROVED,
    overdue: S.APPROVED,
    disputed: S.APPROVED,
    // money-named states resolve via the overlay
    partially_paid: S.PARTIALLY_PAID,
    paid: S.PAID,
  };

  it('covers every legacy state present in the map', () => {
    expect(Object.keys(cases).sort()).toEqual(Object.keys(LEGACY_STATE_MAP).sort());
  });

  for (const [state, expected] of Object.entries(cases)) {
    it(`${state} → ${expected}`, () => {
      // partially_paid/paid need money context to resolve via the overlay
      const doc = state === 'partially_paid' ? { state, totalAmount: 100, remainingBalance: 60, paidAmount: 40 }
                : state === 'paid'           ? { state, totalAmount: 100, remainingBalance: 0,  paidAmount: 100 }
                : { state };
      expect(deriveUnifiedStatus(doc)).toBe(expected);
    });
  }
});

describe('deriveUnifiedStatus — money overlay is authoritative from Approved onward', () => {
  it('approved + fully paid → PAID', () => {
    expect(deriveUnifiedStatus({ state: 'approved', totalAmount: 100, remainingBalance: 0, paidAmount: 100 })).toBe(S.PAID);
  });
  it('sent + partly paid → PARTIALLY_PAID', () => {
    expect(deriveUnifiedStatus({ state: 'sent', totalAmount: 100, remainingBalance: 60, paidAmount: 40 })).toBe(S.PARTIALLY_PAID);
  });
  it('overdue + unpaid → APPROVED', () => {
    expect(deriveUnifiedStatus({ state: 'overdue', totalAmount: 100, remainingBalance: 100, paidAmount: 0 })).toBe(S.APPROVED);
  });
  it('terminal/pre-approval states are NOT overridden by money', () => {
    expect(deriveUnifiedStatus({ state: 'voided', totalAmount: 100, remainingBalance: 0, paidAmount: 100 })).toBe(S.VOIDED);
    expect(deriveUnifiedStatus({ state: 'draft',  totalAmount: 100, remainingBalance: 0, paidAmount: 100 })).toBe(S.DRAFT);
    expect(deriveUnifiedStatus({ state: 'rejected' })).toBe(S.REJECTED);
  });
  it('falls back to DRAFT for an unknown state', () => {
    expect(deriveUnifiedStatus({ state: 'nonsense' })).toBe(S.DRAFT);
  });
});

describe('mapLegacyState', () => {
  it('mirrors the workflow bucket (no money overlay)', () => {
    expect(mapLegacyState('awaiting_approval')).toBe(S.PENDING_APPROVAL);
    expect(mapLegacyState('cancelled')).toBe(S.VOIDED);
    expect(mapLegacyState('paid')).toBe(S.PAID);
  });
});

describe('canTransition — EVERY declared canonical transition is valid', () => {
  it('allows every (from → to) listed in UNIFIED_TRANSITIONS and same-state', () => {
    for (const [from, targets] of Object.entries(UNIFIED_TRANSITIONS)) {
      expect(canTransition(from, from)).toBe(true); // idempotent
      for (const to of targets) {
        expect(canTransition(from, to)).toBe(true);
      }
    }
  });

  it('rejects representative illegal transitions', () => {
    expect(canTransition(S.DRAFT, S.PAID)).toBe(false);
    expect(canTransition(S.PENDING_APPROVAL, S.PAID)).toBe(false);
    expect(canTransition(S.PAID, S.APPROVED)).toBe(false);      // terminal
    expect(canTransition(S.VOIDED, S.DRAFT)).toBe(false);       // terminal
    expect(canTransition(S.PARTIALLY_PAID, S.APPROVED)).toBe(false);
  });

  it('paid and voided are terminal (no outgoing transitions)', () => {
    expect(UNIFIED_TRANSITIONS[S.PAID]).toEqual([]);
    expect(UNIFIED_TRANSITIONS[S.VOIDED]).toEqual([]);
  });

  it('canonical happy path: draft → pending_approval → approved → partially_paid → paid', () => {
    expect(canTransition(S.DRAFT, S.PENDING_APPROVAL)).toBe(true);
    expect(canTransition(S.PENDING_APPROVAL, S.APPROVED)).toBe(true);
    expect(canTransition(S.APPROVED, S.PARTIALLY_PAID)).toBe(true);
    expect(canTransition(S.PARTIALLY_PAID, S.PAID)).toBe(true);
  });
});
