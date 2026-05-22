const customerRepository = require('../repositories/customer.repository');
const transactionRepository = require('../repositories/transaction.repository');
const JournalEntry = require('../models/JournalEntry.model');
const { ApiError } = require('../utils/ApiError');
const { TRANSACTION_TYPES, PAYMENT_STATUS } = require('../config/constants');
const logger = require('../config/logger');
const mongoose = require('mongoose');

class CustomerService {
  /**
   * Create a new customer
   * @param {string} businessId - The business ID
   * @param {Object} customerData - Customer details
   * @returns {Promise<Object>} - Created customer object
   */
  async createCustomer(businessId, customerData) {
    if (!businessId) {
      throw new ApiError(400, 'Business ID is required');
    }
    const customer = await customerRepository.create({
      businessId,
      ...customerData
    });
    logger.info(`Customer created for business ${businessId}: ${customer._id}`);
    return customer;
  }

  /**
   * Update an existing customer
   * @param {string} customerId - The customer ID
   * @param {string} businessId - The business ID
   * @param {Object} updateData - Fields to update
   * @returns {Promise<Object>} - Updated customer object
   */
  async updateCustomer(customerId, businessId, updateData) {
    const customer = await customerRepository.findByBusinessAndId(businessId, customerId);
    if (!customer) {
      throw new ApiError(404, 'Customer not found');
    }
    const updated = await customerRepository.update(customerId, updateData);
    logger.info(`Customer updated: ${customerId}`);
    return updated;
  }

  /**
   * Get a customer by ID
   * @param {string} customerId - The customer ID
   * @param {string} businessId - The business ID
   * @returns {Promise<Object>} - Customer object
   */
  async getCustomerById(customerId, businessId) {
    const customer = await customerRepository.findByBusinessAndId(businessId, customerId);
    if (!customer) {
      throw new ApiError(404, 'Customer not found');
    }
    return customer;
  }

  /**
   * List customers for a business
   * @param {string} businessId - The business ID
   * @param {Object} filters - Optional filters
   * @param {Object} pagination - Pagination parameters
   * @returns {Promise<Object>} - Paginated list of customers
   */
  async listCustomers(businessId, filters = {}, pagination = {}) {
    if (!businessId) {
      throw new ApiError(400, 'Business ID is required');
    }
    return customerRepository.findByBusiness(businessId, filters, pagination);
  }

  /**
   * Get total balance for a customer
   * @param {string} customerId - The customer ID
   * @param {string} businessId - The business ID
   * @returns {Promise<number>} - Customer balance
   */
  async getCustomerBalance(customerId, businessId) {
    const customer = await customerRepository.findByBusinessAndId(businessId, customerId);
    if (!customer) {
      throw new ApiError(404, 'Customer not found');
    }
    return customer.currentReceivableBalance || 0;
  }

  /**
   * Get transaction history for a customer
   * @param {string} customerId - The customer ID
   * @param {string} businessId - The business ID
   * @param {Object} filters - Optional transaction filters
   * @param {Object} pagination - Pagination and sorting options
   * @returns {Promise<Object>} - Paginated transaction history
   */
  async getCustomerTransactionHistory(customerId, businessId, filters = {}, pagination = {}) {
    const customer = await customerRepository.findByBusinessAndId(businessId, customerId);
    if (!customer) {
      throw new ApiError(404, 'Customer not found');
    }
    return transactionRepository.findByCustomer(businessId, customerId, filters, pagination);
  }

  /**
   * Aggregate ERP-style customer activity statistics.
   *
   * Returns:
   *   - currentReceivable       : Outstanding AR (denormalized field)
   *   - lifetimeRevenue         : Sum of all Credit Sale + Income amounts
   *   - lifetimePaymentsReceived: Sum of Payment Received amounts
   *   - invoiceCount            : Count of Credit Sale entries
   *   - paymentCount            : Count of Payment Received entries
   *   - avgInvoiceValue         : Average Credit Sale amount
   *   - overdueCount            : Number of overdue invoices (paymentStatus = OVERDUE)
   *   - lastInvoiceDate         : Most recent Credit Sale date
   *   - lastPaymentDate         : Most recent Payment Received date
   *   - lastActivityDate        : Most recent activity of ANY type
   *
   * @param {string} customerId
   * @param {string} businessId
   * @returns {Promise<Object>}
   */
  async getCustomerStats(customerId, businessId) {
    const customer = await customerRepository.findByBusinessAndId(businessId, customerId);
    if (!customer) throw new ApiError(404, 'Customer not found');

    const customerObjId = new mongoose.Types.ObjectId(String(customerId));
    const businessObjId = new mongoose.Types.ObjectId(String(businessId));

    const [stats] = await JournalEntry.aggregate([
      {
        $match: {
          businessId: businessObjId,
          customerId: customerObjId,
          isArchived: { $ne: true },
        },
      },
      {
        $group: {
          _id: null,
          lifetimeRevenue: {
            $sum: {
              $cond: [
                { $in: ['$transactionType', [TRANSACTION_TYPES.CREDIT_SALE, TRANSACTION_TYPES.INCOME]] },
                '$amount',
                0,
              ],
            },
          },
          lifetimePaymentsReceived: {
            $sum: {
              $cond: [
                { $eq: ['$transactionType', TRANSACTION_TYPES.PAYMENT_RECEIVED] },
                '$amount',
                0,
              ],
            },
          },
          invoiceCount: {
            $sum: {
              $cond: [{ $eq: ['$transactionType', TRANSACTION_TYPES.CREDIT_SALE] }, 1, 0],
            },
          },
          paymentCount: {
            $sum: {
              $cond: [{ $eq: ['$transactionType', TRANSACTION_TYPES.PAYMENT_RECEIVED] }, 1, 0],
            },
          },
          overdueCount: {
            $sum: {
              $cond: [{ $eq: ['$paymentStatus', PAYMENT_STATUS.OVERDUE] }, 1, 0],
            },
          },
          invoiceAmountSum: {
            $sum: {
              $cond: [{ $eq: ['$transactionType', TRANSACTION_TYPES.CREDIT_SALE] }, '$amount', 0],
            },
          },
          lastInvoiceDate: {
            $max: {
              $cond: [
                { $eq: ['$transactionType', TRANSACTION_TYPES.CREDIT_SALE] },
                '$transactionDate',
                null,
              ],
            },
          },
          lastPaymentDate: {
            $max: {
              $cond: [
                { $eq: ['$transactionType', TRANSACTION_TYPES.PAYMENT_RECEIVED] },
                '$transactionDate',
                null,
              ],
            },
          },
          lastActivityDate: { $max: '$transactionDate' },
        },
      },
    ]);

    const safe = stats || {
      lifetimeRevenue: 0,
      lifetimePaymentsReceived: 0,
      invoiceCount: 0,
      paymentCount: 0,
      overdueCount: 0,
      invoiceAmountSum: 0,
      lastInvoiceDate: null,
      lastPaymentDate: null,
      lastActivityDate: null,
    };

    return {
      currentReceivable: customer.currentReceivableBalance || 0,
      lifetimeRevenue: safe.lifetimeRevenue,
      lifetimePaymentsReceived: safe.lifetimePaymentsReceived,
      invoiceCount: safe.invoiceCount,
      paymentCount: safe.paymentCount,
      overdueCount: safe.overdueCount,
      avgInvoiceValue: safe.invoiceCount > 0
        ? Math.round((safe.invoiceAmountSum / safe.invoiceCount) * 100) / 100
        : 0,
      lastInvoiceDate: safe.lastInvoiceDate,
      lastPaymentDate: safe.lastPaymentDate,
      lastActivityDate: safe.lastActivityDate,
    };
  }

  /**
   * Toggle the active status of a customer
   * @param {string} customerId - The customer ID
   * @param {string} businessId - The business ID
   * @returns {Promise<Object>} - Updated customer object
   */
  async toggleCustomerActive(customerId, businessId) {
    const customer = await customerRepository.findByBusinessAndId(businessId, customerId);
    if (!customer) {
      throw new ApiError(404, 'Customer not found');
    }
    const newStatus = customer.isActive === undefined ? false : !customer.isActive;
    const updated = await customerRepository.update(customerId, { isActive: newStatus });
    logger.info(`Customer ${customerId} active status changed to ${newStatus}`);
    return updated;
  }
}

module.exports = new CustomerService();
