/**
 * tests/unit/services/taxOverrideGuard.service.test.js
 *
 * R-03 guard. _clampTaxToEngine enforces that the tax engine is authoritative:
 * a client-supplied tax amount is honoured only within a small rounding
 * tolerance; out-of-tolerance amounts are snapped back to the engine figure so
 * a forged value can never corrupt the tax ledger.
 */
'use strict';

jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const transactionService = require('../../../services/transaction.service');

describe('_clampTaxToEngine (R-03 tax-override guard)', () => {
  it('uses the engine value when no override is supplied', () => {
    expect(transactionService._clampTaxToEngine(null, 170)).toBe(170);
  });

  it('honours an override within rounding tolerance (a few paisa)', () => {
    // engine 170.00, frontend computed 170.01 → within tolerance → honoured
    expect(transactionService._clampTaxToEngine(170.01, 170)).toBe(170.01);
  });

  it('honours an override within the 1% band', () => {
    // 1% of 1000 = 10 tolerance; 1007 is within → honoured
    expect(transactionService._clampTaxToEngine(1007, 1000)).toBe(1007);
  });

  it('REJECTS a forged low override (tax evasion) and snaps to the engine value', () => {
    expect(transactionService._clampTaxToEngine(0, 170)).toBe(170);
  });

  it('REJECTS a forged high override (ledger inflation) and snaps to the engine value', () => {
    expect(transactionService._clampTaxToEngine(5000, 170)).toBe(170);
  });
});
