// services/paymentReminder.service.js
//
// Phase 2.1 — Automated customer payment reminder service.
//
// Runs daily (via jobs/paymentReminder.job.js).  For each business, scans
// unpaid invoices in approved/sent/partially_paid/overdue state and sends
// an email reminder at four cadences:
//
//   T-3 days       — "Payment due soon"
//   T+0 (due)      — "Payment due today"
//   T+7 days       — "First overdue notice"
//   T+14 days      — "Second overdue notice"
//   T+30 days      — "Final overdue notice"
//
// Idempotency: each Invoice tracks `reminderHistory[]` so the same cadence
// fires at most once per invoice.  Re-running the job is safe.
//
// IMPORTANT — GAAP/IFRS compliance:
// This service only sends communications and writes reminder metadata.
// It does NOT touch the ledger.  No journal entries are posted by this job.
//

const mongoose = require('mongoose');
const Invoice = require('../models/Invoice.model');
const Business = require('../models/Business.model');
const Customer = require('../models/Customer.model');
const logger = require('../config/logger');
const { sendCustomerPaymentReminderEmail } = require('../utils/email.utils');

const MS_PER_DAY = 1000 * 60 * 60 * 24;

const CADENCES = [
  { key: 'due_in_3',      daysOffset: -3, label: 'Payment due in 3 days',    tone: 'reminder' },
  { key: 'due_today',     daysOffset:  0, label: 'Payment due today',         tone: 'reminder' },
  { key: 'overdue_7',     daysOffset:  7, label: 'First overdue notice',      tone: 'first_notice' },
  { key: 'overdue_14',    daysOffset: 14, label: 'Second overdue notice',     tone: 'second_notice' },
  { key: 'overdue_30',    daysOffset: 30, label: 'Final overdue notice',      tone: 'final_notice' },
];

class PaymentReminderService {
  /**
   * Find which reminder cadence (if any) applies to an invoice today.
   * Returns null if no reminder is due.
   *
   * @param {Date} today
   * @param {Date} dueDate
   * @returns {{key:string,label:string,tone:string} | null}
   */
  pickCadence(today, dueDate) {
    if (!dueDate) return null;
    const due = new Date(dueDate);
    due.setHours(0, 0, 0, 0);
    const t = new Date(today);
    t.setHours(0, 0, 0, 0);
    const diffDays = Math.round((t - due) / MS_PER_DAY);
    // diffDays = +5 means 5 days past due; diffDays = -3 means due in 3 days
    for (const c of CADENCES) {
      if (diffDays === c.daysOffset) return c;
    }
    return null;
  }

  /**
   * Has this cadence already been sent for this invoice?
   */
  hasFired(invoice, cadenceKey) {
    return (invoice.reminderHistory || []).some(r => r.cadenceKey === cadenceKey);
  }

  /**
   * Scan one business's unpaid invoices and fire any reminders due today.
   * @param {Object} business
   * @returns {Promise<{ scanned, fired, skipped, errors }>}
   */
  async scanBusiness(business, today = new Date()) {
    const stats = { scanned: 0, fired: 0, skipped: 0, errors: 0 };

    // Pull all invoices that may need a reminder.
    const invoices = await Invoice.find({
      businessId: business._id,
      isArchived: { $ne: true },
      state: { $in: ['approved', 'sent', 'partially_paid', 'overdue'] },
      remainingBalance: { $gt: 0 },
      dueDate: { $ne: null },
    });

    for (const invoice of invoices) {
      stats.scanned += 1;
      try {
        const cadence = this.pickCadence(today, invoice.dueDate);
        if (!cadence) { stats.skipped += 1; continue; }
        if (this.hasFired(invoice, cadence.key)) { stats.skipped += 1; continue; }

        // Resolve customer email — prefer snapshot, fall back to current Customer
        let email = invoice.customerSnapshot?.email;
        let displayName = invoice.customerSnapshot?.businessName
                       || invoice.customerSnapshot?.fullName;
        if (!email && invoice.customerId) {
          const cust = await Customer.findById(invoice.customerId).select('email fullName businessName').lean();
          email = cust?.email;
          displayName = cust?.businessName || cust?.fullName || displayName;
        }
        if (!email) {
          logger.warn(`[reminder] Invoice ${invoice.invoiceNumber}: no customer email — skipping`);
          stats.skipped += 1;
          continue;
        }

        await sendCustomerPaymentReminderEmail({
          to:             email,
          customerName:   displayName || 'Customer',
          invoiceNumber:  invoice.invoiceNumber,
          dueDate:        invoice.dueDate,
          totalAmount:    invoice.totalAmount,
          remainingBalance: invoice.remainingBalance,
          currencyCode:   invoice.currencyCode || 'PKR',
          cadenceLabel:   cadence.label,
          tone:           cadence.tone,
          businessName:   business.businessName,
          businessEmail:  business.email,
          businessPhone:  business.phone,
        });

        // Persist that this cadence fired
        invoice.reminderHistory = invoice.reminderHistory || [];
        invoice.reminderHistory.push({
          cadenceKey: cadence.key,
          firedAt:    new Date(),
          channel:    'email',
          to:         email,
        });
        await invoice.save();
        stats.fired += 1;
      } catch (err) {
        logger.error(`[reminder] Invoice ${invoice._id} failed: ${err.message}`);
        stats.errors += 1;
      }
    }
    return stats;
  }

  /**
   * Scan ALL businesses (used by the daily cron job).
   */
  async scanAll(today = new Date()) {
    const businesses = await Business.find({ isActive: { $ne: false } })
      .select('_id businessName email phone').lean();

    const aggregate = { businesses: 0, scanned: 0, fired: 0, skipped: 0, errors: 0 };
    for (const biz of businesses) {
      aggregate.businesses += 1;
      try {
        const stats = await this.scanBusiness(biz, today);
        aggregate.scanned += stats.scanned;
        aggregate.fired += stats.fired;
        aggregate.skipped += stats.skipped;
        aggregate.errors += stats.errors;
      } catch (err) {
        logger.error(`[reminder] Business ${biz._id} failed: ${err.message}`);
        aggregate.errors += 1;
      }
    }
    return aggregate;
  }
}

module.exports = new PaymentReminderService();
module.exports.CADENCES = CADENCES;
