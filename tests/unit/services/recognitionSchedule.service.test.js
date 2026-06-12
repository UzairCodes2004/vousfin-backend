/**
 * tests/unit/services/recognitionSchedule.service.test.js
 *
 * Phase 4 — Accrual accounting. Validates the recognition-schedule engine:
 *   • straight-line split (last slice absorbs the rounding remainder)
 *   • createSchedule validates the two accounts + their types
 *   • postDueRecognitions posts only due+pending lines, with the correct
 *     debit/credit direction per type, marks them posted, tallies the
 *     recognized amount, completes the schedule, and is idempotent.
 *
 * The model + ledger poster are mocked; the engine logic runs for real.
 */
'use strict';

jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../../models/RecognitionSchedule.model', () => ({ create: jest.fn(), find: jest.fn(), findOne: jest.fn() }));
jest.mock('../../../models/ChartOfAccount.model', () => ({ findOne: jest.fn() }));
jest.mock('../../../services/ledgerPosting.service', () => ({ postBalancedJournal: jest.fn() }));

const service          = require('../../../services/recognitionSchedule.service');
const RecognitionSchedule = require('../../../models/RecognitionSchedule.model');
const ChartOfAccount   = require('../../../models/ChartOfAccount.model');
const ledgerPosting    = require('../../../services/ledgerPosting.service');

const BIZ = '507f1f77bcf86cd799439060';
const REV = '507f1f77bcf86cd799439a11'; // a Revenue account id
const EXP = '507f1f77bcf86cd799439a22'; // an Expense account id
const DEF = '507f1f77bcf86cd799439b11'; // Unearned Revenue (liability)
const PRE = '507f1f77bcf86cd799439b22'; // Prepaid Expenses (asset)

beforeEach(() => {
  jest.clearAllMocks();
  ledgerPosting.postBalancedJournal.mockImplementation((e) => Promise.resolve({ _id: 'je-' + Math.random().toString(36).slice(2), ...e }));
  RecognitionSchedule.create.mockImplementation((doc) => Promise.resolve({ _id: 'sched1', ...doc }));
  ChartOfAccount.findOne.mockImplementation((q) => ({
    lean: () => {
      if (q.accountCode === '2170') return Promise.resolve({ _id: DEF, accountType: 'Liability' });
      if (q.accountCode === '1120') return Promise.resolve({ _id: PRE, accountType: 'Asset' });
      if (String(q._id) === REV)     return Promise.resolve({ _id: REV, accountType: 'Revenue' });
      if (String(q._id) === EXP)     return Promise.resolve({ _id: EXP, accountType: 'Expense' });
      return Promise.resolve(null);
    },
  }));
});

// ── Straight-line split ───────────────────────────────────────────────────────
describe('buildLines()', () => {
  it('splits evenly and puts the rounding remainder on the last slice', () => {
    const lines = service.buildLines(1000, new Date('2026-01-15'), 3);
    expect(lines.map((l) => l.amount)).toEqual([333.33, 333.33, 333.34]);
    expect(lines.reduce((s, l) => s + l.amount, 0)).toBeCloseTo(1000, 5);
    // monthly cadence, first slice on startDate
    expect(lines[0].scheduledDate.getMonth()).toBe(0); // Jan
    expect(lines[1].scheduledDate.getMonth()).toBe(1); // Feb
    expect(lines[2].scheduledDate.getMonth()).toBe(2); // Mar
    expect(lines.every((l) => l.status === 'pending')).toBe(true);
  });
});

// ── createSchedule ────────────────────────────────────────────────────────────
describe('createSchedule()', () => {
  it('creates a deferred_revenue schedule, defaulting the holding account to 2170', async () => {
    const s = await service.createSchedule(BIZ, {
      type: 'deferred_revenue', description: 'Annual sub', totalAmount: 1200,
      startDate: '2026-01-01', periods: 12, recognitionAccountId: REV,
    }, { _id: 'u1' });

    expect(s.type).toBe('deferred_revenue');
    expect(String(s.deferralAccountId)).toBe(DEF);
    expect(String(s.recognitionAccountId)).toBe(REV);
    expect(s.lines).toHaveLength(12);
    expect(s.status).toBe('active');
  });

  it('rejects when the recognition account is the wrong type', async () => {
    // deferred_revenue requires a Revenue recognition account; pass an Expense one.
    await expect(service.createSchedule(BIZ, {
      type: 'deferred_revenue', totalAmount: 100, startDate: '2026-01-01', periods: 2,
      recognitionAccountId: EXP,
    }, { _id: 'u1' })).rejects.toMatchObject({ statusCode: 400 });
  });
});

// ── postDueRecognitions ───────────────────────────────────────────────────────
const makeSchedule = (over = {}) => ({
  _id: 's1', businessId: BIZ, type: 'deferred_revenue', description: 'Annual sub',
  periods: 3, currencyCode: 'PKR', deferralAccountId: DEF, recognitionAccountId: REV,
  createdBy: 'u1', recognizedAmount: 0, status: 'active',
  lines: [
    { periodNumber: 1, scheduledDate: new Date('2026-01-01'), amount: 333.33, status: 'pending', journalEntryId: null, postedAt: null },
    { periodNumber: 2, scheduledDate: new Date('2026-02-01'), amount: 333.33, status: 'pending', journalEntryId: null, postedAt: null },
    { periodNumber: 3, scheduledDate: new Date('2099-01-01'), amount: 333.34, status: 'pending', journalEntryId: null, postedAt: null },
  ],
  save: jest.fn(function () { return Promise.resolve(this); }),
  ...over,
});

describe('postDueRecognitions()', () => {
  it('posts only due+pending lines, tallies recognized, and stays active while a future line remains', async () => {
    const sched = makeSchedule();
    RecognitionSchedule.find.mockResolvedValue([sched]);

    const res = await service.postDueRecognitions(BIZ, new Date('2026-02-15'));

    expect(ledgerPosting.postBalancedJournal).toHaveBeenCalledTimes(2); // lines 1 + 2 (3 is future)
    expect(res.linesPosted).toBe(2);
    expect(sched.lines[0].status).toBe('posted');
    expect(sched.lines[1].status).toBe('posted');
    expect(sched.lines[2].status).toBe('pending');
    expect(sched.recognizedAmount).toBeCloseTo(666.66, 2);
    expect(sched.status).toBe('active'); // line 3 still pending
    expect(sched.save).toHaveBeenCalledTimes(1);
  });

  it('uses DR holding / CR revenue for deferred_revenue', async () => {
    RecognitionSchedule.find.mockResolvedValue([makeSchedule()]);
    await service.postDueRecognitions(BIZ, new Date('2026-01-15'));
    const entry = ledgerPosting.postBalancedJournal.mock.calls[0][0];
    expect(String(entry.debitAccountId)).toBe(DEF);   // Unearned Revenue down
    expect(String(entry.creditAccountId)).toBe(REV);  // Revenue up
    expect(entry.inputMethod).toBe('form');
  });

  it('uses DR expense / CR holding for prepaid_expense', async () => {
    RecognitionSchedule.find.mockResolvedValue([makeSchedule({
      type: 'prepaid_expense', deferralAccountId: PRE, recognitionAccountId: EXP,
    })]);
    await service.postDueRecognitions(BIZ, new Date('2026-01-15'));
    const entry = ledgerPosting.postBalancedJournal.mock.calls[0][0];
    expect(String(entry.debitAccountId)).toBe(EXP);   // Expense up
    expect(String(entry.creditAccountId)).toBe(PRE);  // Prepaid asset down
  });

  it('completes the schedule when every line is posted', async () => {
    const sched = makeSchedule();
    RecognitionSchedule.find.mockResolvedValue([sched]);
    await service.postDueRecognitions(BIZ, new Date('2099-12-31')); // all due
    expect(ledgerPosting.postBalancedJournal).toHaveBeenCalledTimes(3);
    expect(sched.status).toBe('completed');
  });

  it('is idempotent — never re-posts a line already marked posted', async () => {
    const sched = makeSchedule();
    sched.lines[0].status = 'posted'; // already done on a prior run
    RecognitionSchedule.find.mockResolvedValue([sched]);
    await service.postDueRecognitions(BIZ, new Date('2026-02-15'));
    expect(ledgerPosting.postBalancedJournal).toHaveBeenCalledTimes(1); // only line 2
  });
});
