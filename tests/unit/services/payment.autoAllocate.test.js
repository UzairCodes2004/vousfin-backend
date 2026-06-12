/**
 * tests/unit/services/payment.autoAllocate.test.js
 *
 * Verifies the Phase 2 AR Subledger auto-allocation engine.
 */
'use strict';

const mongoose = require('mongoose');

jest.mock('../../../models/Invoice.model', () => ({
  find: jest.fn(),
}));

// We only mock what we need from paymentService
const paymentService = require('../../../services/payment.service');
const Invoice = require('../../../models/Invoice.model');
const { ApiError } = require('../../../utils/ApiError');

describe('paymentService.autoAllocatePayment()', () => {
  const businessId = new mongoose.Types.ObjectId();
  const partyId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Mock the core recordPayment so we don't actually hit the DB for transactions
    paymentService.recordPayment = jest.fn().mockResolvedValue({ _id: 'payment-1' });
  });

  it('throws an error if payment amount is zero or negative', async () => {
    await expect(
      paymentService.autoAllocatePayment(businessId, 'customer', partyId, { amount: 0 }, userId, '127.0.0.1')
    ).rejects.toThrow(ApiError);
  });

  it('throws an error if there are no open invoices', async () => {
    const mockFind = {
      sort: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) })
    };
    Invoice.find.mockReturnValue(mockFind);

    await expect(
      paymentService.autoAllocatePayment(businessId, 'customer', partyId, { amount: 100 }, userId, '127.0.0.1')
    ).rejects.toThrow(/No open documents found/i);
  });

  it('allocates the payment across multiple invoices oldest first', async () => {
    const invoices = [
      { _id: 'inv-1', remainingBalance: 50 },
      { _id: 'inv-2', remainingBalance: 100 },
      { _id: 'inv-3', remainingBalance: 75 }
    ];

    const mockFind = {
      sort: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(invoices) })
    };
    Invoice.find.mockReturnValue(mockFind);

    const paymentData = { amount: 120, cashAccountId: new mongoose.Types.ObjectId() };
    await paymentService.autoAllocatePayment(businessId, 'customer', partyId, paymentData, userId, '127.0.0.1');

    expect(paymentService.recordPayment).toHaveBeenCalledTimes(1);
    const calledData = paymentService.recordPayment.mock.calls[0][1];
    
    expect(calledData.allocations).toHaveLength(2);
    expect(calledData.allocations[0]).toEqual({ documentType: 'invoice', documentId: 'inv-1', amount: 50 });
    expect(calledData.allocations[1]).toEqual({ documentType: 'invoice', documentId: 'inv-2', amount: 70 });
  });

  it('allocates perfectly and stops when amount is exhausted', async () => {
    const invoices = [
      { _id: 'inv-1', remainingBalance: 50 },
      { _id: 'inv-2', remainingBalance: 50 }
    ];

    const mockFind = {
      sort: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(invoices) })
    };
    Invoice.find.mockReturnValue(mockFind);

    const paymentData = { amount: 50, cashAccountId: new mongoose.Types.ObjectId() };
    await paymentService.autoAllocatePayment(businessId, 'customer', partyId, paymentData, userId, '127.0.0.1');

    const calledData = paymentService.recordPayment.mock.calls[0][1];
    expect(calledData.allocations).toHaveLength(1);
    expect(calledData.allocations[0]).toEqual({ documentType: 'invoice', documentId: 'inv-1', amount: 50 });
  });
});
