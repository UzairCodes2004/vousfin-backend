// services/expenseAllocation.service.js
//
// Phase 3.3 — Expense Allocation (cost-centre / department splitting)
//
// Creates a BillAllocation record and generates balanced journal entries
// for each allocation line (DR per cost-centre, CR Accounts Payable).
//
// Rules:
//   • allocation lines must sum to bill.totalAmount (balanced)
//   • each line can target department | branch | project | cost_center
//   • method: equal | percentage | amount
//
'use strict';
const mongoose      = require('mongoose');
const Bill          = require('../models/Bill.model');
const BillAllocation= require('../models/BillAllocation.model');
const ChartOfAccount= require('../models/ChartOfAccount.model');
const JournalEntry  = require('../models/JournalEntry.model');
const { ApiError }  = require('../utils/ApiError');
const logger        = require('../config/logger');
const {
  ALLOCATION_METHODS,
  COST_CENTER_TYPES,
  TRANSACTION_TYPES,
  TRANSACTION_SOURCES,
  JOURNAL_STATUS,
} = require('../config/constants');

class ExpenseAllocationService {

  _validateId(id, label = 'id') {
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      throw new ApiError(400, `Invalid ${label}`);
    }
  }

  _r2(v) { return Math.round(v * 100) / 100; }

  // ── Validation ────────────────────────────────────────────────────────────────

  _validateLines(lines, totalAmount, method) {
    if (!Array.isArray(lines) || lines.length === 0) {
      throw new ApiError(400, 'At least one allocation line is required');
    }
    for (const [i, line] of lines.entries()) {
      if (!line.costCenterType || !Object.values(COST_CENTER_TYPES).includes(line.costCenterType)) {
        throw new ApiError(400, `Line ${i + 1}: invalid costCenterType`);
      }
      if (!line.costCenterId) throw new ApiError(400, `Line ${i + 1}: costCenterId is required`);
      if (!line.costCenterName) throw new ApiError(400, `Line ${i + 1}: costCenterName is required`);
    }

    // Check balance for amount method
    if (method === ALLOCATION_METHODS.AMOUNT) {
      const sum = this._r2(lines.reduce((s, l) => s + (l.amount || 0), 0));
      const diff = Math.abs(sum - totalAmount);
      if (diff > 0.05) {
        throw new ApiError(400, `Allocation amounts (${sum}) must equal bill total (${totalAmount})`);
      }
    }
    // Check percentages sum to 100
    if (method === ALLOCATION_METHODS.PERCENTAGE) {
      const pctSum = this._r2(lines.reduce((s, l) => s + (l.percentage || 0), 0));
      if (Math.abs(pctSum - 100) > 0.01) {
        throw new ApiError(400, `Allocation percentages must sum to 100 (got ${pctSum})`);
      }
    }
  }

  // ── Build lines with computed amounts ────────────────────────────────────────

  _buildLines(lines, totalAmount, method) {
    if (method === ALLOCATION_METHODS.EQUAL) {
      const each = this._r2(totalAmount / lines.length);
      return lines.map((l, i) => ({
        ...l,
        amount:     i === lines.length - 1 ? this._r2(totalAmount - each * (lines.length - 1)) : each,
        percentage: this._r2(100 / lines.length),
      }));
    }
    if (method === ALLOCATION_METHODS.PERCENTAGE) {
      return lines.map((l, i) => {
        const pct = l.percentage || 0;
        const amount = i === lines.length - 1
          ? this._r2(totalAmount - lines.slice(0, i).reduce((s, p) => s + this._r2(totalAmount * (p.percentage || 0) / 100), 0))
          : this._r2(totalAmount * pct / 100);
        return { ...l, amount };
      });
    }
    // AMOUNT: use as-is
    return lines.map(l => ({ ...l, percentage: this._r2((l.amount / totalAmount) * 100) }));
  }

  // ── Create allocation ─────────────────────────────────────────────────────────

  /**
   * @param {string}   billId
   * @param {string}   businessId
   * @param {object}   data  — { method, lines, notes }
   * @param {object}   actor
   */
  async create(billId, businessId, data, actor) {
    this._validateId(billId,     'billId');
    this._validateId(businessId, 'businessId');

    const bill = await Bill.findOne({ _id: billId, businessId, isArchived: { $ne: true } });
    if (!bill) throw new ApiError(404, 'Bill not found');

    const method = data.method || ALLOCATION_METHODS.PERCENTAGE;
    if (!Object.values(ALLOCATION_METHODS).includes(method)) {
      throw new ApiError(400, `Invalid allocation method: ${method}`);
    }

    this._validateLines(data.lines, bill.totalAmount, method);
    const builtLines = this._buildLines(data.lines, bill.totalAmount, method);

    // Create JE lines and allocation records
    let apAccount = null;
    try {
      apAccount = await ChartOfAccount.findOne({ businessId, accountCode: '2110' }).lean();
    } catch (_) {}

    // Post a combined allocation journal entry
    let summaryJournalId = null;
    if (apAccount) {
      try {
        const je = await JournalEntry.create({
          businessId,
          description: `Expense allocation: ${bill.billNumber}`,
          transactionType:   TRANSACTION_TYPES.CREDIT_PURCHASE,
          transactionSource: TRANSACTION_SOURCES.SYSTEM_GENERATED,
          status:            JOURNAL_STATUS.POSTED,
          date:              new Date(),
          lines: builtLines.map(l => ({
            accountId:   l.accountId || apAccount._id,
            description: `${l.costCenterType}: ${l.costCenterName}`,
            debit:       l.amount,
            credit:      0,
          })).concat([{
            accountId:   apAccount._id,
            description: `AP allocation for ${bill.billNumber}`,
            debit:       0,
            credit:      bill.totalAmount,
          }]),
          totalAmount:  bill.totalAmount,
          currencyCode: bill.currencyCode,
          referenceId:  bill._id,
          referenceType:'Bill',
          createdBy:    actor?._id || null,
        });
        summaryJournalId = je._id;
      } catch (err) {
        logger.warn(`[allocation] JE creation failed: ${err.message}`);
      }
    }

    // Persist allocation
    const existing = await BillAllocation.findOne({ billId, businessId });
    if (existing) {
      // Replace existing allocation
      existing.method          = method;
      existing.totalAllocated  = bill.totalAmount;
      existing.lines           = builtLines;
      existing.isBalanced      = true;
      existing.summaryJournalId = summaryJournalId;
      existing.updatedBy       = actor?._id || null;
      existing.notes           = data.notes || null;
      await existing.save();

      bill.allocationId = existing._id;
      await bill.save();
      return existing;
    }

    const allocation = await BillAllocation.create({
      businessId,
      billId,
      method,
      totalAllocated:  bill.totalAmount,
      lines:           builtLines,
      isBalanced:      true,
      summaryJournalId,
      createdBy:       actor?._id || null,
      notes:           data.notes || null,
    });

    bill.allocationId = allocation._id;
    await bill.save();

    logger.info(`[allocation] created for bill ${billId} method=${method} lines=${builtLines.length}`);
    return allocation;
  }

  // ── Query ─────────────────────────────────────────────────────────────────────

  async getByBill(billId, businessId) {
    this._validateId(billId, 'billId');
    return BillAllocation.findOne({ billId, businessId }).lean();
  }

  async delete(billId, businessId) {
    this._validateId(billId, 'billId');
    const a = await BillAllocation.findOneAndDelete({ billId, businessId });
    if (!a) throw new ApiError(404, 'Allocation not found');
    await Bill.findOneAndUpdate({ _id: billId, businessId }, { $set: { allocationId: null } });
    return { deleted: true };
  }

  // ── Aging report ──────────────────────────────────────────────────────────────

  /**
   * Returns bill aging buckets: how much AP balance is current / 1-30 / 31-60 / 61-90 / 90+.
   */
  async getAgingReport(businessId) {
    this._validateId(businessId, 'businessId');
    const now = new Date();
    const bills = await Bill.find({
      businessId,
      state: { $in: ['approved', 'scheduled', 'partially_paid', 'overdue'] },
      isArchived: { $ne: true },
      remainingBalance: { $gt: 0 },
    }).select('dueDate remainingBalance vendorId vendorSnapshot').lean();

    const buckets = { current: 0, '1_30': 0, '31_60': 0, '61_90': 0, '90_plus': 0 };

    for (const b of bills) {
      const daysOverdue = b.dueDate
        ? Math.ceil((now - new Date(b.dueDate)) / 86400000)
        : 0;
      const bal = b.remainingBalance || 0;
      if (daysOverdue <= 0)       buckets.current += bal;
      else if (daysOverdue <= 30) buckets['1_30'] += bal;
      else if (daysOverdue <= 60) buckets['31_60'] += bal;
      else if (daysOverdue <= 90) buckets['61_90'] += bal;
      else                        buckets['90_plus'] += bal;
    }

    // Round all
    for (const k of Object.keys(buckets)) buckets[k] = this._r2(buckets[k]);
    return { buckets, billCount: bills.length };
  }
}

module.exports = new ExpenseAllocationService();
