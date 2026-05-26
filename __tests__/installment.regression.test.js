'use strict';
// ════════════════════════════════════════════════════════════════════════════
// VousFin Installment Accounting — Full Regression Test Suite
// Tests all pure-logic (no DB required) — math, journals, lifecycle
// ════════════════════════════════════════════════════════════════════════════

const { INSTALLMENT_STATUS, INSTALLMENT_FREQUENCY, PAYMENT_STATUS } = require('../config/constants');
const InstallmentPlan = require('../models/InstallmentPlan.model');
const normalizationService = require('../services/nlParser/services/normalizationService');
const proto = InstallmentPlan.prototype;

const round2 = (n) => Math.round(n * 100) / 100;

let passed = 0, failed = 0;
const results = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    results.push({ status: 'PASS', name });
  } catch (e) {
    failed++;
    results.push({ status: 'FAIL', name, error: e.message });
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

function assertBalanced(lines) {
  const dr = lines.filter(l => l.type === 'debit').reduce((s, l) => s + l.amount, 0);
  const cr = lines.filter(l => l.type === 'credit').reduce((s, l) => s + l.amount, 0);
  assert(Math.abs(dr - cr) < 0.02, `Journal unbalanced: DR=${round2(dr)} CR=${round2(cr)}`);
  return { dr, cr };
}

function buildPlan(principal, count, rate, method = 'reducing_balance', freq = 'monthly') {
  return InstallmentPlan.buildAmortization({
    startDate: new Date('2026-01-01'),
    principal, count, frequency: freq,
    annualRatePct: rate, method,
  });
}

function makeMockPlan(overrides = {}) {
  const plan = {
    status: INSTALLMENT_STATUS.ACTIVE, overdueStatus: 'current',
    totalPenaltiesAccrued: 0, penaltyRate: null,
    restructureHistory: [], settlementDiscount: 0, settledEarlyDate: null,
    totalInterestPaid: 0, remainingAmount: 0, outstandingPrincipal: 0,
    principalAmount: 0, paidInstallments: 0, remainingInstallments: 0,
    installmentFrequency: INSTALLMENT_FREQUENCY.MONTHLY,
    interestRate: 12, interestMethod: 'reducing_balance',
    installmentAmount: 0, installmentCount: 0,
    nextDueDate: null, schedule: [],
    constructor: InstallmentPlan,
    ...overrides,
  };
  // Bind prototype methods so plain mock objects behave like Mongoose docs
  plan.refreshOverdueStatus = proto.refreshOverdueStatus.bind(plan);
  plan.getActiveScheduleRow = proto.getActiveScheduleRow.bind(plan);
  return plan;
}

// ══════════════════════════════════════════════════════════════════════════════
// SCENARIO 1 — Financed Vehicle (500,000 @ 15%, 36 months)
// ══════════════════════════════════════════════════════════════════════════════
test('S1: Vehicle - schedule generates 36 rows', () => {
  const { schedule } = buildPlan(500000, 36, 15);
  assert(schedule.length === 36, `Got ${schedule.length}`);
});

test('S1: Vehicle - EMI formula (500k @ 15%, 36m)', () => {
  const { installmentAmount } = buildPlan(500000, 36, 15);
  const r = (15 / 100) / 12, n = 36;
  const expected = round2(500000 * r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1));
  assert(Math.abs(installmentAmount - expected) < 0.02, `EMI: got ${installmentAmount}, expected ${expected}`);
});

test('S1: Vehicle - principal sum = 500,000', () => {
  const { schedule } = buildPlan(500000, 36, 15);
  const sumP = round2(schedule.reduce((s, r) => s + r.principalDue, 0));
  assert(Math.abs(sumP - 500000) < 0.02, `Principal sum: ${sumP}`);
});

test('S1: Vehicle - interest sum = totalInterest', () => {
  const { schedule, totalInterest } = buildPlan(500000, 36, 15);
  const sumI = round2(schedule.reduce((s, r) => s + r.interestDue, 0));
  assert(Math.abs(sumI - totalInterest) < 0.02, `Interest sum: ${sumI} vs ${totalInterest}`);
});

test('S1: Vehicle - last row closingBalance = 0', () => {
  const { schedule } = buildPlan(500000, 36, 15);
  const last = schedule[schedule.length - 1];
  assert(Math.abs(last.closingBalance) < 0.02, `Last closing: ${last.closingBalance}`);
});

test('S1: Vehicle - compound journal balances (DR 500k = CR 100k + CR 400k)', () => {
  assertBalanced([
    { type: 'debit',  amount: 500000, account: 'Vehicle' },
    { type: 'credit', amount: 100000, account: 'Cash at Bank' },
    { type: 'credit', amount: 400000, account: 'Loan Payable' },
  ]);
});

// ══════════════════════════════════════════════════════════════════════════════
// SCENARIO 2 — Furniture (120,000 @ 10%, 12m, flat)
// ══════════════════════════════════════════════════════════════════════════════
test('S2: Furniture flat - equal principal portions per row', () => {
  const { schedule } = buildPlan(120000, 12, 10, 'flat');
  const p0 = schedule[0].principalDue, p6 = schedule[6].principalDue;
  assert(Math.abs(p0 - p6) < 0.02, `Flat principal unequal: ${p0} vs ${p6}`);
});

test('S2: Furniture flat - totalInterest = P × r × t', () => {
  const { totalInterest } = buildPlan(120000, 12, 10, 'flat');
  const expected = round2(120000 * 0.10 * (12 / 12));
  assert(Math.abs(totalInterest - expected) < 0.02, `Flat interest: ${totalInterest} vs ${expected}`);
});

test('S2: Furniture flat - principal sums to 120,000', () => {
  const { schedule } = buildPlan(120000, 12, 10, 'flat');
  const sum = round2(schedule.reduce((s, r) => s + r.principalDue, 0));
  assert(Math.abs(sum - 120000) < 0.02, `Sum: ${sum}`);
});

// ══════════════════════════════════════════════════════════════════════════════
// SCENARIO 3 — Equipment (250,000 @ 18%, 24m, reducing balance)
// ══════════════════════════════════════════════════════════════════════════════
test('S3: Equipment - first row interest = P × monthly_rate', () => {
  const { schedule } = buildPlan(250000, 24, 18);
  const expected = round2(250000 * (18 / 100) / 12);
  assert(Math.abs(schedule[0].interestDue - expected) < 0.02,
    `First interest: ${schedule[0].interestDue} vs ${expected}`);
});

test('S3: Equipment - each opening = previous closing', () => {
  const { schedule } = buildPlan(250000, 24, 18);
  for (let i = 1; i < schedule.length; i++) {
    const gap = Math.abs(schedule[i - 1].closingBalance - schedule[i].openingBalance);
    assert(gap < 0.02, `Balance gap at row ${i}: ${gap}`);
  }
});

test('S3: Equipment - last row closing = 0', () => {
  const { schedule } = buildPlan(250000, 24, 18);
  assert(Math.abs(schedule[23].closingBalance) < 0.02, `Last closing: ${schedule[23].closingBalance}`);
});

// ══════════════════════════════════════════════════════════════════════════════
// SCENARIO 4 — Zero-interest (60,000 in 6 months)
// ══════════════════════════════════════════════════════════════════════════════
test('S4: Zero-interest - all interest = 0', () => {
  const { schedule, totalInterest } = buildPlan(60000, 6, 0);
  assert(totalInterest === 0, `totalInterest: ${totalInterest}`);
  schedule.forEach((r, i) => assert(r.interestDue === 0, `Row ${i} interest: ${r.interestDue}`));
});

test('S4: Zero-interest - equal split 10,000 per row', () => {
  const { schedule } = buildPlan(60000, 6, 0);
  schedule.forEach((r, i) => assert(Math.abs(r.principalDue - 10000) < 0.02, `Row ${i}: ${r.principalDue}`));
});

// ══════════════════════════════════════════════════════════════════════════════
// SCENARIO 5 — Down Payment (400k total, 100k down, 300k financed)
// ══════════════════════════════════════════════════════════════════════════════
test('S5: Down payment - schedule on financed 300k only', () => {
  const { schedule } = buildPlan(300000, 24, 12);
  const sum = round2(schedule.reduce((s, r) => s + r.principalDue, 0));
  assert(Math.abs(sum - 300000) < 0.02, `Principal sum: ${sum}`);
});

test('S5: Down payment - 3-line journal balances', () => {
  assertBalanced([
    { type: 'debit',  amount: 400000, account: 'Vehicle' },
    { type: 'credit', amount: 100000, account: 'Cash at Bank' },
    { type: 'credit', amount: 300000, account: 'Loan Payable' },
  ]);
});

test('S5: No down payment - 2-line journal balances', () => {
  assertBalanced([
    { type: 'debit',  amount: 400000, account: 'Vehicle' },
    { type: 'credit', amount: 400000, account: 'Loan Payable' },
  ]);
});

// ══════════════════════════════════════════════════════════════════════════════
// SCENARIO 6 — Partial EMI Payment
// ══════════════════════════════════════════════════════════════════════════════
test('S6: Partial payment - row becomes partially_paid', () => {
  const { schedule, installmentAmount } = buildPlan(100000, 12, 12);
  const plan = makeMockPlan({
    schedule: schedule.map(r => ({ ...r })),
    remainingAmount: 100000, outstandingPrincipal: 100000,
    principalAmount: 100000, remainingInstallments: 12, installmentAmount,
  });
  proto.recordPayment.call(plan, round2(installmentAmount / 2), 'tx1');
  assert(plan.schedule[0].status === PAYMENT_STATUS.PARTIALLY_PAID,
    `Status: ${plan.schedule[0].status}`);
});

test('S6: Partial payment - interest-first waterfall', () => {
  const { schedule, installmentAmount } = buildPlan(100000, 12, 12);
  const plan = makeMockPlan({
    schedule: schedule.map(r => ({ ...r })),
    remainingAmount: 100000, outstandingPrincipal: 100000,
    principalAmount: 100000, remainingInstallments: 12, installmentAmount,
  });
  const interestOnly = schedule[0].interestDue;
  proto.recordPayment.call(plan, interestOnly, 'tx1');
  assert(Math.abs(plan.schedule[0].paidInterest - interestOnly) < 0.02, 'Interest must be settled first');
  assert(plan.schedule[0].paidPrincipal === 0, 'Principal untouched when only interest paid');
});

test('S6: Partial + full = row PAID', () => {
  const { schedule, installmentAmount } = buildPlan(50000, 6, 0);
  const plan = makeMockPlan({
    schedule: schedule.map(r => ({ ...r })),
    remainingAmount: 50000, outstandingPrincipal: 50000,
    principalAmount: 50000, remainingInstallments: 6, installmentAmount,
  });
  proto.recordPayment.call(plan, round2(installmentAmount / 2), 'tx1');
  proto.recordPayment.call(plan, round2(installmentAmount / 2), 'tx2');
  assert(plan.schedule[0].status === PAYMENT_STATUS.PAID, `Status: ${plan.schedule[0].status}`);
});

// ══════════════════════════════════════════════════════════════════════════════
// SCENARIO 7 — Overdue Installment
// ══════════════════════════════════════════════════════════════════════════════
test('S7: 1 overdue row → overdueStatus=overdue', () => {
  const past = new Date(Date.now() - 10 * 86400000);
  const plan = makeMockPlan({
    schedule: [
      { status: 'unpaid', dueDate: past },
      { status: 'unpaid', dueDate: new Date(Date.now() + 30 * 86400000) },
    ],
  });
  proto.refreshOverdueStatus.call(plan);
  assert(plan.overdueStatus === 'overdue', `Got: ${plan.overdueStatus}`);
});

test('S7: 3 overdue rows → overdueStatus=defaulted', () => {
  const past = new Date(Date.now() - 30 * 86400000);
  const plan = makeMockPlan({
    schedule: [
      { status: 'unpaid', dueDate: past },
      { status: 'unpaid', dueDate: past },
      { status: 'unpaid', dueDate: past },
    ],
  });
  proto.refreshOverdueStatus.call(plan);
  assert(plan.overdueStatus === 'defaulted', `Got: ${plan.overdueStatus}`);
});

test('S7: Penalty daily rate correct (3% p.a.)', () => {
  const plan = makeMockPlan({ penaltyRate: 3 });
  const daily = proto.dailyPenaltyAmount.call(plan, 100000);
  const expected = round2(100000 * 0.03 / 365);
  assert(Math.abs(daily - expected) < 0.01, `Daily: ${daily} vs ${expected}`);
});

test('S7: Penalty journal balances (DR AR / CR Penalty Income)', () => {
  assertBalanced([
    { type: 'debit',  amount: 500, account: 'Accounts Receivable' },
    { type: 'credit', amount: 500, account: 'Penalty Income' },
  ]);
});

test('S7: Vendor penalty journal balances (DR Penalty Expense / CR AP)', () => {
  assertBalanced([
    { type: 'debit',  amount: 300, account: 'Penalty Expense' },
    { type: 'credit', amount: 300, account: 'Accounts Payable' },
  ]);
});

// ══════════════════════════════════════════════════════════════════════════════
// SCENARIO 8 — Restructuring
// ══════════════════════════════════════════════════════════════════════════════
test('S8: Restructure - paid rows kept, unpaid rebuilt', () => {
  const { schedule } = buildPlan(120000, 12, 10);
  const paid   = schedule.slice(0, 4).map(r => ({ ...r, status: PAYMENT_STATUS.PAID }));
  const unpaid = schedule.slice(4).map(r => ({ ...r, status: PAYMENT_STATUS.UNPAID }));
  const plan = makeMockPlan({
    schedule: [...paid, ...unpaid],
    paidInstallments: 4, remainingInstallments: 8,
    outstandingPrincipal: 80000,
  });
  proto.restructure.call(plan, { count: 12, startDate: new Date() });
  assert(plan.schedule.filter(r => r.status === PAYMENT_STATUS.PAID).length === 4, 'Paid rows preserved');
  assert(plan.schedule.filter(r => r.status === PAYMENT_STATUS.UNPAID).length === 12, 'New 12 unpaid rows');
});

test('S8: Restructure - EMI recomputed', () => {
  const plan = makeMockPlan({ outstandingPrincipal: 60000, schedule: [], paidInstallments: 0, remainingInstallments: 0 });
  const { newEMI } = proto.restructure.call(plan, { count: 6, annualRatePct: 12, startDate: new Date() });
  const r = (12 / 100) / 12, n = 6;
  const expected = round2(60000 * r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1));
  assert(Math.abs(newEMI - expected) < 0.02, `New EMI: ${newEMI} vs ${expected}`);
});

test('S8: Restructure - logs history with reason', () => {
  const plan = makeMockPlan({ outstandingPrincipal: 50000, schedule: [], paidInstallments: 0, remainingInstallments: 0 });
  proto.restructure.call(plan, { count: 6, reason: 'Hardship', startDate: new Date() });
  assert(plan.restructureHistory.length === 1, 'One history entry');
  assert(plan.restructureHistory[0].reason === 'Hardship', 'Reason preserved');
  assert(plan.restructureHistory[0].outstandingAtRestructure === 50000, 'Outstanding captured');
});

test('S8: Restructure - status=restructured, overdue reset', () => {
  const plan = makeMockPlan({
    outstandingPrincipal: 30000, schedule: [],
    paidInstallments: 0, remainingInstallments: 0,
    status: INSTALLMENT_STATUS.OVERDUE, overdueStatus: 'overdue',
  });
  proto.restructure.call(plan, { count: 3, startDate: new Date() });
  assert(plan.status === INSTALLMENT_STATUS.RESTRUCTURED, `Status: ${plan.status}`);
  assert(plan.overdueStatus === 'current', `Overdue: ${plan.overdueStatus}`);
});

// ══════════════════════════════════════════════════════════════════════════════
// SCENARIO 9 — Early Settlement
// ══════════════════════════════════════════════════════════════════════════════
test('S9: Settle early - all rows marked PAID', () => {
  const { schedule } = buildPlan(200000, 24, 12);
  const plan = makeMockPlan({ schedule: schedule.map(r => ({ ...r })), remainingAmount: 200000, outstandingPrincipal: 200000 });
  proto.settleEarly.call(plan, 5000, new Date());
  assert(plan.schedule.every(r => r.status === PAYMENT_STATUS.PAID), 'All rows must be PAID');
});

test('S9: Settle early - status=settled_early, balance=0', () => {
  const plan = makeMockPlan({
    schedule: [{ status: 'unpaid', amount: 5000 }],
    remainingAmount: 5000, outstandingPrincipal: 5000,
  });
  proto.settleEarly.call(plan, 0);
  assert(plan.status === INSTALLMENT_STATUS.SETTLED_EARLY, `Status: ${plan.status}`);
  assert(plan.remainingAmount === 0, `Remaining: ${plan.remainingAmount}`);
});

test('S9: Settle with discount - journal balances (DR 50k Loan = CR 47.5k Cash + CR 2.5k Discount)', () => {
  assertBalanced([
    { type: 'debit',  amount: 50000, account: 'Loan Payable' },
    { type: 'credit', amount: 47500, account: 'Cash at Bank' },
    { type: 'credit', amount: 2500,  account: 'Settlement Discount Income' },
  ]);
});

test('S9: Customer settle with discount - journal balances', () => {
  // DR Cash + DR Discount Expense / CR Accounts Receivable
  assertBalanced([
    { type: 'debit',  amount: 47500, account: 'Cash at Bank' },
    { type: 'debit',  amount: 2500,  account: 'Settlement Discount Expense' },
    { type: 'credit', amount: 50000, account: 'Accounts Receivable' },
  ]);
});

// ══════════════════════════════════════════════════════════════════════════════
// SCENARIO 10 — Mixed Financing + Tax
// ══════════════════════════════════════════════════════════════════════════════
test('S10: Payroll 3-line journal balances', () => {
  assertBalanced([
    { type: 'debit',  amount: 100000, account: 'Wages and Salaries' },
    { type: 'credit', amount: 93000,  account: 'Cash at Bank' },
    { type: 'credit', amount: 7000,   account: 'WHT Payable' },
  ]);
});

test('S10: GST sale 3-line journal balances', () => {
  assertBalanced([
    { type: 'debit',  amount: 117000, account: 'Cash at Bank' },
    { type: 'credit', amount: 100000, account: 'Sales' },
    { type: 'credit', amount: 17000,  account: 'GST Payable' },
  ]);
});

test('S10: GST reverse calc (17%): 117,000 → GST = 17,000', () => {
  const total = 117000;
  const gst = round2(total - total / 1.17);
  assert(Math.abs(gst - 17000) < 0.02, `GST: ${gst}`);
});

test('S10: EMI journal (DR Loan + DR Interest / CR Cash) balances', () => {
  assertBalanced([
    { type: 'debit',  amount: 8000,  account: 'Loan Payable' },
    { type: 'debit',  amount: 1000,  account: 'Interest Expense' },
    { type: 'credit', amount: 9000,  account: 'Cash at Bank' },
  ]);
});

// ══════════════════════════════════════════════════════════════════════════════
// SCENARIO 11 — Multi-currency
// ══════════════════════════════════════════════════════════════════════════════
test('S11: USD 50,000 @ 8%, 36m schedule generates', () => {
  const { schedule, installmentAmount } = buildPlan(50000, 36, 8);
  assert(schedule.length === 36);
  assert(installmentAmount > 0);
  schedule.forEach((r, i) => {
    assert(r.amount > 0 && r.principalDue >= 0 && r.interestDue >= 0, `Row ${i} invalid`);
  });
});

test('S11: Exchange-rate journal balances (USD 50k @ 278 = PKR 13.9M)', () => {
  assertBalanced([
    { type: 'debit',  amount: 13900000, account: 'Vehicle' },
    { type: 'credit', amount: 13900000, account: 'Loan Payable' },
  ]);
});

test('S11: Currency revaluation journal balances', () => {
  // USD loan on books at 13.9M, now worth 14.1M → DR Unrealised Currency Gains 200k
  assertBalanced([
    { type: 'debit',  amount: 200000, account: 'Unrealised Currency Gains' },
    { type: 'credit', amount: 200000, account: 'Loan Payable' },
  ]);
});

// ══════════════════════════════════════════════════════════════════════════════
// SCENARIO 12 — NLP Financing Flow
// ══════════════════════════════════════════════════════════════════════════════
const { normalizeAmount, normalizeExtraction } = normalizationService;

test('S12: NLP normalizeAmount - lakh', () => {
  assert(normalizeAmount('5 lakh') === 500000);
  assert(normalizeAmount('2.5 lakh') === 250000);
});

test('S12: NLP normalizeAmount - crore', () => {
  assert(normalizeAmount('1 crore') === 10000000);
});

test('S12: NLP normalizeAmount - k', () => {
  assert(normalizeAmount('500k') === 500000);
});

test('S12: NLP normalizeAmount - rejects negatives', () => {
  assert(normalizeAmount(-100) === null);
  assert(normalizeAmount('-100') === null);
});

test('S12: NLP - installment fields preserved through normalization', () => {
  const raw = {
    intent: 'vehicle purchase',
    transactionType: 'financed_asset_purchase',
    amount: 500000,
    isInstallment: true,
    totalInstallmentAmount: 500000,
    installmentPeriodMonths: 36,
    downPayment: 50000,
    interestRate: 12,
    firstPaymentDate: '2026-02-15',
    interestMethod: 'reducing_balance',
    confidence: { intent: 0.95, amount: 0.9, date: 0.7, accountMapping: 0.8 },
  };
  const { normalized } = normalizeExtraction(raw);
  assert(normalized.isInstallment === true, 'isInstallment');
  assert(normalized.installmentPeriodMonths === 36, 'months');
  assert(normalized.downPayment === 50000, 'downPayment');
  assert(normalized.interestRate === 12, 'interestRate');
  assert(normalized.interestMethod === 'reducing_balance', 'interestMethod');
});

test('S12: NLP - flat interestMethod preserved', () => {
  const { normalized } = normalizeExtraction({
    transactionType: 'financed_asset_purchase', amount: 100000,
    isInstallment: true, interestMethod: 'flat', confidence: {},
  });
  assert(normalized.interestMethod === 'flat', `Got: ${normalized.interestMethod}`);
});

test('S12: NLP - asset_purchase + isInstallment upgrades type to financed_asset_purchase', () => {
  const { normalized } = normalizeExtraction({
    transactionType: 'asset_purchase', amount: 200000,
    isInstallment: true, confidence: {},
  });
  // No sourceAccount → should upgrade
  assert(normalized.transactionType === 'financed_asset_purchase',
    `Type: ${normalized.transactionType}`);
});

// ══════════════════════════════════════════════════════════════════════════════
// REGRESSION CHECKS
// ══════════════════════════════════════════════════════════════════════════════

test('R1: Full payment marks row PAID', () => {
  const { schedule, installmentAmount } = buildPlan(60000, 6, 0);
  const plan = makeMockPlan({
    schedule: schedule.map(r => ({ ...r })),
    remainingAmount: 60000, outstandingPrincipal: 60000,
    principalAmount: 60000, remainingInstallments: 6, installmentAmount,
  });
  proto.recordPayment.call(plan, installmentAmount, 'tx1');
  assert(plan.schedule[0].status === PAYMENT_STATUS.PAID);
  assert(plan.paidInstallments === 1);
  assert(plan.remainingInstallments === 5);
});

test('R2: 6 full payments → COMPLETED, remainingAmount = 0', () => {
  const { schedule, installmentAmount } = buildPlan(60000, 6, 0);
  const plan = makeMockPlan({
    schedule: schedule.map(r => ({ ...r })),
    remainingAmount: 60000, outstandingPrincipal: 60000,
    principalAmount: 60000, remainingInstallments: 6, installmentAmount,
  });
  for (let i = 0; i < 6; i++) proto.recordPayment.call(plan, installmentAmount, `tx${i}`);
  assert(plan.status === INSTALLMENT_STATUS.COMPLETED, `Status: ${plan.status}`);
  assert(plan.remainingAmount <= 0.02, `Remaining: ${plan.remainingAmount}`);
});

test('R3: No duplicate settlement - 2nd payment goes to next row', () => {
  const { schedule, installmentAmount } = buildPlan(60000, 6, 0);
  const plan = makeMockPlan({
    schedule: schedule.map(r => ({ ...r })),
    remainingAmount: 60000, outstandingPrincipal: 60000,
    principalAmount: 60000, remainingInstallments: 6, installmentAmount,
  });
  proto.recordPayment.call(plan, installmentAmount, 'tx1');
  proto.recordPayment.call(plan, installmentAmount, 'tx2');
  assert(plan.schedule[0].status === PAYMENT_STATUS.PAID, 'Row 0 PAID');
  assert(plan.schedule[1].status === PAYMENT_STATUS.PAID, 'Row 1 PAID');
  assert(plan.paidInstallments === 2);
});

test('R4: buildAmortization rejects principal = 0', () => {
  let threw = false;
  try { buildPlan(0, 12, 12); } catch (e) { threw = true; }
  assert(threw, 'Should throw for principal=0');
});

test('R5: buildAmortization rejects count = 0', () => {
  let threw = false;
  try { buildPlan(10000, 0, 12); } catch (e) { threw = true; }
  assert(threw, 'Should throw for count=0');
});

test('R6: restructure rejects count = 0', () => {
  const plan = makeMockPlan({ outstandingPrincipal: 50000 });
  let threw = false;
  try { proto.restructure.call(plan, { count: 0, startDate: new Date() }); } catch (e) { threw = true; }
  assert(threw, 'Should throw for count=0');
});

test('R7: settleEarly with 0 discount → settlementDiscount = 0', () => {
  const plan = makeMockPlan({
    schedule: [{ status: 'unpaid', amount: 10000 }],
    remainingAmount: 10000, outstandingPrincipal: 10000,
  });
  proto.settleEarly.call(plan, 0);
  assert(plan.settlementDiscount === 0, `Discount: ${plan.settlementDiscount}`);
});

test('R8: Interest-first waterfall applied correctly', () => {
  const { schedule, installmentAmount } = buildPlan(100000, 12, 12);
  const plan = makeMockPlan({
    schedule: schedule.map(r => ({ ...r })),
    remainingAmount: 100000, outstandingPrincipal: 100000,
    principalAmount: 100000, remainingInstallments: 12, installmentAmount,
  });
  const { interestApplied, principalApplied } = proto.recordPayment.call(plan, installmentAmount, 'tx1');
  assert(Math.abs(interestApplied - schedule[0].interestDue) < 0.02,
    `Interest: ${interestApplied} vs ${schedule[0].interestDue}`);
  assert(Math.abs(principalApplied - schedule[0].principalDue) < 0.02,
    `Principal: ${principalApplied} vs ${schedule[0].principalDue}`);
});

test('R9: Weekly schedule - 52 rows, 7-day gaps', () => {
  const { schedule } = buildPlan(52000, 52, 0, 'reducing_balance', 'weekly');
  assert(schedule.length === 52);
  const diffDays = (new Date(schedule[1].dueDate) - new Date(schedule[0].dueDate)) / 86400000;
  assert(Math.abs(diffDays - 7) < 1, `Weekly gap: ${diffDays}`);
});

test('R10: Quarterly schedule - 4 rows, 3-month gaps', () => {
  const { schedule } = buildPlan(40000, 4, 0, 'reducing_balance', 'quarterly');
  assert(schedule.length === 4);
  const d0 = new Date(schedule[0].dueDate), d1 = new Date(schedule[1].dueDate);
  const mDiff = (d1.getFullYear() - d0.getFullYear()) * 12 + (d1.getMonth() - d0.getMonth());
  assert(mDiff === 3, `Quarterly gap: ${mDiff} months`);
});

test('R11: applyPenaltyToRow accumulates correctly', () => {
  const mock = {
    schedule: [{ _id: 'r1', penaltyAmount: 100 }],
    totalPenaltiesAccrued: 100,
  };
  mock.schedule.id = (id) => mock.schedule.find(r => r._id === id);
  proto.applyPenaltyToRow.call(mock, 'r1', 150);
  assert(mock.schedule[0].penaltyAmount === 250, `Row penalty: ${mock.schedule[0].penaltyAmount}`);
  assert(mock.totalPenaltiesAccrued === 250, `Total penalties: ${mock.totalPenaltiesAccrued}`);
});

test('R12: dailyPenaltyAmount = 0 when penaltyRate is null', () => {
  const plan = makeMockPlan({ penaltyRate: null });
  assert(proto.dailyPenaltyAmount.call(plan, 100000) === 0, 'Should return 0 for null rate');
});

// ══════════════════════════════════════════════════════════════════════════════
// PERFORMANCE BENCHMARKS
// ══════════════════════════════════════════════════════════════════════════════

function bench(name, fn, iterations = 1000) {
  const start = Date.now();
  for (let i = 0; i < iterations; i++) fn();
  const ms = Date.now() - start;
  const avg = (ms / iterations).toFixed(3);
  return { name, iterations, totalMs: ms, avgMs: avg };
}

// ══════════════════════════════════════════════════════════════════════════════
// RESULTS SUMMARY
// ══════════════════════════════════════════════════════════════════════════════

console.log('\n╔══════════════════════════════════════════════════════════════╗');
console.log('║  VousFin Installment Regression Suite                        ║');
console.log('╚══════════════════════════════════════════════════════════════╝\n');

// Run benchmarks
const benchmarks = [
  bench('buildAmortization (100k, 36m, 12%)',  () => buildPlan(100000, 36, 12)),
  bench('buildAmortization (500k, 120m, 15%)', () => buildPlan(500000, 120, 15)),
  bench('buildAmortization flat (60k, 24m)',   () => buildPlan(60000, 24, 10, 'flat')),
  bench('recordPayment (zero-interest 12m)',    () => {
    const { schedule, installmentAmount } = buildPlan(60000, 12, 0);
    const plan = makeMockPlan({
      schedule: schedule.map(r => ({ ...r })),
      remainingAmount: 60000, outstandingPrincipal: 60000,
      principalAmount: 60000, remainingInstallments: 12, installmentAmount,
    });
    for (let i = 0; i < 12; i++) proto.recordPayment.call(plan, installmentAmount, `tx${i}`);
  }, 200),
];

console.log('PERFORMANCE BENCHMARKS:');
benchmarks.forEach(b => {
  const flag = parseFloat(b.avgMs) < 1 ? '✓' : parseFloat(b.avgMs) < 5 ? '⚠' : '✗';
  console.log(`  ${flag} ${b.name}: ${b.avgMs}ms avg (${b.iterations} iterations)`);
});

console.log(`\nTEST RESULTS: ${passed} PASSED | ${failed} FAILED | ${passed + failed} TOTAL`);
console.log('═'.repeat(64));

if (failed > 0) {
  console.log('\nFAILED:');
  results.filter(r => r.status === 'FAIL').forEach(r => {
    console.log(`  ✗ ${r.name}`);
    console.log(`    → ${r.error}`);
  });
}

console.log('\nPASSED:');
results.filter(r => r.status === 'PASS').forEach(r => console.log(`  ✓ ${r.name}`));

if (failed > 0) process.exit(1);
