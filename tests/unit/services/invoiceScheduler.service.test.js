/**
 * tests/unit/services/invoiceScheduler.service.test.js
 *
 * AR/AP Domain Refactor — Milestone M8 (recurring invoices).
 * Validates recurrence-date math and that due schedules generate invoices and
 * advance nextRunDate idempotently.
 */
'use strict';

jest.mock('../../../models/InvoiceSchedule.model', () => ({ find: jest.fn(), findByIdAndUpdate: jest.fn() }));
jest.mock('../../../models/Invoice.model', () => ({ create: jest.fn() }));
jest.mock('../../../models/Customer.model', () => ({ findById: jest.fn() }));
jest.mock('../../../services/audit.service', () => ({ log: jest.fn().mockResolvedValue(true) }));
jest.mock('../../../services/businessEventEngine.service', () => ({
  businessEvents: { emit: jest.fn() },
  EVENTS: { RECURRING_INVOICE_GENERATED: 'invoice.recurring_generated' },
}));

const scheduler = require('../../../services/invoiceScheduler.service');
const InvoiceSchedule = require('../../../models/InvoiceSchedule.model');
const Invoice = require('../../../models/Invoice.model');
const { businessEvents } = require('../../../services/businessEventEngine.service');

beforeEach(() => jest.clearAllMocks());

describe('computeNextRunDate', () => {
  const from = new Date('2026-01-15T00:00:00Z');
  it('advances by each pattern', () => {
    expect(scheduler.computeNextRunDate('weekly', from).toISOString().slice(0, 10)).toBe('2026-01-22');
    expect(scheduler.computeNextRunDate('biweekly', from).toISOString().slice(0, 10)).toBe('2026-01-29');
    expect(scheduler.computeNextRunDate('monthly', from).toISOString().slice(0, 10)).toBe('2026-02-15');
    expect(scheduler.computeNextRunDate('quarterly', from).toISOString().slice(0, 10)).toBe('2026-04-15');
    expect(scheduler.computeNextRunDate('annual', from).toISOString().slice(0, 10)).toBe('2027-01-15');
  });
  it('throws on an unknown pattern', () => {
    expect(() => scheduler.computeNextRunDate('hourly', from)).toThrow();
  });
});

describe('generateDueInvoices', () => {
  it('generates an invoice per due schedule, advances nextRunDate, emits event', async () => {
    const sched = {
      _id: 's1', businessId: 'b1', customerId: null, name: 'Monthly retainer',
      recurrencePattern: 'monthly', nextRunDate: new Date('2026-01-01'),
      lineItems: [{ name: 'Retainer', quantity: 1, unitPrice: 500 }],
      currencyCode: 'PKR', paymentTermsCode: 'NET_30', invoicePrefix: 'REC',
      autoSubmit: false, createdBy: 'u1',
    };
    InvoiceSchedule.find.mockReturnValue({ lean: () => Promise.resolve([sched]) });
    Invoice.create.mockResolvedValue({ _id: 'inv1', invoiceNumber: 'REC-20260101-000001' });
    InvoiceSchedule.findByIdAndUpdate.mockResolvedValue(true);

    const ids = await scheduler.generateDueInvoices();
    expect(ids).toEqual(['inv1']);
    expect(Invoice.create).toHaveBeenCalledTimes(1);
    const created = Invoice.create.mock.calls[0][0];
    expect(created.isRecurring).toBe(true);
    expect(created.recurringScheduleId).toBe('s1');
    expect(created.paymentTerms.code).toBe('NET_30');
    expect(InvoiceSchedule.findByIdAndUpdate).toHaveBeenCalledWith('s1', expect.objectContaining({
      $inc: { runCount: 1 },
    }));
    expect(businessEvents.emit).toHaveBeenCalledWith('invoice.recurring_generated', expect.any(Object));
  });

  it('continues past a failing schedule without aborting the batch', async () => {
    InvoiceSchedule.find.mockReturnValue({ lean: () => Promise.resolve([
      { _id: 'bad', businessId: 'b1', recurrencePattern: 'monthly', nextRunDate: new Date(), lineItems: [], createdBy: 'u' },
      { _id: 'good', businessId: 'b1', recurrencePattern: 'monthly', nextRunDate: new Date(), lineItems: [{ name: 'X', quantity: 1, unitPrice: 10 }], createdBy: 'u', invoicePrefix: 'REC' },
    ]) });
    Invoice.create
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ _id: 'g1', invoiceNumber: 'REC-x' });
    InvoiceSchedule.findByIdAndUpdate.mockResolvedValue(true);

    const ids = await scheduler.generateDueInvoices();
    expect(ids).toEqual(['g1']);
  });
});
