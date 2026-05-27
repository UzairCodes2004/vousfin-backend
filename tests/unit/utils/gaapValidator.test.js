/**
 * tests/unit/utils/gaapValidator.test.js
 *
 * Phase 5.5 Step 7 — Accounting Hardening + GAAP Validation
 *
 * 14 required test scenarios (no DB, no mocks needed):
 *  1.  Credit Sale
 *  2.  Vendor Bill
 *  3.  Partial Customer Payment
 *  4.  Partial Vendor Payment
 *  5.  Inventory Purchase
 *  6.  Inventory Sale (with COGS)
 *  7.  Installment Purchase
 *  8.  Tax-Inclusive Invoice
 *  9.  Customer Refund
 *  10. Write-Off (Bad Debt)
 *  11. Multi-Currency Sale (IAS 21)
 *  12. Overdue Receivable
 *  13. Overdue Payable
 *  14. Inventory Return
 *
 * Also covers:
 *  - Balance rule (ΣDR = ΣCR)
 *  - Non-zero / positive amounts
 *  - Distinct accounts rule
 *  - AR/AP account type correctness warnings
 *  - Unbalanced journal → error
 */

'use strict';

const {
  validateDoubleEntry,
  validateTransactionEntry,
  validateJournalBalance,
  scenarioAudit,
  TOLERANCE,
} = require('../../../utils/gaapValidator');

// ── Helpers ───────────────────────────────────────────────────────────────────
const dr = (amount, accountName = '') => ({ type: 'debit',  amount, accountName });
const cr = (amount, accountName = '') => ({ type: 'credit', amount, accountName });

// ═════════════════════════════════════════════════════════════════════════════
//  CORE DOUBLE-ENTRY RULE TESTS
// ═════════════════════════════════════════════════════════════════════════════

describe('validateDoubleEntry — core rules', () => {
  test('balanced 2-line entry passes', () => {
    const r = validateDoubleEntry([dr(1000), cr(1000)]);
    expect(r.valid).toBe(true);
    expect(r.balanced).toBe(true);
    expect(r.imbalance).toBe(0);
  });

  test('unbalanced entry fails', () => {
    const r = validateDoubleEntry([dr(1000), cr(900)]);
    expect(r.valid).toBe(false);
    expect(r.balanced).toBe(false);
    expect(r.imbalance).toBeCloseTo(100);
    expect(r.errors.some(e => e.includes('unbalanced'))).toBe(true);
  });

  test('imbalance within tolerance passes', () => {
    const r = validateDoubleEntry([dr(1000), cr(1000.005)]);
    expect(r.balanced).toBe(true);
  });

  test('missing debit fails', () => {
    const r = validateDoubleEntry([cr(500)]);
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.includes('debit'))).toBe(true);
  });

  test('missing credit fails', () => {
    const r = validateDoubleEntry([dr(500)]);
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.includes('credit'))).toBe(true);
  });

  test('negative amount produces error', () => {
    const r = validateDoubleEntry([dr(-100), cr(-100)]);
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.includes('positive'))).toBe(true);
  });

  test('compound balanced entry (3+ lines) passes', () => {
    // Sale + GST split: DR Cash 11700 / CR Sales 10000 / CR GST Payable 1700
    const r = validateDoubleEntry([
      dr(11700, 'Cash at Bank'),
      cr(10000, 'Sales Revenue'),
      cr(1700,  'GST Payable'),
    ]);
    expect(r.valid).toBe(true);
    expect(r.totalDebits).toBeCloseTo(11700);
    expect(r.totalCredits).toBeCloseTo(11700);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  validateJournalBalance wrapper
// ═════════════════════════════════════════════════════════════════════════════
describe('validateJournalBalance', () => {
  test('returns balanced=true for equal sides', () => {
    const r = validateJournalBalance([dr(500), cr(500)]);
    expect(r.balanced).toBe(true);
    expect(r.imbalance).toBe(0);
  });

  test('handles empty array gracefully', () => {
    const r = validateJournalBalance([]);
    // Empty journal is unbalanced — 0 debits, 0 credits but errors from missing lines
    expect(r.totalDebits).toBe(0);
    expect(r.totalCredits).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  14 GAAP SCENARIOS
// ═════════════════════════════════════════════════════════════════════════════

describe('Scenario 1 — Credit Sale (AR Invoice)', () => {
  const scenario = {
    scenarioName: 'Credit Sale',
    transactionType: 'Credit Sale',
    amount: 25000,
    debitAccountName:  'Accounts Receivable',
    creditAccountName: 'Sales Revenue',
    customerName: 'ABC Traders',
    journalLines: [
      dr(25000, 'Accounts Receivable'),
      cr(25000, 'Sales Revenue'),
    ],
  };
  test('journal is balanced', () => {
    const r = scenarioAudit(scenario);
    expect(r.balanced).toBe(true);
  });
  test('entry is valid', () => {
    const r = validateTransactionEntry(scenario);
    expect(r.valid).toBe(true);
  });
  test('matching principle flag raised', () => {
    const r = validateTransactionEntry(scenario);
    expect(r.gaapFlags.length).toBeGreaterThan(0);
  });
});

describe('Scenario 2 — Vendor Bill (AP)', () => {
  const scenario = {
    scenarioName: 'Vendor Bill',
    transactionType: 'Credit Purchase',
    amount: 15000,
    debitAccountName:  'Office Supplies',
    creditAccountName: 'Accounts Payable',
    vendorName: 'Ali Wholesalers',
    journalLines: [
      dr(15000, 'Office Supplies Expense'),
      cr(15000, 'Accounts Payable'),
    ],
  };
  test('journal is balanced', () => {
    const r = scenarioAudit(scenario);
    expect(r.balanced).toBe(true);
  });
  test('no errors', () => {
    const r = validateTransactionEntry(scenario);
    expect(r.errors).toHaveLength(0);
  });
});

describe('Scenario 3 — Partial Customer Payment', () => {
  // Full invoice: 25000 / Partial payment: 10000 / Remaining: 15000
  const scenario = {
    scenarioName: 'Partial Customer Payment',
    transactionType: 'Payment Received',
    amount: 10000,
    debitAccountName:  'Cash at Bank',
    creditAccountName: 'Accounts Receivable',
    customerName: 'ABC Traders',
    journalLines: [
      dr(10000, 'Cash at Bank'),
      cr(10000, 'Accounts Receivable'),
    ],
  };
  test('balanced', () => {
    const r = validateDoubleEntry(scenario.journalLines);
    expect(r.balanced).toBe(true);
  });
  test('valid entry', () => {
    const r = validateTransactionEntry(scenario);
    expect(r.valid).toBe(true);
  });
});

describe('Scenario 4 — Partial Vendor Payment', () => {
  const scenario = {
    scenarioName: 'Partial Vendor Payment',
    transactionType: 'Payment Made',
    amount: 5000,
    debitAccountName:  'Accounts Payable',
    creditAccountName: 'Cash at Bank',
    vendorName: 'Ali Wholesalers',
    journalLines: [
      dr(5000, 'Accounts Payable'),
      cr(5000, 'Cash at Bank'),
    ],
  };
  test('balanced', () => {
    const r = validateDoubleEntry(scenario.journalLines);
    expect(r.balanced).toBe(true);
  });
  test('valid entry', () => {
    const r = validateTransactionEntry(scenario);
    expect(r.valid).toBe(true);
  });
});

describe('Scenario 5 — Inventory Purchase', () => {
  const scenario = {
    scenarioName: 'Inventory Purchase',
    transactionType: 'Inventory Purchase',
    amount: 50000,
    debitAccountName:  'Inventory',
    creditAccountName: 'Accounts Payable',
    vendorName: 'Stock Suppliers Ltd',
    journalLines: [
      dr(50000, 'Inventory'),
      cr(50000, 'Accounts Payable'),
    ],
  };
  test('balanced', () => {
    const r = validateDoubleEntry(scenario.journalLines);
    expect(r.balanced).toBe(true);
  });
  test('valid', () => {
    const r = validateTransactionEntry(scenario);
    expect(r.valid).toBe(true);
  });
});

describe('Scenario 6 — Inventory Sale (with COGS)', () => {
  // Revenue leg: DR Cash 30000 / CR Sales 30000
  // COGS leg:    DR COGS 20000 / CR Inventory 20000
  const journalLines = [
    dr(30000, 'Cash at Bank'),
    cr(30000, 'Sales Revenue'),
    dr(20000, 'Cost of Goods Sold'),
    cr(20000, 'Inventory'),
  ];
  test('compound journal is balanced', () => {
    const r = validateDoubleEntry(journalLines);
    expect(r.balanced).toBe(true);
    expect(r.totalDebits).toBeCloseTo(50000);
    expect(r.totalCredits).toBeCloseTo(50000);
  });
  test('COGS line present suppresses advisory warning', () => {
    const r = validateTransactionEntry({
      transactionType: 'Inventory Sale',
      amount: 30000,
      journalLines,
    });
    // COGS line IS present — no inventory warning
    expect(r.warnings.filter(w => w.includes('COGS'))).toHaveLength(0);
  });
});

describe('Scenario 7 — Installment Purchase', () => {
  // Asset 100000, down 20000, loan 80000
  const journalLines = [
    dr(100000, 'Fixed Assets — Machinery'),
    cr(20000,  'Cash at Bank'),
    cr(80000,  'Loan Payable'),
  ];
  test('compound entry balanced', () => {
    const r = validateDoubleEntry(journalLines);
    expect(r.balanced).toBe(true);
    expect(r.totalDebits).toBeCloseTo(100000);
    expect(r.totalCredits).toBeCloseTo(100000);
  });
});

describe('Scenario 8 — Tax-Inclusive Invoice (GST 17%)', () => {
  // Invoice 11700 incl. 17% GST: base 10000, GST 1700
  const journalLines = [
    dr(11700, 'Cash at Bank'),
    cr(10000, 'Sales Revenue'),
    cr(1700,  'GST Payable'),
  ];
  test('balanced with tax split', () => {
    const r = validateDoubleEntry(journalLines);
    expect(r.balanced).toBe(true);
    expect(r.totalDebits).toBeCloseTo(11700);
    expect(r.totalCredits).toBeCloseTo(11700);
  });
  test('valid entry', () => {
    const r = validateTransactionEntry({
      transactionType: 'Cash Sale',
      amount: 11700,
      journalLines,
    });
    expect(r.valid).toBe(true);
  });
});

describe('Scenario 9 — Customer Refund', () => {
  // Reverse of original sale: DR Sales Revenue / CR Cash
  const journalLines = [
    dr(5000, 'Sales Revenue'),
    cr(5000, 'Cash at Bank'),
  ];
  test('balanced', () => {
    const r = validateDoubleEntry(journalLines);
    expect(r.balanced).toBe(true);
  });
  test('valid refund entry', () => {
    const r = validateTransactionEntry({
      transactionType: 'Refund',
      amount: 5000,
      journalLines,
    });
    expect(r.valid).toBe(true);
  });
});

describe('Scenario 10 — Write-Off (Bad Debt)', () => {
  // DR Bad Debt Expense / CR Accounts Receivable
  const journalLines = [
    dr(8000, 'Bad Debt Expense'),
    cr(8000, 'Accounts Receivable'),
  ];
  test('balanced', () => {
    const r = validateDoubleEntry(journalLines);
    expect(r.balanced).toBe(true);
  });
  test('IFRS 9 flag raised for write-off type', () => {
    const r = validateTransactionEntry({
      transactionType: 'Write-Off',
      amount: 8000,
      journalLines,
    });
    expect(r.gaapFlags.some(f => f.includes('IFRS 9'))).toBe(true);
  });
});

describe('Scenario 11 — Multi-Currency Sale (IAS 21)', () => {
  // USD 1000 @ 280 PKR = 280000 PKR
  const scenario = {
    transactionType: 'Cash Sale',
    amount: 1000,          // foreign amount
    currencyCode: 'USD',
    exchangeRate: 280,
    journalLines: [
      dr(280000, 'Cash at Bank'),
      cr(280000, 'Sales Revenue'),
    ],
  };
  test('balanced in base currency', () => {
    const r = validateDoubleEntry(scenario.journalLines);
    expect(r.balanced).toBe(true);
  });
  test('IAS 21 flag raised', () => {
    const r = validateTransactionEntry(scenario);
    expect(r.gaapFlags.some(f => f.includes('IAS 21'))).toBe(true);
  });
});

describe('Scenario 12 — Overdue Receivable', () => {
  test('GAAP accrual flag raised for OVERDUE status', () => {
    const r = validateTransactionEntry({
      transactionType: 'Credit Sale',
      amount: 20000,
      paymentStatus: 'OVERDUE',
      customerName: 'Late Payer Co',
      journalLines: [dr(20000), cr(20000)],
    });
    expect(r.gaapFlags.some(f => f.includes('ACCRUAL_BASIS'))).toBe(true);
  });
  test('entry still valid despite overdue flag', () => {
    const r = validateTransactionEntry({
      transactionType: 'Credit Sale',
      amount: 20000,
      paymentStatus: 'OVERDUE',
      journalLines: [dr(20000), cr(20000)],
    });
    expect(r.valid).toBe(true);
  });
});

describe('Scenario 13 — Overdue Payable', () => {
  // Overdue payable — journal is still balanced, no entry-level error
  const journalLines = [
    dr(12000, 'Accounts Payable'),
    cr(12000, 'Cash at Bank'),
  ];
  test('payment journal balanced', () => {
    const r = validateDoubleEntry(journalLines);
    expect(r.balanced).toBe(true);
  });
  test('valid payment entry', () => {
    const r = validateTransactionEntry({
      transactionType: 'Payment Made',
      amount: 12000,
      vendorName: 'Overdue Vendor',
      journalLines,
    });
    expect(r.valid).toBe(true);
  });
});

describe('Scenario 14 — Inventory Return', () => {
  // Reverse of original purchase: DR Accounts Payable / CR Inventory
  const journalLines = [
    dr(7500, 'Accounts Payable'),
    cr(7500, 'Inventory'),
  ];
  test('balanced', () => {
    const r = validateDoubleEntry(journalLines);
    expect(r.balanced).toBe(true);
  });
  test('valid return entry', () => {
    const r = validateTransactionEntry({
      transactionType: 'Inventory Return',
      amount: 7500,
      vendorName: 'Stock Suppliers Ltd',
      journalLines,
    });
    expect(r.valid).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  EDGE CASE / HARDENING
// ═════════════════════════════════════════════════════════════════════════════

describe('Hardening — edge cases', () => {
  test('amount of zero is rejected', () => {
    const r = validateTransactionEntry({ transactionType: 'Income', amount: 0 });
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.includes('greater than zero'))).toBe(true);
  });

  test('same DR and CR account raises error', () => {
    const r = validateTransactionEntry({
      transactionType: 'Transfer',
      amount: 1000,
      debitAccountId:  'acc001',
      creditAccountId: 'acc001',
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.includes('different'))).toBe(true);
  });

  test('Credit Sale without customer raises advisory warning', () => {
    const r = validateTransactionEntry({
      transactionType: 'Credit Sale',
      amount: 5000,
      debitAccountName:  'Accounts Receivable',
      creditAccountName: 'Sales Revenue',
      // No customerName / customerId
    });
    expect(r.warnings.some(w => w.includes('customer'))).toBe(true);
  });

  test('Credit Purchase without vendor raises advisory warning', () => {
    const r = validateTransactionEntry({
      transactionType: 'Credit Purchase',
      amount: 3000,
      debitAccountName:  'Expense Account',
      creditAccountName: 'Accounts Payable',
      // No vendorName / vendorId
    });
    expect(r.warnings.some(w => w.includes('vendor'))).toBe(true);
  });

  test('Inventory Sale without COGS line raises advisory warning', () => {
    const r = validateTransactionEntry({
      transactionType: 'Inventory Sale',
      amount: 10000,
      journalLines: [
        dr(10000, 'Cash at Bank'),
        cr(10000, 'Sales Revenue'),
        // No COGS line
      ],
    });
    expect(r.warnings.some(w => w.includes('COGS'))).toBe(true);
  });

  test('scenarioAudit returns structured report', () => {
    const r = scenarioAudit({
      scenarioName: 'Unit Test',
      transactionType: 'Expense',
      amount: 1000,
      journalLines: [dr(1000), cr(1000)],
    });
    expect(r.scenarioName).toBe('Unit Test');
    expect(r.balanced).toBe(true);
    expect(r.valid).toBe(true);
  });

  test('TOLERANCE constant is 0.01', () => {
    expect(TOLERANCE).toBe(0.01);
  });
});
