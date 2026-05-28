// models/BillDocument.model.js
//
// Phase 3.3 — Document Management
//
// Stores metadata for files uploaded against bills (PDF invoices, receipts,
// contracts, attachments).  The actual binary lives in cloud storage (or local
// disk in dev); this document holds the URL + audit trail.
//
'use strict';
const mongoose = require('mongoose');
const { DOCUMENT_TYPES, DOCUMENT_STATES } = require('../config/constants');

const auditLogSchema = new mongoose.Schema(
  {
    action:    { type: String, required: true },
    actorId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    actorName: { type: String, default: null },
    note:      { type: String, default: null },
    timestamp: { type: Date, default: Date.now },
  },
  { _id: false }
);

const billDocumentSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      index: true,
    },

    // ── Linked entities ───────────────────────────────────────────────────────
    billId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Bill',
      default: null,
      index: true,
    },
    purchaseOrderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PurchaseOrder',
      default: null,
      index: true,
    },
    vendorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Vendor',
      default: null,
      index: true,
    },

    // ── File metadata ─────────────────────────────────────────────────────────
    documentType: {
      type: String,
      enum: Object.values(DOCUMENT_TYPES),
      default: DOCUMENT_TYPES.ATTACHMENT,
      index: true,
    },
    fileName:    { type: String, required: true, trim: true, maxlength: 255 },
    originalName:{ type: String, default: null, trim: true, maxlength: 255 },
    mimeType:    { type: String, default: null, trim: true, maxlength: 100 },
    fileSize:    { type: Number, default: null, min: 0 },       // bytes
    fileUrl:     { type: String, required: true, maxlength: 1000 },
    storageKey:  { type: String, default: null, maxlength: 500 }, // cloud key
    checksum:    { type: String, default: null, maxlength: 64 },  // SHA-256

    // ── OCR / processing ──────────────────────────────────────────────────────
    state: {
      type: String,
      enum: Object.values(DOCUMENT_STATES),
      default: DOCUMENT_STATES.AVAILABLE,
      index: true,
    },
    ocrText:     { type: String, default: null },       // extracted text
    ocrMeta:     { type: mongoose.Schema.Types.Mixed, default: null }, // structured fields

    // ── Audit ─────────────────────────────────────────────────────────────────
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    uploadedAt: { type: Date, default: Date.now },
    auditLog:   [auditLogSchema],

    isArchived: { type: Boolean, default: false, index: true },
    description:{ type: String, default: null, maxlength: 500 },
    tags:       [{ type: String, trim: true }],
  },
  {
    timestamps: true,
    toJSON: {
      transform: (doc, ret) => { delete ret.__v; return ret; },
    },
  }
);

billDocumentSchema.index({ businessId: 1, billId: 1 });
billDocumentSchema.index({ businessId: 1, vendorId: 1, documentType: 1 });

const BillDocument = mongoose.model('BillDocument', billDocumentSchema);
module.exports = BillDocument;
