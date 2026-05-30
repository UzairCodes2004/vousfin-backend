// services/eventLog.service.js
//
// AR/AP Refactor — Milestone M9 (durable event log + replay).
//
// Persists every domain event to the EventLog collection and replays them
// through the (idempotent) registered handlers to rebuild derived state.
//
// SAFETY:
//   • record() is fire-and-forget from the engine's wildcard observer. It never
//     throws back to the emitter and short-circuits when the DB isn't connected
//     (so a degraded event store can never block or roll back a ledger write).
//   • record() is idempotent — upsert keyed on (businessId, eventId).
//   • replay() re-dispatches the STORED payload with a `__replay` marker so the
//     event-log writer skips it (no duplicate rows, no new identities) while the
//     real projection handlers (reconcile, cache) re-run idempotently.
//
'use strict';
const mongoose = require('mongoose');
const EventLog = require('../models/EventLog.model');
const { businessEvents } = require('./businessEventEngine.service');
const config = require('../config');
const logger = require('../config/logger');
const { ApiError } = require('../utils/ApiError');

const dbReady = () => mongoose.connection && mongoose.connection.readyState === 1;

class EventLogService {
  /**
   * Durably record one event envelope. Idempotent (upsert on eventId). Never
   * throws; returns null on a no-op/failure.
   */
  async record(envelope, { handlerErrors = 0 } = {}) {
    if (!config.EVENT_LOG_ENABLED) return null;
    if (!envelope || !envelope.businessId || !envelope.eventId) return null;
    if (envelope.__replay) return null;       // never re-persist a replayed event
    if (!dbReady()) return null;              // no DB → no-op (test/degraded safe)

    const { eventId, eventName, occurredAt, businessId, entityType, entityId, userId, ...rest } = envelope;
    // Strip engine internals from the stored payload.
    delete rest.__replay;

    try {
      await EventLog.updateOne(
        { businessId, eventId },
        {
          $setOnInsert: {
            businessId, eventId, eventName,
            occurredAt: occurredAt || new Date(),
            entityType: entityType || null,
            entityId: entityId != null ? String(entityId) : null,
            userId: userId || null,
            payload: rest,
            handlerErrors,
            status: 'recorded',
          },
        },
        { upsert: true }
      );
      return true;
    } catch (e) {
      logger.warn(`[eventLog] record failed for ${eventName} (${eventId}): ${e.message}`);
      return null;
    }
  }

  /** Paginated, filterable read of the durable log for one tenant. */
  async list(businessId, { eventName, entityType, entityId, from, to, limit = 100 } = {}) {
    if (!mongoose.Types.ObjectId.isValid(businessId)) throw new ApiError(400, 'Invalid businessId');
    const q = { businessId };
    if (eventName)  q.eventName = eventName;
    if (entityType) q.entityType = entityType;
    if (entityId)   q.entityId = String(entityId);
    if (from || to) {
      q.occurredAt = {};
      if (from) q.occurredAt.$gte = new Date(from);
      if (to)   q.occurredAt.$lte = new Date(to);
    }
    return EventLog.find(q).sort({ occurredAt: -1 }).limit(Math.min(limit, 1000)).lean();
  }

  /** Event-type counts for a tenant (observability). */
  async stats(businessId) {
    if (!mongoose.Types.ObjectId.isValid(businessId)) throw new ApiError(400, 'Invalid businessId');
    const rows = await EventLog.aggregate([
      { $match: { businessId: new mongoose.Types.ObjectId(businessId) } },
      { $group: { _id: '$eventName', count: { $sum: 1 }, errors: { $sum: '$handlerErrors' } } },
      { $sort: { count: -1 } },
    ]);
    return rows.map((r) => ({ eventName: r._id, count: r.count, handlerErrors: r.errors }));
  }

  /**
   * Replay logged events (oldest → newest) through the registered handlers.
   * Idempotent by construction: handlers like the AR/AP reconcile project
   * absolute values, so replaying converges to the same state.
   *
   * @param {string} businessId
   * @param {Object} [opts] { eventName, entityType, entityId, from, to, dryRun }
   * @returns {Promise<{matched, replayed, failed, dryRun, events?}>}
   */
  async replay(businessId, opts = {}) {
    if (!mongoose.Types.ObjectId.isValid(businessId)) throw new ApiError(400, 'Invalid businessId');
    const q = { businessId };
    if (opts.eventName)  q.eventName = opts.eventName;
    if (opts.entityType) q.entityType = opts.entityType;
    if (opts.entityId)   q.entityId = String(opts.entityId);
    if (opts.from || opts.to) {
      q.occurredAt = {};
      if (opts.from) q.occurredAt.$gte = new Date(opts.from);
      if (opts.to)   q.occurredAt.$lte = new Date(opts.to);
    }

    const events = await EventLog.find(q).sort({ occurredAt: 1 }).lean();
    if (opts.dryRun) {
      return { matched: events.length, replayed: 0, failed: 0, dryRun: true,
        events: events.map((e) => ({ eventId: e.eventId, eventName: e.eventName, occurredAt: e.occurredAt })) };
    }

    let replayed = 0;
    let failed = 0;
    for (const ev of events) {
      try {
        // Re-dispatch the stored payload; __replay tells the writer to skip it.
        const res = await businessEvents.emitAndWait(ev.eventName, {
          ...ev.payload,
          businessId: String(businessId),
          entityType: ev.entityType || undefined,
          entityId: ev.entityId || undefined,
          userId: ev.userId || undefined,
          __replay: true,
        });
        await EventLog.updateOne(
          { _id: ev._id },
          { $set: { status: res.failed ? 'failed' : 'replayed', lastReplayedAt: new Date() }, $inc: { replayCount: 1 } }
        );
        if (res.failed) failed += 1; else replayed += 1;
      } catch (e) {
        failed += 1;
        logger.warn(`[eventLog] replay failed for ${ev.eventName} (${ev.eventId}): ${e.message}`);
      }
    }
    logger.info(`[eventLog] replay business=${businessId}: ${replayed} replayed, ${failed} failed of ${events.length}`);
    return { matched: events.length, replayed, failed, dryRun: false };
  }
}

module.exports = new EventLogService();
