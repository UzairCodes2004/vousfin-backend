// services/business.service.js
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const businessRepository = require('../repositories/business.repository');
const accountRepository = require('../repositories/account.repository');
const userRepository = require('../repositories/user.repository');
const { ApiError } = require('../utils/ApiError');
const { USER_STATUS, BUSINESS_TYPES, DEFAULT_CURRENCY } = require('../config/constants');
const logger = require('../config/logger');

/**
 * Every collection that stores data for one business carries a `businessId`
 * field. Rather than maintain a hand-written list (which silently goes stale
 * every time a new model is added), we delete from *every* registered model
 * whose schema has a `businessId` path — except the Business and User docs
 * themselves. This guarantees a wipe is always complete.
 *
 * @param {string} businessId
 * @returns {Promise<Object>} map of { modelName: deletedCount }
 */
/**
 * Make sure EVERY Mongoose model is registered before we wipe. The wipe walks
 * `mongoose.modelNames()`, so any model that hasn't been required yet would be
 * silently skipped — leaving orphaned data behind on a "complete" delete. We
 * require every `*.model.js` once (require() is cached, so this is cheap).
 */
function ensureAllModelsRegistered() {
  const modelsDir = path.join(__dirname, '..', 'models');
  for (const file of fs.readdirSync(modelsDir)) {
    if (file.endsWith('.model.js')) {
      require(path.join(modelsDir, file)); // eslint-disable-line global-require, import/no-dynamic-require
    }
  }
}

async function wipeBusinessScopedData(businessId) {
  ensureAllModelsRegistered();
  const bizId = new mongoose.Types.ObjectId(String(businessId));
  const deleted = {};
  for (const name of mongoose.modelNames()) {
    if (name === 'Business' || name === 'User') continue;
    const Model = mongoose.model(name);
    if (!Model.schema || !Model.schema.path('businessId')) continue;
    try {
      // Use the native driver (collection.deleteMany) so this DELIBERATE,
      // user-confirmed purge bypasses Mongoose delete middleware — namely the
      // audit-log immutability guard and the journal period-lock guard. Those
      // hooks exist to block accidental/normal deletes, not a full business wipe.
      const res = await Model.collection.deleteMany({ businessId: bizId });
      const count = res.deletedCount || 0;
      if (count) deleted[name] = count;
    } catch (err) {
      logger.error(`[wipeBusinessScopedData] failed to clear ${name} for business ${businessId}: ${err.message}`);
      throw err; // surface — a partial wipe must not be reported as success
    }
  }
  return deleted;
}

class BusinessService {
  /**
   * Create a new business profile for a user and seed default chart of accounts.
   * @param {string} userId - User ID (must be active and not have a business)
   * @param {Object} businessData - { businessName, businessType, currency, fiscalYearStartMonth, logoUrl (optional) }
   * @param {string} ipAddress
   * @returns {Promise<Object>} - Created business object
   */
  async createBusiness(userId, businessData, ipAddress) {
    // Validate user exists and is active
    const user = await userRepository.findActiveById(userId);
    if (!user) {
      throw new ApiError(404, 'User not found or inactive');
    }
    if (user.status !== USER_STATUS.ACTIVE) {
      throw new ApiError(403, 'Account not verified. Please verify your email first.');
    }

    // Check if user already has a business
    const existing = await businessRepository.existsForUser(userId);
    if (existing) {
      throw new ApiError(409, 'Business profile already exists for this user');
    }

    // Validate business type
    if (!BUSINESS_TYPES.includes(businessData.businessType)) {
      throw new ApiError(400, `Invalid business type. Must be one of: ${BUSINESS_TYPES.join(', ')}`);
    }

    // Validate fiscal year month
    let fiscalYearStartMonth = businessData.fiscalYearStartMonth || 1;
    if (fiscalYearStartMonth < 1 || fiscalYearStartMonth > 12) {
      throw new ApiError(400, 'Fiscal year start month must be between 1 and 12');
    }

    // Create business
    const business = await businessRepository.create({
      userId,
      businessName: businessData.businessName.trim(),
      registrationNumber: businessData.registrationNumber?.trim() || null,
      businessType: businessData.businessType,
      currency: businessData.currency || DEFAULT_CURRENCY,
      fiscalYearStartMonth,
      logoUrl: businessData.logoUrl || null,
    });

    // Seed default Chart of Accounts
    await accountRepository.bulkCreateDefaultAccounts(business._id);

    // Link business to user
    await userRepository.update(userId, { businessId: business._id });

    logger.info(`Business created for user ${userId} (${business.businessName}) from IP ${ipAddress}`);
    return business;
  }

  /**
   * Get business profile by user ID.
   * @param {string} userId
   * @param {boolean} includeAccountCount - Whether to include total number of accounts
   * @returns {Promise<Object|null>}
   */
  async getBusinessByUserId(userId, includeAccountCount = false) {
    const business = await businessRepository.findByUserId(userId);
    if (!business) return null;

    if (includeAccountCount) {
      const accounts = await accountRepository.findByBusiness(business._id);
      business._doc = business._doc || {};
      business._doc.accountCount = accounts.length;
    }
    return business;
  }

  /**
   * Update business settings.
   * @param {string} businessId
   * @param {Object} updateData - Fields to update (businessName, businessType, currency, fiscalYearStartMonth, logoUrl)
   * @param {string} userId - For audit logging (who performed the update)
   * @param {string} ipAddress
   * @returns {Promise<Object>} Updated business
   */
  async updateBusiness(businessId, updateData, userId, ipAddress) {
    // Verify business exists
    const business = await businessRepository.findById(businessId);
    if (!business) {
      throw new ApiError(404, 'Business not found');
    }

    // Validate business type if provided
    if (updateData.businessType && !BUSINESS_TYPES.includes(updateData.businessType)) {
      throw new ApiError(400, `Invalid business type. Must be one of: ${BUSINESS_TYPES.join(', ')}`);
    }

    // Validate fiscal year month if provided
    if (updateData.fiscalYearStartMonth !== undefined) {
      const month = parseInt(updateData.fiscalYearStartMonth, 10);
      if (isNaN(month) || month < 1 || month > 12) {
        throw new ApiError(400, 'Fiscal year start month must be between 1 and 12');
      }
      updateData.fiscalYearStartMonth = month;
    }

    const updated = await businessRepository.updateBusinessSettings(businessId, updateData);
    logger.info(`Business ${businessId} updated by user ${userId} from IP ${ipAddress}`);
    return updated;
  }

  /**
   * Check if a user already has a business profile.
   * @param {string} userId
   * @returns {Promise<boolean>}
   */
  async hasBusiness(userId) {
    return businessRepository.existsForUser(userId);
  }

  /**
   * Reset a business to a clean slate: erase ALL of its data (transactions,
   * customers, vendors, invoices, bills, journal entries, reports, etc.) but
   * KEEP the business profile itself, then re-seed a fresh default chart of
   * accounts with zero balances.
   *
   * Use case: a user who entered test data and wants to start recording for
   * real without creating a whole new business.
   *
   * @param {string} businessId
   * @param {string} userId - who initiated (for the audit log)
   * @returns {Promise<{wiped: Object}>}
   */
  async resetBusinessData(businessId, userId) {
    const business = await businessRepository.findById(businessId);
    if (!business) {
      throw new ApiError(404, 'Business not found');
    }

    // Wipe everything scoped to this business (this includes the chart of
    // accounts, so running balances are cleared too).
    const wiped = await wipeBusinessScopedData(businessId);

    // Re-seed a fresh default chart of accounts (zero balances).
    await accountRepository.bulkCreateDefaultAccounts(businessId);

    logger.warn(
      `Business ${businessId} (${business.businessName}) DATA RESET by user ${userId}. Cleared: ${JSON.stringify(wiped)}`
    );
    return { wiped };
  }

  /**
   * Permanently delete a business and ALL of its associated data, then unlink
   * it from the owner so they can create a new one.
   *
   * Used both by the account-owner (self-service "delete my business") and by
   * the admin user-deletion flow.
   *
   * @param {string} businessId
   * @param {string} userId - User initiating the deletion (for audit)
   * @returns {Promise<{wiped: Object}>}
   */
  async deleteBusiness(businessId, userId) {
    // Verify business exists
    const business = await businessRepository.findById(businessId);
    if (!business) {
      throw new ApiError(404, 'Business not found');
    }

    // Erase every collection that belongs to this business.
    const wiped = await wipeBusinessScopedData(businessId);

    // Delete the business itself.
    await businessRepository.delete(businessId);

    // Remove business reference from user so they can set up a new one.
    await userRepository.update(business.userId, { businessId: null });

    logger.warn(
      `Business ${businessId} (${business.businessName}) DELETED by user ${userId}. Cleared: ${JSON.stringify(wiped)}`
    );
    return { wiped };
  }
}

module.exports = new BusinessService();