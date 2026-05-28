// jobs/paymentReminder.job.js
//
// Phase 2.1 — Daily cron job that scans all businesses and emails
// outstanding-payment reminders to customers at the appropriate cadence.
//
// Cron schedule: 08:00 server time, every day.
// Distributed lock prevents double-scans on multi-instance deployments.
//

const cron = require('node-cron');
const os = require('os');
const mongoose = require('mongoose');
const paymentReminderService = require('../services/paymentReminder.service');
const logger = require('../config/logger');

const LOCK_COLLECTION = 'cronlocks';
const LOCK_ID         = 'payment-reminder-lock';
const LOCK_TTL_MS     = 3 * 60 * 60 * 1000; // 3 hours
const INSTANCE_ID     = `${os.hostname()}-${process.pid}`;

let CronLock;
const getCronLockModel = () => {
  if (CronLock) return CronLock;
  const schema = new mongoose.Schema({
    _id:         String,
    lockedBy:    String,
    lockedAt:    Date,
    lockedUntil: Date,
  }, { collection: LOCK_COLLECTION, _id: false, versionKey: false });
  CronLock = mongoose.models['CronLock'] || mongoose.model('CronLock', schema);
  return CronLock;
};

async function acquireLock() {
  const Lock = getCronLockModel();
  const now = new Date();
  const until = new Date(now.getTime() + LOCK_TTL_MS);
  try {
    await Lock.findOneAndUpdate(
      {
        _id: LOCK_ID,
        $or: [
          { lockedUntil: { $lt: now } },
          { lockedUntil: { $exists: false } },
        ],
      },
      {
        $set: { lockedBy: INSTANCE_ID, lockedAt: now, lockedUntil: until },
      },
      { upsert: true, new: true }
    );
    const fresh = await Lock.findById(LOCK_ID).lean();
    return fresh?.lockedBy === INSTANCE_ID;
  } catch (err) {
    if (err.code === 11000) return false; // race lost — another instance got it
    throw err;
  }
}

async function releaseLock() {
  const Lock = getCronLockModel();
  try {
    await Lock.deleteOne({ _id: LOCK_ID, lockedBy: INSTANCE_ID });
  } catch (err) {
    logger.warn(`[reminder-cron] Failed to release lock: ${err.message}`);
  }
}

/**
 * Run the reminder scan once.  Public so tests + manual triggers can call it.
 */
async function runOnce() {
  const acquired = await acquireLock();
  if (!acquired) {
    logger.info('[reminder-cron] Skipping — another instance holds the lock');
    return null;
  }
  const startedAt = Date.now();
  logger.info(`[reminder-cron] Starting daily scan as ${INSTANCE_ID}`);
  try {
    const stats = await paymentReminderService.scanAll(new Date());
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    logger.info(`[reminder-cron] Done in ${elapsed}s — businesses=${stats.businesses}, scanned=${stats.scanned}, fired=${stats.fired}, skipped=${stats.skipped}, errors=${stats.errors}`);
    return stats;
  } catch (err) {
    logger.error(`[reminder-cron] Scan failed: ${err.message}`);
    throw err;
  } finally {
    await releaseLock();
  }
}

/**
 * Register the cron schedule.  Should be called once at app startup.
 */
function schedulePaymentReminders() {
  // 0 8 * * *  → every day at 08:00 server time
  cron.schedule('0 8 * * *', () => {
    runOnce().catch(err => logger.error(`[reminder-cron] Top-level: ${err.message}`));
  }, { timezone: process.env.CRON_TIMEZONE || 'Asia/Karachi' });

  logger.info('⏰ Payment-reminder cron scheduled (daily 08:00)');
}

module.exports = { schedulePaymentReminders, runOnce };
