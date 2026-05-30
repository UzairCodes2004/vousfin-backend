// routes/v1/arApIntegrity.routes.js — AR/AP M9
// Durable event log, replay, projection rebuild, consistency verification.
'use strict';
const express = require('express');
const router  = express.Router();
const ctrl    = require('../../controllers/arApIntegrity.controller');
const { authMiddleware }  = require('../../middleware/auth.middleware');
const { requireBusiness } = require('../../middleware/business.middleware');

router.use(authMiddleware, requireBusiness);

router.get('/events',        ctrl.listEvents);
router.get('/events/stats',  ctrl.eventStats);
router.post('/replay',       ctrl.replay);
router.post('/rebuild',      ctrl.rebuildBusiness);
router.post('/rebuild/:kind/:id', ctrl.rebuildDocument);
router.get('/verify',        ctrl.verify);

module.exports = router;
