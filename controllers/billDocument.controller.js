// controllers/billDocument.controller.js — Phase 3.3
'use strict';
const billDocumentService = require('../services/billDocument.service');
const { ApiResponse }     = require('../utils/ApiResponse');

exports.upload = async (req, res, next) => {
  try {
    const file = req.file; // set by multer middleware
    const {
      billId, vendorId, purchaseOrderId,
      documentType, description,
    } = req.body;

    if (!file && !req.body.fileUrl) {
      return next(Object.assign(new Error('No file uploaded'), { statusCode: 400 }));
    }

    const params = {
      businessId:      req.user.businessId,
      billId:          billId || null,
      vendorId:        vendorId || null,
      purchaseOrderId: purchaseOrderId || null,
      documentType,
      fileName:        file ? file.filename    : req.body.fileName,
      originalName:    file ? file.originalname: req.body.originalName,
      mimeType:        file ? file.mimetype    : req.body.mimeType,
      fileSize:        file ? file.size        : Number(req.body.fileSize) || null,
      fileUrl:         file ? `/uploads/${file.filename}` : req.body.fileUrl,
      storageKey:      file ? file.path        : null,
      description,
    };

    const doc = await billDocumentService.upload(params, req.user);
    ApiResponse.created(res, doc, 'Document uploaded');
  } catch (err) { next(err); }
};

exports.listByBill = async (req, res, next) => {
  try {
    const docs = await billDocumentService.listByBill(req.params.billId, req.user.businessId);
    ApiResponse.success(res, docs);
  } catch (err) { next(err); }
};

exports.listByVendor = async (req, res, next) => {
  try {
    const docs = await billDocumentService.listByVendor(req.params.vendorId, req.user.businessId);
    ApiResponse.success(res, docs);
  } catch (err) { next(err); }
};

exports.getById = async (req, res, next) => {
  try {
    const doc = await billDocumentService.getById(req.params.id, req.user.businessId);
    ApiResponse.success(res, doc);
  } catch (err) { next(err); }
};

exports.linkToBill = async (req, res, next) => {
  try {
    const doc = await billDocumentService.linkToBill(
      req.params.id, req.body.billId, req.user.businessId, req.user
    );
    ApiResponse.success(res, doc, 'Document linked to bill');
  } catch (err) { next(err); }
};

exports.archive = async (req, res, next) => {
  try {
    const doc = await billDocumentService.archive(req.params.id, req.user.businessId, req.user);
    ApiResponse.success(res, doc, 'Document archived');
  } catch (err) { next(err); }
};

exports.summaryByBill = async (req, res, next) => {
  try {
    const summary = await billDocumentService.summaryByBill(req.params.billId, req.user.businessId);
    ApiResponse.success(res, summary);
  } catch (err) { next(err); }
};
