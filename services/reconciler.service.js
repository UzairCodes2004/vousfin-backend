// services/reconciler.service.js
//
// Autonomy roadmap Phase 3.1 — the Reconciler agent.
//
// VousFin's bank-reconciliation engine already auto-links the obviously-certain
// statement lines at import time and ranks candidates for the rest. The
// Reconciler brings those "strong but not certain" suggestions into the one
// inbox as ProposedActions:
//   - dial at Suggest  → each match waits for one-click approval,
//   - dial at Co-pilot/Autopilot → high-confidence matches clear themselves
//     within policy (confidence ≥ your threshold).
// Every clear is reversible — one click un-links the line (the ledger is never
// mutated; reconciliation state lives only on the statement line).
//
'use strict';
const actionRouter = require('./actionRouter.service');
const executors = require('./actionExecutors');
const bankRec = require('./bankReconciliation.service');
const repo = require('../repositories/proposedAction.repository');
const logger = require('../config/logger');
const {
  PROPOSED_ACTION_TYPES, PROPOSED_ACTION_STATUS, BANK_LINE_STATUS,
} = require('../config/constants');

const CLEAR_BANK_MATCH = PROPOSED_ACTION_TYPES.CLEAR_BANK_MATCH;
// Only surface a suggestion when the best candidate is genuinely strong and
// clearly ahead of the runner-up — otherwise it's noise, not help.
const PROPOSE_MIN_SCORE = 60;
const PROPOSE_MIN_GAP    = 8;

const rs = (n) => 'Rs ' + Number(n || 0).toLocaleString();

/** Has this exact line already been proposed / handled? (don't nag) */
async function alreadyHandled(businessId, sourceId) {
  const last = await repo.latestBySource(businessId, 'bank_line', sourceId);
  return last && last.status !== PROPOSED_ACTION_STATUS.FAILED;
}

/** Scan one statement and propose matches for its strong unmatched lines. */
async function scanStatement(businessId, statementId, actor) {
  const stmt = await bankRec.getStatement(statementId, businessId);
  let proposed = 0;
  for (const line of stmt.lines || []) {
    if (line.status !== BANK_LINE_STATUS.UNMATCHED) continue;
    const best = line.candidates?.[0];
    const second = line.candidates?.[1];
    if (!best || best.score < PROPOSE_MIN_SCORE) continue;
    if (second && best.score - second.score < PROPOSE_MIN_GAP) continue;

    const sourceId = `${statementId}:${line.lineRef}`;
    if (await alreadyHandled(businessId, sourceId)) continue;

    const dir = line.direction === 'in' ? 'received' : 'paid';
    await actionRouter.propose({
      businessId,
      capability: 'reconciliation',
      type:       CLEAR_BANK_MATCH,
      title:      `Match ${rs(line.amount)} ${dir} to "${(best.description || 'a ledger entry').slice(0, 50)}"`,
      summary:    `This bank line looks like your entry "${(best.description || '').slice(0, 80)}" — same amount, around the same date.`,
      rationale:  `Match score ${best.score}/100${best.amountExact ? ' (exact amount)' : ''}.`,
      citations:  [`Bank line: ${rs(line.amount)} ${dir} on ${new Date(line.date).toLocaleDateString()}`,
                   `Ledger entry: ${(best.description || '').slice(0, 80)} — ${rs(best.amount)}`],
      confidence: Math.max(0, Math.min(1, best.score / 100)),
      amount:     line.amount,
      payload:    { statementId, lineRef: line.lineRef, journalEntryId: String(best.journalEntryId), userId: actor?.id || null },
      reversal:   { kind: 'bank_unmatch' },
      sourceType: 'bank_line',
      sourceId,
    });
    proposed++;
  }
  return proposed;
}

/** Scan every in-progress statement for the business. */
async function scanBusiness(businessId, actor) {
  let total = 0;
  try {
    const statements = await bankRec.list(businessId, {});
    for (const s of statements) {
      if (s.status && s.status !== 'in_progress') continue;
      try { total += await scanStatement(businessId, String(s._id), actor); }
      catch (e) { logger.warn(`[reconciler] scan statement ${s._id} failed: ${e.message}`); }
    }
  } catch (e) { logger.warn(`[reconciler] scanBusiness failed: ${e.message}`); }
  return total;
}

/* ── Executor: confirm the match (the one authoritative reconcile path) ──────── */
async function executeClearMatch(action) {
  const p = action.payload || {};
  const actor = { id: p.userId || null, fullName: 'VousFin Reconciler' };
  await bankRec.confirmMatch(p.statementId, p.lineRef, p.journalEntryId, action.businessId, actor);
  return { statementId: p.statementId, lineRef: p.lineRef, journalEntryId: p.journalEntryId };
}

/* ── Reverser: un-link the line ─────────────────────────────────────────────── */
async function reverseClearMatch(action) {
  const p = action.payload || {};
  await bankRec.unmatch(p.statementId, p.lineRef, action.businessId);
  return { unmatched: true };
}

executors.register(CLEAR_BANK_MATCH, { execute: executeClearMatch, reverse: reverseClearMatch });

module.exports = { scanStatement, scanBusiness, executeClearMatch, reverseClearMatch, PROPOSE_MIN_SCORE, PROPOSE_MIN_GAP };
