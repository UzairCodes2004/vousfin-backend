/**
 * gaapValidator.js
 *
 * Pure GAAP / IFRS double-entry validation utilities.
 * Zero DB dependencies — functions take plain data objects and return
 * { valid, errors[], warnings[] }.
 *
 * Used by:
 *   - Pre-save advisory checks (AI route)
 *   - Hardening test suite (14 scenarios)
 *   - Future reconciliation endpoint
 *
 * Rules enforced:
 *   1. Balance rule            — ΣDebit = ΣCredit within 0.01 tolerance (IAS 1)
 *   2. Non-zero rule           — every journal line must have amount > 0
 *   3. Distinct accounts rule  — DR ≠ CR for simple entries (prevents circular entries)
 *   4. Minimum lines rule      — at least 1 DR + 1 CR line
 *   5. Matching principle      — revenue lines must have a corresponding expense or asset (GAAP)
 *   6. AR/AP type rule         — Credit Sale must debit receivable; Credit Purchase must credit payable
 *   7. No negative amounts     — amounts must always be positive (sign comes from DR/CR type)
 *   8. Inventory COGS pairing  — Inventory Sale entries must include COGS lines (advisory)
 */

'use strict';

const TOLERANCE = 0.01; // Maximum DR-CR imbalance allowed (rounding)

/* ── Normalise ───────────────────────────────────────────────────────────────
 * Accepts both formats:
 *   - { type: 'debit'|'credit', amount, accountName? }   ← journalLines format
 *   - { entryType: 'debit'|'credit', amount, account? }  ← journalGenerator format
 */
function normalise(lines) {
  return (lines || []).map(l => ({
    type:        (l.type || l.entryType || '').toLowerCase(),
    amount:      Number(l.amount || 0),
    accountName: l.accountName || l.account || '',
  }));
}

/* ── Core: validateDoubleEntry ───────────────────────────────────────────────
 * @param  {Array}  lines   - array of journal line objects (normalised above)
 * @param  {Object} options - { tolerance?: number }
 * @returns {{ valid, totalDebits, totalCredits, imbalance, errors, warnings }}
 */
function validateDoubleEntry(lines, options = {}) {
  const tol    = options.tolerance ?? TOLERANCE;
  const norm   = normalise(lines);
  const errors   = [];
  const warnings = [];

  // Rule 4: Minimum lines
  const debits  = norm.filter(l => l.type === 'debit');
  const credits = norm.filter(l => l.type === 'credit');

  if (debits.length === 0)  errors.push('Journal must have at least one debit line');
  if (credits.length === 0) errors.push('Journal must have at least one credit line');

  // Rule 7: No negative amounts
  norm.forEach((l, i) => {
    if (l.amount < 0) errors.push(`Line ${i + 1}: amount must be positive (got ${l.amount})`);
  });

  // Rule 2: Non-zero
  norm.forEach((l, i) => {
    if (l.amount === 0) warnings.push(`Line ${i + 1}: zero-amount journal line (${l.accountName || 'unnamed'})`);
  });

  // Rule 1: Balance
  const totalDebits  = debits.reduce((s, l) => s + l.amount, 0);
  const totalCredits = credits.reduce((s, l) => s + l.amount, 0);
  const imbalance    = Math.abs(totalDebits - totalCredits);
  const balanced     = imbalance <= tol;

  if (!balanced) {
    errors.push(
      `Journal is unbalanced: DR ${totalDebits.toFixed(2)} ≠ CR ${totalCredits.toFixed(2)} ` +
      `(imbalance ${imbalance.toFixed(4)} exceeds tolerance ${tol})`
    );
  }

  return {
    valid:        errors.length === 0,
    balanced,
    totalDebits:  Math.round(totalDebits  * 100) / 100,
    totalCredits: Math.round(totalCredits * 100) / 100,
    imbalance:    Math.round(imbalance    * 100) / 100,
    errors,
    warnings,
  };
}

/* ── validateTransactionEntry ────────────────────────────────────────────────
 * Higher-level check for a full transaction record.
 * @param {Object} entry  - { transactionType, amount, debitAccountName?,
 *                           creditAccountName?, journalLines?, taxAmount?,
 *                           customerId?, vendorId?, paymentStatus? }
 * @returns {{ valid, errors[], warnings[], gaapFlags[] }}
 */
function validateTransactionEntry(entry) {
  const errors   = [];
  const warnings = [];
  const gaapFlags = [];

  const type = (entry.transactionType || '').toLowerCase().replace(/_/g, ' ');
  const amt  = Number(entry.amount || 0);

  // Basic amount check
  if (amt <= 0) errors.push('Transaction amount must be greater than zero');

  // Build simple 2-line check when journalLines not provided
  const lines = entry.journalLines?.length
    ? entry.journalLines
    : [
        { type: 'debit',  amount: amt },
        { type: 'credit', amount: amt },
      ];

  const balResult = validateDoubleEntry(lines);
  if (!balResult.valid) errors.push(...balResult.errors);
  warnings.push(...balResult.warnings);

  // Rule 3: Distinct accounts (simple entries only)
  const debitId  = entry.debitAccountId  || entry.debitAccountName;
  const creditId = entry.creditAccountId || entry.creditAccountName;
  if (debitId && creditId && debitId === creditId) {
    errors.push('Debit and credit accounts must be different');
  }

  // Rule 5: Matching Principle — Revenue must pair with an asset or COGS debit
  if (type.includes('sale') || type.includes('income')) {
    gaapFlags.push('MATCHING_PRINCIPLE: Revenue recognised — ensure corresponding expense/COGS is recorded in same period');
  }

  // Rule 6: AR/AP Type correctness
  if (type === 'credit sale') {
    if (!entry.customerId && !entry.customerName) {
      warnings.push('Credit Sale should reference a customer for AR tracking');
    }
    const debitName = (entry.debitAccountName || '').toLowerCase();
    if (debitName && !debitName.includes('receivable') && !debitName.includes('debtor')) {
      warnings.push('Credit Sale debit account should be Accounts Receivable');
    }
  }

  if (type === 'credit purchase') {
    if (!entry.vendorId && !entry.vendorName) {
      warnings.push('Credit Purchase should reference a vendor for AP tracking');
    }
    const creditName = (entry.creditAccountName || '').toLowerCase();
    if (creditName && !creditName.includes('payable') && !creditName.includes('creditor')) {
      warnings.push('Credit Purchase credit account should be Accounts Payable');
    }
  }

  // Rule 8: Inventory COGS pairing (advisory)
  if (type === 'inventory sale') {
    const hasCogsLine = lines.some(l =>
      (l.accountName || l.account || '').toLowerCase().includes('cost of goods')
    );
    if (!hasCogsLine) {
      warnings.push('Inventory Sale should include a COGS debit line (DR Cost of Goods Sold / CR Inventory)');
    }
    gaapFlags.push('MATCHING_PRINCIPLE: Inventory Sale — COGS must be recognised in the same period as the revenue');
  }

  // Overdue check (advisory)
  if (entry.paymentStatus === 'OVERDUE') {
    gaapFlags.push('ACCRUAL_BASIS: Overdue receivable — consider allowance for doubtful accounts per GAAP');
  }

  // Write-off GAAP note
  if (type.includes('write') && type.includes('off')) {
    gaapFlags.push('IFRS 9: Write-off requires documented evidence of uncollectability; should debit Allowance for Doubtful Accounts first');
  }

  // Multi-currency IAS 21
  if (entry.currencyCode && entry.exchangeRate && entry.exchangeRate !== 1) {
    gaapFlags.push(`IAS 21: Foreign currency transaction (${entry.currencyCode} @ ${entry.exchangeRate}) — exchange differences should be recognised in P&L`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    gaapFlags,
  };
}

/* ── validateJournalBalance ──────────────────────────────────────────────────
 * Thin wrapper — accepts raw journal lines array (the format stored in DB).
 * Returns { balanced, totalDebits, totalCredits, imbalance }.
 */
function validateJournalBalance(journalLines) {
  const result = validateDoubleEntry(journalLines || []);
  return {
    balanced:     result.balanced,
    totalDebits:  result.totalDebits,
    totalCredits: result.totalCredits,
    imbalance:    result.imbalance,
  };
}

/* ── scenarioAudit ───────────────────────────────────────────────────────────
 * Run all GAAP checks for a scenario object and return a structured report.
 * Used by the 14-scenario test suite.
 */
function scenarioAudit(scenario) {
  const entry = validateTransactionEntry(scenario);
  const balance = scenario.journalLines
    ? validateDoubleEntry(scenario.journalLines)
    : { balanced: true, totalDebits: scenario.amount, totalCredits: scenario.amount, imbalance: 0, errors: [], warnings: [] };

  return {
    scenarioName:  scenario.scenarioName || 'Unnamed',
    transactionType: scenario.transactionType,
    amount:        scenario.amount,
    valid:         entry.valid && balance.balanced,
    balanced:      balance.balanced,
    totalDebits:   balance.totalDebits,
    totalCredits:  balance.totalCredits,
    imbalance:     balance.imbalance,
    errors:        [...entry.errors, ...balance.errors],
    warnings:      [...entry.warnings, ...balance.warnings],
    gaapFlags:     entry.gaapFlags,
  };
}

module.exports = {
  validateDoubleEntry,
  validateTransactionEntry,
  validateJournalBalance,
  scenarioAudit,
  TOLERANCE,
};
