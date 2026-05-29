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
 * and a single credit account for the SAME amount. Running-balance updates are
 * best-effort and isolated — a balance-cache failure is logged but never throws
 * back to the caller, so it can never roll back a ledger write (Rule 3). The
 * cache can always be rebuilt with transaction.service.recalculateAccountBalance.
 */

'use strict';

const JournalEntry = require('../models/JournalEntry.model');
const accountRepository = require('../repositories/account.repository');
const logger = require('../config/logger');

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

/**
 * Apply a posted amount to one account's cached running balance, respecting the
 * account's normal balance. Mirrors transaction.service._updateAccountBalance.
 *
 * @param {string} accountId
 * @param {number} amount   always positive — the journal line amount
 * @param {'debit'|'credit'} side
 */
async function applyRunningBalance(accountId, amount, side) {
  if (!accountId) return;
  try {
    const account = await accountRepository.findById(accountId);
    if (!account) {
      logger.warn(`[ledgerPosting] account ${accountId} not found — running balance not updated`);
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
    await accountRepository.updateRunningBalance(accountId, r2(delta));
  } catch (e) {
    logger.error(`[ledgerPosting] running-balance update failed for ${accountId}: ${e.message}`);
  }
}

/**
 * Create a balanced two-account JournalEntry and sync both running balances.
 *
 * @param {Object} entry   a JournalEntry payload with debitAccountId,
 *                         creditAccountId and amount (plus the usual metadata)
 * @param {Object} [opts]
 * @param {boolean} [opts.updateBalances=true]  set false to skip the cache sync
 * @returns {Promise<Object>}  the created JournalEntry document
 */
async function postBalancedJournal(entry, { updateBalances = true } = {}) {
  const je = await JournalEntry.create(entry);
  if (updateBalances) {
    // Sequential (not Promise.all) so a self-referential pair can't race; both
    // are isolated so one failure never blocks the other or the caller.
    await applyRunningBalance(je.debitAccountId, je.amount, 'debit');
    await applyRunningBalance(je.creditAccountId, je.amount, 'credit');
  }
  return je;
}

module.exports = { postBalancedJournal, applyRunningBalance };
