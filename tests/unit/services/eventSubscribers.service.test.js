/**
 * tests/unit/services/eventSubscribers.service.test.js
 *
 * ERP Integration Refactor — Step 7 (Dashboard / Forecast / Report sync).
 * Verifies the event engine finally has real subscribers: registering attaches
 * an analytics cache-sync handler that invalidates the per-business report cache
 * whenever a material business event fires (and is tenant-scoped + idempotent).
 */
'use strict';

jest.mock('../../../utils/reportCache', () => ({ invalidate: jest.fn() }));
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const eventSubscribers = require('../../../services/eventSubscribers.service');
const reportCache = require('../../../utils/reportCache');
const { businessEvents, EVENTS } = require('../../../services/businessEventEngine.service');

const BIZ = '507f1f77bcf86cd799439060';

beforeEach(() => {
  jest.clearAllMocks();
  eventSubscribers._resetForTest();
  businessEvents.off(); // detach all handlers for a clean slate
});

describe('eventSubscribers.registerAll()', () => {
  it('registers once and is idempotent', () => {
    expect(eventSubscribers.isRegistered()).toBe(false);
    expect(eventSubscribers.registerAll()).toBe(true);
    expect(eventSubscribers.isRegistered()).toBe(true);
    expect(eventSubscribers.registerAll()).toBe(false); // second call is a no-op
  });

  it('invalidates the per-business analytics cache when a bill is approved', async () => {
    eventSubscribers.registerAll();
    await businessEvents.emitAndWait(EVENTS.BILL_APPROVED, { businessId: BIZ, entityId: 'b1' });
    expect(reportCache.invalidate).toHaveBeenCalledWith(BIZ);
  });

  it('invalidates on a customer balance change (AR ↔ analytics sync)', async () => {
    eventSubscribers.registerAll();
    await businessEvents.emitAndWait(EVENTS.CUSTOMER_BALANCE_CHANGED, { businessId: BIZ, delta: 100 });
    expect(reportCache.invalidate).toHaveBeenCalledWith(BIZ);
  });

  it('invalidates on goods received (procurement ↔ analytics sync)', async () => {
    eventSubscribers.registerAll();
    await businessEvents.emitAndWait(EVENTS.GOODS_RECEIVED, { businessId: BIZ, grnNumber: 'GRN-1' });
    expect(reportCache.invalidate).toHaveBeenCalledWith(BIZ);
  });

  it('only invalidates the emitting tenant', async () => {
    eventSubscribers.registerAll();
    await businessEvents.emitAndWait(EVENTS.INVOICE_PAID, { businessId: BIZ, entityId: 'inv1' });
    expect(reportCache.invalidate).toHaveBeenCalledTimes(1);
    expect(reportCache.invalidate).toHaveBeenCalledWith(BIZ);
  });

  it('curated list excludes purely-informational anomaly events', () => {
    expect(eventSubscribers.CACHE_INVALIDATING_EVENTS).not.toContain(EVENTS.ANOMALY_DETECTED);
    expect(eventSubscribers.CACHE_INVALIDATING_EVENTS).toContain(EVENTS.TRANSACTION_CREATED);
  });
});
