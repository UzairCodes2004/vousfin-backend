// services/collector.service.js
//
// Autonomy roadmap Phase 3.2 — the Collector agent.
//
// Watches overdue invoices and proposes the next polite chase (the dunning
// ladder VousFin already uses): a reminder, then a first notice, then a second
// notice. Brought into the one inbox so the owner can approve each chase — or,
// once Collections is dialed up, let strong-signal chases go out within policy.
//
// Escalation is a soft state change on the invoice (it records the step and
// emits an event the reminder system listens to); it moves no money. We keep
// confidence conservative so chases only auto-send when the owner has
// explicitly turned the dial up.
//
'use strict';
const actionRouter = require('./actionRouter.service');
const executors = require('./actionExecutors');
const dunning = require('./dunning.service');
const Invoice = require('../models/Invoice.model');
const repo = require('../repositories/proposedAction.repository');
const logger = require('../config/logger');
const { PROPOSED_ACTION_TYPES, PROPOSED_ACTION_STATUS } = require('../config/constants');

const ESCALATE_DUNNING = PROPOSED_ACTION_TYPES.ESCALATE_DUNNING;
const OPEN_STATES = ['approved', 'sent', 'partially_paid', 'overdue'];
const rs = (n) => 'Rs ' + Number(n || 0).toLocaleString();
const nameOf = (inv) => inv.customerSnapshot?.businessName || inv.customerSnapshot?.fullName || 'this customer';

/** A chase already proposed/handled at this exact step? (don't nag) */
async function alreadyHandled(businessId, sourceId) {
  const last = await repo.latestBySource(businessId, 'dunning_step', sourceId);
  return last && last.status !== PROPOSED_ACTION_STATUS.FAILED;
}

/** Plain-language phrasing per ladder step. */
function phrase(levelKey) {
  switch (levelKey) {
    case 'reminder':      return 'send a friendly payment reminder';
    case 'first_notice':  return 'send a first overdue notice';
    case 'second_notice': return 'send a second (firmer) overdue notice';
    case 'final_notice':  return 'send a final notice before collections';
    default:              return 'send the next overdue notice';
  }
}

/** Scan overdue invoices and propose the next chase for those due one. */
async function scanBusiness(businessId, actor, asOf = new Date()) {
  let proposed = 0;
  let invoices;
  try {
    invoices = await Invoice.find({
      businessId, state: { $in: OPEN_STATES }, isArchived: { $ne: true },
      remainingBalance: { $gt: 0 }, dueDate: { $ne: null, $lt: asOf },
    }).select('invoiceNumber customerSnapshot dueDate remainingBalance dunningLevel currencyCode').lean();
  } catch (e) { logger.warn(`[collector] load overdue failed: ${e.message}`); return 0; }

  for (const inv of invoices) {
    try {
      const dOver = dunning.daysOverdue(inv.dueDate, asOf);
      const target = dunning.resolveLevel(dOver);
      const current = inv.dunningLevel || 0;
      if (!target || target.level <= current) continue; // not due for a new step

      const sourceId = `${inv._id}:${target.level}`;
      if (await alreadyHandled(businessId, sourceId)) continue;

      await actionRouter.propose({
        businessId,
        capability: 'collections',
        type:       ESCALATE_DUNNING,
        title:      `Chase ${nameOf(inv)} — ${rs(inv.remainingBalance)} overdue ${dOver} days`,
        summary:    `Invoice ${inv.invoiceNumber || ''} is ${dOver} days past due. Time to ${phrase(target.key)}.`,
        rationale:  `${dOver} days overdue → ladder step "${target.label || target.key}".`,
        citations:  [`Invoice ${inv.invoiceNumber || ''}: ${rs(inv.remainingBalance)} outstanding`,
                     `Due ${new Date(inv.dueDate).toLocaleDateString()} (${dOver} days ago)`],
        confidence: Math.max(0.55, Math.min(0.9, 0.6 + 0.08 * target.level)),
        amount:     inv.remainingBalance,
        payload:    { invoiceId: String(inv._id), targetLevel: target.level, userId: actor?.id || null },
        sourceType: 'dunning_step',
        sourceId,
      });
      proposed++;
    } catch (e) { logger.warn(`[collector] invoice ${inv._id} failed: ${e.message}`); }
  }
  return proposed;
}

/* ── Executor: advance the dunning ladder (the chase the owner approved) ─────── */
async function executeEscalate(action) {
  const p = action.payload || {};
  const inv = await Invoice.findOne({ _id: p.invoiceId, businessId: action.businessId });
  if (!inv) throw new Error('That invoice is no longer available to chase.');
  const actor = { _id: p.userId || null, fullName: 'VousFin Collector' };
  const stepped = await dunning.escalateInvoice(inv, actor);
  return { invoiceId: p.invoiceId, level: stepped?.level ?? inv.dunningLevel, alreadyAtLevel: !stepped };
}

// No reverser: a sent notice can't be un-sent. Escalation moves no money and is
// gated by approval (or an explicit autopilot dial), so it needs no undo path.
executors.register(ESCALATE_DUNNING, { execute: executeEscalate });

module.exports = { scanBusiness, executeEscalate };
