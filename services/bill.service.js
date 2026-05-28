// services/bill.service.js
//
// Phase 1 — Bill domain service (Accounts Payable counterpart of invoice.service).
//
// Public API mirrors invoice.service:
//   createDraft, submitForApproval, approve, reject, schedule, markPaid,
//   cancel, softDelete, transitionState, getById, list, syncFromJournalEntry,
//   getTimeline.
//
const mongoose = require('mongoose');
const Bill = require('../models/Bill.model');
const vendorRepository = require('../repositories/vendor.repository');
const auditService = require('./audit.service');
const { ApiError } = require('../utils/ApiError');
const logger = require('../config/logger');
const {
  BILL_STATES,
  APPROVAL_STATUS,
  AUDIT_ACTIONS,
  ENTITY_TYPES,
  DEFAULT_APPROVAL_THRESHOLD,
} = require('../config/constants');

class BillService {
  // ───────────────────────────────────────────────────────────────────────────
  // Helpers
  // ───────────────────────────────────────────────────────────────────────────

  _requiresApproval(amount, businessConfig = {}) {
    const threshold = Number.isFinite(businessConfig.billApprovalThreshold)
      ? businessConfig.billApprovalThreshold
      : DEFAULT_APPROVAL_THRESHOLD;
    return amount >= threshold;
  }

  async _vendorSnapshot(businessId, vendorId) {
    if (!vendorId) return {};
    const v = await vendorRepository.findByBusinessAndId(businessId, vendorId);
    if (!v) return {};
    return {
      vendorName: v.vendorName || null,
      email:      v.email || null,
      phone:      v.phone || null,
      taxId:      v.taxId || null,
      strn:       v.whtProfile?.strn || null,
    };
  }

  _guardTransition(bill, toState) {
    if (!Bill.canTransition(bill.state, toState)) {
      throw new ApiError(
        409,
        `Illegal state transition: bill ${bill._id} cannot move from "${bill.state}" to "${toState}"`
      );
    }
  }

  async _applyStateChange(bill, toState, user, { reason = null, ipAddress = null } = {}) {
    this._guardTransition(bill, toState);
    const fromState = bill.state;
    bill.recordStateChange(toState, user, reason);
    bill.state = toState;
    bill.lastModifiedBy = user._id;
    await bill.save();
    try {
      await auditService.log({
        businessId:      bill.businessId,
        entityType:      ENTITY_TYPES.BILL,
        entityId:        bill._id,
        action:          AUDIT_ACTIONS.STATE_CHANGED,
        performedBy:     user._id,
        performedByName: user.fullName || user.email || 'Unknown User',
        beforeState:     { state: fromState },
        afterState:      { state: toState, reason },
        ipAddress,
      });
    } catch (e) {
      logger.warn(`[bill] audit log failed for state change ${fromState}→${toState}: ${e.message}`);
    }
    return bill;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Creation
  // ───────────────────────────────────────────────────────────────────────────

  async createDraft(data, user, ipAddress) {
    const hasLines = Array.isArray(data.lineItems) && data.lineItems.length > 0;
    if (!data.businessId || !data.billNumber || !data.issueDate) {
      throw new ApiError(400, 'createDraft requires: businessId, billNumber, issueDate');
    }
    if (!hasLines && (!data.amount || data.amount <= 0)) {
      throw new ApiError(400, 'Bill amount must be greater than zero (or provide lineItems)');
    }

    const snap = await this._vendorSnapshot(data.businessId, data.vendorId);

    const estimateAmount = data.amount || (hasLines
      ? data.lineItems.reduce((s, li) => s + (li.quantity || 0) * (li.unitPrice || 0), 0)
      : 0);
    const approvalRequired = this._requiresApproval(estimateAmount, data.businessConfig);

    const bill = new Bill({
      businessId:           data.businessId,
      billNumber:           data.billNumber,
      vendorReferenceNumber:data.vendorReferenceNumber || null,
      linkedJournalEntryId: data.linkedJournalEntryId || null,
      vendorId:             data.vendorId || null,
      vendorSnapshot:       Object.keys(snap).length ? snap : data.vendorSnapshot || {},

      lineItems:            hasLines ? data.lineItems : [],
      amount:               hasLines ? 0.01 : data.amount,
      taxAmount:            data.taxAmount || 0,
      whtAmount:            data.whtAmount || 0,
      currencyCode:         data.currencyCode || 'PKR',

      invoiceDiscountType:  data.invoiceDiscountType || null,
      invoiceDiscountValue: data.invoiceDiscountValue || 0,
      shippingCharges:      data.shippingCharges || 0,
      roundingAdjustment:   data.roundingAdjustment || 0,
      exchangeRate:         data.exchangeRate || 1,
      attachments:          data.attachments || [],

      issueDate:            data.issueDate,
      dueDate:              data.dueDate || null,
      state:                BILL_STATES.DRAFT,
      approvalRequired,
      approvalStatus:       approvalRequired ? APPROVAL_STATUS.PENDING : APPROVAL_STATUS.NOT_REQUIRED,
      approvalThreshold:    approvalRequired ? (data.businessConfig?.billApprovalThreshold ?? DEFAULT_APPROVAL_THRESHOLD) : null,
      description:          data.description || null,
      notes:                data.notes || null,
      tags:                 data.tags || [],
      createdBy:            user._id,
      lastModifiedBy:       user._id,
    });
    bill.recordStateChange(BILL_STATES.DRAFT, user, 'Initial creation');
    await bill.save();
    try {
      await auditService.logCreate(
        ENTITY_TYPES.BILL,
        bill._id,
        bill.businessId,
        user._id,
        bill.toObject(),
        ipAddress
      );
    } catch (e) {
      logger.warn(`[bill] audit logCreate failed: ${e.message}`);
    }
    return bill;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Approval workflow
  // ───────────────────────────────────────────────────────────────────────────

  async submitForApproval(id, user, ipAddress) {
    const bill = await this._loadOrThrow(id);
    if (!bill.approvalRequired) {
      return this._applyStateChange(bill, BILL_STATES.APPROVED, user, {
        reason: 'Below approval threshold — auto-approved',
        ipAddress,
      });
    }
    bill.approvalLog.push({
      action:    'submitted',
      actorId:   user._id,
      actorName: user.fullName || user.email || 'Unknown',
      actorRole: user.role || null,
      timestamp: new Date(),
    });
    bill.approvalStatus = APPROVAL_STATUS.PENDING;
    return this._applyStateChange(bill, BILL_STATES.AWAITING_APPROVAL, user, { ipAddress });
  }

  async approve(id, user, note, ipAddress) {
    const bill = await this._loadOrThrow(id);
    bill.approvalLog.push({
      action: 'approved',
      actorId: user._id,
      actorName: user.fullName || user.email || 'Unknown',
      actorRole: user.role || null,
      note: note || null,
      timestamp: new Date(),
    });
    bill.approvalStatus = APPROVAL_STATUS.APPROVED;
    bill.approvedBy = user._id;
    bill.approvedAt = new Date();
    return this._applyStateChange(bill, BILL_STATES.APPROVED, user, { reason: note, ipAddress });
  }

  async reject(id, user, note, ipAddress) {
    const bill = await this._loadOrThrow(id);
    bill.approvalLog.push({
      action: 'rejected',
      actorId: user._id,
      actorName: user.fullName || user.email || 'Unknown',
      actorRole: user.role || null,
      note: note || null,
      timestamp: new Date(),
    });
    bill.approvalStatus = APPROVAL_STATUS.REJECTED;
    return this._applyStateChange(bill, BILL_STATES.DRAFT, user, {
      reason: note || 'Rejected — returned to draft',
      ipAddress,
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Lifecycle ops
  // ───────────────────────────────────────────────────────────────────────────

  async schedule(id, user, payDate, ipAddress) {
    const bill = await this._loadOrThrow(id);
    bill.scheduledPayDate = payDate || null;
    return this._applyStateChange(bill, BILL_STATES.SCHEDULED, user, {
      reason: payDate ? `Scheduled for ${new Date(payDate).toISOString()}` : null,
      ipAddress,
    });
  }

  async cancel(id, user, reason, ipAddress) {
    const bill = await this._loadOrThrow(id);
    return this._applyStateChange(bill, BILL_STATES.CANCELLED, user, { reason, ipAddress });
  }

  /**
   * Phase 2 — update a draft bill (only drafts can be edited).
   */
  async updateDraft(id, data, user, ipAddress) {
    const bill = await this._loadOrThrow(id);
    if (bill.state !== BILL_STATES.DRAFT) {
      throw new ApiError(409, 'Only draft bills can be edited');
    }
    const editable = [
      'billNumber', 'vendorReferenceNumber', 'vendorId', 'lineItems', 'amount', 'taxAmount',
      'whtAmount', 'currencyCode', 'invoiceDiscountType', 'invoiceDiscountValue',
      'shippingCharges', 'roundingAdjustment', 'issueDate', 'dueDate',
      'description', 'notes', 'tags', 'attachments',
    ];
    for (const field of editable) {
      if (data[field] !== undefined) {
        const before = bill[field];
        bill[field] = data[field];
        if (!['lineItems', 'attachments', 'tags'].includes(field)) {
          bill.recordFieldChange(field, before, data[field], user._id);
        }
      }
    }
    if (data.vendorId && String(data.vendorId) !== String(bill.vendorId)) {
      bill.vendorSnapshot = await this._vendorSnapshot(bill.businessId, data.vendorId);
    }
    const hasLines = bill.lineItems && bill.lineItems.length > 0;
    const estimateAmount = hasLines
      ? bill.lineItems.reduce((s, li) => s + (li.quantity || 0) * (li.unitPrice || 0), 0)
      : bill.amount;
    bill.approvalRequired = this._requiresApproval(estimateAmount, data.businessConfig);
    bill.approvalStatus = bill.approvalRequired ? APPROVAL_STATUS.PENDING : APPROVAL_STATUS.NOT_REQUIRED;
    bill.lastModifiedBy = user._id;
    await bill.save();
    try {
      await auditService.log({
        businessId:      bill.businessId,
        entityType:      ENTITY_TYPES.BILL,
        entityId:        bill._id,
        action:          AUDIT_ACTIONS.EDITED,
        performedBy:     user._id,
        performedByName: user.fullName || user.email || 'Unknown',
        ipAddress,
      });
    } catch (e) {
      logger.warn(`[bill] audit log (updateDraft) failed: ${e.message}`);
    }
    return bill;
  }

  async markPaid(id, user, ipAddress) {
    const bill = await this._loadOrThrow(id);
    bill.paidAmount = bill.totalAmount;
    bill.remainingBalance = 0;
    return this._applyStateChange(bill, BILL_STATES.PAID, user, { ipAddress });
  }

  async transitionState(id, toState, user, { reason = null, ipAddress = null } = {}) {
    const bill = await this._loadOrThrow(id);
    return this._applyStateChange(bill, toState, user, { reason, ipAddress });
  }

  async softDelete(id, user, ipAddress) {
    const bill = await this._loadOrThrow(id);
    if (bill.isArchived) return bill;
    bill.isArchived = true;
    bill.archivedAt = new Date();
    bill.archivedBy = user._id;
    bill.lastModifiedBy = user._id;
    await bill.save();
    try {
      await auditService.logDelete(
        ENTITY_TYPES.BILL,
        bill._id,
        bill.businessId,
        user._id,
        bill.toObject(),
        ipAddress
      );
    } catch (e) {
      logger.warn(`[bill] audit logDelete failed: ${e.message}`);
    }
    return bill;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Sync helper (dual-write from transaction.service)
  // ───────────────────────────────────────────────────────────────────────────

  async syncFromJournalEntry(je, user, ipAddress) {
    if (!je || !je.invoiceNumber) return null;
    const existing = await Bill.findOne({
      businessId: je.businessId,
      billNumber: je.invoiceNumber, // we reuse the BILL-XXXXX number stored on JE.invoiceNumber
    });
    if (existing) {
      if (!existing.linkedJournalEntryId) {
        existing.linkedJournalEntryId = je._id;
        await existing.save();
      }
      return existing;
    }
    const snap = await this._vendorSnapshot(je.businessId, je.vendorId);
    let initialState = BILL_STATES.APPROVED; // ledger posted ⇒ approved
    if (je.paymentStatus === 'paid')                initialState = BILL_STATES.PAID;
    else if (je.paymentStatus === 'partially_paid') initialState = BILL_STATES.PARTIALLY_PAID;
    else if (je.paymentStatus === 'overdue')        initialState = BILL_STATES.OVERDUE;

    const totalAmount = (je.amount || 0) + (je.taxAmount || 0);
    const approvalRequired = this._requiresApproval(totalAmount);

    const bill = new Bill({
      businessId:           je.businessId,
      billNumber:           je.invoiceNumber,
      linkedJournalEntryId: je._id,
      vendorId:             je.vendorId || null,
      vendorSnapshot:       snap,
      amount:               je.amount,
      taxAmount:            je.taxAmount || 0,
      currencyCode:         je.currencyCode || 'PKR',
      issueDate:            je.transactionDate,
      dueDate:              je.dueDate || null,
      state:                initialState,
      paidAmount:           je.partiallyPaidAmount || 0,
      remainingBalance:     je.remainingBalance != null ? je.remainingBalance : totalAmount,
      approvalRequired,
      approvalStatus:       approvalRequired ? APPROVAL_STATUS.APPROVED : APPROVAL_STATUS.NOT_REQUIRED,
      approvalThreshold:    approvalRequired ? DEFAULT_APPROVAL_THRESHOLD : null,
      approvedBy:           approvalRequired ? user._id : null,
      approvedAt:           approvalRequired ? new Date() : null,
      description:          je.description || null,
      createdBy:            user._id,
      lastModifiedBy:       user._id,
    });
    bill.recordStateChange(initialState, user, 'Auto-created from journal entry');
    if (approvalRequired) {
      bill.approvalLog.push({
        action:    'approved',
        actorId:   user._id,
        actorName: user.fullName || user.email || 'System',
        note:      'Auto-approved (created via direct journal posting)',
        timestamp: new Date(),
      });
    }
    await bill.save();
    try {
      await auditService.logCreate(
        ENTITY_TYPES.BILL,
        bill._id,
        bill.businessId,
        user._id,
        bill.toObject(),
        ipAddress
      );
    } catch (e) {
      logger.warn(`[bill] audit logCreate (sync) failed: ${e.message}`);
    }
    return bill;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Read APIs
  // ───────────────────────────────────────────────────────────────────────────

  async _loadOrThrow(id) {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new ApiError(400, 'Invalid bill id');
    }
    const bill = await Bill.findById(id);
    if (!bill) throw new ApiError(404, 'Bill not found');
    if (bill.isArchived) throw new ApiError(410, 'Bill has been archived');
    return bill;
  }

  async getById(id, businessId) {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new ApiError(400, 'Invalid bill id');
    }
    const query = { _id: id };
    if (businessId) query.businessId = businessId;
    const bill = await Bill.findOne(query);
    if (!bill) throw new ApiError(404, 'Bill not found');
    return bill;
  }

  async list(businessId, filters = {}, pagination = {}) {
    const { page = 1, limit = 25 } = pagination;
    const q = { businessId, isArchived: { $ne: true } };
    if (filters.state) q.state = filters.state;
    if (filters.vendorId) q.vendorId = filters.vendorId;
    if (filters.approvalStatus) q.approvalStatus = filters.approvalStatus;
    if (filters.search) q.billNumber = { $regex: filters.search, $options: 'i' };
    if (filters.startDate || filters.endDate) {
      q.issueDate = {};
      if (filters.startDate) q.issueDate.$gte = new Date(filters.startDate);
      if (filters.endDate)   q.issueDate.$lte = new Date(filters.endDate);
    }
    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      Bill.find(q).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Bill.countDocuments(q),
    ]);
    return { data, total, page, limit };
  }

  async getTimeline(id, businessId) {
    const bill = await this.getById(id, businessId);
    const entries = [];
    for (const e of (bill.approvalLog || [])) {
      entries.push({ type: 'approval', timestamp: e.timestamp, ...e.toObject?.() ?? e });
    }
    for (const e of (bill.stateHistory || [])) {
      entries.push({ type: 'state', timestamp: e.timestamp, ...e.toObject?.() ?? e });
    }
    for (const e of (bill.fieldHistory || [])) {
      entries.push({ type: 'field', timestamp: e.changedAt, ...e.toObject?.() ?? e });
    }
    entries.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    return { bill, timeline: entries };
  }
}

module.exports = new BillService();
