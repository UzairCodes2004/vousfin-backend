/**
 * tests/unit/services/eventLog.service.test.js
 *
 * AR/AP Domain Refactor — Milestone M9 (durable event log + replay).
 * Validates idempotent recording, the __replay guard, listing, and that replay
 * re-dispatches stored events (oldest→newest) with the replay marker.
 */
'use strict';

jest.mock('../../../models/EventLog.model', () => ({
  updateOne: jest.fn().mockResolvedValue({ acknowledged: true }),
  find: jest.fn(),
  aggregate: jest.fn(),
}));
jest.mock('../../../services/businessEventEngine.service', () => ({
  businessEvents: { emitAndWait: jest.fn().mockResolvedValue({ failed: 0, handled: 1 }) },
}));
jest.mock('../../../config', () => ({ EVENT_LOG_ENABLED: true }));

const mongoose = require('mongoose');
const EventLog = require('../../../models/EventLog.model');
const { businessEvents } = require('../../../services/businessEventEngine.service');
const svc = require('../../../services/eventLog.service');

const BIZ = '507f1f77bcf86cd799439060';

// Pretend the DB is connected so record() doesn't short-circuit.
beforeAll(() => {
  Object.defineProperty(mongoose.connection, 'readyState', { configurable: true, get: () => 1 });
});
beforeEach(() => jest.clearAllMocks());

describe('record', () => {
  it('persists a new event via idempotent upsert', async () => {
    const ok = await svc.record({ businessId: BIZ, eventId: 'e1', eventName: 'payment.recorded', occurredAt: new Date(), entityId: 'x', foo: 1 });
    expect(ok).toBe(true);
    expect(EventLog.updateOne).toHaveBeenCalledWith(
      { businessId: BIZ, eventId: 'e1' },
      expect.objectContaining({ $setOnInsert: expect.objectContaining({ eventName: 'payment.recorded' }) }),
      { upsert: true }
    );
  });

  it('never re-persists a replayed event (__replay guard)', async () => {
    const r = await svc.record({ businessId: BIZ, eventId: 'e1', eventName: 'x', __replay: true });
    expect(r).toBeNull();
    expect(EventLog.updateOne).not.toHaveBeenCalled();
  });

  it('no-ops on a malformed envelope', async () => {
    expect(await svc.record({})).toBeNull();
    expect(await svc.record(null)).toBeNull();
  });
});

describe('replay', () => {
  it('re-dispatches stored events oldest→newest with __replay and tallies', async () => {
    const events = [
      { _id: 'r1', eventId: 'e1', eventName: 'payment.recorded', occurredAt: new Date('2026-01-01'), payload: { parentJournalEntryId: 'je1' }, entityId: 'je1' },
      { _id: 'r2', eventId: 'e2', eventName: 'payment.recorded', occurredAt: new Date('2026-01-02'), payload: { parentJournalEntryId: 'je2' }, entityId: 'je2' },
    ];
    EventLog.find.mockReturnValue({ sort: () => ({ lean: () => Promise.resolve(events) }) });

    const res = await svc.replay(BIZ, {});
    expect(res.matched).toBe(2);
    expect(res.replayed).toBe(2);
    expect(res.failed).toBe(0);
    expect(businessEvents.emitAndWait).toHaveBeenCalledTimes(2);
    // every replay carries the marker so the writer skips it
    expect(businessEvents.emitAndWait.mock.calls[0][1]).toEqual(expect.objectContaining({ __replay: true }));
    expect(EventLog.updateOne).toHaveBeenCalledTimes(2);
  });

  it('counts a handler failure without aborting', async () => {
    EventLog.find.mockReturnValue({ sort: () => ({ lean: () => Promise.resolve([
      { _id: 'r1', eventId: 'e1', eventName: 'x', occurredAt: new Date(), payload: {} },
    ]) }) });
    businessEvents.emitAndWait.mockResolvedValueOnce({ failed: 1, handled: 0 });
    const res = await svc.replay(BIZ, {});
    expect(res.failed).toBe(1);
    expect(res.replayed).toBe(0);
  });

  it('dryRun lists matches without dispatching', async () => {
    EventLog.find.mockReturnValue({ sort: () => ({ lean: () => Promise.resolve([
      { _id: 'r1', eventId: 'e1', eventName: 'x', occurredAt: new Date(), payload: {} },
    ]) }) });
    const res = await svc.replay(BIZ, { dryRun: true });
    expect(res.dryRun).toBe(true);
    expect(res.matched).toBe(1);
    expect(res.replayed).toBe(0);
    expect(businessEvents.emitAndWait).not.toHaveBeenCalled();
  });
});

describe('list', () => {
  it('builds a filtered, sorted, limited query', async () => {
    EventLog.find.mockReturnValue({ sort: () => ({ limit: () => ({ lean: () => Promise.resolve([{ eventId: 'e1' }]) }) }) });
    const rows = await svc.list(BIZ, { eventName: 'payment.recorded', limit: 10 });
    expect(rows).toHaveLength(1);
    expect(EventLog.find).toHaveBeenCalledWith(expect.objectContaining({ businessId: BIZ, eventName: 'payment.recorded' }));
  });
});
