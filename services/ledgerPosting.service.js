/**
 * ledgerPosting.service.js — ERP Integration Refactor, Step 4
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  SHARED BALANCED-JOURNAL POSTER                                            │
 * │                                                                            │
 * │  One place that creates a two-account JournalEntry AND keeps the          │
 * │  Chart-of-Accounts running balances in lock-step. Before this, only       │
 * │  transaction.service updated running balances (via _updateAccountBalance) │
 * │  — bill.service / vendorCredit.service created JournalEntries directly and │
 * │  silently left the trial balance stale.                                   │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * WHY (mandatory rules):
 *   • Rule 4 (GAAP) / Rule 5 (double-entry integrity): a posted journal must
 *     move BOTH account running balances, or the trial balance drifts.
 *   • Rule 8 (no duplicate logic) / Rule 9 (centralized): the debit/credit
 *     sign rule lived only inside transaction.service; now any service that
 *     posts a system journal reuses the exact same rule here.
 *
 * The journal itself is always balanced by construction: a single debit account
 * and a single credit account for the SAME amount.
 *
 * ATOMICITY (R-01 / R-02 fix):
 *   The JournalEntry insert AND both running-balance updates now run inside ONE
 *   MongoDB transaction (via utils/withTransaction). Either the journal AND both
 *   balances commit together, or they ALL roll back — so a crash mid-post can no
 *   longer leave the trial balance drifted from the ledger.
 *     • On a replica set (Atlas / prod): real all-or-nothing. If a balance update
 *       fails, the whole post — including the JournalEntry — rolls back, and the
 *       error propagates so the caller knows the post did not happen. Better to
 *       fail loudly and retry than to silently drift.
 *     • On a standalone dev server (no transactions): withTransaction runs the
 *       work without a session, and the balance updates stay best-effort (a
 *       cache hiccup is logged, the JE survives) — exactly the old behaviour, so
 *       local dev never breaks.
 *   Callers already inside their own transaction can pass `{ session }`; the post
 *   then joins that transaction instead of opening a nested one.
 */

'use strict';

const JournalEntry = require('../models/JournalEntry.model');
const accountRepository = require('../repositories/account.repository');
const { withTransaction } = require('../utils/withTransaction');
const logger = require('../config/logger');

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

/**
 * Apply a posted amount to one account's cached running balance, respecting the
 * account's normal balance. Mirrors transaction.service._updateAccountBalance.
 *
 * @param {string} accountId
 * @param {number} amount   always positive — the journal line amount
 * @param {'debit'|'credit'} side
 * @param {Object}  [opts]
 * @param {import('mongoose').ClientSession|null} [opts.session]  txn session to join
 * @param {boolean} [opts.strict]  when true (inside a real txn), a failure THROWS
 *                                 so the transaction rolls back; when false it is
 *                                 logged and swallowed (legacy best-effort).
 */
async function applyRunningBalance(accountId, amount, side, { session = null, strict = false } = {}) {
  if (!accountId) return;
  try {
    const account = await accountRepository.findById(accountId);
    if (!account) {
      // normalBalance is immutable, so a non-session read is consistent here.
      const msg = `[ledgerPosting] account ${accountId} not found — running balance not updated`;
      if (strict) throw new Error(msg);
      logger.warn(msg);
      return;
    }
    let delta;
    if (side === 'debit') {
      // Debit increases debit-normal accounts, decreases credit-normal ones.
      delta = account.normalBalance === 'Debit' ? amount : -amount;
    } else {
      // Credit increases credit-normal accounts, decreases debit-normal ones.
      delta = account.normalBalance === 'Credit' ? amount : -amount;
    }
    await accountRepository.updateRunningBalance(accountId, r2(delta), session);
  } catch (e) {
    if (strict) throw e; // inside a transaction → propagate so the JE rolls back
    logger.error(`[ledgerPosting] running-balance update failed for ${accountId}: ${e.message}`);
  }
}

/**
 * Create a balanced two-account JournalEntry and sync both running balances —
 * atomically (see the ATOMICITY note in the file header).
 *
 * @param {Object} entry   a JournalEntry payload with debitAccountId,
 *                         creditAccountId and amount (plus the usual metadata)
 * @param {Object} [opts]
 * @param {boolean} [opts.updateBalances=true]  set false to skip the cache sync
 * @param {import('mongoose').ClientSession|null} [opts.session]  join an existing txn
 * @returns {Promise<Object>}  the created JournalEntry document
 */
async function postBalancedJournal(entry, { updateBalances = true, session = null } = {}) {
  // The unit of work: insert the JE, then move both running balances. Every write
  // forwards the session `s` so they share one transaction.
  const run = async (s) => {
    // Mongoose's array form returns an array; stay tolerant of a single-doc result.
    const created = await JournalEntry.create([entry], { session: s });
    const je = Array.isArray(created) ? created[0] : created;
    if (updateBalances) {
      // Sequential (not Promise.all) so a self-referential pair can't race.
      // strict = inside a real txn → a balance failure rolls the whole post back.
      await applyRunningBalance(je.debitAccountId, je.amount, 'debit',  { session: s, strict: !!s });
      await applyRunningBalance(je.creditAccountId, je.amount, 'credit', { session: s, strict: !!s });
    }
    return je;
  };

  if (session) return run(session);       // caller already owns a transaction
  if (!updateBalances) return run(null);  // a single insert is atomic on its own
  return withTransaction(run);            // open our own all-or-nothing unit
}

module.exports = { postBalancedJournal, applyRunningBalance };
