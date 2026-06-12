// routes/v1/alert.routes.js
// FR-02.1 / FR-02.3 — financial alerts (persisted, deduplicated, configurable).
'use strict';

const express = require('express');
const router = express.Router();
const ctrl = require('../../controllers/alert.controller');
const { authMiddleware }  = require('../../middleware/auth.middleware');
const { requireBusiness } = require('../../middleware/business.middleware');

router.use(authMiddleware, requireBusiness);

router.get('/',         ctrl.listAlerts);
router.post('/run',     ctrl.runNow);
router.post('/:id/ack', ctrl.acknowledgeAlert);
router.get('/config',   ctrl.getConfig);
router.put('/config',   ctrl.updateConfig);

module.exports = router;
