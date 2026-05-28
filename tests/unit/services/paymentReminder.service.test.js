// tests/unit/services/paymentReminder.service.test.js
//
// Phase 2.1 — Tests for the customer payment reminder service.
// Covers cadence picking, idempotency, and the per-business scan.
//

const mongoose = require('mongoose');

// ── Shared mock stores via global to satisfy Jest scoping ─────────────────────
global.__mockInvoiceStore = new Map();
global.__mockSentEmails = [];

jest.mock('../../../models/Invoice.model', () => {
  function makeDoc(props) {
    return {
      ...props,
      reminderHistory: props.reminderHistory || [],
      async save() {
        global.__mockInvoiceStore.set(String(this._id), this);
        return this;
      },
    };
  }
  const Invoice = function (props) { return makeDoc(props); };
  Invoice.find = jest.fn(async () => Array.from(global.__mockInvoiceStore.values()));
  Invoice.findById = jest.fn(async (id) => global.__mockInvoiceStore.get(String(id)) || null);
  return Invoice;
});

jest.mock('../../../models/Business.model', () => ({
  find: jest.fn(() => ({
    select: jest.fn(() => ({
      lean: jest.fn().mockResolvedValue([
        { _id: 'biz1', businessName: 'Test Biz', email: 'biz@test.com', phone: '+92123' },
      ]),
    })),
  })),
}));

jest.mock('../../../models/Customer.model', () => ({
  findById: jest.fn(() => ({
    select: jest.fn(() => ({ lean: jest.fn().mockResolvedValue(null) })),
  })),
}));

jest.mock('../../../utils/email.utils', () => ({
  sendCustomerPaymentReminderEmail: jest.fn(async (opts) => {
    global.__mockSentEmails.push(opts);
  }),
}));

const paymentReminderService = require('../../../services/paymentReminder.service');
const { CADENCES } = require('../../../services/paymentReminder.service');

beforeEach(() => {
  global.__mockInvoiceStore.clear();
  global.__mockSentEmails.length = 0;
  jest.clearAllMocks();
});

function seedInvoice(props) {
  const id = new mongoose.Types.ObjectId();
  const inv = {
    _id: id,
    invoiceNumber: props.invoiceNumber || 'INV-001',
    businessId: 'biz1',
    customerSnapshot: { email: 'cust@test.com', fullName: 'Test Customer' },
    customerId: null,
    state: props.state || 'sent',
    isArchived: false,
    totalAmount: 1000,
    remainingBalance: props.remainingBalance != null ? props.remainingBalance : 1000,
    currencyCode: 'PKR',
    dueDate: props.dueDate,
    reminderHistory: props.reminderHistory || [],
    async save() { global.__mockInvoiceStore.set(String(this._id), this); return this; },
  };
  global.__mockInvoiceStore.set(String(id), inv);
  return inv;
}

// ═════════════════════════════════════════════════════════════════════════════

describe('PaymentReminderService — pickCadence', () => {
  test('returns null when no dueDate', () => {
    expect(paymentReminderService.pickCadence(new Date(), null)).toBeNull();
  });

  test('matches T-3 (due in 3 days)', () => {
    const today = new Date('2026-05-28');
    const due = new Date('2026-05-31');
    expect(paymentReminderService.pickCadence(today, due)?.key).toBe('due_in_3');
  });

  test('matches T+0 (due today)', () => {
    const today = new Date('2026-05-28');
    expect(paymentReminderService.pickCadence(today, today)?.key).toBe('due_today');
  });

  test('matches T+7 (overdue 7 days)', () => {
    const today = new Date('2026-05-28');
    const due = new Date('2026-05-21');
    expect(paymentReminderService.pickCadence(today, due)?.key).toBe('overdue_7');
  });

  test('matches T+30 (final notice)', () => {
    const today = new Date('2026-05-28');
    const due = new Date('2026-04-28');
    expect(paymentReminderService.pickCadence(today, due)?.key).toBe('overdue_30');
  });

  test('no match for non-cadence days (e.g. T-1 or T+5)', () => {
    const today = new Date('2026-05-28');
    expect(paymentReminderService.pickCadence(today, new Date('2026-05-29'))).toBeNull();
    expect(paymentReminderService.pickCadence(today, new Date('2026-05-23'))).toBeNull();
  });

  test('exposes 5 cadences total', () => {
    expect(CADENCES.length).toBe(5);
  });
});

describe('PaymentReminderService — scanBusiness', () => {
  const business = { _id: 'biz1', businessName: 'Test Biz', email: 'biz@test.com' };

  test('fires reminder for invoice due today', async () => {
    const today = new Date('2026-05-28');
    seedInvoice({ dueDate: today });

    const stats = await paymentReminderService.scanBusiness(business, today);
    expect(stats.fired).toBe(1);
    expect(global.__mockSentEmails.length).toBe(1);
    expect(global.__mockSentEmails[0].cadenceLabel).toBe('Payment due today');
  });

  test('records firedAt entry so it does not re-send', async () => {
    const today = new Date('2026-05-28');
    const inv = seedInvoice({ dueDate: today });

    await paymentReminderService.scanBusiness(business, today);
    expect(inv.reminderHistory.length).toBe(1);
    expect(inv.reminderHistory[0].cadenceKey).toBe('due_today');

    // Re-run on the same day — must not re-fire
    global.__mockSentEmails.length = 0;
    const stats2 = await paymentReminderService.scanBusiness(business, today);
    expect(stats2.fired).toBe(0);
    expect(stats2.skipped).toBe(1);
    expect(global.__mockSentEmails.length).toBe(0);
  });

  test('skips paid invoices (remainingBalance = 0)', async () => {
    const today = new Date('2026-05-28');
    // Invoice.find mock returns ALL store entries, so we need to filter manually here
    // because the real service relies on Mongo query filters
    seedInvoice({ dueDate: today, remainingBalance: 0 });

    // For this test we need our find mock to honour the filter
    const Invoice = require('../../../models/Invoice.model');
    Invoice.find.mockImplementationOnce(async () =>
      Array.from(global.__mockInvoiceStore.values()).filter(i => i.remainingBalance > 0)
    );

    const stats = await paymentReminderService.scanBusiness(business, today);
    expect(stats.fired).toBe(0);
  });

  test('skips invoices without a customer email', async () => {
    const today = new Date('2026-05-28');
    const inv = seedInvoice({ dueDate: today });
    inv.customerSnapshot = {}; // strip email

    const stats = await paymentReminderService.scanBusiness(business, today);
    expect(stats.fired).toBe(0);
    expect(stats.skipped).toBe(1);
  });

  test('different cadences for different invoices in one pass', async () => {
    const today = new Date('2026-05-28');
    seedInvoice({ invoiceNumber: 'A', dueDate: new Date('2026-05-31') }); // T-3
    seedInvoice({ invoiceNumber: 'B', dueDate: new Date('2026-05-28') }); // T+0
    seedInvoice({ invoiceNumber: 'C', dueDate: new Date('2026-05-21') }); // T+7
    seedInvoice({ invoiceNumber: 'D', dueDate: new Date('2026-05-25') }); // not a cadence

    const stats = await paymentReminderService.scanBusiness(business, today);
    expect(stats.fired).toBe(3);
    expect(stats.skipped).toBe(1);
    const keys = global.__mockSentEmails.map(e => e.invoiceNumber).sort();
    expect(keys).toEqual(['A', 'B', 'C']);
  });

  test('escalates tone for later cadences', async () => {
    const today = new Date('2026-05-28');
    seedInvoice({ invoiceNumber: 'X', dueDate: new Date('2026-04-28') }); // T+30

    await paymentReminderService.scanBusiness(business, today);
    expect(global.__mockSentEmails[0].tone).toBe('final_notice');
  });
});
