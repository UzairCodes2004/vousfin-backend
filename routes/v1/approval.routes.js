// routes/v1/approval.routes.js
const express = require('express');
const router = express.Router();
const controller = require('../../controllers/approval.controller');
const { authMiddleware } = require('../../middleware/auth.middleware');
const { requireBusiness } = require('../../middleware/business.middleware');
const validate = require('../../middleware/validate.middleware');
const {
  updateSettingsSchema, decisionSchema, approvalIdParamSchema,
} = require('../../validations/approval.validation');

router.use(authMiddleware, requireBusiness);

// Settings (static paths before /:id)
router.get('/settings', controller.getSettings);
router.put('/settings', validate(updateSettingsSchema), controller.updateSettings);
router.get('/count', controller.count);

// Queue
router.get('/', controller.list);
router.get('/:id', validate(approvalIdParamSchema, 'params'), controller.getById);
router.post('/:id/approve', validate(approvalIdParamSchema, 'params'), validate(decisionSchema), controller.approve);
router.post('/:id/reject',  validate(approvalIdParamSchema, 'params'), validate(decisionSchema), controller.reject);
router.post('/:id/cancel',  validate(approvalIdParamSchema, 'params'), controller.cancel);

module.exports = router;
