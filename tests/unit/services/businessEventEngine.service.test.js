/**
 * tests/unit/services/businessEventEngine.service.test.js
 *
 * ERP Integration Refactor — Step 2.
 * Validates the central pub/sub event engine: subscription, fire-and-forget
 * safety, error isolation, business-isolation, wildcard observers, once-handlers,
 * history ring buffer, and stats.
 */
'use strict';

// Silence the logger so test output stays clean.
jest.mock('../../../config/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const { businessEvents, EVENTS, WILDCARD } = require('../../../services/businessEventEngine.service');

const ID_B1 = '507f1f77bcf86cd799439001';
const ID_B2 = '507f1f77bcf86cd799439002';

// Reset engine state BEFORE each test so every case starts from a clean slate —
// this also clears the require-time diagnostic wildcard tracer, letting us assert
// exact handler counts. (Production registers that tracer once at require-time.)
beforeEach(() => businessEvents.reset());
afterEach(() => businessEvents.reset());

describe('BusinessEventEngine', () => {

  // ── Subscription + emitAndWait ─────────────────────────────────────────────
  describe('emitAndWait()', () => {
    it('runs a subscribed handler with a normalized envelope', async () => {
      const seen = [];
      businessEvents.on(EVENTS.TRANSACTION_CREATED, (evt) => seen.push(evt), { name: 't1' });

      const res = await businessEvents.emitAndWait(EVENTS.TRANSACTION_CREATED, {
        businessId: ID_B1, entityType: 'journal_entry', entityId: 'abc',
      });

      expect(res.handled).toBe(1);
      expect(res.failed).toBe(0);
      expect(seen).toHaveLength(1);
      expect(seen[0].eventName).toBe(EVENTS.TRANSACTION_CREATED);
      expect(seen[0].businessId).toBe(ID_B1);
      expect(seen[0].eventId).toEqual(expect.any(String));
      expect(seen[0].occurredAt).toBeInstanceOf(Date);
    });

    it('runs handlers in registration order, sequentially', async () => {
      const order = [];
      businessEvents.on(EVENTS.BILL_PAID, () => order.push('a'), { name: 'a' });
      businessEvents.on(EVENTS.BILL_PAID, () => order.push('b'), { name: 'b' });

      await businessEvents.emitAndWait(EVENTS.BILL_PAID, { businessId: ID_B1 });
      expect(order).toEqual(['a', 'b']);
    });

    it('isolates a failing handler — others still run, no throw', async () => {
      const ran = [];
      businessEvents.on(EVENTS.INVOICE_PAID, () => { throw new Error('boom'); }, { name: 'bad' });
      businessEvents.on(EVENTS.INVOICE_PAID, () => ran.push('good'), { name: 'good' });

      const res = await businessEvents.emitAndWait(EVENTS.INVOICE_PAID, { businessId: ID_B1 });
      expect(res.failed).toBe(1);
      expect(res.handled).toBe(1);
      expect(res.errors[0].message).toBe('boom');
      expect(ran).toEqual(['good']); // the good handler still executed
    });
  });

  // ── Fire-and-forget emit() ─────────────────────────────────────────────────
  describe('emit() — fire-and-forget', () => {
    it('returns an eventId synchronously and never throws on handler error', () => {
      businessEvents.on(EVENTS.TRANSACTION_CREATED, () => { throw new Error('explode'); }, { name: 'x' });
      // Must not throw even though the handler throws asynchronously.
      const id = businessEvents.emit(EVENTS.TRANSACTION_CREATED, { businessId: ID_B1 });
      expect(id).toEqual(expect.any(String));
    });

    it('eventually invokes the handler', async () => {
      const calls = [];
      businessEvents.on(EVENTS.PAYMENT_RECORDED, (evt) => calls.push(evt.businessId), { name: 'p' });
      businessEvents.emit(EVENTS.PAYMENT_RECORDED, { businessId: ID_B1 });
      // Allow the detached microtask chain to flush.
      await new Promise((r) => setImmediate(r));
      expect(calls).toEqual([ID_B1]);
    });
  });

  // ── Business isolation ─────────────────────────────────────────────────────
  describe('business isolation', () => {
    it('throws when an event is published without a businessId', () => {
      expect(() => businessEvents.emit(EVENTS.TRANSACTION_CREATED, { entityId: 'x' }))
        .toThrow(/businessId is required/);
    });

    it('history can be filtered per business and never mixes tenants', async () => {
      businessEvents.on(EVENTS.BILL_CREATED, () => {}, { name: 'noop' });
      await businessEvents.emitAndWait(EVENTS.BILL_CREATED, { businessId: ID_B1, entityId: '1' });
      await businessEvents.emitAndWait(EVENTS.BILL_CREATED, { businessId: ID_B2, entityId: '2' });
      await businessEvents.emitAndWait(EVENTS.BILL_CREATED, { businessId: ID_B1, entityId: '3' });

      const b1 = businessEvents.getHistory(ID_B1);
      const b2 = businessEvents.getHistory(ID_B2);
      expect(b1).toHaveLength(2);
      expect(b2).toHaveLength(1);
      expect(b1.every((r) => r.businessId === ID_B1)).toBe(true);
      expect(b2.every((r) => r.businessId === ID_B2)).toBe(true);
    });
  });

  // ── Wildcard observers ─────────────────────────────────────────────────────
  describe('wildcard (*) observers', () => {
    it('receive every event regardless of name', async () => {
      const all = [];
      businessEvents.on(WILDCARD, (evt) => all.push(evt.eventName), { name: 'spy' });

      await businessEvents.emitAndWait(EVENTS.TRANSACTION_CREATED, { businessId: ID_B1 });
      await businessEvents.emitAndWait(EVENTS.INVENTORY_RECEIVED, { businessId: ID_B1 });

      expect(all).toEqual([EVENTS.TRANSACTION_CREATED, EVENTS.INVENTORY_RECEIVED]);
    });
  });

  // ── once() + unsubscribe ───────────────────────────────────────────────────
  describe('once() and unsubscribe', () => {
    it('once-handler runs a single time then auto-removes', async () => {
      let count = 0;
      businessEvents.once(EVENTS.LOW_STOCK_REACHED, () => { count++; }, { name: 'one' });

      await businessEvents.emitAndWait(EVENTS.LOW_STOCK_REACHED, { businessId: ID_B1 });
      await businessEvents.emitAndWait(EVENTS.LOW_STOCK_REACHED, { businessId: ID_B1 });
      expect(count).toBe(1);
      expect(businessEvents.handlerCount(EVENTS.LOW_STOCK_REACHED)).toBe(0);
    });

    it('the unsubscribe closure removes the handler', async () => {
      let count = 0;
      const off = businessEvents.on(EVENTS.GOODS_RECEIVED, () => { count++; }, { name: 'g' });
      await businessEvents.emitAndWait(EVENTS.GOODS_RECEIVED, { businessId: ID_B1 });
      off();
      await businessEvents.emitAndWait(EVENTS.GOODS_RECEIVED, { businessId: ID_B1 });
      expect(count).toBe(1);
    });
  });

  // ── Stats + diagnostics ────────────────────────────────────────────────────
  describe('stats', () => {
    it('counts emitted, handled, and errored events', async () => {
      businessEvents.on(EVENTS.TAX_CALCULATED, () => {}, { name: 'ok' });
      businessEvents.on(EVENTS.TAX_CALCULATED, () => { throw new Error('e'); }, { name: 'err' });

      await businessEvents.emitAndWait(EVENTS.TAX_CALCULATED, { businessId: ID_B1 });
      const stats = businessEvents.getStats();
      expect(stats.emitted).toBe(1);
      expect(stats.handled).toBe(1);
      expect(stats.errors).toBe(1);
    });
  });
});
