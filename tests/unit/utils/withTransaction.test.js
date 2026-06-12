/**
 * tests/unit/utils/withTransaction.test.js
 *
 * Proves the all-or-nothing save helper:
 *   • runs work inside a transaction when the server supports it
 *   • safely falls back to no-session (old behaviour) on a standalone server
 *   • still propagates real business errors (does NOT swallow them)
 *   • remembers a standalone server and stops probing
 */
'use strict';

jest.mock('mongoose', () => ({ startSession: jest.fn() }));
jest.mock('../../../config/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const mongoose = require('mongoose');
const { withTransaction, _resetProbe } = require('../../../utils/withTransaction');

const makeSession = (withTransactionImpl) => ({
  withTransaction: jest.fn(withTransactionImpl),
  endSession: jest.fn(),
});

beforeEach(() => {
  jest.clearAllMocks();
  _resetProbe();
});

test('runs work inside a transaction and returns its result (replica set)', async () => {
  const session = makeSession(async (fn) => { await fn(); });
  mongoose.startSession.mockResolvedValue(session);

  const work = jest.fn(async (s) => (s === session ? 'committed' : 'no-session'));
  const result = await withTransaction(work);

  expect(result).toBe('committed');
  expect(work).toHaveBeenCalledWith(session);
  expect(session.endSession).toHaveBeenCalled();
});

test('falls back to a session-less run on a standalone server', async () => {
  const session = makeSession(async () => {
    const e = new Error('Transaction numbers are only allowed on a replica set member or mongos');
    throw e;
  });
  mongoose.startSession.mockResolvedValue(session);

  const work = jest.fn(async (s) => (s === null ? 'fallback' : 'txn'));
  const result = await withTransaction(work);

  expect(result).toBe('fallback');
  expect(work).toHaveBeenCalledWith(null);
});

test('propagates a real business error (does not fall back)', async () => {
  const session = makeSession(async (fn) => { await fn(); });
  mongoose.startSession.mockResolvedValue(session);

  const work = jest.fn(async () => { throw new Error('insufficient balance'); });
  await expect(withTransaction(work)).rejects.toThrow('insufficient balance');
});

test('remembers a standalone server and skips probing next time', async () => {
  const session = makeSession(async () => { throw new Error('Transactions are not supported'); });
  mongoose.startSession.mockResolvedValue(session);

  await withTransaction(jest.fn(async (s) => s)); // first call → detects standalone
  mongoose.startSession.mockClear();

  const result = await withTransaction(jest.fn(async (s) => (s === null ? 'noTxn' : 'txn')));
  expect(result).toBe('noTxn');
  expect(mongoose.startSession).not.toHaveBeenCalled(); // no second probe
});
