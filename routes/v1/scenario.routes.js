// routes/v1/scenario.routes.js — FR-03.3 decision impact modeler (simulations only)
'use strict';

const express = require('express');
const router = express.Router();
const { authMiddleware }  = require('../../middleware/auth.middleware');
const { requireBusiness } = require('../../middleware/business.middleware');
const modeler = require('../../services/scenarioModeler.service');
const ApiResponse = require('../../utils/ApiResponse');

router.use(authMiddleware, requireBusiness);

/** Run a what-if simulation (not persisted). Body = params. */
router.post('/simulate', async (req, res, next) => {
  try { ApiResponse.success(res, await modeler.simulate(req.user.businessId, req.body || {}), 'Scenario simulated'); }
  catch (err) { next(err); }
});

router.get('/', async (req, res, next) => {
  try { ApiResponse.success(res, await modeler.list(req.user.businessId), 'Scenarios'); }
  catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try { ApiResponse.created(res, await modeler.save(req.user.businessId, req.user.id, req.body || {}), 'Scenario saved'); }
  catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try { ApiResponse.success(res, await modeler.remove(req.user.businessId, req.params.id), 'Scenario deleted'); }
  catch (err) { next(err); }
});

/** Side-by-side: POST { ids: [...] } */
router.post('/compare', async (req, res, next) => {
  try { ApiResponse.success(res, await modeler.compare(req.user.businessId, req.body?.ids || []), 'Comparison'); }
  catch (err) { next(err); }
});

module.exports = router;
