/**
 * tests/unit/services/billScheduler.service.test.js
 *
 * Phase 3.3 — Unit tests for BillSchedulerService.
 * Tests computeNextRunDate and updateReminderStates logic.
 * DB interactions are mocked.
 */
'use strict';

const ID_BUSINESS = '507f1f77bcf86cd799439020';
const ID_VENDOR   = '507f1f77bcf86cd799439021';
const ID_SCHEDULE = '507f1f77bcf86cd799439022';

// ── Mock helper ──────────────────────────────────────────────────────────────
function mockQuery(value) {
  const p = Promise.resolve(value);
  return { lean: () => p, then: p.then.bind(p), catch: p.catch.bind(p) };
}

// ── Mock models ──────────────────────────────────────────────────────────────
jest.mock('../../../models/BillSchedule.model', () => ({
  create:         jest.fn(),
  find:           jest.fn(),
  findOne:        jest.fn(),
  findByIdAndUpdate: jest.fn(),
  findOneAndUpdate:  jest.fn(),
}));
jest.mock('../../../models/Bill.model', () => ({
  create:    jest.fn(),
  find:      jest.fn(),
  findOne:   jest.fn(),
  updateOne: jest.fn(),
  aggregate: jest.fn(),
}));

const BillSchedule = require('../../../models/BillSchedule.model');
const Bill         = require('../../../models/Bill.model');
const svc          = require('../../../services/billScheduler.service');
const { RECURRENCE_PATTERNS, REMINDER_STATES } = require('../../../config/constants');

afterEach(() => jest.resetAllMocks());

// ── computeNextRunDate ────────────────────────────────────────────────────────

describe('computeNextRunDate()', () => {
  const base = new Date('2025-01-01T00:00:00Z');

  it('advances 7 days for weekly', () => {
    const next = svc.computeNextRunDate(RECURRENCE_PATTERNS.WEEKLY, base);
    expect(next.getDate()).toBe(8);
  });

  it('advances 14 days for biweekly', () => {
    const next = svc.computeNextRunDate(RECURRENCE_PATTERNS.BIWEEKLY, base);
    expect(next.getDate()).toBe(15);
  });

  it('advances 1 month for monthly', () => {
    const next = svc.computeNextRunDate(RECURRENCE_PATTERNS.MONTHLY, base);
    expect(next.getMonth()).toBe(1); // February
  });

  it('advances 3 months for quarterly', () => {
    const next = svc.computeNextRunDate(RECURRENCE_PATTERNS.QUARTERLY, base);
    expect(next.getMonth()).toBe(3); // April
  });

  it('advances 1 year for annual', () => {
    const next = svc.computeNextRunDate(RECURRENCE_PATTERNS.ANNUAL, base);
    expect(next.getFullYear()).toBe(2026);
  });

  it('throws 400 for unknown pattern', () => {
    expect(() => svc.computeNextRunDate('every_monday', base))
      .toThrow(expect.objectContaining({ statusCode: 400 }));
  });
});

// ── create ────────────────────────────────────────────────────────────────────

describe('create()', () => {
  it('creates a schedule with correct nextRunDate = startDate', async () => {
    const schedDoc = { _id: ID_SCHEDULE, name: 'Office Rent', recurrencePattern: 'monthly' };
    BillSchedule.create.mockResolvedValueOnce(schedDoc);

    const result = await svc.create(ID_BUSINESS, {
      name: 'Office Rent',
      recurrencePattern: RECURRENCE_PATTERNS.MONTHLY,
      startDate: '2025-03-01',
      lineItems: [{ name: 'Rent', quantity: 1, unitPrice: 50000 }],
    }, { _id: ID_VENDOR });

    expect(BillSchedule.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name:              'Office Rent',
        recurrencePattern: 'monthly',
        businessId:        ID_BUSINESS,
      })
    );
    expect(result).toBe(schedDoc);
  });

  it('throws 400 when name is missing', async () => {
    await expect(svc.create(ID_BUSINESS, { recurrencePattern: 'monthly', startDate: '2025-01-01' }, {}))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('throws 400 for invalid recurrencePattern', async () => {
    await expect(svc.create(ID_BUSINESS, { name: 'Test', recurrencePattern: 'hourly', startDate: '2025-01-01' }, {}))
      .rejects.toMatchObject({ statusCode: 400 });
  });
});

// ── updateReminderStates ──────────────────────────────────────────────────────

describe('updateReminderStates()', () => {
  function makeBill(daysOffset, currentReminderState = null) {
    const due = new Date();
    due.setDate(due.getDate() + daysOffset);
    return { _id: `bill-${daysOffset}`, dueDate: due, reminderState: currentReminderState };
  }

  function mockSelect(bills) {
    return { select: jest.fn().mockResolvedValueOnce(bills) };
  }

  it('sets upcoming for bills due in 3 days', async () => {
    const bills = [makeBill(3)];
    Bill.find.mockReturnValueOnce(mockSelect(bills));
    Bill.updateOne.mockResolvedValue({});

    const result = await svc.updateReminderStates();
    expect(result.updated).toBe(1);
    expect(Bill.updateOne).toHaveBeenCalledWith(
      { _id: bills[0]._id },
      { $set: { reminderState: REMINDER_STATES.UPCOMING } }
    );
  });

  it('sets due_today for bills due today', async () => {
    const bills = [makeBill(0)];
    Bill.find.mockReturnValueOnce(mockSelect(bills));
    Bill.updateOne.mockResolvedValue({});

    await svc.updateReminderStates();
    expect(Bill.updateOne).toHaveBeenCalledWith(
      { _id: bills[0]._id },
      { $set: { reminderState: REMINDER_STATES.DUE_TODAY } }
    );
  });

  it('sets overdue for bills 15 days past due', async () => {
    const bills = [makeBill(-15)];
    Bill.find.mockReturnValueOnce(mockSelect(bills));
    Bill.updateOne.mockResolvedValue({});

    await svc.updateReminderStates();
    expect(Bill.updateOne).toHaveBeenCalledWith(
      { _id: bills[0]._id },
      { $set: { reminderState: REMINDER_STATES.OVERDUE } }
    );
  });

  it('sets critical_overdue for bills 45 days past due', async () => {
    const bills = [makeBill(-45)];
    Bill.find.mockReturnValueOnce(mockSelect(bills));
    Bill.updateOne.mockResolvedValue({});

    await svc.updateReminderStates();
    expect(Bill.updateOne).toHaveBeenCalledWith(
      { _id: bills[0]._id },
      { $set: { reminderState: REMINDER_STATES.CRITICAL_OVERDUE } }
    );
  });

  it('skips bills that already have the correct reminder state', async () => {
    const bills = [makeBill(3, REMINDER_STATES.UPCOMING)]; // already correct
    Bill.find.mockReturnValueOnce(mockSelect(bills));

    const result = await svc.updateReminderStates();
    expect(result.updated).toBe(0);
    expect(Bill.updateOne).not.toHaveBeenCalled();
  });

  it('sets null for bills more than 7 days out', async () => {
    const bills = [makeBill(14, REMINDER_STATES.UPCOMING)]; // was upcoming, now too far
    Bill.find.mockReturnValueOnce(mockSelect(bills));
    Bill.updateOne.mockResolvedValue({});

    const result = await svc.updateReminderStates();
    expect(result.updated).toBe(1);
    expect(Bill.updateOne).toHaveBeenCalledWith(
      { _id: bills[0]._id },
      { $set: { reminderState: null } }
    );
  });
});
