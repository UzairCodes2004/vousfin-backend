// models/EventLog.model.js
//
// AR/AP Refactor — Milestone M9 (durable event log).
//
// The durable, append-only system-of-record for every domain event published
// through businessEventEngine. Replaces the engine's in-memory ring buffer as
// the persistent log (the buffer stays as a fast diagnostics cache). Enables:
//   • event replay         — re-dispatch logged events to idempotent handlers
//   • projection rebuild    — reconstruct document payment state from the ledger
//   • consistency verification + a permanent audit trail that survives restarts.
//
// Append-only: rows are written once and only their replay bookkeeping
// (status / replayCount / lastReplayedAt) is updated. Money is never stored or
// mutated here — the EventLog records WHAT happened, not balances.
//
'use strict';
const mongoose = require('mongoose');

const eventLogSchema = new mongoose.Schema(
  {
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },

    // Stable identity minted by the event engine (envelope.eventId) — used to
    // dedupe so re-recording the same event is a no-op (replay-safe).
    eventId:    { type: String, required: true },
    eventName:  { type: String, required: true, index: true },
    occurredAt: { type: Date,   required: true, index: true },

    // What the event was about (for entity-scoped replay / audit).
    entityType: { type: String, default: null },
    entityId:   { type: String, default: null },
    userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    // The full event payload (envelope minus engine internals) — the replay input.
    payload:    { type: mongoose.Schema.Types.Mixed, default: {} },

    // Number of handler errors observed when the event first dispatched.
    handlerErrors: { type: Number, default: 0 },

    // Replay bookkeeping.
    status:         { type: String, enum: ['recorded', 'replayed', 'failed'], default: 'recorded', index: true },
    replayCount:    { type: Number, default: 0 },
    lastReplayedAt: { type: Date, default: null },
  },
  { timestamps: true, toJSON: { transform: (d, r) => { delete r.__v; return r; } } }
);

// Dedupe identity (per tenant) + the common query shapes.
eventLogSchema.index({ businessId: 1, eventId: 1 }, { unique: true });
eventLogSchema.index({ businessId: 1, occurredAt: -1 });
eventLogSchema.index({ businessId: 1, eventName: 1, occurredAt: -1 });
eventLogSchema.index({ businessId: 1, entityType: 1, entityId: 1 });

const EventLog = mongoose.model('EventLog', eventLogSchema);
module.exports = EventLog;
