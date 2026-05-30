// services/customerStatement.service.js
//
// AR/AP Refactor — Milestone M8 (customer statements).
//
// Produces a document-sourced account statement for a customer over a date
// window: an opening balance reconstructed from history, the period's charges
// (invoices) and credits (payments + credit memos) as a running ledger, a
// closing balance, and an aging snapshot of what is currently open.
//
// READ-ONLY. The statement reads Invoice + Payment documents (the AR sources of
// truth post-M1/M2); it never posts journals or mutates balances — so producing
// a statement can never affect ledger integrity.
//
'use strict';
const mongoose = require('mongoose');
const Invoice = require('../models/Invoice.model');
const Payment = require('../models/Payment.model');
const Customer = require('../models/Customer.model');
const { businessEvents, EVENTS } = require('./businessEventEngine.service');
const { ApiError } = require('../utils/ApiError');
const logger = require('../config/logger');

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const MS_PER_DAY = 86400000;

// Invoice states that represent a real posted charge on a statement.
const CHARGE_STATES = ['approved', 'sent', 'partially_paid', 'paid', 'overdue', 'written_off'];
// Currently-open states for the aging snapshot.
const OPEN_STATES = ['approved', 'sent', 'partially_paid', 'overdue', 'disputed'];

class CustomerStatementService {
  /** Aging bucket for an open balance by days overdue. */
  _bucketOf(dueDate, asOf) {
    if (!dueDate) return 'current';
    const d = Math.round((new Date(asOf).setHours(0, 0, 0, 0) - new Date(dueDate).setHours(0, 0, 0, 0)) / MS_PER_DAY);
    if (d <= 0) return 'current';
    if (d <= 30) return '1-30';
    if (d <= 60) return '31-60';
    if (d <= 90) return '61-90';
    return '90+';
  }

  /**
   * Pure: assemble the running ledger from an opening balance and a list of
   * dated transactions. Charges are positive (debit AR), credits negative.
   * Exposed for unit testing.
   *
   * @param {number} opening
   * @param {Array<{date,type,reference,charge,credit}>} txns
   * @returns {{ lines, closingBalance, totalCharges, totalCredits }}
   */
  buildLedger(opening, txns) {
    const sorted = [...txns].sort((a, b) => new Date(a.date) - new Date(b.date));
    let balance = r2(opening);
    let totalCharges = 0;
    let totalCredits = 0;
    const lines = sorted.map((t) => {
      const charge = r2(t.charge || 0);
      const credit = r2(t.credit || 0);
      balance = r2(balance + charge - credit);
      totalCharges = r2(totalCharges + charge);
      totalCredits = r2(totalCredits + credit);
      return { ...t, charge, credit, balance };
    });
    return { lines, closingBalance: balance, totalCharges, totalCredits };
  }

  /**
   * Generate the statement.
   * @param {string} businessId
   * @param {string} customerId
   * @param {{ from?: Date|string, to?: Date|string }} range
   */
  async getStatement(businessId, customerId, { from, to } = {}, actor = null) {
    if (!mongoose.Types.ObjectId.isValid(businessId)) throw new ApiError(400, 'Invalid businessId');
    if (!mongoose.Types.ObjectId.isValid(customerId)) throw new ApiError(400, 'Invalid customerId');

    const now = new Date();
    const toDate = to ? new Date(to) : now;
    const fromDate = from ? new Date(from) : new Date(toDate.getTime() - 90 * MS_PER_DAY);
    if (fromDate > toDate) throw new ApiError(400, 'from date cannot be after to date');

    const customer = await Customer.findOne({ _id: customerId, businessId })
      .select('fullName businessName email phone currentReceivableBalance').lean();
    if (!customer) throw new ApiError(404, 'Customer not found');

    // All charge-state invoices for this customer (need history for opening balance).
    const invoices = await Invoice.find({
      businessId, customerId, isArchived: { $ne: true }, state: { $in: CHARGE_STATES },
    }).select('invoiceNumber issueDate dueDate totalAmount remainingBalance state creditMemos').lean();

    // All inbound (receipt) payments for this customer.
    const payments = await Payment.find({
      businessId, partyId: customerId, direction: 'inbound', status: { $ne: 'void' },
    }).select('paymentNumber paymentDate amount').lean();

    // ── Opening balance = everything that happened strictly before `from` ─────
    let opening = 0;
    for (const inv of invoices) {
      if (new Date(inv.issueDate) < fromDate) opening = r2(opening + (inv.totalAmount || 0));
      for (const cm of inv.creditMemos || []) {
        if (cm.appliedAt && new Date(cm.appliedAt) < fromDate) opening = r2(opening - (cm.amount || 0));
      }
    }
    for (const p of payments) {
      if (new Date(p.paymentDate) < fromDate) opening = r2(opening - (p.amount || 0));
    }

    // ── In-window transactions ────────────────────────────────────────────────
    const txns = [];
    for (const inv of invoices) {
      const issued = new Date(inv.issueDate);
      if (issued >= fromDate && issued <= toDate) {
        txns.push({ date: inv.issueDate, type: 'invoice', reference: inv.invoiceNumber, charge: r2(inv.totalAmount), credit: 0 });
      }
      for (const cm of inv.creditMemos || []) {
        const appliedAt = cm.appliedAt ? new Date(cm.appliedAt) : null;
        if (appliedAt && appliedAt >= fromDate && appliedAt <= toDate) {
          txns.push({ date: cm.appliedAt, type: 'credit_memo', reference: inv.invoiceNumber, charge: 0, credit: r2(cm.amount) });
        }
      }
    }
    for (const p of payments) {
      const pd = new Date(p.paymentDate);
      if (pd >= fromDate && pd <= toDate) {
        txns.push({ date: p.paymentDate, type: 'payment', reference: p.paymentNumber, charge: 0, credit: r2(p.amount) });
      }
    }

    const ledger = this.buildLedger(opening, txns);

    // ── Aging snapshot of what is currently open (as of `to`) ─────────────────
    const aging = { current: 0, '1-30': 0, '31-60': 0, '61-90': 0, '90+': 0, total: 0 };
    for (const inv of invoices) {
      if (!OPEN_STATES.includes(inv.state)) continue;
      const rem = r2(inv.remainingBalance != null ? inv.remainingBalance : inv.totalAmount);
      if (rem <= 0) continue;
      const bucket = this._bucketOf(inv.dueDate, toDate);
      aging[bucket] = r2(aging[bucket] + rem);
      aging.total = r2(aging.total + rem);
    }

    const statement = {
      customer: {
        id: customer._id,
        name: customer.businessName || customer.fullName,
        email: customer.email || null,
        phone: customer.phone || null,
      },
      period: { from: fromDate, to: toDate },
      openingBalance: r2(opening),
      transactions: ledger.lines,
      totalCharges: ledger.totalCharges,
      totalCredits: ledger.totalCredits,
      closingBalance: ledger.closingBalance,
      currentOutstanding: r2(customer.currentReceivableBalance || 0),
      aging,
      generatedAt: new Date(),
    };

    businessEvents.emit(EVENTS.CUSTOMER_STATEMENT_GENERATED, {
      businessId: String(businessId), userId: actor?._id || null,
      entityType: 'customer', entityId: customerId,
      from: fromDate, to: toDate, closingBalance: statement.closingBalance,
    });

    return statement;
  }
}

module.exports = new CustomerStatementService();
