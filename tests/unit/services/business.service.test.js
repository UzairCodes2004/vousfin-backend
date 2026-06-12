/**
 * tests/unit/services/business.service.test.js
 *
 * Covers the destructive maintenance flows added for Settings:
 *   • resetBusinessData — wipes every business-scoped collection then re-seeds
 *     a fresh default chart of accounts, keeping the business profile.
 *   • deleteBusiness   — wipes everything, deletes the business, unlinks the user.
 *
 * The wipe walks mongoose.modelNames() and deletes from any model whose schema
 * has a `businessId` path (except Business/User). We mock mongoose so we can
 * assert exactly which collections are cleared without a live DB.
 */
'use strict';

// fs.readdirSync is used by ensureAllModelsRegistered — return nothing so the
// service doesn't try to require real model files against the mocked mongoose.
jest.mock('fs', () => ({ readdirSync: jest.fn(() => []) }));

const mockMakeModel = (hasBusinessId) => ({
  schema: { path: (p) => (p === 'businessId' && hasBusinessId ? {} : undefined) },
  // The wipe uses the native driver (collection.deleteMany) to bypass delete
  // middleware (audit immutability / period locks) for a deliberate purge.
  collection: { deleteMany: jest.fn().mockResolvedValue({ deletedCount: 3 }) },
});

const mockModels = {
  Business:     mockMakeModel(true),   // must be skipped
  User:         mockMakeModel(true),   // must be skipped
  JournalEntry: mockMakeModel(true),
  Customer:     mockMakeModel(true),
  CurrencyRate: mockMakeModel(false),  // no businessId path → skipped
};

jest.mock('mongoose', () => ({
  modelNames: () => Object.keys(mockModels),
  model: (name) => mockModels[name],
  Types: { ObjectId: function (v) { return v; } },
}));

jest.mock('../../../repositories/business.repository', () => ({
  findById: jest.fn(),
  delete:   jest.fn().mockResolvedValue(true),
}));
jest.mock('../../../repositories/account.repository', () => ({
  bulkCreateDefaultAccounts: jest.fn().mockResolvedValue(true),
}));
jest.mock('../../../repositories/user.repository', () => ({
  update: jest.fn().mockResolvedValue(true),
}));
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const businessService   = require('../../../services/business.service');
const businessRepository = require('../../../repositories/business.repository');
const accountRepository  = require('../../../repositories/account.repository');
const userRepository     = require('../../../repositories/user.repository');

const BIZ = '507f1f77bcf86cd799439060';
const USR = '507f1f77bcf86cd799439061';
const business = { _id: BIZ, businessName: 'Code Hub', userId: USR };

beforeEach(() => {
  jest.clearAllMocks();
  businessRepository.findById.mockResolvedValue(business);
});

describe('resetBusinessData()', () => {
  it('wipes business-scoped collections, skips Business/User and non-scoped models, then reseeds COA', async () => {
    const res = await businessService.resetBusinessData(BIZ, USR);

    // Scoped collections cleared (native driver, businessId cast to ObjectId)
    expect(mockModels.JournalEntry.collection.deleteMany).toHaveBeenCalled();
    expect(mockModels.Customer.collection.deleteMany).toHaveBeenCalled();

    // Skipped: the business + user docs, and a model without businessId
    expect(mockModels.Business.collection.deleteMany).not.toHaveBeenCalled();
    expect(mockModels.User.collection.deleteMany).not.toHaveBeenCalled();
    expect(mockModels.CurrencyRate.collection.deleteMany).not.toHaveBeenCalled();

    // Fresh chart of accounts re-seeded; business NOT deleted
    expect(accountRepository.bulkCreateDefaultAccounts).toHaveBeenCalledWith(BIZ);
    expect(businessRepository.delete).not.toHaveBeenCalled();

    expect(res.wiped).toEqual({ JournalEntry: 3, Customer: 3 });
  });

  it('throws 404 when the business does not exist', async () => {
    businessRepository.findById.mockResolvedValue(null);
    await expect(businessService.resetBusinessData(BIZ, USR)).rejects.toMatchObject({ statusCode: 404 });
    expect(accountRepository.bulkCreateDefaultAccounts).not.toHaveBeenCalled();
  });
});

describe('deleteBusiness()', () => {
  it('wipes everything, deletes the business, and unlinks the owner', async () => {
    const res = await businessService.deleteBusiness(BIZ, USR);

    expect(mockModels.JournalEntry.collection.deleteMany).toHaveBeenCalled();
    expect(mockModels.Customer.collection.deleteMany).toHaveBeenCalled();

    expect(businessRepository.delete).toHaveBeenCalledWith(BIZ);
    expect(userRepository.update).toHaveBeenCalledWith(USR, { businessId: null });

    // A full delete does NOT reseed a chart of accounts
    expect(accountRepository.bulkCreateDefaultAccounts).not.toHaveBeenCalled();

    expect(res.wiped).toEqual({ JournalEntry: 3, Customer: 3 });
  });

  it('throws 404 when the business does not exist', async () => {
    businessRepository.findById.mockResolvedValue(null);
    await expect(businessService.deleteBusiness(BIZ, USR)).rejects.toMatchObject({ statusCode: 404 });
    expect(businessRepository.delete).not.toHaveBeenCalled();
  });
});
