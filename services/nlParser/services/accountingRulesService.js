/**
 * @module accountingRulesService
 * @description Enforces accounting rules including debit/credit mapping,
 * normal balance validation, and account type verification.
 * This layer ensures AI output never bypasses accounting integrity.
 */

const { ACCOUNT_ALIAS_MAP } = require('../constants/chartOfAccounts');
const { NORMAL_BALANCES } = require('../constants/accountTypes');
const { REVERSAL_TYPES } = require('../constants/transactionTypes');

/**
 * Resolve an account name/alias to a valid chart-of-accounts entry.
 * @param {string} accountRef - Account name or alias from AI or mapping.
 * @returns {{ account: object|null, resolved: boolean }}
 */
function resolveAccount(accountRef) {
  if (!accountRef) return { account: null, resolved: false };

  const key = accountRef.toString().toLowerCase().trim();
  const account = ACCOUNT_ALIAS_MAP.get(key);

  if (account) {
    return { account, resolved: true };
  }

  return { account: null, resolved: false };
}

/**
 * Validate that a journal entry respects normal balance rules.
 * Assets and Expenses normally increase via debit.
 * Liabilities, Equity, and Revenue normally increase via credit.
 *
 * @param {string} accountName - The account being debited/credited.
 * @param {string} entryType - 'debit' or 'credit'.
 * @param {string} transactionType - The classified transaction type.
 * @returns {{ valid: boolean, warning: string|null }}
 */
function validateNormalBalance(accountName, entryType, transactionType) {
  const { account } = resolveAccount(accountName);
  if (!account) {
    return { valid: true, warning: 'Account not found in chart of accounts' };
  }

  const expectedNormal = NORMAL_BALANCES[account.type];
  if (!expectedNormal) {
    return { valid: true, warning: null };
  }

  // For reversal-type transactions, opposite entries are expected
  if (REVERSAL_TYPES.has(transactionType)) {
    return { valid: true, warning: null };
  }

  // Check if this entry increases the account (matches normal balance)
  // or decreases it (opposite of normal balance).
  // Both are valid in proper accounting — we only flag truly anomalous patterns.
  // For example, crediting an expense account outside of a refund/adjustment.
  const isIncreasing = entryType === expectedNormal;
  const isDecreasing = entryType !== expectedNormal;

  // Flag unusual: decreasing an expense (credit) or decreasing revenue (debit)
  // when transaction is not a reversal
  if (isDecreasing) {
    if (account.type === 'expense' && entryType === 'credit') {
      return {
        valid: true,
        warning: `Crediting expense account "${accountName}" — verify this is intentional`,
      };
    }
    if (account.type === 'revenue' && entryType === 'debit') {
      return {
        valid: true,
        warning: `Debiting revenue account "${accountName}" — verify this is intentional`,
      };
    }
  }

  return { valid: true, warning: null };
}

/**
 * Validate that all accounts in journal entries are accounting-valid.
 *
 * Resolution priority:
 *   1. Live business accounts from MongoDB (case-insensitive exact match)
 *   2. Static ACCOUNT_ALIAS_MAP (default CoA template — fallback only)
 *
 * This ensures businesses with custom account names (e.g. "Trade Debtors",
 * "HSBC Current Account") are validated correctly instead of being flagged
 * as unresolved.
 *
 * @param {Array<{ account: string, entryType: string, amount: number }>} entries
 * @param {string} transactionType
 * @param {Array}  businessAccounts - Live ChartOfAccount docs from MongoDB (optional).
 * @returns {{ valid: boolean, warnings: string[], unresolvedAccounts: string[] }}
 */
function validateJournalAccounts(entries, transactionType, businessAccounts = []) {
  const warnings = [];
  const unresolvedAccounts = [];

  // Build a fast lookup from live business accounts (populated from MongoDB)
  const liveAccountMap = new Map();
  for (const acct of businessAccounts) {
    if (acct?.accountName) {
      liveAccountMap.set(acct.accountName.toLowerCase().trim(), {
        name: acct.accountName,
        type: acct.accountType?.toLowerCase(),
      });
    }
  }

  for (const entry of entries) {
    const liveKey = entry.account?.toLowerCase().trim();
    const liveMatch = liveKey ? liveAccountMap.get(liveKey) : null;

    if (liveMatch) {
      // ── Found in live MongoDB accounts ──────────────────────────────────────
      // Validate normal balance using live account type
      if (!REVERSAL_TYPES.has(transactionType)) {
        const { type } = liveMatch;
        const normalIncrease = (type === 'asset' || type === 'expense') ? 'debit' : 'credit';
        if (entry.entryType !== normalIncrease) {
          if (type === 'expense' && entry.entryType === 'credit') {
            warnings.push(`Crediting expense account "${entry.account}" — verify this is intentional`);
          } else if (type === 'revenue' && entry.entryType === 'debit') {
            warnings.push(`Debiting revenue account "${entry.account}" — verify this is intentional`);
          }
        }
      }
    } else {
      // ── Fall back to static alias map ───────────────────────────────────────
      const { account, resolved } = resolveAccount(entry.account);

      if (!resolved) {
        // Only flag as unresolved when both live accounts AND static map have no match.
        // This means the account name is genuinely unknown — not just a custom name.
        unresolvedAccounts.push(entry.account);
        // Downgrade to a softer warning — may be a custom account not in template
        warnings.push(`Account "${entry.account}" not in default template (verify it exists in your Chart of Accounts)`);
      } else {
        const balanceCheck = validateNormalBalance(entry.account, entry.entryType, transactionType);
        if (balanceCheck.warning) {
          warnings.push(balanceCheck.warning);
        }
      }
    }
  }

  return {
    valid: unresolvedAccounts.length === 0,
    warnings,
    unresolvedAccounts,
  };
}

module.exports = {
  resolveAccount,
  validateNormalBalance,
  validateJournalAccounts,
};
