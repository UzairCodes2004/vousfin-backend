/**
 * tests/unit/services/invoice.creditLimit.test.js
 *
 * Verifies Phase 2 AR Subledger customer credit limit enforcement.
 */
'use strict';

const mongoose = require('mongoose');

// Mock dependencies
jest.mock('../../../models/Customer.model', () => ({
  findById: jest.fn(),
}));

const invoiceService = require('../../../services/invoice.service');
const Customer = require('../../../models/Customer.model');
const { ApiError } = require('../../../utils/ApiError');

describe('invoiceService.approve() - Credit Limits', () => {
  const invoiceId = new mongoose.Types.ObjectId();
  const customerId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Mock the core load method to return our fake invoice.
    // businessId is required because approve() emits an INVOICE_APPROVED event
    // that stringifies invoice.businessId after the credit-limit check.
    invoiceService._loadOrThrow = jest.fn().mockResolvedValue({
      _id: invoiceId,
      businessId: new mongoose.Types.ObjectId(),
      invoiceNumber: 'INV-CL-1',
      customerId,
      totalAmount: 500,
      approvalLog: [],
      save: jest.fn().mockResolvedValue(true),
    });

    // Mock other side effects to prevent real logic
    invoiceService._applyStateChange = jest.fn().mockResolvedValue(true);
    invoiceService.postArJournal = jest.fn().mockResolvedValue(true);
  });

  it('allows approval if customer has no credit limit', async () => {
    Customer.findById.mockReturnValue({ lean: jest.fn().mockResolvedValue({ creditLimit: null }) });

    await expect(invoiceService.approve(invoiceId, { _id: userId }, 'test', '127.0.0.1')).resolves.toBeDefined();
  });

  it('allows approval if new balance is exactly at credit limit', async () => {
    Customer.findById.mockReturnValue({ lean: jest.fn().mockResolvedValue({ 
      creditLimit: 1000, 
      currentReceivableBalance: 500 
    }) }); // 500 + 500 = 1000

    await expect(invoiceService.approve(invoiceId, { _id: userId }, 'test', '127.0.0.1')).resolves.toBeDefined();
  });

  it('blocks approval and throws ApiError if creditLimitAction is block and limit is exceeded', async () => {
    Customer.findById.mockReturnValue({ lean: jest.fn().mockResolvedValue({ 
      creditLimit: 900, 
      currentReceivableBalance: 500,
      creditLimitAction: 'block'
    }) }); // 500 + 500 = 1000 > 900

    await expect(invoiceService.approve(invoiceId, { _id: userId }, 'test', '127.0.0.1'))
      .rejects.toThrow(ApiError);
      
    await expect(invoiceService.approve(invoiceId, { _id: userId }, 'test', '127.0.0.1'))
      .rejects.toThrow(/exceeds customer credit limit/i);
  });

  it('allows approval and only warns if creditLimitAction is warn and limit is exceeded', async () => {
    Customer.findById.mockReturnValue({ lean: jest.fn().mockResolvedValue({ 
      creditLimit: 900, 
      currentReceivableBalance: 500,
      creditLimitAction: 'warn'
    }) }); // 500 + 500 = 1000 > 900

    await expect(invoiceService.approve(invoiceId, { _id: userId }, 'test', '127.0.0.1')).resolves.toBeDefined();
  });
});
