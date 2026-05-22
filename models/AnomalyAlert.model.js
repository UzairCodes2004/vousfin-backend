// models/AnomalyAlert.model.js
const mongoose = require('mongoose');
const { ANOMALY_STATUS } = require('../config/constants');

/**
 * AnomalyAlert Schema (v2)
 *
 * Persistent record of a flagged transaction.  Tied 1:1 to a `journalEntryId`
 * via a compound unique index so the SAME transaction is never duplicated
 * across rescans.  Instead, rescans UPDATE the existing alert (or skip it if
 * the user has already given a verdict).
 *
 * Lifecycle (see config/constants.js → ANOMALY_STATUS):
 *   pending          - newly flagged
 *   marked_legit     - user OK'd it — suppress in future scans
 *   confirmed_fraud  - user flagged as fraud — keep tracked
 *   ignored          - dismissed — suppress for N days
 *   rescanned        - reviewed but txn changed → eligible to re-flag
 */
const anomalyAlertSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      index: true,
    },
    journalEntryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JournalEntry',
      required: true,
      index: true,
    },
    anomalyScore: {
      type: Number,
      required: true,
      // 0-1 range. 1.0 = highly anomalous, 0.5 = neutral, 0.0 = definitely normal
    },
    reason: {
      type: String,
      required: true,
      trim: true,
    },
    // Detailed explainability fields (Step 7)
    triggeredRules: {
      type: [String],
      default: [],
      // e.g. ['amount_zscore_3.5', 'weekend_transaction', 'rare_account_pair']
    },
    explanation: {
      type: String,
      default: '',
      // Long-form human-readable explanation: "Amount PKR 250,000 is 4.8× the normal vendor average..."
    },
    featureVector: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    // Used to detect whether the transaction has materially changed since
    // the alert was created. If unchanged & user has reviewed it → suppress.
    transactionFingerprint: {
      type: String,
      default: null,
      index: true,
    },
    status: {
      type: String,
      enum: Object.values(ANOMALY_STATUS),
      default: ANOMALY_STATUS.PENDING,
      required: true,
      index: true,
    },
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    reviewedAt: {
      type: Date,
      default: null,
    },
    reviewNotes: {
      type: String,
      default: '',
      trim: true,
    },
    // Multi-component score breakdown (Step 3)
    scoreBreakdown: {
      isolationForest:   { type: Number, default: 0 }, // [0,1]
      zScore:            { type: Number, default: 0 }, // [0,1]
      heuristic:         { type: Number, default: 0 }, // [0,1]
      behavioral:        { type: Number, default: 0 }, // [0,1]
      frequency:         { type: Number, default: 0 }, // [0,1]
      velocity:          { type: Number, default: 0 }, // [0,1]
    },
    confidence: {
      type: Number,
      default: 0,
      // 0-100% how confident the ensemble is in this anomaly classification
    },
    detectedAt: {
      type: Date,
      default: Date.now,
      required: true,
      index: true,
    },
    lastScannedAt: {
      type: Date,
      default: Date.now,
      // Updated on each rescan (even if no change). Useful for "stale alerts".
    },
    scanCount: {
      type: Number,
      default: 1,
      // How many times this transaction has been flagged across rescans
    },
    scanId: {
      type: String,
      required: true,
      index: true,
    },
  },
  {
    timestamps: false,
    toJSON: {
      transform: (doc, ret) => {
        delete ret.__v;
        return ret;
      },
    },
  }
);

// ── Indexes ───────────────────────────────────────────────────────────────────
// One alert per (business, journal-entry) — prevents duplicates on rescan.
// PartialFilter ensures already-soft-deleted records don't block re-creation.
anomalyAlertSchema.index(
  { businessId: 1, journalEntryId: 1 },
  { unique: true, name: 'uniq_biz_journal' }
);
// Listing pending alerts
anomalyAlertSchema.index({ businessId: 1, status: 1, detectedAt: -1 });
// Scan batch lookups
anomalyAlertSchema.index({ scanId: 1 });
// Dashboard counts
anomalyAlertSchema.index({ businessId: 1, detectedAt: -1 });

// ── Instance methods ─────────────────────────────────────────────────────────
anomalyAlertSchema.methods.review = async function (userId, classification, notes = '') {
  if (!Object.values(ANOMALY_STATUS).includes(classification)) {
    throw new Error(`Invalid classification: ${classification}`);
  }
  if (classification === ANOMALY_STATUS.PENDING ||
      classification === ANOMALY_STATUS.PENDING_REVIEW) {
    throw new Error('Cannot set status back to pending via review()');
  }
  this.status      = classification;
  this.reviewedBy  = userId;
  this.reviewedAt  = new Date();
  if (notes) this.reviewNotes = String(notes).substring(0, 1000);
  return this.save();
};

// ── Statics ──────────────────────────────────────────────────────────────────
anomalyAlertSchema.statics.getPendingAlerts = async function (businessId, options = {}) {
  const { page = 1, limit = 25 } = options;
  const skip = (page - 1) * limit;
  return this.find({
    businessId,
    status: { $in: [ANOMALY_STATUS.PENDING, ANOMALY_STATUS.PENDING_REVIEW, ANOMALY_STATUS.RESCANNED] },
  })
    .sort({ detectedAt: -1 })
    .skip(skip)
    .limit(limit)
    .populate('journalEntryId');
};

anomalyAlertSchema.statics.getByBusiness = async function (businessId, status = null, pagination = {}) {
  const { page = 1, limit = 25 } = pagination;
  const skip = (page - 1) * limit;
  const query = { businessId };
  if (status && Object.values(ANOMALY_STATUS).includes(status)) {
    query.status = status;
  }
  const [data, total] = await Promise.all([
    this.find(query).sort({ detectedAt: -1 }).skip(skip).limit(limit).populate('journalEntryId'),
    this.countDocuments(query),
  ]);
  return { data, total, page, limit };
};

anomalyAlertSchema.statics.getStalePendingAlerts = function (businessId, hoursAgo = 24) {
  const cutoff = new Date();
  cutoff.setHours(cutoff.getHours() - hoursAgo);
  return this.find({
    businessId,
    status: { $in: [ANOMALY_STATUS.PENDING, ANOMALY_STATUS.PENDING_REVIEW] },
    detectedAt: { $lte: cutoff },
  }).sort({ detectedAt: 1 });
};

// ── Pre-save ─────────────────────────────────────────────────────────────────
anomalyAlertSchema.pre('save', function () {
  if (!this.detectedAt) this.detectedAt = new Date();
  this.lastScannedAt = new Date();
});

const AnomalyAlert = mongoose.model('AnomalyAlert', anomalyAlertSchema);

module.exports = AnomalyAlert;
