// models/InstallmentPlan.model.js
const mongoose = require('mongoose');
const {
  INSTALLMENT_STATUS,
  INSTALLMENT_FREQUENCY,
  PAYMENT_STATUS,
} = require('../config/constants');

/**
 * InstallmentPlan Schema
 * Tracks installment/loan repayment schedules linked to a parent journal entry.
 * Supports asset purchases, loan repayments, vendor and customer installment payments.
 */
const installmentScheduleItemSchema = new mongoose.Schema(
  {
    installmentNumber: {
      type: Number,
      required: true,
      min: 1,
    },
    dueDate: {
      type: Date,
      required: true,
    },
    /** Total EMI for this row (principalDue + interestDue) */
    amount: {
      type: Number,
      required: true,
      min: 0.01,
    },
    // ── Amortization split (Phase B) ────────────────────────────────────────────
    /** Principal portion of this EMI (computed at schedule generation) */
    principalDue: {
      type: Number,
      default: 0,
      min: 0,
    },
    /** Interest portion of this EMI (computed at schedule generation) */
    interestDue: {
      type: Number,
      default: 0,
      min: 0,
    },
    /** Loan principal at start of this period */
    openingBalance: {
      type: Number,
      default: 0,
      min: 0,
    },
    /** Loan principal at end of this period (after this row's principal applied) */
    closingBalance: {
      type: Number,
      default: 0,
      min: 0,
    },
    /** Cumulative principal actually paid on this row */
    paidPrincipal: {
      type: Number,
      default: 0,
      min: 0,
    },
    /** Cumulative interest actually paid on this row */
    paidInterest: {
      type: Number,
      default: 0,
      min: 0,
    },
    // ────────────────────────────────────────────────────────────────────────────
    status: {
      type: String,
      enum: Object.values(PAYMENT_STATUS),
      default: PAYMENT_STATUS.UNPAID,
    },
    paidDate: {
      type: Date,
      default: null,
    },
    /** Total amount paid against this row (paidPrincipal + paidInterest) */
    paidAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    transactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JournalEntry',
      default: null,
    },
    /** Penalty accrued on this row (field reserved; auto-fill cron is separate) */
    penaltyAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  { _id: true }
);

const installmentPlanSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      index: true,
    },
    linkedTransactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JournalEntry',
      required: true,
    },
    // Optional party references
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      default: null,
    },
    vendorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Vendor',
      default: null,
    },
    // Financial details
    totalAmount: {
      type: Number,
      required: true,
      min: 0.01,
    },
    downPayment: {
      type: Number,
      default: 0,
      min: 0,
    },
    remainingAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    // Plan structure
    installmentCount: {
      type: Number,
      required: true,
      min: 1,
      max: 120, // max 10 years monthly
    },
    installmentFrequency: {
      type: String,
      enum: Object.values(INSTALLMENT_FREQUENCY),
      required: true,
    },
    installmentAmount: {
      type: Number,
      required: true,
      min: 0.01,
    },
    // ── Interest / financing metadata (Phase 3) ──────────────────────────────
    /**
     * Annual interest rate as a percentage (e.g. 12 for 12% p.a.).
     * null = zero-interest / interest-free installment plan.
     */
    interestRate: {
      type: Number,
      default: null,
      min: 0,
      max: 100,
    },
    /**
     * Principal portion of the total financed amount (totalAmount - downPayment).
     * Stored separately so interest calculations remain traceable.
     */
    principalAmount: {
      type: Number,
      default: null,
      min: 0,
    },
    /**
     * Total interest that will be paid over the full term
     * (principalAmount × interestRate × period).
     * null = interest-free plan.
     */
    totalInterest: {
      type: Number,
      default: null,
      min: 0,
    },
    /**
     * Cumulative interest actually paid so far (updated each payment recording).
     */
    totalInterestPaid: {
      type: Number,
      default: 0,
      min: 0,
    },
    /**
     * Outstanding principal: principal still owed (≠ remainingAmount which is
     * total outstanding including unpaid interest). On a reducing-balance loan,
     * this is the figure that interest accrues against next period.
     */
    outstandingPrincipal: {
      type: Number,
      default: 0,
      min: 0,
    },
    /**
     * Amortization method:
     *   - 'reducing_balance': interest computed on declining principal (standard EMI)
     *   - 'flat':             interest = principal × rate × years, split evenly
     */
    interestMethod: {
      type: String,
      enum: ['reducing_balance', 'flat'],
      default: 'reducing_balance',
    },
    /**
     * Overdue status (denormalised for quick filtering).
     *   - 'current':  next due date in the future
     *   - 'overdue':  at least one unpaid row past due
     *   - 'defaulted': 3+ rows past due (configurable per business)
     */
    overdueStatus: {
      type: String,
      enum: ['current', 'overdue', 'defaulted'],
      default: 'current',
    },

    // ── Penalty tracking (Phase Advanced) ───────────────────────────────────
    /**
     * Annual late-payment penalty rate as a percentage (e.g. 2 = 2% p.a.).
     * Applied per overdue EMI row, prorated to days late.
     * null = no penalty clause on this plan.
     */
    penaltyRate: {
      type: Number,
      default: null,
      min: 0,
      max: 100,
    },
    /** Cumulative penalty charged across all rows (informational; not added to remainingAmount). */
    totalPenaltiesAccrued: {
      type: Number,
      default: 0,
      min: 0,
    },

    // ── Restructuring history (Phase Advanced) ───────────────────────────────
    /**
     * Each element records a single restructure event.
     * Retained for audit trail and regulatory reporting.
     */
    restructureHistory: {
      type: [
        {
          _id:                    false,
          date:                   { type: Date, required: true },
          reason:                 { type: String, default: null },
          outstandingAtRestructure:{ type: Number, required: true },
          previousCount:          { type: Number, required: true },
          previousEMI:            { type: Number, required: true },
          previousRate:           { type: Number, default: null },
          newCount:               { type: Number, required: true },
          newEMI:                 { type: Number, required: true },
          newRate:                { type: Number, default: null },
          newMethod:              { type: String, default: null },
        },
      ],
      default: [],
    },

    // ── Early settlement (Phase Advanced) ────────────────────────────────────
    /** Date the plan was settled early (null when not settled early). */
    settledEarlyDate: {
      type: Date,
      default: null,
    },
    /** Discount amount granted at early settlement (0 = no discount). */
    settlementDiscount: {
      type: Number,
      default: 0,
      min: 0,
    },
    // ────────────────────────────────────────────────────────────────────────
    nextDueDate: {
      type: Date,
      default: null,
    },
    // Status tracking
    status: {
      type: String,
      enum: Object.values(INSTALLMENT_STATUS),
      default: INSTALLMENT_STATUS.ACTIVE,
    },
    paidInstallments: {
      type: Number,
      default: 0,
      min: 0,
    },
    remainingInstallments: {
      type: Number,
      required: true,
      min: 0,
    },
    // Full schedule
    schedule: [installmentScheduleItemSchema],
    // Notes
    notes: {
      type: String,
      default: null,
      maxlength: 500,
      trim: true,
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (doc, ret) => {
        delete ret.__v;
        return ret;
      },
    },
  }
);

// ===============================
// Indexes
// ===============================
installmentPlanSchema.index({ businessId: 1, status: 1 });
installmentPlanSchema.index({ linkedTransactionId: 1 });
installmentPlanSchema.index({ businessId: 1, nextDueDate: 1 });
installmentPlanSchema.index({ businessId: 1, customerId: 1 });
installmentPlanSchema.index({ businessId: 1, vendorId: 1 });

// ===============================
// Instance Methods
// ===============================

/**
 * Record a payment against the next unpaid installment.
 * @param {number} paidAmount
 * @param {string} transactionId - The journal entry ID for the payment
 * @returns {Object} Updated installment item
 */
/**
 * Record a payment against the next unpaid installment.
 *
 * Payment allocation rules (standard waterfall):
 *   1. Settle outstanding interestDue on the active row first
 *   2. Any remainder goes to principalDue
 *   3. Overpayment beyond the active row spills forward to the next row
 *
 * @param {number} paidAmount       Total payment received
 * @param {string} transactionId    Linked JournalEntry _id
 * @returns {{ activeRow, principalApplied, interestApplied }}
 */
installmentPlanSchema.methods.recordPayment = function (paidAmount, transactionId) {
  let remaining = Math.round(paidAmount * 100) / 100;
  let totalPrincipalApplied = 0;
  let totalInterestApplied  = 0;
  const round2 = (n) => Math.round(n * 100) / 100;

  let firstTouchedRow = null;

  while (remaining > 0) {
    const row = this.schedule.find(
      (item) =>
        item.status === PAYMENT_STATUS.UNPAID ||
        item.status === PAYMENT_STATUS.PARTIALLY_PAID
    );
    if (!row) {
      // No more unpaid rows but we still have funds — overpayment.
      // Reduce remainingAmount and stop; caller can refund the excess if needed.
      this.remainingAmount = Math.max(0, this.remainingAmount - remaining);
      break;
    }
    if (!firstTouchedRow) firstTouchedRow = row;

    // 1. Settle interest first
    const interestOutstanding = Math.max(0, (row.interestDue || 0) - (row.paidInterest || 0));
    const interestPay = Math.min(remaining, interestOutstanding);
    if (interestPay > 0) {
      row.paidInterest = round2((row.paidInterest || 0) + interestPay);
      totalInterestApplied += interestPay;
      remaining = round2(remaining - interestPay);
    }

    // 2. Then principal
    const principalOutstanding = Math.max(0, (row.principalDue || 0) - (row.paidPrincipal || 0));
    const principalPay = Math.min(remaining, principalOutstanding);
    if (principalPay > 0) {
      row.paidPrincipal = round2((row.paidPrincipal || 0) + principalPay);
      totalPrincipalApplied += principalPay;
      remaining = round2(remaining - principalPay);
    }

    // 3. Update row totals + status
    row.paidAmount = round2((row.paidAmount || 0) + interestPay + principalPay);
    row.paidDate = new Date();
    row.transactionId = transactionId;

    const rowFullyPaid =
      row.paidPrincipal >= row.principalDue - 0.01 &&
      row.paidInterest  >= row.interestDue  - 0.01;

    if (rowFullyPaid) {
      row.status = PAYMENT_STATUS.PAID;
      this.paidInstallments += 1;
      this.remainingInstallments = Math.max(0, this.remainingInstallments - 1);
    } else {
      row.status = PAYMENT_STATUS.PARTIALLY_PAID;
      // Cannot spill into next row without finishing this one — stop
      break;
    }

    // Loop: if remaining > 0, the next iteration picks the next row
  }

  // ── Update plan-level totals ────────────────────────────────────────────────
  this.totalInterestPaid = round2((this.totalInterestPaid || 0) + totalInterestApplied);
  this.remainingAmount   = round2(Math.max(0, (this.remainingAmount || 0) - paidAmount));
  this.outstandingPrincipal = round2(
    Math.max(0, (this.outstandingPrincipal || this.principalAmount || 0) - totalPrincipalApplied)
  );

  // Update nextDueDate to next unpaid row
  const nextStillUnpaid = this.schedule.find(
    (item) => item.status === PAYMENT_STATUS.UNPAID || item.status === PAYMENT_STATUS.PARTIALLY_PAID
  );
  this.nextDueDate = nextStillUnpaid ? nextStillUnpaid.dueDate : null;

  // Recompute overdue status (guard: method may not exist on plain objects/lean docs)
  if (typeof this.refreshOverdueStatus === 'function') {
    this.refreshOverdueStatus();
  }

  // Plan completion check
  if (this.remainingInstallments === 0 || this.remainingAmount <= 0.01) {
    this.status = INSTALLMENT_STATUS.COMPLETED;
    this.remainingAmount = 0;
    this.outstandingPrincipal = 0;
  }

  return {
    activeRow:        firstTouchedRow,
    principalApplied: round2(totalPrincipalApplied),
    interestApplied:  round2(totalInterestApplied),
  };
};

/**
 * Refresh overdueStatus based on the current schedule rows.
 *   - 'current':   no unpaid row past its due date
 *   - 'overdue':   1–2 unpaid rows past due
 *   - 'defaulted': 3+ unpaid rows past due
 * Called automatically by recordPayment, and can be invoked manually
 * by a daily cron to keep status fresh between payments.
 */
installmentPlanSchema.methods.refreshOverdueStatus = function () {
  const now = new Date();
  const overdueCount = this.schedule.filter(
    (row) =>
      (row.status === PAYMENT_STATUS.UNPAID ||
       row.status === PAYMENT_STATUS.PARTIALLY_PAID) &&
      row.dueDate < now
  ).length;
  if      (overdueCount >= 3) this.overdueStatus = 'defaulted';
  else if (overdueCount >= 1) this.overdueStatus = 'overdue';
  else                        this.overdueStatus = 'current';
  return this.overdueStatus;
};

/**
 * Get the active (next unpaid / partially-paid) schedule row.
 * Used by the payment service to split an EMI into principal/interest before
 * generating the journal entry.
 * @returns {Object|null}
 */
installmentPlanSchema.methods.getActiveScheduleRow = function () {
  return (
    this.schedule.find(
      (row) =>
        row.status === PAYMENT_STATUS.UNPAID ||
        row.status === PAYMENT_STATUS.PARTIALLY_PAID
    ) || null
  );
};

/**
 * Apply a penalty charge to a specific overdue schedule row.
 * Does NOT create a journal entry — that is the service layer's responsibility.
 * Updates row.penaltyAmount and plan.totalPenaltiesAccrued.
 *
 * @param {string|ObjectId} rowId   - schedule sub-document _id
 * @param {number}          amount  - penalty amount to add
 * @returns {Object|null}           - the updated row, or null if not found
 */
installmentPlanSchema.methods.applyPenaltyToRow = function (rowId, amount) {
  const round2 = (n) => Math.round(n * 100) / 100;
  const row = this.schedule.id(rowId);
  if (!row) return null;
  row.penaltyAmount    = round2((row.penaltyAmount || 0) + amount);
  this.totalPenaltiesAccrued = round2((this.totalPenaltiesAccrued || 0) + amount);
  return row;
};

/**
 * Calculate the daily penalty for a given principal using the plan's penaltyRate.
 * Formula: principal × (penaltyRate / 100) / 365
 *
 * @param {number} principal  - amount on which penalty accrues
 * @returns {number}          - daily penalty amount (0 when penaltyRate is null/0)
 */
installmentPlanSchema.methods.dailyPenaltyAmount = function (principal) {
  if (!this.penaltyRate || this.penaltyRate <= 0) return 0;
  return Math.round((principal * (this.penaltyRate / 100) / 365) * 100) / 100;
};

/**
 * Restructure the repayment plan in-place.
 * Keeps all already-paid rows unchanged.
 * Rebuilds the remaining unpaid rows using new parameters.
 *
 * @param {Object} newConfig
 * @param {number}  newConfig.count          - new total installment count for remaining balance
 * @param {string}  newConfig.frequency      - INSTALLMENT_FREQUENCY enum value
 * @param {number}  [newConfig.annualRatePct]- new interest rate (optional, defaults to existing)
 * @param {string}  [newConfig.method]       - 'reducing_balance' | 'flat'
 * @param {Date}    [newConfig.startDate]    - anchor date for new schedule
 * @param {string}  [newConfig.reason]       - reason for restructuring
 * @returns {{ newEMI: number, newTotalInterest: number }}
 */
installmentPlanSchema.methods.restructure = function (newConfig) {
  const {
    count,
    frequency    = this.installmentFrequency,
    annualRatePct = (this.interestRate  || 0),
    method       = (this.interestMethod || 'reducing_balance'),
    startDate    = new Date(),
    reason       = null,
  } = newConfig;

  if (!count || count < 1) throw new Error('count must be ≥ 1');

  // Outstanding principal is used as the new principal
  const outstanding = this.outstandingPrincipal || this.remainingAmount || 0;
  if (outstanding <= 0) throw new Error('No outstanding balance to restructure');

  // ── Record history entry before modifying ──────────────────────────────
  this.restructureHistory.push({
    date:                    new Date(),
    reason,
    outstandingAtRestructure: outstanding,
    previousCount:           this.remainingInstallments,
    previousEMI:             this.installmentAmount,
    previousRate:            this.interestRate || null,
    newCount:                count,
    newEMI:                  0,          // filled in below
    newRate:                 annualRatePct || null,
    newMethod:               method,
  });

  // ── Build new amortization (uses the static on the constructor) ────────
  const InstallmentPlanModel = this.constructor;
  const { schedule: newRows, installmentAmount: newEMI, totalInterest: newTotalInterest } =
    InstallmentPlanModel.buildAmortization({
      startDate,
      principal:     outstanding,
      count,
      frequency,
      annualRatePct,
      method,
    });

  // Update history record with computed EMI
  this.restructureHistory[this.restructureHistory.length - 1].newEMI = newEMI;

  // ── Remove unpaid rows; keep paid rows for audit ───────────────────────
  const paidRows = this.schedule.filter(
    (r) => r.status === PAYMENT_STATUS.PAID
  );
  this.schedule = [
    ...paidRows,
    ...newRows,
  ];

  // ── Update plan-level fields ───────────────────────────────────────────
  this.installmentCount       = (this.paidInstallments || 0) + count;
  this.remainingInstallments  = count;
  this.installmentAmount      = newEMI;
  this.installmentFrequency   = frequency;
  this.interestRate           = annualRatePct > 0 ? annualRatePct : null;
  this.interestMethod         = method;
  this.totalInterest          = newTotalInterest > 0 ? newTotalInterest : null;
  this.nextDueDate            = newRows[0]?.dueDate || null;
  this.status                 = INSTALLMENT_STATUS.RESTRUCTURED;
  this.overdueStatus          = 'current';   // overdue slate cleared after restructure

  return { newEMI, newTotalInterest };
};

/**
 * Settle the plan early — mark all remaining rows as PAID and close the plan.
 * Does NOT create journal entries — the service layer handles accounting.
 *
 * @param {number} discountAmount - discount granted (0 = none)
 * @param {Date}   [settledDate]  - effective settlement date (defaults to now)
 */
installmentPlanSchema.methods.settleEarly = function (discountAmount = 0, settledDate = new Date()) {
  const round2 = (n) => Math.round(n * 100) / 100;

  // Close all unpaid rows
  for (const row of this.schedule) {
    if (row.status === PAYMENT_STATUS.UNPAID || row.status === PAYMENT_STATUS.PARTIALLY_PAID) {
      row.status    = PAYMENT_STATUS.PAID;
      row.paidDate  = settledDate;
      row.paidAmount = round2(row.amount || 0);
    }
  }

  this.settlementDiscount    = round2(discountAmount);
  this.settledEarlyDate      = settledDate;
  this.status                = INSTALLMENT_STATUS.SETTLED_EARLY;
  this.remainingAmount       = 0;
  this.outstandingPrincipal  = 0;
  this.remainingInstallments = 0;
  this.nextDueDate           = null;
  this.overdueStatus         = 'current';
};

// ===============================
// Statics
// ===============================

/**
 * Get overdue installment plans for a business.
 * @param {string} businessId
 * @returns {Promise<Array>}
 */
installmentPlanSchema.statics.getOverduePlans = function (businessId) {
  return this.find({
    businessId,
    status: { $in: [INSTALLMENT_STATUS.ACTIVE, INSTALLMENT_STATUS.OVERDUE, INSTALLMENT_STATUS.RESTRUCTURED] },
    nextDueDate: { $lt: new Date() },
  })
    .populate('linkedTransactionId', 'description amount')
    .populate('customerId', 'fullName')
    .populate('vendorId', 'vendorName')
    .lean();
};

/**
 * Compute the next due date given a frequency.
 * Pure helper — exposed so callers (cron, restructuring) reuse the same logic.
 */
installmentPlanSchema.statics.advanceDate = function (date, frequency) {
  const d = new Date(date);
  switch (frequency) {
    case INSTALLMENT_FREQUENCY.WEEKLY:    d.setDate(d.getDate() + 7);  break;
    case INSTALLMENT_FREQUENCY.BIWEEKLY:  d.setDate(d.getDate() + 14); break;
    case INSTALLMENT_FREQUENCY.MONTHLY:   d.setMonth(d.getMonth() + 1); break;
    case INSTALLMENT_FREQUENCY.QUARTERLY: d.setMonth(d.getMonth() + 3); break;
    default:                              d.setMonth(d.getMonth() + 1);
  }
  return d;
};

/**
 * Compute period rate for an annual rate given the installment frequency.
 * Returns the decimal rate per period (e.g. 0.01 for 1% monthly).
 */
installmentPlanSchema.statics.periodRate = function (annualRatePct, frequency) {
  const r = (annualRatePct || 0) / 100;
  switch (frequency) {
    case INSTALLMENT_FREQUENCY.WEEKLY:    return r / 52;
    case INSTALLMENT_FREQUENCY.BIWEEKLY:  return r / 26;
    case INSTALLMENT_FREQUENCY.MONTHLY:   return r / 12;
    case INSTALLMENT_FREQUENCY.QUARTERLY: return r / 4;
    default:                              return r / 12;
  }
};

/**
 * Generate a full amortization schedule with per-row principal/interest split.
 *
 * Supports two amortization methods:
 *   - 'reducing_balance' (default): interest computed on declining principal.
 *     EMI is constant; principal portion grows each period.
 *     EMI = P × r × (1+r)^n / ((1+r)^n − 1)
 *
 *   - 'flat': interest = principal × annualRate × years, split evenly.
 *     EMI is constant; principal AND interest portions are constant too.
 *
 * @param {Object} params
 * @param {Date}   params.startDate          - First due date anchor
 * @param {number} params.principal          - Financed amount (excl. down payment)
 * @param {number} params.count              - Number of installments
 * @param {string} params.frequency          - INSTALLMENT_FREQUENCY enum value
 * @param {number} [params.annualRatePct=0]  - Interest rate, as a percentage (e.g. 12 for 12% p.a.)
 * @param {string} [params.method='reducing_balance']
 * @returns {{ schedule: Array, installmentAmount: number, totalInterest: number }}
 */
installmentPlanSchema.statics.buildAmortization = function ({
  startDate, principal, count, frequency,
  annualRatePct = 0, method = 'reducing_balance',
}) {
  if (!principal || principal <= 0) {
    throw new Error('Principal must be > 0 for amortization');
  }
  if (!count || count < 1) {
    throw new Error('Installment count must be ≥ 1');
  }

  const round2 = (n) => Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
  const rate   = this.periodRate(annualRatePct, frequency);

  let emi, totalInterest;

  // ── Compute EMI based on method ─────────────────────────────────────────────
  if (annualRatePct > 0 && method === 'reducing_balance' && rate > 0) {
    const pow = Math.pow(1 + rate, count);
    emi = principal * rate * pow / (pow - 1);
    totalInterest = (emi * count) - principal;
  } else if (annualRatePct > 0 && method === 'flat') {
    // Years equivalent for any frequency
    const periodsPerYear =
      frequency === INSTALLMENT_FREQUENCY.WEEKLY    ? 52 :
      frequency === INSTALLMENT_FREQUENCY.BIWEEKLY  ? 26 :
      frequency === INSTALLMENT_FREQUENCY.QUARTERLY ?  4 : 12;
    const years = count / periodsPerYear;
    totalInterest = principal * (annualRatePct / 100) * years;
    emi = (principal + totalInterest) / count;
  } else {
    // Zero-interest: flat principal split
    emi = principal / count;
    totalInterest = 0;
  }

  emi = round2(emi);
  totalInterest = round2(totalInterest);

  // ── Build per-row schedule ──────────────────────────────────────────────────
  const schedule = [];
  let opening    = principal;
  let nextDate   = new Date(startDate);
  let principalSum = 0;   // running total of principal allocated (for last-row correction)
  let interestSum  = 0;

  for (let i = 1; i <= count; i++) {
    nextDate = this.advanceDate(nextDate, frequency);

    let principalDue, interestDue;
    if (method === 'reducing_balance' && annualRatePct > 0) {
      interestDue  = round2(opening * rate);
      principalDue = round2(emi - interestDue);
    } else if (method === 'flat' && annualRatePct > 0) {
      principalDue = round2(principal / count);
      interestDue  = round2(totalInterest / count);
    } else {
      principalDue = round2(principal / count);
      interestDue  = 0;
    }

    // Last-row rounding correction: absorb any drift so totals match exactly
    if (i === count) {
      principalDue = round2(principal - principalSum);
      interestDue  = round2(totalInterest - interestSum);
    }

    const closing = round2(Math.max(0, opening - principalDue));
    const rowAmount = round2(principalDue + interestDue);

    schedule.push({
      installmentNumber: i,
      dueDate:           new Date(nextDate),
      amount:            rowAmount,
      principalDue,
      interestDue,
      openingBalance:    round2(opening),
      closingBalance:    closing,
      paidPrincipal:     0,
      paidInterest:      0,
      status:            PAYMENT_STATUS.UNPAID,
      paidDate:          null,
      paidAmount:        0,
      transactionId:     null,
      penaltyAmount:     0,
    });

    principalSum += principalDue;
    interestSum  += interestDue;
    opening       = closing;
  }

  return { schedule, installmentAmount: emi, totalInterest };
};

/**
 * Legacy helper — preserved for backward compatibility.
 * Newer callers should use buildAmortization() which returns principal/interest split.
 *
 * @deprecated Use buildAmortization()
 */
installmentPlanSchema.statics.generateSchedule = function (startDate, count, frequency, installmentAmount) {
  const schedule = [];
  let currentDate = new Date(startDate);

  for (let i = 1; i <= count; i++) {
    const dueDate = this.advanceDate(currentDate, frequency);
    schedule.push({
      installmentNumber: i,
      dueDate: new Date(dueDate),
      amount: installmentAmount,
      principalDue: installmentAmount,  // assume zero-interest legacy
      interestDue: 0,
      openingBalance: 0,
      closingBalance: 0,
      paidPrincipal: 0,
      paidInterest: 0,
      status: PAYMENT_STATUS.UNPAID,
      paidDate: null,
      paidAmount: 0,
      transactionId: null,
      penaltyAmount: 0,
    });
    currentDate = new Date(dueDate);
  }
  return schedule;
};

// ===============================
// Model Export
// ===============================
const InstallmentPlan = mongoose.model('InstallmentPlan', installmentPlanSchema);

module.exports = InstallmentPlan;
