const express = require('express');
const router = express.Router();
const businessController = require('../../controllers/business.controller');
const { authMiddleware } = require('../../middleware/auth.middleware');
const validate = require('../../middleware/validate.middleware');
const {
  createBusinessSchema,
  updateBusinessSchema,
  confirmActionSchema,
  addCustomAccountSchema,
  updateAccountSchema,
  listAccountsQuerySchema,
} = require('../../validations/business.validation');

// All business routes require authentication
router.use(authMiddleware);

// Business profile routes (no business required for creation)
router.post('/', validate(createBusinessSchema), businessController.createBusiness);
router.get('/', businessController.getBusiness);
router.put('/', validate(updateBusinessSchema), businessController.updateBusiness);

// Destructive maintenance routes (require typed business-name confirmation)
router.post('/reset', validate(confirmActionSchema), businessController.resetBusinessData);
router.delete('/', validate(confirmActionSchema), businessController.deleteBusiness);

// Chart of accounts routes (business must exist)
router.get('/accounts', validate(listAccountsQuerySchema, 'query'), businessController.getAccounts);
// Sync route MUST be defined before /:accountId to avoid path conflict
router.post('/accounts/sync', businessController.syncAccounts);
router.post('/accounts', validate(addCustomAccountSchema), businessController.addCustomAccount);
router.put('/accounts/:accountId', validate(updateAccountSchema), businessController.updateAccount);

module.exports = router;