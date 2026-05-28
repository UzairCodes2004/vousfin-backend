// routes/v1/billDocument.routes.js — Phase 3.3
'use strict';
const express    = require('express');
const router     = express.Router();
const ctrl       = require('../../controllers/billDocument.controller');
const { authMiddleware } = require('../../middleware/auth.middleware');

router.use(authMiddleware);

// Document upload (metadata-only; binary handled by multer middleware added by app)
router.post('/',                      ctrl.upload);

// By document ID
router.get('/:id',                    ctrl.getById);
router.patch('/:id/link',             ctrl.linkToBill);
router.delete('/:id',                 ctrl.archive);

// By bill
router.get('/by-bill/:billId',         ctrl.listByBill);
router.get('/by-bill/:billId/summary', ctrl.summaryByBill);

// By vendor
router.get('/by-vendor/:vendorId',     ctrl.listByVendor);

module.exports = router;
