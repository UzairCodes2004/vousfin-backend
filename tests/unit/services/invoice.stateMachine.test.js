// tests/unit/services/invoice.stateMachine.test.js
//
// Phase 1 — Pure state-machine tests for Invoice + Bill canTransition() statics.
// No DB / mocks needed — these are deterministic table-driven checks.
//
const Invoice = require('../../../models/Invoice.model');
const Bill    = require('../../../models/Bill.model');
const {
  INVOICE_STATES,
  BILL_STATES,
} = require('../../../config/constants');

describe('Invoice.canTransition() — state machine', () => {
  test('draft can move to pending_approval, approved, cancelled', () => {
    expect(Invoice.canTransition('draft', 'pending_approval')).toBe(true);
    expect(Invoice.canTransition('draft', 'approved')).toBe(true);
    expect(Invoice.canTransition('draft', 'cancelled')).toBe(true);
  });

  test('draft cannot jump to paid or sent directly', () => {
    expect(Invoice.canTransition('draft', 'paid')).toBe(false);
    expect(Invoice.canTransition('draft', 'sent')).toBe(false);
    expect(Invoice.canTransition('draft', 'written_off')).toBe(false);
  });

  test('approved can move to sent, partially_paid, paid, overdue, disputed, cancelled', () => {
    for (const s of ['sent', 'partially_paid', 'paid', 'overdue', 'disputed', 'cancelled']) {
      expect(Invoice.canTransition('approved', s)).toBe(true);
    }
  });

  test('paid is terminal', () => {
    expect(Invoice.canTransition('paid', 'sent')).toBe(false);
    expect(Invoice.canTransition('paid', 'draft')).toBe(false);
    expect(Invoice.canTransition('paid', 'cancelled')).toBe(false);
  });

  test('cancelled is terminal', () => {
    expect(Invoice.canTransition('cancelled', 'draft')).toBe(false);
    expect(Invoice.canTransition('cancelled', 'approved')).toBe(false);
  });

  test('written_off is terminal', () => {
    expect(Invoice.canTransition('written_off', 'paid')).toBe(false);
  });

  test('same-state transition is allowed (idempotent no-op)', () => {
    for (const s of Object.values(INVOICE_STATES)) {
      expect(Invoice.canTransition(s, s)).toBe(true);
    }
  });

  test('disputed can recover to approved, sent, paid, written_off, cancelled', () => {
    for (const s of ['approved', 'sent', 'partially_paid', 'paid', 'written_off', 'cancelled']) {
      expect(Invoice.canTransition('disputed', s)).toBe(true);
    }
  });

  test('unknown source state returns false', () => {
    expect(Invoice.canTransition('xyz_unknown', 'draft')).toBe(false);
    expect(Invoice.canTransition(null, 'draft')).toBe(false);
  });
});

describe('Bill.canTransition() — state machine', () => {
  test('draft can move to awaiting_approval, approved, cancelled', () => {
    expect(Bill.canTransition('draft', 'awaiting_approval')).toBe(true);
    expect(Bill.canTransition('draft', 'approved')).toBe(true);
    expect(Bill.canTransition('draft', 'cancelled')).toBe(true);
  });

  test('draft cannot jump to scheduled or paid directly', () => {
    expect(Bill.canTransition('draft', 'scheduled')).toBe(false);
    expect(Bill.canTransition('draft', 'paid')).toBe(false);
  });

  test('approved → scheduled, partially_paid, paid, cancelled, overdue allowed', () => {
    for (const s of ['scheduled', 'partially_paid', 'paid', 'cancelled', 'overdue']) {
      expect(Bill.canTransition('approved', s)).toBe(true);
    }
  });

  test('paid and cancelled are terminal', () => {
    expect(Bill.canTransition('paid', 'draft')).toBe(false);
    expect(Bill.canTransition('paid', 'overdue')).toBe(false);
    expect(Bill.canTransition('cancelled', 'draft')).toBe(false);
  });

  test('same-state transition is allowed', () => {
    for (const s of Object.values(BILL_STATES)) {
      expect(Bill.canTransition(s, s)).toBe(true);
    }
  });

  test('scheduled can go to partially_paid, paid, overdue, cancelled', () => {
    for (const s of ['partially_paid', 'paid', 'overdue', 'cancelled']) {
      expect(Bill.canTransition('scheduled', s)).toBe(true);
    }
  });
});
