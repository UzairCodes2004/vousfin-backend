// routes/v1/payment.routes.js — AR/AP Domain Refactor, Milestone M2
const express = require('express');
const router  = express.Router();
const paymentCtrl = require('../../controllers/payment.controller');
const { authMiddleware }  = require('../../middleware/auth.middleware');
const { requireBusiness } = require('../../middleware/business.middleware');

router.use(authMiddleware, requireBusiness);

router.post('/',    paymentCtrl.record);   // record + apply (multi-allocation)
router.get('/',     paymentCtrl.list);     // list (?direction&partyId&status&startDate&endDate)
router.get('/:id',  paymentCtrl.getById);

module.exports = router;
