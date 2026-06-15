// services/autonomyPolicy.service.js
//
// Autonomy roadmap Phase 0 — the Autonomy Engine. Resolves how a proposed action
// should be handled (observe / queue for approval / auto-execute) from the
// business's per-capability policy + the action's confidence and amount. Every
// capability defaults to "suggest" (human approves everything) — autonomy is
// earned by dialing capabilities up over time.
//
'use strict';
const mongoose = require('mongoose');
const { ApiError } = require('../utils/ApiError');
const { AUTONOMY_LEVELS, AUTONOMY_CAPABILITIES } = require('../config/constants');

const AutonomyPolicy = () => mongoose.model('AutonomyPolicy');

const DEFAULT_CAP = { level: AUTONOMY_LEVELS.SUGGEST, confidenceThreshold: 0.85, maxAutoAmount: null };

function defaults() {
  const caps = {};
  for (const c of AUTONOMY_CAPABILITIES) caps[c] = { ...DEFAULT_CAP };
  return caps;
}

/** Full policy for a business, stored overrides merged over safe defaults. */
async function getPolicy(businessId) {
  const doc = await AutonomyPolicy().findOne({ businessId }).lean();
  const stored = (doc && doc.capabilities) || {};
  const caps = defaults();
  for (const c of AUTONOMY_CAPABILITIES) caps[c] = { ...caps[c], ...(stored[c] || {}) };
  return { businessId, capabilities: caps };
}

/** Update one capability's dial. Validates capability, level and threshold. */
async function setCapability(businessId, capability, patch = {}, updatedBy = null) {
  if (!AUTONOMY_CAPABILITIES.includes(capability)) throw new ApiError(400, `Unknown capability: ${capability}`);
  if (patch.level != null && !Object.values(AUTONOMY_LEVELS).includes(patch.level)) {
    throw new ApiError(400, `Unknown autonomy level: ${patch.level}`);
  }
  if (patch.confidenceThreshold != null && (patch.confidenceThreshold < 0 || patch.confidenceThreshold > 1)) {
    throw new ApiError(400, 'confidenceThreshold must be between 0 and 1');
  }

  const set = { updatedBy };
  if (patch.level != null)              set[`capabilities.${capability}.level`] = patch.level;
  if (patch.confidenceThreshold != null) set[`capabilities.${capability}.confidenceThreshold`] = patch.confidenceThreshold;
  if (patch.maxAutoAmount !== undefined) set[`capabilities.${capability}.maxAutoAmount`] = patch.maxAutoAmount;

  await AutonomyPolicy().findOneAndUpdate(
    { businessId },
    { $set: set, $setOnInsert: { businessId } },
    { upsert: true, new: true },
  );
  return getPolicy(businessId);
}

/**
 * Pure routing decision: 'observe' | 'queue' | 'execute'.
 * Limits ALWAYS force approval; copilot needs ≥ threshold; autopilot a lower bar.
 */
function resolveDecision({ level, confidence = 0, threshold = 0.85, withinLimits = true }) {
  if (level === AUTONOMY_LEVELS.OBSERVE) return 'observe';
  if (level === AUTONOMY_LEVELS.SUGGEST) return 'queue';
  if (!withinLimits) return 'queue';
  if (level === AUTONOMY_LEVELS.AUTOPILOT) return confidence >= threshold * 0.8 ? 'execute' : 'queue';
  if (level === AUTONOMY_LEVELS.COPILOT)   return confidence >= threshold ? 'execute' : 'queue';
  return 'queue';
}

/** Resolve a decision for a capability given an action's confidence + amount. */
async function decideForCapability(businessId, capability, { confidence = 0, amount = null } = {}) {
  const policy = await getPolicy(businessId);
  const cap = policy.capabilities[capability] || { ...DEFAULT_CAP };
  const withinLimits = cap.maxAutoAmount == null || amount == null || Math.abs(amount) <= cap.maxAutoAmount;
  const decision = resolveDecision({ level: cap.level, confidence, threshold: cap.confidenceThreshold, withinLimits });
  return { decision, cap, withinLimits };
}

module.exports = { getPolicy, setCapability, resolveDecision, decideForCapability, defaults, DEFAULT_CAP };
