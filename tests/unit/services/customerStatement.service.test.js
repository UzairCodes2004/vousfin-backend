/**
 * tests/unit/services/customerStatement.service.test.js
 *
 * AR/AP Domain Refactor — Milestone M8 (customer statements).
 * Validates the pure running-ledger assembly and the aging bucket classifier.
 */
'use strict';

jest.mock('../../../models/Invoice.model', () => ({ find: jest.fn() }));
jest.mock('../../../models/Payment.model', () => ({ find: jest.fn() }));
jest.mock('../../../models/Customer.model', () => ({ findOne: jest.fn() }));
jest.mock('../../../services/businessEventEngine.service', () => ({
  businessEvents: { emit: jest.fn() },
  EVENTS: { CUSTOMER_STATEMENT_GENERATED: 'customer.statement_generated' },
}));

const svc = require('../../../services/customerStatement.service');

describe('buildLedger (pure running balance)', () => {
  it('applies charges and credits in date order with a running balance', () => {
    const { lines, closingBalance, totalCharges, totalCredits } = svc.buildLedger(100, [
      { date: '2026-02-10', type: 'payment', charge: 0, credit: 50 },
      { date: '2026-02-01', type: 'invoice', charge: 200, credit: 0 },
    ]);
    // sorted: invoice (Feb 1) then payment (Feb 10)
    expect(lines[0].balance).toBe(300); // 100 + 200
    expect(lines[1].balance).toBe(250); // 300 - 50
    expect(closingBalance).toBe(250);
    expect(totalCharges).toBe(200);
    expect(totalCredits).toBe(50);
  });

  it('handles an empty period (opening = closing)', () => {
    const { lines, closingBalance } = svc.buildLedger(420, []);
    expect(lines).toHaveLength(0);
    expect(closingBalance).toBe(420);
  });
});

describe('_bucketOf', () => {
  const asOf = new Date('2026-03-01');
  it('classifies open balances by days overdue', () => {
    expect(svc._bucketOf(null, asOf)).toBe('current');
    expect(svc._bucketOf(new Date('2026-03-15'), asOf)).toBe('current'); // not due
    expect(svc._bucketOf(new Date('2026-02-20'), asOf)).toBe('1-30');
    expect(svc._bucketOf(new Date('2026-01-20'), asOf)).toBe('31-60');
    expect(svc._bucketOf(new Date('2025-12-20'), asOf)).toBe('61-90');
    expect(svc._bucketOf(new Date('2025-10-01'), asOf)).toBe('90+');
  });
});

describe('getStatement (integration of sources)', () => {
  const Invoice = require('../../../models/Invoice.model');
  const Payment = require('../../../models/Payment.model');
  const Customer = require('../../../models/Customer.model');
  const BIZ = '507f1f77bcf86cd799439060';
  const CUST = '507f1f77bcf86cd799439061';

  const chain = (val) => ({ select: () => ({ lean: () => Promise.resolve(val) }) });

  it('reconstructs opening balance + window activity + aging', async () => {
    Customer.findOne.mockReturnValue(chain({ _id: CUST, fullName: 'Acme', businessName: 'Acme Co', currentReceivableBalance: 150 }));
    Invoice.find.mockReturnValue(chain([
      // before window → contributes to opening
      { invoiceNumber: 'INV-0', issueDate: new Date('2025-12-01'), dueDate: new Date('2025-12-31'), totalAmount: 100, remainingBalance: 0, state: 'paid', creditMemos: [] },
      // inside window → a charge + still open for aging
      { invoiceNumber: 'INV-1', issueDate: new Date('2026-01-10'), dueDate: new Date('2026-02-09'), totalAmount: 200, remainingBalance: 150, state: 'partially_paid', creditMemos: [] },
    ]));
    Payment.find.mockReturnValue(chain([
      { paymentNumber: 'PAY-0', paymentDate: new Date('2025-12-15'), amount: 100 }, // before window
      { paymentNumber: 'PAY-1', paymentDate: new Date('2026-01-20'), amount: 50 },  // in window
    ]));

    const st = await svc.getStatement(BIZ, CUST, { from: new Date('2026-01-01'), to: new Date('2026-02-01') });
    // opening = 100 (INV-0) - 100 (PAY-0 before window) = 0
    expect(st.openingBalance).toBe(0);
    // window: +200 charge, -50 credit → closing = 150
    expect(st.totalCharges).toBe(200);
    expect(st.totalCredits).toBe(50);
    expect(st.closingBalance).toBe(150);
    expect(st.aging.total).toBe(150);
  });
});
