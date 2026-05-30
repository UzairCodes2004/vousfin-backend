// controllers/arApIntegrity.controller.js — AR/AP M9
// Event log, event replay, projection rebuild, consistency verification.
'use strict';
const eventLog = require('../services/eventLog.service');
const projectionRebuild = require('../services/projectionRebuild.service');
const consistency = require('../services/consistencyVerification.service');
const ApiResponse = require('../utils/ApiResponse');

const biz = (req) => req.user.businessId;

// ── Event log ────────────────────────────────────────────────────────────────
exports.listEvents = async (req, res, next) => {
  try {
    const { eventName, entityType, entityId, from, to, limit } = req.query;
    const rows = await eventLog.list(biz(req), { eventName, entityType, entityId, from, to, limit: limit ? Number(limit) : undefined });
    ApiResponse.success(res, rows, 'Event log');
  } catch (err) { next(err); }
};

exports.eventStats = async (req, res, next) => {
  try {
    ApiResponse.success(res, await eventLog.stats(biz(req)), 'Event log stats');
  } catch (err) { next(err); }
};

// ── Event replay ───────────────────────────────────────────────────────────────
exports.replay = async (req, res, next) => {
  try {
    const { eventName, entityType, entityId, from, to, dryRun } = req.body || {};
    const result = await eventLog.replay(biz(req), { eventName, entityType, entityId, from, to, dryRun: dryRun === true });
    ApiResponse.success(res, result, result.dryRun ? 'Replay preview' : 'Events replayed');
  } catch (err) { next(err); }
};

// ── Projection rebuild ─────────────────────────────────────────────────────────
exports.rebuildBusiness = async (req, res, next) => {
  try {
    const stats = await projectionRebuild.rebuildBusiness(biz(req), { kind: req.body?.kind, userId: req.user._id });
    ApiResponse.success(res, stats, 'Projections rebuilt');
  } catch (err) { next(err); }
};

exports.rebuildDocument = async (req, res, next) => {
  try {
    const { kind, id } = req.params;
    if (!['invoice', 'bill'].includes(kind)) return next(Object.assign(new Error('kind must be invoice|bill'), { statusCode: 400 }));
    const result = await projectionRebuild.rebuildDocument(biz(req), kind, id, { userId: req.user._id });
    ApiResponse.success(res, result, 'Projection rebuilt');
  } catch (err) { next(err); }
};

// ── Consistency verification ────────────────────────────────────────────────────
exports.verify = async (req, res, next) => {
  try {
    ApiResponse.success(res, await consistency.verify(biz(req)), 'AR/AP consistency verification');
  } catch (err) { next(err); }
};
