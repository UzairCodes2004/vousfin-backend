// routes/v1/vendorRisk.routes.js — Phase 3.3
'use strict';
const express = require('express');
const router  = express.Router();
const ctrl    = require('../../controllers/vendorRisk.controller');
const { authMiddleware } = require('../../middleware/auth.middleware');

router.use(authMiddleware);

router.get('/summary',              ctrl.riskLevelSummary);
router.get('/list',                 ctrl.listByRisk);
router.post('/refresh',             ctrl.refreshAll);
router.post('/:vendorId/compute',   ctrl.computeForVendor);

module.exports = router;
