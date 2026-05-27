const express = require('express');
const multer = require('multer');
const router = express.Router();
const transactionController = require('../../controllers/transaction.controller');
const { authMiddleware } = require('../../middleware/auth.middleware');
const { requireBusiness } = require('../../middleware/business.middleware');
const validate = require('../../middleware/validate.middleware');
const {
  createTransactionSchema,
  updateTransactionSchema,
  recordPaymentSchema,
  createInstallmentSchema,
  naturalLanguageSchema,
  confirmNaturalLanguageSchema,
  transactionFiltersSchema,
  transactionIdParamSchema,
  reverseTransactionSchema,
} = require('../../validations/transaction.validation');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.use(authMiddleware, requireBusiness);

// Transaction Creation (v2)
router.post('/form', validate(createTransactionSchema), transactionController.createFormTransaction);

// AR/AP & Settlements (v2)
router.get('/outstanding', transactionController.getOutstandingBalances);
router.post('/payment', validate(recordPaymentSchema), transactionController.recordPayment);
router.get('/:id/settlements', validate(transactionIdParamSchema, 'params'), transactionController.getSettlementHistory);

// AR/AP Data Integrity Repair — idempotent, GAAP-compliant fix for mis-typed entries
router.post('/repair-ar-ap',       transactionController.repairARAPTransactions);
// AR Overdue Refresh — marks overdue AR entries where dueDate < today
router.post('/refresh-overdue-ar', transactionController.refreshOverdueAR);

// Installments (v2) — Core
router.post('/installment', validate(createInstallmentSchema), transactionController.createInstallmentTransaction);
router.post('/installment/:planId/pay', transactionController.recordInstallmentPayment);

// Installments — Advanced Lifecycle Management
router.get('/installments',                     transactionController.getInstallmentPlans);
router.get('/installments/reminders',           transactionController.getInstallmentReminders);
router.get('/installments/overdue-alerts',      transactionController.getOverdueAlerts);
router.get('/installment/:planId',              transactionController.getInstallmentPlan);
router.post('/installment/:planId/penalty',     transactionController.accrueInstallmentPenalty);
router.post('/installments/accrue-all-penalties', transactionController.accrueAllPenalties);
router.post('/installment/:planId/restructure', transactionController.restructureInstallmentPlan);
router.post('/installment/:planId/settle-early',transactionController.settleInstallmentEarly);
router.post('/installments/refresh-overdue',    transactionController.refreshOverdueStatuses);

// Natural Language
router.post('/nl', validate(naturalLanguageSchema), transactionController.processNaturalLanguage);
router.post('/nl/confirm', validate(confirmNaturalLanguageSchema), transactionController.confirmNaturalLanguage);

// Excel Bulk Import  (GET template must come before /:id to avoid route collision)
router.get('/excel/template', transactionController.downloadExcelTemplate);
router.post('/excel', upload.single('file'), transactionController.uploadExcelPreview);
router.post('/excel/confirm', transactionController.confirmExcelImport);

// General Querying and CRUD
router.get('/', validate(transactionFiltersSchema, 'query'), transactionController.getTransactions);
router.get('/:id', validate(transactionIdParamSchema, 'params'), transactionController.getTransactionById);
router.put('/:id', validate(transactionIdParamSchema, 'params'), validate(updateTransactionSchema), transactionController.updateTransaction);
router.delete('/:id', validate(transactionIdParamSchema, 'params'), transactionController.deleteTransaction);

// Reversal & Audit Trail (GAAP-compliant correction flow)
router.post('/:id/reverse',  validate(transactionIdParamSchema, 'params'), validate(reverseTransactionSchema), transactionController.reverseTransaction);
router.get('/:id/history',   validate(transactionIdParamSchema, 'params'), transactionController.getTransactionAuditHistory);

module.exports = router;