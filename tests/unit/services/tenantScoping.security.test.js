/**
 * tests/unit/services/tenantScoping.security.test.js
 *
 * R-05 regression guard. The lifecycle loaders (_loadOrThrow) must scope by
 * businessId when the caller supplies one, so a user from business A can never
 * load/mutate business B's document by passing a foreign id. The controllers
 * now always pass req.user.businessId, so the scoped path is what runs in prod.
 */
'use strict';

jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../../models/Invoice.model', () => ({ findOne: jest.fn(), findById: jest.fn() }));
jest.mock('../../../models/Bill.model',    () => ({ findOne: jest.fn(), findById: jest.fn() }));

const invoiceService = require('../../../services/invoice.service');
const billService    = require('../../../services/bill.service');
const Invoice = require('../../../models/Invoice.model');
const Bill    = require('../../../models/Bill.model');

const ID  = '507f1f77bcf86cd799439011';
const BIZ = '507f1f77bcf86cd799439060';

beforeEach(() => jest.clearAllMocks());

describe('invoice _loadOrThrow tenant scoping', () => {
  it('queries with businessId when supplied (no cross-tenant load)', async () => {
    Invoice.findOne.mockResolvedValue({ _id: ID, isArchived: false });
    await invoiceService._loadOrThrow(ID, BIZ);
    expect(Invoice.findOne).toHaveBeenCalledWith({ _id: ID, businessId: BIZ });
    expect(Invoice.findById).not.toHaveBeenCalled();
  });

  it('throws 404 when the id belongs to another tenant (scoped query misses)', async () => {
    Invoice.findOne.mockResolvedValue(null); // foreign-tenant invoice not visible
    await expect(invoiceService._loadOrThrow(ID, BIZ)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('bill _loadOrThrow tenant scoping', () => {
  it('queries with businessId when supplied', async () => {
    Bill.findOne.mockResolvedValue({ _id: ID, isArchived: false });
    await billService._loadOrThrow(ID, BIZ);
    expect(Bill.findOne).toHaveBeenCalledWith({ _id: ID, businessId: BIZ });
    expect(Bill.findById).not.toHaveBeenCalled();
  });
});
