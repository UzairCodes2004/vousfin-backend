// routes/v1/audit.routes.js — ERP Integration Refactor, Step 9
// Cross-module unified audit / activity trail.
const express = require('express');
const router  = express.Router();
const auditCtrl = require('../../controllers/audit.controller');
const { authMiddleware }  = require('../../middleware/auth.middleware');
const { requireBusiness } = require('../../middleware/business.middleware');

// All routes require authentication + an active business.
router.use(authMiddleware, requireBusiness);

router.get('/activity', auditCtrl.getActivity);                       // merged timeline
router.get('/logs',     auditCtrl.getLogs);                           // durable log (paginated)
router.get('/entity/:entityType/:entityId', auditCtrl.getEntityTrail); // single-entity trail

module.exports = router;
