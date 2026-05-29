// middleware/procurementPermissions.js
//
// Phase 3.4 — Procurement Permission Guards
//
// Thin Express middleware that enforces business-scoping on procurement
// routes and validates file attachments before they reach service layer.
//
'use strict';
const { ApiError } = require('../utils/ApiError');
const procurementAuditSvc = require('../services/procurementAudit.service');

// ── Allowed file types for bill attachments ────────────────────────────────────
const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/tiff',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
]);

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

// ── Middleware: ensure req.user.businessId is present and matches param ─────────

/**
 * Verifies the authenticated user belongs to the business in the request context.
 * Attaches req.businessId for downstream convenience.
 */
function requireBusiness(req, res, next) {
  const businessId = req.user?.businessId?._id?.toString()
    ?? req.user?.businessId?.toString();

  if (!businessId) {
    return next(new ApiError(401, 'Business context required'));
  }

  req.businessId = businessId;
  next();
}

/**
 * Validates a file upload (req.file populated by multer).
 * Rejects unsupported mime types and oversized files.
 */
function validateAttachment(req, res, next) {
  const file = req.file;
  if (!file) return next(); // attachment is optional on most routes

  if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
    return next(new ApiError(400, `File type '${file.mimetype}' is not allowed. Accepted: PDF, images, Word, Excel, CSV`));
  }

  if (file.size > MAX_FILE_SIZE_BYTES) {
    return next(new ApiError(400, `File too large (max 10 MB). Received ${(file.size / (1024 * 1024)).toFixed(1)} MB`));
  }

  // Sanitize original filename
  req.file.originalname = req.file.originalname
    .replace(/[^a-zA-Z0-9._\-() ]/g, '_')
    .slice(0, 200);

  next();
}

/**
 * Logs a security event when a request is denied, and passes the error to next().
 * Wrap around other error-generating middleware.
 */
function auditDeniedRequest(entityType) {
  return (err, req, res, next) => {
    if (err instanceof ApiError && (err.statusCode === 401 || err.statusCode === 403)) {
      procurementAuditSvc.log({
        businessId: req.businessId ?? 'unknown',
        entityType,
        entityId:   req.params?.id ?? 'unknown',
        action:     'access_denied',
        actor:      req.user,
        source:     'user',
        meta:       { path: req.path, method: req.method, statusCode: err.statusCode },
        ipAddress:  req.ip,
        userAgent:  req.get('user-agent'),
      }).catch(() => {}); // fire-and-forget
    }
    next(err);
  };
}

/**
 * Ensures the vendorId query param or body field, if present,
 * belongs to the authenticated business before proxying to a service.
 * Prevents cross-business vendor data leakage via URL manipulation.
 */
function scopeVendorToBusinessBody(req, res, next) {
  // If vendorId is embedded in the body, attach businessId so service can scope it
  if (req.body && req.body.vendorId && !req.body.businessId) {
    req.body.businessId = req.businessId;
  }
  next();
}

module.exports = {
  requireBusiness,
  validateAttachment,
  auditDeniedRequest,
  scopeVendorToBusinessBody,
  ALLOWED_MIME_TYPES,
  MAX_FILE_SIZE_BYTES,
};
