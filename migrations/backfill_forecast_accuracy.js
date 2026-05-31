/**
 * Migration / backfill — Forecast Platform Stage A2.
 *
 * Bootstraps the accuracy/confidence score for every business by replaying the
 * model walk-forward over its real history (no leakage, no fabricated actuals)
 * and seeding ModelRegistry. After this runs, A1's accuracy-score has genuine
 * signal from day one instead of "Insufficient" everywhere.
 *
 * Idempotent + safe to re-run. Never writes to the ledger.
 *
 * Run:  node migrations/backfill_forecast_accuracy.js
 *   or  npm run migrate:backfill-accuracy
 */
'use strict';
const mongoose = require('mongoose');
require('dotenv').config();

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/vousfin';

async function migrate() {
  console.log('[backfill-accuracy] connecting to MongoDB…');
  await mongoose.connect(MONGO_URI);
  console.log('[backfill-accuracy] connected.');

  const Business = require('../models/Business.model');
  const accuracyBackfill = require('../services/forecasting/accuracyBackfill.service');

  const businesses = await Business.find({ isActive: { $ne: false } }).select('_id businessName').lean();
  console.log(`[backfill-accuracy] ${businesses.length} businesses`);

  const agg = { businesses: 0, targets: 0, points: 0, skipped: 0, errors: 0 };
  for (const biz of businesses) {
    agg.businesses += 1;
    try {
      const s = await accuracyBackfill.backfillBusiness(biz._id);
      agg.targets += s.targets || 0;
      agg.points += s.points || 0;
      agg.skipped += s.skipped || 0;
    } catch (err) {
      agg.errors += 1;
      console.error(`[backfill-accuracy] ${biz._id} failed: ${err.message}`);
    }
    if (agg.businesses % 50 === 0) console.log(`[backfill-accuracy] …${agg.businesses}/${businesses.length}`);
  }

  console.log(`[backfill-accuracy] done — ${agg.targets} target-series · ${agg.points} accuracy points · skipped ${agg.skipped} · errors ${agg.errors}`);
  await mongoose.connection.close();
  console.log('[backfill-accuracy] connection closed.');
}

if (require.main === module) {
  migrate().catch((err) => { console.error('[backfill-accuracy] fatal:', err); process.exit(1); });
}

module.exports = migrate;
