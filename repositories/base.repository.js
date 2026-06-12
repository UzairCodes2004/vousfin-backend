// repositories/base.repository.js
const logger = require('../config/logger');

// Strip infrastructure details (hostnames, ports, replica-set names) from
// Mongo driver errors before they propagate to HTTP responses.
function sanitizeDbError(error) {
  const msg = error?.message || String(error);
  // MongoDB driver errors contain the full topology description in their message.
  // Replace anything that looks like a hostname, IP:port, or connection failure —
  // e.g. "connection 17 to <ip>:27017 timed out" must never reach a client.
  if (msg.includes('ENOTFOUND') || msg.includes('ETIMEOUT') || msg.includes('ECONNREFUSED') ||
      msg.includes('topology') || msg.includes('mongod') || msg.includes('mongodb.net') ||
      msg.includes('timed out') || msg.includes('Server selection') ||
      /\bconnection \d+ to\b/.test(msg) ||
      /\b\d{1,3}(\.\d{1,3}){3}:\d{2,5}\b/.test(msg)) {
    return 'Database connection error. Please try again.';
  }
  // Duplicate key: expose constraint name but not internal field path
  if (error?.code === 11000) {
    return 'A record with this value already exists.';
  }
  return msg;
}

/**
 * Generic base repository providing common CRUD operations.
 * @template T - Mongoose model type
 */
class BaseRepository {
  /**
   * @param {import('mongoose').Model} model - Mongoose model
   */
  constructor(model) {
    this.model = model;
  }

  /**
   * Create a new document.
   * @param {Object} data - Document data
   * @returns {Promise<Object>} Created document
   */
  async create(data) {
    try {
      const document = new this.model(data);
      return await document.save();
    } catch (error) {
      logger.error(`[BaseRepository.create] ${error.message}`);
      throw new Error(`Error creating document: ${sanitizeDbError(error)}`);
    }
  }

  /**
   * Find document by ID.
   * @param {string|import('mongoose').Types.ObjectId} id
   * @param {string|Array} populateFields - Fields to populate (e.g., 'userId' or ['userId', 'businessId'])
   * @returns {Promise<Object|null>}
   */
  async findById(id, populateFields = null) {
    try {
      let query = this.model.findById(id);
      if (populateFields) {
        if (Array.isArray(populateFields)) {
          populateFields.forEach(field => {
            query = query.populate(field);
          });
        } else {
          query = query.populate(populateFields);
        }
      }
      return await query.exec();
    } catch (error) {
      logger.error(`[BaseRepository.findById] ${error.message}`);
      throw new Error(`Error finding document by ID: ${sanitizeDbError(error)}`);
    }
  }

  /**
   * Find a single document matching conditions.
   * @param {Object} conditions - MongoDB query conditions
   * @param {string|Array} populateFields - Optional populate
   * @returns {Promise<Object|null>}
   */
  async findOne(conditions, populateFields = null) {
    try {
      let query = this.model.findOne(conditions);
      if (populateFields) {
        if (Array.isArray(populateFields)) {
          populateFields.forEach(field => {
            query = query.populate(field);
          });
        } else {
          query = query.populate(populateFields);
        }
      }
      return await query.exec();
    } catch (error) {
      logger.error(`[BaseRepository.findOne] ${error.message}`);
      throw new Error(`Error finding document: ${sanitizeDbError(error)}`);
    }
  }

  /**
   * Find multiple documents with pagination and sorting.
   * @param {Object} conditions - MongoDB query conditions
   * @param {Object} options - { page, limit, sort, select }
   * @returns {Promise<{data: Array, total: number, page: number, limit: number}>}
   */
  async findAll(conditions = {}, options = {}) {
    const {
      page = 1,
      limit = 25,
      sort = { createdAt: -1 },
      select = null,
      populate = null,
    } = options;

    const skip = (page - 1) * limit;

    try {
      let query = this.model.find(conditions);
      if (select) query = query.select(select);
      if (populate) {
        if (Array.isArray(populate)) {
          populate.forEach(field => {
            query = query.populate(field);
          });
        } else {
          query = query.populate(populate);
        }
      }
      const [data, total] = await Promise.all([
        query.sort(sort).skip(skip).limit(limit).exec(),
        this.model.countDocuments(conditions),
      ]);
      return { data, total, page, limit };
    } catch (error) {
      logger.error(`[BaseRepository.findAll] ${error.message}`);
      throw new Error(`Error finding documents: ${sanitizeDbError(error)}`);
    }
  }

  /**
   * Update a document by ID.
   * @param {string|import('mongoose').Types.ObjectId} id
   * @param {Object} updateData - Fields to update
   * @param {Object} options - Mongoose update options (e.g., { new: true })
   * @returns {Promise<Object|null>}
   */
  async update(id, updateData, options = { new: true }) {
    try {
      return await this.model.findByIdAndUpdate(id, updateData, options).exec();
    } catch (error) {
      logger.error(`[BaseRepository.update] ${error.message}`);
      throw new Error(`Error updating document: ${sanitizeDbError(error)}`);
    }
  }

  /**
   * Permanently delete a document by ID.
   * Note: For financial systems, prefer soft deletion (setting a status field).
   * @param {string|import('mongoose').Types.ObjectId} id
   * @returns {Promise<Object|null>}
   */
  async delete(id) {
    try {
      return await this.model.findByIdAndDelete(id).exec();
    } catch (error) {
      logger.error(`[BaseRepository.delete] ${error.message}`);
      throw new Error(`Error deleting document: ${sanitizeDbError(error)}`);
    }
  }

  /**
   * Count documents matching conditions.
   * @param {Object} conditions
   * @returns {Promise<number>}
   */
  async count(conditions = {}) {
    try {
      return await this.model.countDocuments(conditions);
    } catch (error) {
      logger.error(`[BaseRepository.count] ${error.message}`);
      throw new Error(`Error counting documents: ${sanitizeDbError(error)}`);
    }
  }

  /**
   * Check if any document exists matching conditions.
   * @param {Object} conditions
   * @returns {Promise<boolean>}
   */
  async exists(conditions) {
    try {
      const count = await this.model.countDocuments(conditions).limit(1);
      return count > 0;
    } catch (error) {
      logger.error(`[BaseRepository.exists] ${error.message}`);
      throw new Error(`Error checking existence: ${sanitizeDbError(error)}`);
    }
  }

  /**
   * Run an aggregation pipeline.
   * @param {Array} pipeline - Mongoose aggregation pipeline
   * @returns {Promise<Array>}
   */
  async aggregate(pipeline) {
    try {
      return await this.model.aggregate(pipeline);
    } catch (error) {
      logger.error(`[BaseRepository.aggregate] ${error.message}`);
      throw new Error(`Aggregation error: ${sanitizeDbError(error)}`);
    }
  }
}

module.exports = BaseRepository;