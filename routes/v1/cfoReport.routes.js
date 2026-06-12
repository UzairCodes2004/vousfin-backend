// routes/v1/cfoReport.routes.js — FR-03.4 autonomous monthly CFO report
'use strict';

const express = require('express');
const router = express.Router();
const { authMiddleware }  = require('../../middleware/auth.middleware');
const { requireBusiness } = require('../../middleware/business.middleware');
const cfoReport = require('../../services/cfoReport.service');
const ApiResponse = require('../../utils/ApiResponse');

router.use(authMiddleware, requireBusiness);

router.get('/', async (req, res, next) => {
  try { ApiResponse.success(res, await cfoReport.list(req.user.businessId), 'CFO reports'); }
  catch (err) { next(err); }
});

/** Manual trigger (the monthly cron does this automatically). */
router.post('/generate', async (req, res, next) => {
  try {
    const monthDate = req.body?.month ? new Date(`${req.body.month}-15`) : null;
    ApiResponse.created(res, await cfoReport.generate(req.user.businessId, monthDate), 'CFO report generated');
  } catch (err) { next(err); }
});

router.post('/:month/send', async (req, res, next) => {
  try { ApiResponse.success(res, await cfoReport.deliver(req.user.businessId, req.params.month), 'CFO report delivered'); }
  catch (err) { next(err); }
});

/** Optional commentary — re-embeds into the PDF, never blocks automation. */
router.post('/:month/commentary', async (req, res, next) => {
  try { ApiResponse.success(res, await cfoReport.addCommentary(req.user.businessId, req.params.month, req.body?.commentary), 'Commentary saved'); }
  catch (err) { next(err); }
});

router.get('/:month/pdf', async (req, res, next) => {
  try {
    const p = await cfoReport.pdfPathFor(req.user.businessId, req.params.month);
    if (!p) return ApiResponse.error(res, 'Report not found', 404);
    res.download(p);
  } catch (err) { next(err); }
});

module.exports = router;
