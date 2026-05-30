/**
 * tests/unit/utils/paymentTerms.test.js
 *
 * AR/AP Domain Refactor — Milestone M8 (payment terms + early-pay discounts).
 * Pure engine: dueDate derivation, discount window, discount amount, preview.
 */
'use strict';

const pt = require('../../../utils/paymentTerms');

const ISSUE = '2026-01-01';

describe('resolveTerms', () => {
  it('resolves a known code', () => {
    const t = pt.resolveTerms('2_10_NET_30');
    expect(t.netDays).toBe(30);
    expect(t.discountPct).toBe(2);
    expect(t.discountDays).toBe(10);
  });
  it('falls back to NET_30 for unknown codes', () => {
    expect(pt.resolveTerms('NOPE').netDays).toBe(30);
    expect(pt.resolveTerms(null).netDays).toBe(30);
  });
  it('accepts a custom terms object and sanitizes negatives', () => {
    const t = pt.resolveTerms({ netDays: -5, discountPct: -1, discountDays: 3.9 });
    expect(t.netDays).toBe(0);
    expect(t.discountPct).toBe(0);
    expect(t.discountDays).toBe(3);
  });
});

describe('computeDueDate', () => {
  it('adds netDays to the issue date', () => {
    expect(pt.computeDueDate(ISSUE, 'NET_30').toISOString().slice(0, 10)).toBe('2026-01-31');
    expect(pt.computeDueDate(ISSUE, 'NET_7').toISOString().slice(0, 10)).toBe('2026-01-08');
    expect(pt.computeDueDate(ISSUE, 'DUE_ON_RECEIPT').toISOString().slice(0, 10)).toBe('2026-01-01');
  });
});

describe('discount window + amount', () => {
  it('is available within the discount days', () => {
    expect(pt.isDiscountAvailable(ISSUE, '2_10_NET_30', new Date('2026-01-05'))).toBe(true);
    expect(pt.isDiscountAvailable(ISSUE, '2_10_NET_30', new Date('2026-01-11'))).toBe(true);  // boundary
    expect(pt.isDiscountAvailable(ISSUE, '2_10_NET_30', new Date('2026-01-12'))).toBe(false); // past
  });
  it('computes the discount only inside the window', () => {
    expect(pt.computeDiscount(1000, ISSUE, '2_10_NET_30', new Date('2026-01-05'))).toBe(20);
    expect(pt.computeDiscount(1000, ISSUE, '2_10_NET_30', new Date('2026-01-20'))).toBe(0);
  });
  it('returns 0 for terms with no discount', () => {
    expect(pt.computeDiscount(1000, ISSUE, 'NET_30', new Date('2026-01-02'))).toBe(0);
  });
  it('never exceeds the outstanding balance and ignores non-positive balances', () => {
    expect(pt.computeDiscount(0, ISSUE, '2_10_NET_30', new Date('2026-01-02'))).toBe(0);
    expect(pt.computeDiscount(-50, ISSUE, '2_10_NET_30', new Date('2026-01-02'))).toBe(0);
  });
});

describe('settlementPreview', () => {
  it('summarizes discount + net due + overdue flag', () => {
    const p = pt.settlementPreview(1000, ISSUE, '2_10_NET_30', new Date('2026-01-05'));
    expect(p.discountAvailable).toBe(true);
    expect(p.discountAmount).toBe(20);
    expect(p.netDueIfDiscounted).toBe(980);
    expect(p.isOverdue).toBe(false);
  });
  it('flags overdue past the due date', () => {
    const p = pt.settlementPreview(1000, ISSUE, 'NET_30', new Date('2026-03-01'));
    expect(p.isOverdue).toBe(true);
    expect(p.daysUntilDue).toBeLessThan(0);
  });
});

describe('buildSnapshot', () => {
  it('produces an immutable, storable snapshot', () => {
    const s = pt.buildSnapshot('1_10_NET_30');
    expect(s).toEqual(expect.objectContaining({
      code: '1_10_NET_30', netDays: 30, discountPct: 1, discountDays: 10,
    }));
  });
});
