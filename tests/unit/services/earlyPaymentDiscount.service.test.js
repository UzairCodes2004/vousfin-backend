/**
 * tests/unit/services/earlyPaymentDiscount.service.test.js
 *
 * AR/AP Domain Refactor — Milestone M8 (early-payment discounts).
 * Validates the discount preview, window/idempotency guards, and that the AR
 * path reuses the GL-correct credit-memo posting (no duplicate accounting).
 */
'use strict';

jest.mock('../../../models/ChartOfAccount.model', () => ({ findOne: jest.fn() }));
jest.mock('../../../services/ledgerPosting.service', () => ({ postBalancedJournal: jest.fn() }));
jest.mock('../../../services/partyBalance.service', () => ({ adjustPayable: jest.fn().mockResolvedValue(true), adjustReceivable: jest.fn().mockResolvedValue(true) }));
jest.mock('../../../services/arApVoidCredit.service', () => ({ applyCreditMemo: jest.fn().mockResolvedValue(true) }));
jest.mock('../../../services/audit.service', () => ({ log: jest.fn().mockResolvedValue(true) }));
jest.mock('../../../services/businessEventEngine.service', () => ({
  businessEvents: { emit: jest.fn() },
  EVENTS: { EARLY_PAYMENT_DISCOUNT_APPLIED: 'ar_ap.early_payment_discount' },
}));

const svc = require('../../../services/earlyPaymentDiscount.service');
const arApVoidCredit = require('../../../services/arApVoidCredit.service');
const { businessEvents } = require('../../../services/businessEventEngine.service');

const ISSUE = '2026-01-01';
const inWindow = new Date('2026-01-05');
const pastWindow = new Date('2026-01-20');

const makeInvoice = (over = {}) => ({
  _id: 'i1', businessId: 'b1', invoiceNumber: 'INV-1', customerId: 'c1', state: 'sent',
  issueDate: ISSUE, totalAmount: 1000, remainingBalance: 1000,
  paymentTerms: { code: '2_10_NET_30', label: '2/10 Net 30', netDays: 30, discountPct: 2, discountDays: 10 },
  save: jest.fn().mockResolvedValue(true),
  ...over,
});

beforeEach(() => jest.clearAllMocks());

describe('preview', () => {
  it('reports the discount available inside the window', () => {
    const p = svc.preview('invoice', makeInvoice(), inWindow);
    expect(p.available).toBe(true);
    expect(p.discountAmount).toBe(20);
    expect(p.netDueIfDiscounted).toBe(980);
  });
  it('reports unavailable past the window', () => {
    const p = svc.preview('invoice', makeInvoice(), pastWindow);
    expect(p.available).toBe(false);
    expect(p.reason).toBe('window_passed');
  });
  it('reports no_terms when the document has no terms', () => {
    const p = svc.preview('invoice', makeInvoice({ paymentTerms: {} }), inWindow);
    expect(p.available).toBe(false);
    expect(p.reason).toBe('no_terms');
  });
  it('reports already_taken once a discount has been realized', () => {
    const p = svc.preview('invoice', makeInvoice({ paymentTerms: { code: '2_10_NET_30', discountPct: 2, discountDays: 10, discountTakenAt: new Date() } }), inWindow);
    expect(p.available).toBe(false);
    expect(p.reason).toBe('already_taken');
  });
});

describe('apply (AR — reuses credit-memo path)', () => {
  it('delegates the GL posting to applyCreditMemo and stamps the terms', async () => {
    const inv = makeInvoice();
    await svc.apply('invoice', inv, { _id: 'u1', fullName: 'Bob' }, '127.0.0.1', { asOf: inWindow });
    expect(arApVoidCredit.applyCreditMemo).toHaveBeenCalledWith(
      'invoice', inv, 20, expect.stringContaining('Early-payment discount'), expect.any(Object), '127.0.0.1'
    );
    expect(inv.paymentTerms.discountTakenAt).toBeInstanceOf(Date);
    expect(inv.paymentTerms.discountTakenAmount).toBe(20);
    expect(inv.save).toHaveBeenCalled();
    expect(businessEvents.emit).toHaveBeenCalledWith('ar_ap.early_payment_discount', expect.objectContaining({ amount: 20 }));
  });

  it('rejects when the window has passed', async () => {
    await expect(svc.apply('invoice', makeInvoice(), { _id: 'u1' }, '', { asOf: pastWindow }))
      .rejects.toThrow(/window has passed/);
    expect(arApVoidCredit.applyCreditMemo).not.toHaveBeenCalled();
  });

  it('rejects a second application (idempotent)', async () => {
    const inv = makeInvoice({ paymentTerms: { code: '2_10_NET_30', discountPct: 2, discountDays: 10, discountTakenAt: new Date() } });
    await expect(svc.apply('invoice', inv, { _id: 'u1' }, '', { asOf: inWindow }))
      .rejects.toThrow(/already been taken/);
  });

  it('rejects a paid/voided document', async () => {
    await expect(svc.apply('invoice', makeInvoice({ state: 'paid' }), { _id: 'u1' }, '', { asOf: inWindow }))
      .rejects.toThrow(/Cannot apply/);
  });
});

describe('apply (AP — vendor discount taken to income 4180)', () => {
  const ChartOfAccount = require('../../../models/ChartOfAccount.model');
  const { postBalancedJournal } = require('../../../services/ledgerPosting.service');
  const partyBalance = require('../../../services/partyBalance.service');

  const makeBill = (over = {}) => ({
    _id: 'bl1', businessId: 'b1', billNumber: 'BILL-1', vendorId: 'v1', state: 'approved',
    issueDate: ISSUE, totalAmount: 1000, remainingBalance: 1000,
    paymentTerms: { code: '2_10_NET_30', label: '2/10 Net 30', netDays: 30, discountPct: 2, discountDays: 10 },
    creditMemos: [], constructor: { canTransition: () => true },
    recordStateChange: jest.fn(), save: jest.fn().mockResolvedValue(true),
    ...over,
  });

  it('posts DR AP / CR Discount Received and unwinds the payable', async () => {
    ChartOfAccount.findOne
      .mockReturnValueOnce({ lean: () => Promise.resolve({ _id: 'ap', accountCode: '2110' }) })
      .mockReturnValueOnce({ lean: () => Promise.resolve({ _id: 'disc', accountCode: '4180' }) });
    postBalancedJournal.mockResolvedValue({ _id: 'je1' });

    const bill = makeBill();
    await svc.apply('bill', bill, { _id: 'u1' }, '', { asOf: inWindow });

    expect(postBalancedJournal).toHaveBeenCalledWith(expect.objectContaining({
      amount: 20, debitAccountId: 'ap', creditAccountId: 'disc',
    }));
    expect(partyBalance.adjustPayable).toHaveBeenCalledWith('b1', 'v1', -20, expect.any(Object));
    expect(bill.remainingBalance).toBe(980);
    expect(bill.paymentTerms.discountTakenAmount).toBe(20);
  });
});
