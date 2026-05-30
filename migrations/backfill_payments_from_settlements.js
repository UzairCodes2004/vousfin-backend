/**
 * Migration / backfill — AR/AP Domain Refactor, Milestone M2.
 *
 * Creates first-class Payment records over EXISTING historical settlement
 * journal entries (child PAYMENT_RECEIVED / PAYMENT_MADE transactions). It does
 * NOT post any new ledger — the settlements already exist; this only groups each
 * into a single-allocation Payment so historical receipts/remittances become
 * visible as Payment documents.
 *
 * Idempotent: a child settlement that is already referenced by a Payment
 * (allocations.settlementTransactionId) is skipped. Safe to re-run.
 *
 * Run:  node migrations/backfill_payments_from_settlements.js
 *   or  npm run migrate:backfill-payment-records
 */
'use strict';

const mongoose = require('mongoose');
require('dotenv').config();

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/vousfin';

async function migrate() {
  console.log('[backfill-payments] connecting…');
  await mongoose.connect(MONGO_URI);
  console.log('[backfill-payments] connected.');

  const JournalEntry = require('../models/JournalEntry.model');
  const Invoice = require('../models/Invoice.model');
  const Bill = require('../models/Bill.model');
  const Payment = require('../models/Payment.model');
  const { TRANSACTION_TYPES } = require('../config/constants');

  const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

  const query = {
    transactionType: { $in: [TRANSACTION_TYPES.PAYMENT_RECEIVED, TRANSACTION_TYPES.PAYMENT_MADE] },
    parentTransactionId: { $ne: null },
    isArchived: { $ne: true },
  };
  const total = await JournalEntry.countDocuments(query);
  console.log(`[backfill-payments] ${total} historical settlement transactions`);

  const cursor = JournalEntry.find(query).sort({ transactionDate: 1, createdAt: 1 }).lean().cursor();

  let processed = 0, created = 0, skipped = 0, errors = 0;
  for (let child = await cursor.next(); child != null; child = await cursor.next()) {
    processed++;
    try {
      // Idempotency: already represented by a Payment?
      const exists = await Payment.findOne({
        businessId: child.businessId,
        'allocations.settlementTransactionId': child._id,
      }).select('_id').lean();
      if (exists) { skipped++; continue; }

      const parent = await JournalEntry.findOne({ _id: child.parentTransactionId, businessId: child.businessId }).lean();
      if (!parent) { skipped++; continue; }

      const inbound = child.transactionType === TRANSACTION_TYPES.PAYMENT_RECEIVED;
      const partyId = (inbound ? (child.customerId || parent.customerId) : (child.vendorId || parent.vendorId)) || null;
      if (!partyId) { skipped++; continue; }

      // Cash account: DR Cash on receipts, CR Cash on disbursements.
      const cashAccountId = inbound ? child.debitAccountId : child.creditAccountId;
      const documentType = inbound ? 'invoice' : 'bill';
      const Model = inbound ? Invoice : Bill;
      const doc = await Model.findOne({ businessId: child.businessId, linkedJournalEntryId: parent._id })
        .select('_id invoiceNumber billNumber').lean();

      const paymentNumber = await Payment.nextPaymentNumber(child.businessId);
      await Payment.create({
        businessId:   child.businessId,
        paymentNumber,
        direction:    inbound ? 'inbound' : 'outbound',
        partyType:    inbound ? 'customer' : 'vendor',
        partyId,
        paymentDate:  child.transactionDate || child.createdAt || new Date(),
        amount:       r2(child.amount),
        currencyCode: child.currencyCode || 'PKR',
        exchangeRate: child.exchangeRate || 1,
        method:       'other',
        reference:    child.transactionReference || null,
        cashAccountId,
        allocations: [{
          documentType,
          documentId:           doc ? doc._id : null,
          documentNumber:       doc ? (doc.invoiceNumber || doc.billNumber) : (parent.invoiceNumber || null),
          parentJournalEntryId: parent._id,
          amount:               r2(child.amount),
          settlementTransactionId: child._id,
        }],
        notes:        'Backfilled from historical settlement',
        createdBy:    child.createdBy,
      });
      created++;
    } catch (e) {
      errors++;
      console.error(`[backfill-payments] failed for settlement ${child._id}: ${e.message}`);
    }
    if (processed % 500 === 0) console.log(`[backfill-payments] …${processed}/${total}`);
  }

  console.log(`[backfill-payments] done — processed ${processed} · created ${created} · skipped ${skipped} · errors ${errors}`);
  await mongoose.connection.close();
  console.log('[backfill-payments] connection closed.');
}

if (require.main === module) {
  migrate().catch((err) => { console.error('[backfill-payments] fatal:', err); process.exit(1); });
}

module.exports = migrate;
