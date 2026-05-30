/**
 * Migration / backfill — AR/AP Domain Refactor, Milestone M9.
 *
 * Retires the dual-write by tagging every AR/AP recognition JournalEntry that
 * has a matching authoritative Invoice/Bill document as an immutable PROJECTION
 * of that document (isProjection + projectionOf). This makes the document the
 * declared source of truth and the journal its generated ledger projection —
 * including the legacy transaction-first entries created before M9.
 *
 * Metadata only — never touches money/balances. Idempotent: re-running only
 * re-tags entries that aren't already linked, and converges to the same result.
 *
 * Run:  node migrations/mark_journal_projections.js
 *   or  npm run migrate:mark-projections
 */
'use strict';

const mongoose = require('mongoose');
require('dotenv').config();

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/vousfin';

async function migrate() {
  console.log('[mark-projections] connecting to MongoDB…');
  await mongoose.connect(MONGO_URI);
  console.log('[mark-projections] connected.');

  const JournalEntry = require('../models/JournalEntry.model');
  const Invoice = require('../models/Invoice.model');
  const Bill = require('../models/Bill.model');
  const { TRANSACTION_TYPES } = require('../config/constants');

  const sides = [
    { kind: 'invoice', Model: Invoice, txn: TRANSACTION_TYPES.CREDIT_SALE,     numberField: 'invoiceNumber', linkField: 'arJournalId' },
    { kind: 'bill',    Model: Bill,    txn: TRANSACTION_TYPES.CREDIT_PURCHASE, numberField: 'billNumber',    linkField: 'apLiabilityJournalId' },
  ];

  let tagged = 0, alreadyTagged = 0, unmatched = 0;

  for (const side of sides) {
    const cursor = JournalEntry.find({ transactionType: side.txn })
      .select('_id businessId invoiceNumber isProjection projectionOf').lean().cursor();

    for (let je = await cursor.next(); je != null; je = await cursor.next()) {
      if (je.isProjection && je.projectionOf && je.projectionOf.documentId) { alreadyTagged++; continue; }

      // Find the authoritative document: strong link first, then document number.
      let doc = await side.Model.findOne({ businessId: je.businessId, [side.linkField]: je._id }).select('_id').lean();
      if (!doc) doc = await side.Model.findOne({ businessId: je.businessId, linkedJournalEntryId: je._id }).select('_id').lean();
      if (!doc && je.invoiceNumber) {
        doc = await side.Model.findOne({ businessId: je.businessId, [side.numberField]: je.invoiceNumber }).select('_id').lean();
      }
      if (!doc) { unmatched++; continue; }

      await JournalEntry.updateOne(
        { _id: je._id },
        { $set: { isProjection: true, projectionOf: { documentType: side.kind, documentId: doc._id } } }
      );
      tagged++;
      if (tagged % 500 === 0) console.log(`[mark-projections] …tagged ${tagged}`);
    }
  }

  console.log(`[mark-projections] done — tagged ${tagged} · already-tagged ${alreadyTagged} · unmatched ${unmatched}`);
  await mongoose.connection.close();
  console.log('[mark-projections] connection closed.');
}

if (require.main === module) {
  migrate().catch((err) => { console.error('[mark-projections] fatal:', err); process.exit(1); });
}

module.exports = migrate;
