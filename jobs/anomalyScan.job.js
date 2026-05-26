// jobs/anomalyScan.job.js
const cron    = require('node-cron');
const os      = require('os');
const mongoose = require('mongoose');
const anomalyDetectionService = require('../services/anomalyDetection.service');
const userRepository = require('../repositories/user.repository');
const logger  = require('../config/logger');
const config  = require('../config');

// ─── Distributed cron lock ─────────────────────────────────────────────────────
// Prevents duplicate scans when Render scales to 2+ instances.
// A MongoDB document acts as a distributed mutex:
//   - Each instance tries to acquire the lock before running.
//   - The lock has a 7-hour TTL. If a scan hangs, the next instance can steal
//     the lock after the TTL expires.
//   - Release happens explicitly when the scan completes.
//
// ⚠ WARNING: The lock is stored in a collection defined inline here using a raw
// mongoose model to avoid adding a new model file. In production, move this to
// a proper SystemLock model file.
const LOCK_COLLECTION = 'cronlocks';
const LOCK_ID         = 'anomaly-scan-lock';
const LOCK_TTL_MS     = 7 * 60 * 60 * 1000;  // 7 hours
const INSTANCE_ID     = `${os.hostname()}-${process.pid}`;

let CronLock;
const getCronLockModel = () => {
  if (CronLock) return CronLock;
  const schema = new mongoose.Schema({
    _id:          String,
    lockedBy:     String,
    lockedAt:     Date,
    lockedUntil:  Date,
  }, { collection: LOCK_COLLECTION, _id: false, versionKey: false });
  CronLock = mongoose.models['CronLock'] || mongoose.model('CronLock', schema);
  return CronLock;
};

/**
 * Try to acquire the distributed anomaly-scan lock.
 * Returns true if acquired, false if another instance holds it.
 */
const acquireLock = async () => {
  const model = getCronLockModel();
  const now   = new Date();
  const until = new Date(Date.now() + LOCK_TTL_MS);
  try {
    // Attempt to update an expired/missing lock atomically
    const result = await model.findOneAndUpdate(
      {
        _id: LOCK_ID,
        $or: [
          { lockedUntil: { $lt: now } },   // lock has expired
          { _id: { $exists: false } },       // lock document not yet created
        ],
      },
      {
        $set: { lockedBy: INSTANCE_ID, lockedAt: now, lockedUntil: until },
        $setOnInsert: { _id: LOCK_ID },
      },
      { upsert: true, new: true }
    );
    // If result is null, the $or filter didn't match — lock is held by another instance
    return !!result;
  } catch (err) {
    // Upsert duplicate key = another instance just grabbed it
    if (err.code === 11000) return false;
    logger.warn(`Anomaly cron: lock acquisition error (${err.message}) — skipping to be safe`);
    return false;
  }
};

/**
 * Release the lock if this instance holds it.
 */
const releaseLock = async () => {
  const model = getCronLockModel();
  try {
    await model.deleteOne({ _id: LOCK_ID, lockedBy: INSTANCE_ID });
  } catch (err) {
    logger.warn(`Anomaly cron: failed to release lock — ${err.message}`);
  }
};

/**
 * Run anomaly detection for a single business.
 * Background scans always respect existing user decisions (force=false).
 * @param {string} businessId
 * @returns {Promise<Object>}
 */
const runScanForBusiness = async (businessId) => {
  try {
    const result = await anomalyDetectionService.runScan(businessId, { force: false });
    logger.info(`Anomaly scan for business ${businessId}: ${result.anomaliesFound} new/active anomalies, ${result.alertsCreated} new alerts, ${result.suppressed} suppressed`);
    return result;
  } catch (error) {
    logger.error(`Anomaly scan failed for business ${businessId}: ${error.message}`);
    return { anomaliesFound: 0, alertsCreated: 0, error: error.message };
  }
};

/**
 * Scan all active businesses.
 * @returns {Promise<{totalBusinesses: number, totalAnomalies: number, totalAlerts: number}>}
 */
const scanAllActiveBusinesses = async () => {
  logger.info('Starting anomaly detection scan for all active businesses');
  const startTime = Date.now();

  // Get all active customers (users with role=customer and status=active who have businessId)
  const activeCustomers = await userRepository.findAll({
    role: 'customer',
    status: 'active',
    businessId: { $ne: null },
  });
  const businesses = activeCustomers.data.filter(u => u.businessId).map(u => u.businessId);
  
  if (businesses.length === 0) {
    logger.info('No active businesses found to scan');
    return { totalBusinesses: 0, totalAnomalies: 0, totalAlerts: 0 };
  }

  logger.info(`Found ${businesses.length} active businesses to scan`);
  let totalAnomalies = 0;
  let totalAlerts = 0;
  let succeeded = 0;

  for (const businessId of businesses) {
    const result = await runScanForBusiness(businessId);
    if (!result.error) {
      succeeded++;
      totalAnomalies += result.anomaliesFound || 0;
      totalAlerts += result.alertsCreated || 0;
    }
  }

  const duration = Date.now() - startTime;
  logger.info(`Anomaly scan completed: ${succeeded}/${businesses.length} businesses, ${totalAnomalies} anomalies, ${totalAlerts} alerts created in ${duration}ms`);
  
  return {
    totalBusinesses: businesses.length,
    succeeded,
    totalAnomalies,
    totalAlerts,
    duration,
  };
};

// /**
//  * Schedule the cron job.
//  * Default schedule: every 6 hours (0 */6 * * *)
//  * Read from config.ANOMALY_SCAN_CRON if provided.**/
 
const scheduleAnomalyScan = () => {
  const cronSchedule = config.ANOMALY_SCAN_CRON || '0 */6 * * *';

  cron.schedule(cronSchedule, async () => {
    const now = new Date().toISOString();

    // ── Distributed lock guard ──────────────────────────────────────────────
    // Prevents duplicate scans when 2+ instances run this cron simultaneously.
    const acquired = await acquireLock();
    if (!acquired) {
      logger.info(`Anomaly cron skipped at ${now} — lock held by another instance`);
      return;
    }

    logger.info(`Anomaly cron lock acquired by ${INSTANCE_ID} at ${now}`);
    try {
      await scanAllActiveBusinesses();
    } catch (error) {
      logger.error(`Scheduled anomaly scan failed: ${error.message}`);
    } finally {
      await releaseLock();
      logger.info(`Anomaly cron lock released by ${INSTANCE_ID}`);
    }
  });

  logger.info(`Anomaly scan job scheduled with cron: ${cronSchedule} (instance: ${INSTANCE_ID})`);
};

module.exports = {
  scanAllActiveBusinesses,
  scheduleAnomalyScan,
};