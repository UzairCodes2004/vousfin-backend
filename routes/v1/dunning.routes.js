// routes/v1/dunning.routes.js — AR/AP M8 (dunning / collections)
'use strict';
const express = require('express');
const router  = express.Router();
const ctrl    = require('../../controllers/dunning.controller');
const { authMiddleware } = require('../../middleware/auth.middleware');

router.use(authMiddleware);

router.get('/summary',        ctrl.getSummary);
router.get('/worklist',       ctrl.getWorklist);
router.post('/run',           ctrl.run);
router.post('/:id/escalate',  ctrl.escalateOne);

module.exports = router;
