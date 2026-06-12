'use strict';

/**
 * withTransaction — run several database writes as ONE all-or-nothing unit.
 *
 * On a replica set (MongoDB Atlas, or local Mongo started in replica-set mode):
 *   `work(session)` runs inside a real MongoDB transaction — every write either
 *   commits together or they ALL roll back. No more half-saved data.
 *
 * On a plain standalone MongoDB (a default local dev server): transactions are
 * not available, so `work(null)` runs WITHOUT a session — i.e. exactly the old
 * behaviour. The app keeps working everywhere; production gets true atomicity.
 * The first time we detect a standalone server we log one warning and then stop
 * probing (so we don't pay the cost on every call).
 *
 * IMPORTANT: `work` must forward the session it receives to every DB call it
 * makes, e.g. `Model.create([doc], { session })`, `doc.save({ session })`,
 * `Model.findOneAndUpdate(q, u, { session })`. When the session is null, passing
 * `{ session: null }` is harmless — Mongoose treats it as "no session".
 *
 * @template T
 * @param {(session: import('mongoose').ClientSession|null) => Promise<T>} work
 * @returns {Promise<T>}
 */
const mongoose = require('mongoose');
const logger = require('../config/logger');

// null = not probed yet | true = transactions work | false = standalone server
let _txnSupported = null;

function _isUnsupportedTxnError(err) {
  if (!err) return false;
  const msg = String(err.message || err);
  return (
    err.code === 20 ||   // IllegalOperation — standalone server rejecting a txn
    err.code === 263 ||  // OperationNotSupportedInTransaction
    /Transaction numbers are only allowed on a replica set/i.test(msg) ||
    /Transactions are not supported/i.test(msg) ||
    /does not support transactions/i.test(msg)
  );
}

async function withTransaction(work) {
  // Already know we're on a standalone server → don't bother starting a session.
  if (_txnSupported === false) {
    return work(null);
  }

  // No DB connection at all (readyState 0 = disconnected — e.g. unit tests with
  // fully mocked repositories): startSession() would hang waiting for a connection
  // that never comes. Run the work without a session and WITHOUT caching the probe
  // result, so a briefly-disconnected production server resumes atomic writes on
  // reconnect. (readyState 2 = connecting is NOT bypassed — startSession waits for
  // the connection and atomicity is preserved through boot.)
  if (mongoose.connection?.readyState === 0) {
    return work(null);
  }

  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    _txnSupported = true;
    return result;
  } catch (err) {
    // Only the FIRST time, and only for a genuine "transactions unsupported"
    // error, do we downgrade to the non-atomic path. A real business error
    // (validation, insufficient balance, etc.) must still abort and propagate.
    if (_txnSupported === null && _isUnsupportedTxnError(err)) {
      _txnSupported = false;
      logger.warn(
        '[withTransaction] MongoDB transactions are unavailable (standalone server). ' +
        'Running saves WITHOUT all-or-nothing safety. Start MongoDB in replica-set ' +
        'mode to enable atomic writes.'
      );
      return work(null);
    }
    throw err;
  } finally {
    session.endSession();
  }
}

/** Test-only: reset the cached probe result. */
function _resetProbe() {
  _txnSupported = null;
}

module.exports = { withTransaction, _resetProbe };
