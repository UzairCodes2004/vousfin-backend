/**
 * tests/unit/services/vendorRisk.service.test.js
 *
 * Phase 3.3 — Unit tests for VendorRiskService.
 * Tests score calculation helpers and riskLevel mapping.
 * DB interactions are mocked.
 */
'use strict';

const ID_BUSINESS = '507f1f77bcf86cd799439030';
const ID_VENDOR   = '507f1f77bcf86cd799439031';

jest.mock('../../../models/Vendor.model', () => ({
  findOne: jest.fn(),
  find:    jest.fn(),
  aggregate: jest.fn(),
}));
jest.mock('../../../models/Bill.model', () => ({
  find:    jest.fn(),
}));

const Vendor = require('../../../models/Vendor.model');
const Bill   = require('../../../models/Bill.model');
const svc    = require('../../../services/vendorRisk.service');
const { VENDOR_RISK_LEVELS } = require('../../../config/constants');

afterEach(() => jest.resetAllMocks());

// ── _scoreToLevel ────────────────────────────────────────────────────────────

describe('_scoreToLevel()', () => {
  it('returns low for score 0', ()     => expect(svc._scoreToLevel(0)).toBe(VENDOR_RISK_LEVELS.LOW));
  it('returns low for score 25', ()    => expect(svc._scoreToLevel(25)).toBe(VENDOR_RISK_LEVELS.LOW));
  it('returns medium for score 26', () => expect(svc._scoreToLevel(26)).toBe(VENDOR_RISK_LEVELS.MEDIUM));
  it('returns medium for score 50', () => expect(svc._scoreToLevel(50)).toBe(VENDOR_RISK_LEVELS.MEDIUM));
  it('returns high for score 51', ()   => expect(svc._scoreToLevel(51)).toBe(VENDOR_RISK_LEVELS.HIGH));
  it('returns high for score 75', ()   => expect(svc._scoreToLevel(75)).toBe(VENDOR_RISK_LEVELS.HIGH));
  it('returns critical for score 76',()=> expect(svc._scoreToLevel(76)).toBe(VENDOR_RISK_LEVELS.CRITICAL));
  it('returns critical for score 100',()=>expect(svc._scoreToLevel(100)).toBe(VENDOR_RISK_LEVELS.CRITICAL));
});

// ── _clamp ────────────────────────────────────────────────────────────────────

describe('_clamp()', () => {
  it('clamps below 0 to 0',   () => expect(svc._clamp(-10)).toBe(0));
  it('clamps above 100 to 100',()=> expect(svc._clamp(150)).toBe(100));
  it('passes through midrange',()=> expect(svc._clamp(50)).toBe(50));
});

// ── _calcLatePaymentScore ─────────────────────────────────────────────────────

describe('_calcLatePaymentScore()', () => {
  it('returns 0 when no paid bills', () => {
    expect(svc._calcLatePaymentScore([{ state: 'approved' }])).toBe(0);
  });

  it('returns 100 when all paid bills were late', () => {
    const yesterday = new Date(Date.now() - 86400000);
    const twoDaysAgo = new Date(Date.now() - 2 * 86400000);
    const bills = [
      { state: 'paid', dueDate: twoDaysAgo, paidAt: yesterday }, // paid after due
    ];
    expect(svc._calcLatePaymentScore(bills)).toBe(100);
  });

  it('returns 0 when all paid bills were on time', () => {
    const yesterday = new Date(Date.now() - 86400000);
    const tomorrow  = new Date(Date.now() + 86400000);
    const bills = [
      { state: 'paid', dueDate: tomorrow, paidAt: yesterday }, // paid before due
    ];
    expect(svc._calcLatePaymentScore(bills)).toBe(0);
  });
});

// ── _calcDuplicateBillingScore ────────────────────────────────────────────────

describe('_calcDuplicateBillingScore()', () => {
  it('returns 0 when no duplicates', () => {
    const bills = [{ matchResult: { duplicateCheck: { isDuplicate: false } } }];
    expect(svc._calcDuplicateBillingScore(bills)).toBe(0);
  });

  it('returns high score when duplicates found', () => {
    const bills = [
      { matchResult: { duplicateCheck: { isDuplicate: true } } },
      { matchResult: { duplicateCheck: { isDuplicate: true } } },
      { matchResult: { duplicateCheck: { isDuplicate: false } } },
    ];
    const score = svc._calcDuplicateBillingScore(bills);
    expect(score).toBeGreaterThan(0);
  });
});

// ── computeForVendor — no data ────────────────────────────────────────────────

describe('computeForVendor()', () => {
  it('returns null risk when vendor has no bills in last 12 months', async () => {
    const vendorDoc = {
      _id: ID_VENDOR,
      riskScore: null,
      riskLevel: null,
      riskFactors: null,
      riskUpdatedAt: null,
      save: jest.fn().mockResolvedValue(true),
    };
    Vendor.findOne.mockResolvedValueOnce(vendorDoc);
    Bill.find.mockReturnValueOnce({ select: jest.fn().mockReturnThis(), lean: jest.fn().mockResolvedValueOnce([]) });

    const result = await svc.computeForVendor(ID_VENDOR, ID_BUSINESS);
    expect(result.riskScore).toBeNull();
    expect(result.riskLevel).toBeNull();
    expect(result.billCount).toBe(0);
    expect(vendorDoc.save).toHaveBeenCalled();
  });

  it('throws 404 when vendor not found', async () => {
    Vendor.findOne.mockResolvedValueOnce(null);
    await expect(svc.computeForVendor(ID_VENDOR, ID_BUSINESS))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('throws 400 for invalid vendorId', async () => {
    await expect(svc.computeForVendor('bad-id', ID_BUSINESS))
      .rejects.toMatchObject({ statusCode: 400 });
  });
});
