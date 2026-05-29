// models/ProcurementAuditLog.model.js
//
// Phase 3.4 — Immutable Procurement Audit Trail
//
// Every significant procurement event (PO state change, bill approval,
// GRN receipt, allocation change, risk refresh) is appended here.
// Documents are NEVER updated or deleted — append-only.
//
// MongoDB TTL index NOT applied — audit records must be retained.
//
'use strict';
const mongoose = require('mongoose');

const procurementAuditLogSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      index: true,
    },

    // What kind of procurement entity changed
    entityType: {
      type: String,
      enum: [
        'bill', 'purchase_order', 'goods_receipt',
        'vendor_credit', 'bill_allocation', 'bill_document',
        'bill_schedule', 'vendor_risk',
      ],
      required: true,
      index: true,
    },

    entityId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },

    // Human-readable reference (bill number, PO number, etc.)
    entityRef: { type: String, default: null, maxlength: 100 },

    // The action that occurred
    action: {
      type: String,
      enum: [
        // State transitions
        'created', 'updated', 'deleted', 'archived',
        'state_changed', 'approved', 'rejected', 'submitted',
        // AP-specific
        'bill_matched', 'bill_match_failed', 'bill_paid',
        'allocation_created', 'allocation_deleted',
        'document_uploaded', 'document_archived',
        'risk_refreshed', 'schedule_deactivated',
        // Security events
        'access_denied', 'invalid_transition_attempt',
      ],
      required: true,
      index: true,
    },

    // State transition details (for state_changed / approved / rejected)
    fromState: { type: String, default: null },
    toState:   { type: String, default: null },

    // Who did it
    actorId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    actorName: { type: String, default: null, maxlength: 200 },
    actorRole: { type: String, default: null, maxlength: 50 },

    // Machine context (for cron-triggered events)
    source: {
      type: String,
      enum: ['user', 'system', 'cron', 'api'],
      default: 'user',
    },

    // Optional structured diff / metadata
    meta: { type: mongoose.Schema.Types.Mixed, default: null },

    // IP + user agent for security tracing
    ipAddress:  { type: String, default: null, maxlength: 45 },
    userAgent:  { type: String, default: null, maxlength: 500 },

    // Timestamp (not managed by timestamps option so we control it explicitly)
    occurredAt: { type: Date, required: true, default: Date.now, index: true },
  },
  {
    // No timestamps option — we manage occurredAt manually for immutability clarity
    // versionKey disabled — no __v on audit docs
    versionKey: false,
  }
);

// ── Compound indexes for common query patterns ─────────────────────────────────
procurementAuditLogSchema.index({ businessId: 1, occurredAt: -1 });
procurementAuditLogSchema.index({ businessId: 1, entityType: 1, entityId: 1, occurredAt: -1 });
procurementAuditLogSchema.index({ businessId: 1, actorId: 1, occurredAt: -1 });

// ── Guard against accidental updates (append-only enforcement) ─────────────────
procurementAuditLogSchema.pre('findOneAndUpdate', function () {
  throw new Error('ProcurementAuditLog is append-only — updates are not allowed');
});
procurementAuditLogSchema.pre('updateOne', function () {
  throw new Error('ProcurementAuditLog is append-only — updates are not allowed');
});
procurementAuditLogSchema.pre('updateMany', function () {
  throw new Error('ProcurementAuditLog is append-only — updates are not allowed');
});

module.exports = mongoose.model('ProcurementAuditLog', procurementAuditLogSchema);
