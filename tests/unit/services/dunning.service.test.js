/**
 * tests/unit/services/dunning.service.test.js
 *
 * AR/AP Domain Refactor — Milestone M8 (dunning / collections).
 * Validates the pure ladder resolution, days-overdue math, and the idempotent
 * per-invoice escalation (no ledger mutation, no downgrade, no repeat).
 */
'use strict';

jest.mock('../../../models/Invoice.model', () => ({ find: jest.fn(), aggregate: jest.fn() }));
jest.mock('../../../services/audit.service', () => ({ log: jest.fn().mockResolvedValue(true) }));
jest.mock('../../../services/businessEventEngine.service', () => ({
  businessEvents: { emit: jest.fn() },
  EVENTS: { DUNNING_ESCALATED: 'dunning.escalated' },
}));

const dunning = require('../../../services/dunning.service');
const { businessEvents } = require('../../../services/businessEventEngine.service');

const daysAgo = (n) => new Date(Date.now() - n * 86400000);

beforeEach(() => jest.clearAllMocks());

describe('resolveLevel (pure ladder)', () => {
  it('returns NONE below the first threshold', () => {
    expect(dunning.resolveLevel(0).key).toBe('none');
  });
  it('climbs the ladder with age', () => {
    expect(dunning.resolveLevel(1).key).toBe('reminder');
    expect(dunning.resolveLevel(14).key).toBe('reminder');
    expect(dunning.resolveLevel(15).key).toBe('first_notice');
    expect(dunning.resolveLevel(30).key).toBe('second_notice');
    expect(dunning.resolveLevel(45).key).toBe('final_notice');
    expect(dunning.resolveLevel(60).key).toBe('collections');
    expect(dunning.resolveLevel(999).key).toBe('collections');
  });
});

describe('daysOverdue', () => {
  it('is 0 when not yet due or no due date', () => {
    expect(dunning.daysOverdue(null)).toBe(0);
    expect(dunning.daysOverdue(new Date(Date.now() + 5 * 86400000))).toBe(0);
  });
  it('counts whole days past due', () => {
    expect(dunning.daysOverdue(daysAgo(20))).toBe(20);
  });
});

describe('escalateInvoice (idempotent)', () => {
  const makeInvoice = (dunningLevel, dueDate) => ({
    _id: 'i1', businessId: 'b1', invoiceNumber: 'INV-1', createdBy: 'u1',
    dunningLevel, dueDate, dunningHistory: [],
    save: jest.fn().mockResolvedValue(true),
  });

  it('escalates an overdue invoice and records history + event', async () => {
    const inv = makeInvoice(0, daysAgo(20)); // 20d → first_notice (level 2)
    const lvl = await dunning.escalateInvoice(inv);
    expect(lvl.key).toBe('first_notice');
    expect(inv.dunningLevel).toBe(2);
    expect(inv.dunningHistory).toHaveLength(1);
    expect(inv.save).toHaveBeenCalled();
    expect(businessEvents.emit).toHaveBeenCalledWith('dunning.escalated', expect.objectContaining({ level: 2 }));
  });

  it('is a no-op when already at or above the warranted level (idempotent)', async () => {
    const inv = makeInvoice(2, daysAgo(20)); // already first_notice
    const lvl = await dunning.escalateInvoice(inv);
    expect(lvl).toBeNull();
    expect(inv.save).not.toHaveBeenCalled();
    expect(businessEvents.emit).not.toHaveBeenCalled();
  });

  it('never downgrades a higher current level', async () => {
    const inv = makeInvoice(5, daysAgo(5)); // 5d would be reminder, but already collections
    const lvl = await dunning.escalateInvoice(inv);
    expect(lvl).toBeNull();
    expect(inv.dunningLevel).toBe(5);
  });
});

describe('runEscalation', () => {
  it('scans overdue invoices and tallies escalations', async () => {
    const Invoice = require('../../../models/Invoice.model');
    const invoices = [
      { _id: 'a', businessId: 'b1', invoiceNumber: 'A', createdBy: 'u', dunningLevel: 0, dueDate: daysAgo(50), dunningHistory: [], save: jest.fn().mockResolvedValue(true) },
      { _id: 'b', businessId: 'b1', invoiceNumber: 'B', createdBy: 'u', dunningLevel: 3, dueDate: daysAgo(31), dunningHistory: [], save: jest.fn().mockResolvedValue(true) }, // already 2nd notice, 31d → no change
    ];
    Invoice.find.mockResolvedValue(invoices);
    const stats = await dunning.runEscalation();
    expect(stats.scanned).toBe(2);
    expect(stats.escalated).toBe(1);
    expect(stats.byLevel.final_notice).toBe(1);
  });
});
