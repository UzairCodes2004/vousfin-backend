// services/vendorRisk.service.js
//
// Phase 3.3 — Vendor Risk Engine
//
// Computes a vendor risk score (0–100) from multiple signals:
//   • Late payment rate       — how often AP pays past dueDate
//   • Dispute frequency       — bills that reached 'cancelled' via dispute
//   • Duplicate billing rate  — bills with threeWayMatchStatus = 'blocked' from dup check
//   • Over-billing rate       — bills blocked for price/quantity mismatch
//   • Price anomaly           — stddev of unit prices vs median
//
// Score → Level:
//   0–25  low  | 26–50 medium | 51–75 high | 76–100 critical
//
'use strict';
const mongoose    = require('mongoose');
const Vendor      = require('../models/Vendor.model');
const Bill        = require('../models/Bill.model');
const { ApiError }= require('../utils/ApiError');
const logger      = require('../config/logger');
const {
  VENDOR_RISK_LEVELS,
  VENDOR_RISK_FACTORS,
  BILL_STATES,
} = require('../config/constants');

// ── Score weights (must sum to 100) ──────────────────────────────────────────
const WEIGHTS = {
  [VENDOR_RISK_FACTORS.LATE_PAYMENT]:      35,
  [VENDOR_RISK_FACTORS.DISPUTE_FREQUENCY]: 20,
  [VENDOR_RISK_FACTORS.DUPLICATE_BILLING]: 25,
  [VENDOR_RISK_FACTORS.OVER_BILLING]:      15,
  [VENDOR_RISK_FACTORS.PRICE_ANOMALY]:      5,
};

class VendorRiskService {

  _validateId(id, label = 'id') {
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      throw new ApiError(400, `Invalid ${label}`);
    }
  }

  // ── Score helpers ────────────────────────────────────────────────────────────

  /** Clamp a value to [0, 100]. */
  _clamp(v) { return Math.max(0, Math.min(100, v)); }

  /** Convert score number to risk level string. */
  _scoreToLevel(score) {
    if (score <= 25) return VENDOR_RISK_LEVELS.LOW;
    if (score <= 50) return VENDOR_RISK_LEVELS.MEDIUM;
    if (score <= 75) return VENDOR_RISK_LEVELS.HIGH;
    return VENDOR_RISK_LEVELS.CRITICAL;
  }

  // ── Individual factor calculators ────────────────────────────────────────────

  /** Percentage of bills paid after dueDate (days past = late). */
  _calcLatePaymentScore(bills) {
    const paid = bills.filter(b => b.state === BILL_STATES.PAID && b.dueDate && b.paidAt);
    if (!paid.length) return 0;
    const lateCount = paid.filter(b => new Date(b.paidAt) > new Date(b.dueDate)).length;
    const latePct   = lateCount / paid.length;
    return this._clamp(latePct * 100); // 0–100 based on how often they bill late
  }

  /** Frequency of disputed bills as a percentage of total. */
  _calcDisputeScore(bills) {
    if (!bills.length) return 0;
    const disputed = bills.filter(b => b.state === 'cancelled' || b.state === 'disputed').length;
    return this._clamp((disputed / bills.length) * 200); // × 2 to make it impactful
  }

  /** Frequency of bills with duplicate detection blocked. */
  _calcDuplicateBillingScore(bills) {
    if (!bills.length) return 0;
    const dups = bills.filter(
      b => b.matchResult?.duplicateCheck?.isDuplicate === true
    ).length;
    return this._clamp((dups / bills.length) * 300); // high weight — very suspicious
  }

  /** Frequency of bills blocked due to over-billing or match issues. */
  _calcOverBillingScore(bills) {
    if (!bills.length) return 0;
    const blocked = bills.filter(
      b => ['over_billed', 'blocked', 'mismatch'].includes(b.threeWayMatchStatus)
    ).length;
    return this._clamp((blocked / bills.length) * 150);
  }

  /**
   * Price anomaly: compute coefficient of variation (stddev / mean) across all
   * line-item unit prices for this vendor.  Higher CV = more abnormal pricing.
   */
  _calcPriceAnomalyScore(bills) {
    const prices = [];
    for (const b of bills) {
      for (const li of b.lineItems || []) {
        if (li.unitPrice > 0) prices.push(li.unitPrice);
      }
    }
    if (prices.length < 3) return 0;
    const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
    if (mean === 0) return 0;
    const variance = prices.reduce((a, b) => a + (b - mean) ** 2, 0) / prices.length;
    const cv       = Math.sqrt(variance) / mean; // coefficient of variation
    return this._clamp(cv * 100);
  }

  // ── Main compute ─────────────────────────────────────────────────────────────

  /**
   * Compute and persist the risk score for a single vendor.
   * Looks back at bills from the last 12 months.
   */
  async computeForVendor(vendorId, businessId) {
    this._validateId(vendorId, 'vendorId');
    this._validateId(businessId, 'businessId');

    const vendor = await Vendor.findOne({ _id: vendorId, businessId });
    if (!vendor) throw new ApiError(404, 'Vendor not found');

    const since = new Date();
    since.setFullYear(since.getFullYear() - 1);

    const bills = await Bill.find({
      vendorId,
      businessId,
      isArchived: { $ne: true },
      createdAt:  { $gte: since },
    })
      .select('state dueDate paidAt matchResult threeWayMatchStatus lineItems')
      .lean();

    if (bills.length === 0) {
      // Not enough data — no risk assigned
      vendor.riskScore    = null;
      vendor.riskLevel    = null;
      vendor.riskFactors  = null;
      vendor.riskUpdatedAt = new Date();
      await vendor.save();
      return { vendorId, riskScore: null, riskLevel: null, riskFactors: null, billCount: 0 };
    }

    const factors = {
      [VENDOR_RISK_FACTORS.LATE_PAYMENT]:      this._calcLatePaymentScore(bills),
      [VENDOR_RISK_FACTORS.DISPUTE_FREQUENCY]: this._calcDisputeScore(bills),
      [VENDOR_RISK_FACTORS.DUPLICATE_BILLING]: this._calcDuplicateBillingScore(bills),
      [VENDOR_RISK_FACTORS.OVER_BILLING]:      this._calcOverBillingScore(bills),
      [VENDOR_RISK_FACTORS.PRICE_ANOMALY]:     this._calcPriceAnomalyScore(bills),
    };

    // Weighted sum
    let score = 0;
    for (const [factor, raw] of Object.entries(factors)) {
      score += raw * (WEIGHTS[factor] / 100);
    }
    score = Math.round(this._clamp(score));
    const level = this._scoreToLevel(score);

    vendor.riskScore    = score;
    vendor.riskLevel    = level;
    vendor.riskFactors  = factors;
    vendor.riskUpdatedAt = new Date();
    await vendor.save();

    logger.info(`[riskEngine] vendor ${vendorId} score=${score} level=${level} bills=${bills.length}`);
    return { vendorId, riskScore: score, riskLevel: level, riskFactors: factors, billCount: bills.length };
  }

  /**
   * Batch refresh risk scores for all vendors of a business.
   * Called by a weekly cron job.
   */
  async refreshAllForBusiness(businessId) {
    this._validateId(businessId, 'businessId');
    const vendors = await Vendor.find({ businessId, isActive: true }).select('_id').lean();
    const results = [];
    for (const v of vendors) {
      try {
        const r = await this.computeForVendor(v._id.toString(), businessId);
        results.push(r);
      } catch (err) {
        logger.warn(`[riskEngine] skipped vendor ${v._id}: ${err.message}`);
      }
    }
    logger.info(`[riskEngine] refreshed ${results.length} vendors for business ${businessId}`);
    return results;
  }

  // ── Query ─────────────────────────────────────────────────────────────────────

  /**
   * Return vendors sorted by risk score (descending), optionally filtered by level.
   */
  async listByRisk(businessId, { level, limit = 20 } = {}) {
    this._validateId(businessId, 'businessId');
    const filter = { businessId, isActive: true, riskScore: { $ne: null } };
    if (level) filter.riskLevel = level;
    return Vendor.find(filter)
      .sort({ riskScore: -1 })
      .limit(limit)
      .select('vendorName riskScore riskLevel riskFactors riskUpdatedAt')
      .lean();
  }

  /**
   * Summary counts per risk level for a business.
   */
  async riskLevelSummary(businessId) {
    const rows = await Vendor.aggregate([
      { $match: { businessId: new mongoose.Types.ObjectId(businessId), isActive: true, riskLevel: { $ne: null } } },
      { $group: { _id: '$riskLevel', count: { $sum: 1 } } },
    ]);
    const out = { low: 0, medium: 0, high: 0, critical: 0 };
    for (const r of rows) out[r._id] = r.count;
    return out;
  }
}

module.exports = new VendorRiskService();
