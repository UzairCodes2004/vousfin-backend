// routes/v1/arApReport.routes.js — AR/AP Domain Refactor, Milestone M7
const express = require('express');
const router  = express.Router();
const ctrl = require('../../controllers/arApReport.controller');
const { authMiddleware }  = require('../../middleware/auth.middleware');
const { requireBusiness } = require('../../middleware/business.middleware');

router.use(authMiddleware, requireBusiness);

router.get('/aging',          ctrl.aging);          // ?type=receivable|payable → buckets + party aging + reconciliation
router.get('/reconciliation', ctrl.reconciliation); // ?type=receivable|payable
router.get('/statement',      ctrl.customerStatement); // M8 — ?customerId=&from=&to=

module.exports = router;
