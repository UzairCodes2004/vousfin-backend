// services/inventory.service.js
const inventoryItemRepository = require('../repositories/inventoryItem.repository');
const { ApiError } = require('../utils/ApiError');
const logger = require('../config/logger');

class InventoryService {
  async createItem(businessId, data) {
    if (!businessId) throw new ApiError(400, 'Business ID is required');
    if (!data.name?.trim()) throw new ApiError(400, 'Item name is required');
    if (typeof data.unitCostPrice !== 'number' || data.unitCostPrice < 0) {
      throw new ApiError(400, 'Unit cost price must be a non-negative number');
    }
    // Duplicate SKU guard
    if (data.sku?.trim()) {
      const existing = await inventoryItemRepository.findBySku(businessId, data.sku.trim());
      if (existing) throw new ApiError(409, `SKU "${data.sku.trim()}" already exists`);
    }
    const item = await inventoryItemRepository.create({ businessId, ...data });
    logger.info(`Inventory item created: ${item._id} (${item.name}) for business ${businessId}`);
    return item;
  }

  async updateItem(businessId, itemId, data) {
    const item = await inventoryItemRepository.findByBusinessAndId(businessId, itemId);
    if (!item) throw new ApiError(404, 'Inventory item not found');
    if (data.sku?.trim() && data.sku !== item.sku) {
      const existing = await inventoryItemRepository.findBySku(businessId, data.sku.trim());
      if (existing && existing._id.toString() !== itemId) {
        throw new ApiError(409, `SKU "${data.sku.trim()}" already exists`);
      }
    }
    const updated = await inventoryItemRepository.update(itemId, data);
    return updated;
  }

  async getItemById(businessId, itemId) {
    const item = await inventoryItemRepository.findByBusinessAndId(businessId, itemId);
    if (!item) throw new ApiError(404, 'Inventory item not found');
    return item;
  }

  async listItems(businessId, filters = {}, pagination = {}) {
    if (!businessId) throw new ApiError(400, 'Business ID is required');
    return inventoryItemRepository.findByBusiness(businessId, filters, pagination);
  }

  /**
   * Add stock to an item (weighted-average cost update).
   *
   * Optionally posts an Inventory Purchase journal entry so the books reflect
   * how the stock was funded (cash, bank, payables, loan, etc.).
   *
   * @param {string} businessId
   * @param {string} itemId
   * @param {number} qty
   * @param {number} costPerUnit
   * @param {Object} [opts]
   * @param {string} [opts.paymentMode]      'cash' | 'bank' | 'credit' (AP) | 'loan'
   * @param {string} [opts.sourceAccountId]  Cash/Bank/Loan account to credit (required for cash/bank/loan)
   * @param {string} [opts.vendorId]         Vendor for AP posting (required for credit mode)
   * @param {string} [opts.userId]           Acting user id (for journal createdBy)
   * @param {string} [opts.ipAddress]
   * @param {Date}   [opts.transactionDate]  defaults to now
   * @param {string} [opts.notes]
   * @returns {Promise<{ item: Object, journalEntry: Object | null }>}
   */
  async addStock(businessId, itemId, qty, costPerUnit, opts = {}) {
    const item = await inventoryItemRepository.model.findOne({ _id: itemId, businessId });
    if (!item) throw new ApiError(404, 'Inventory item not found');

    let journalEntry = null;

    // ── Post an Inventory Purchase journal entry if paymentMode is provided ──
    if (opts.paymentMode) {
      const ChartOfAccount = require('../models/ChartOfAccount.model');
      const { TRANSACTION_TYPES, TRANSACTION_MODES, INPUT_METHODS } = require('../config/constants');

      // Resolve the Inventory account (debit side)
      const inventoryAcct = await ChartOfAccount.findOne({
        businessId,
        accountName: { $regex: /^inventory$/i },
      }).lean();
      if (!inventoryAcct) {
        throw new ApiError(400, 'Inventory account missing from chart of accounts — cannot post journal entry');
      }

      // Resolve the credit-side account based on paymentMode
      let creditAccountId = opts.sourceAccountId;
      let transactionMode = TRANSACTION_MODES.CASH;
      let vendorId = null;

      if (opts.paymentMode === 'credit') {
        // AP — credit the Accounts Payable account, set vendor reference
        const apAcct = await ChartOfAccount.findOne({
          businessId,
          accountName: { $regex: /accounts payable/i },
        }).lean();
        if (!apAcct) throw new ApiError(400, 'Accounts Payable account not found');
        creditAccountId = apAcct._id;
        transactionMode = TRANSACTION_MODES.CREDIT;
        vendorId = opts.vendorId || item.preferredVendorId || null;
        if (!vendorId) throw new ApiError(400, 'vendorId required for credit purchase');
      } else if (!creditAccountId) {
        throw new ApiError(400, `sourceAccountId required for paymentMode="${opts.paymentMode}"`);
      }

      const totalCost = Math.round(qty * costPerUnit * 100) / 100;
      const transactionService = require('./transaction.service');

      const jeData = {
        businessId,
        transactionDate: opts.transactionDate || new Date(),
        description: `Stock purchase: ${qty} ${item.unit || 'units'} of ${item.name}`,
        transactionType: TRANSACTION_TYPES.INVENTORY_PURCHASE,
        amount: totalCost,
        debitAccountId: inventoryAcct._id,
        creditAccountId,
        transactionMode,
        vendorId,
        inventoryItemId: item._id,
        inventoryQty: qty,
        inputMethod: INPUT_METHODS.FORM,
        notes: opts.notes || null,
      };

      // transaction.service handles auditing, AR/AP balance tracking, etc.
      // It expects (data, userId, ipAddress)
      journalEntry = await transactionService.createTransaction(
        jeData,
        opts.userId || null,
        opts.ipAddress || null
      );
      // The journal entry post path may or may not call addStock itself; check
      // current implementation — if it already adds stock, skip the manual call.
      // Otherwise we add stock here.
      // The current transaction.service does NOT call addStock for INVENTORY_PURCHASE,
      // so we still need to do it manually below.
    }

    await item.addStock(qty, costPerUnit);
    logger.info(`Stock added: ${qty} units of "${item.name}" (new stock: ${item.currentStock})`);
    return { item, journalEntry };
  }

  /**
   * Reduce stock and return COGS amount.
   * Called by transaction.service when recording an Inventory Sale.
   *
   * Side effect: if stock crosses the reorder threshold AFTER this reduction,
   * fire an automated reorder email to the item's preferredVendorId.
   *
   * @returns {{ cogsAmount: number, unitCostUsed: number, updatedStock: number }}
   */
  async reduceStock(businessId, itemId, qty) {
    const item = await inventoryItemRepository.model.findOne({ _id: itemId, businessId });
    if (!item) throw new ApiError(404, 'Inventory item not found');

    const stockBefore = item.currentStock;
    const { cogsAmount, unitCostUsed } = await item.reduceStock(qty);
    logger.info(`Stock reduced: ${qty} units of "${item.name}" → COGS ${cogsAmount}, remaining ${item.currentStock}`);

    // Reorder trigger: only fire when we just crossed the threshold (not on every sale)
    const justCrossed = stockBefore > item.reorderLevel && item.currentStock <= item.reorderLevel;
    if (justCrossed && item.reorderLevel > 0) {
      // Fire-and-forget — never block the sale on email
      this._fireReorderEmail(item, businessId).catch(err =>
        logger.error(`[reorder] Hook failed: ${err.message}`)
      );
    }

    return { cogsAmount, unitCostUsed, updatedStock: item.currentStock, itemName: item.name };
  }

  /**
   * Internal — resolve vendor + business details and dispatch the reorder email.
   * Lazy-requires to avoid circular deps and keep email infra optional.
   */
  async _fireReorderEmail(item, businessId) {
    if (!item.preferredVendorId) {
      logger.info(`[reorder] No preferredVendorId set for "${item.name}" — skipping email`);
      return;
    }
    const Vendor = require('../models/Vendor.model');
    const Business = require('../models/Business.model');
    const { sendReorderRequestEmail } = require('../utils/email.utils');

    const [vendor, business] = await Promise.all([
      Vendor.findById(item.preferredVendorId).lean(),
      Business.findById(businessId).select('businessName email').lean(),
    ]);
    if (!vendor) {
      logger.warn(`[reorder] Vendor ${item.preferredVendorId} not found for item "${item.name}"`);
      return;
    }
    await sendReorderRequestEmail({
      to:            vendor.email,
      vendorName:    vendor.businessName || vendor.fullName,
      itemName:      item.name,
      sku:           item.sku,
      currentStock:  item.currentStock,
      reorderLevel:  item.reorderLevel,
      reorderQty:    item.reorderQty,
      unit:          item.unit,
      businessName:  business?.businessName || 'vousFin Business',
      businessEmail: business?.email,
    });
  }

  async getLowStockAlerts(businessId) {
    return inventoryItemRepository.getLowStockItems(businessId);
  }

  async getInventoryValuation(businessId) {
    const { data: items } = await inventoryItemRepository.findByBusiness(
      businessId, { isActive: true }, { limit: 1000 }
    );
    const totalValue = items.reduce((sum, i) => sum + (i.currentStock * i.unitCostPrice), 0);
    const lowStockCount = items.filter(i => i.currentStock <= i.reorderLevel).length;
    return {
      itemCount: items.length,
      totalValue: Math.round(totalValue * 100) / 100,
      lowStockCount,
      items: items.map(i => ({
        _id: i._id,
        name: i.name,
        sku: i.sku,
        currentStock: i.currentStock,
        unitCostPrice: i.unitCostPrice,
        totalValue: Math.round(i.currentStock * i.unitCostPrice * 100) / 100,
        reorderLevel: i.reorderLevel,
        isLowStock: i.currentStock <= i.reorderLevel,
      })),
    };
  }

  async toggleActive(businessId, itemId) {
    const item = await inventoryItemRepository.findByBusinessAndId(businessId, itemId);
    if (!item) throw new ApiError(404, 'Inventory item not found');
    return inventoryItemRepository.update(itemId, { isActive: !item.isActive });
  }

  /**
   * Get stock movement ledger for an item — lists all transactions that
   * reference this inventory item, showing qty-in, qty-out, and running balance.
   *
   * @param {string} businessId
   * @param {string} itemId
   * @returns {Promise<Object>}
   */
  async getStockLedger(businessId, itemId) {
    const item = await inventoryItemRepository.findByBusinessAndId(businessId, itemId);
    if (!item) throw new ApiError(404, 'Inventory item not found');

    const JournalEntry = require('../models/JournalEntry.model');
    const mongoose = require('mongoose');
    const { TRANSACTION_TYPES } = require('../config/constants');

    const entries = await JournalEntry.find({
      businessId: new mongoose.Types.ObjectId(String(businessId)),
      inventoryItemId: new mongoose.Types.ObjectId(String(itemId)),
      isArchived: { $ne: true },
    })
      .sort({ transactionDate: 1, createdAt: 1 })
      .select('transactionDate description transactionType inventoryQty amount')
      .lean();

    let runningQty = 0;
    const lines = entries.map((tx) => {
      const isIn  = tx.transactionType === TRANSACTION_TYPES.INVENTORY_PURCHASE;
      const isOut = tx.transactionType === TRANSACTION_TYPES.INVENTORY_SALE;
      const qtyIn  = isIn  ? (tx.inventoryQty || 0) : 0;
      const qtyOut = isOut ? (tx.inventoryQty || 0) : 0;
      runningQty += qtyIn - qtyOut;
      return {
        _id:         tx._id,
        date:        tx.transactionDate,
        description: tx.description,
        type:        tx.transactionType,
        qtyIn,
        qtyOut,
        balance:     runningQty,
        amount:      tx.amount,
      };
    });

    return {
      item: {
        _id:          item._id,
        name:         item.name,
        sku:          item.sku,
        barcode:      item.barcode,
        category:     item.category,
        currentStock: item.currentStock,
        unitCostPrice:item.unitCostPrice,
        unit:         item.unit,
      },
      lines,
      summary: {
        totalIn:   lines.reduce((s, l) => s + l.qtyIn,  0),
        totalOut:  lines.reduce((s, l) => s + l.qtyOut, 0),
        currentStock: item.currentStock,
      },
    };
  }
}

module.exports = new InventoryService();
