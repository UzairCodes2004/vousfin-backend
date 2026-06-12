// tests/unit/services/bill.service.test.js
//
// Phase 1 — Service-level tests for bill.service.js.
//
jest.mock('../../../repositories/vendor.repository');
jest.mock('../../../services/audit.service');
jest.mock('../../../models/Bill.model', () => {
  const stateStore = new Map();
  const mongoose = require('mongoose');
  const { BILL_TRANSITIONS } = require('../../../config/constants');

  function makeDoc(props) {
    const doc = {
      ...props,
      _id: props._id || new mongoose.Types.ObjectId(),
      approvalLog:  props.approvalLog  || [],
      stateHistory: props.stateHistory || [],
      fieldHistory: props.fieldHistory || [],
      isArchived: !!props.isArchived,
      recordStateChange(toState, actor, reason) {
        this.stateHistory.push({
          fromState: this.state, toState,
          actorId: actor._id, actorName: actor.fullName || 'Unknown',
          reason: reason || null, timestamp: new Date(),
        });
      },
      recordFieldChange(field, before, after, by) {
        this.fieldHistory.push({ field, before, after, changedBy: by, changedAt: new Date() });
      },
      async save() { stateStore.set(String(this._id), this); return this; },
      toObject() { return { ...this }; },
    };
    return doc;
  }

  function Bill(props) { return makeDoc(props); }
  Bill.canTransition = (from, to) => {
    if (from === to) return true;
    const allowed = BILL_TRANSITIONS[from];
    return Array.isArray(allowed) && allowed.includes(to);
  };
  Bill.findById = async (id) => stateStore.get(String(id)) || null;
  // Chainable mock: supports both `await findOne(...)` and `findOne().sort().select().lean()`
  const _chain = (val) => ({
    sort: () => _chain(val), select: () => _chain(val), populate: () => _chain(val),
    lean: async () => val,
    then: (res, rej) => Promise.resolve(val).then(res, rej),
    catch: (rej) => Promise.resolve(val).catch(rej),
  });
  Bill.findOne  = () => _chain(null);
  Bill.find = async () => Array.from(stateStore.values());
  Bill.countDocuments = async () => stateStore.size;
  Bill.__reset = () => stateStore.clear();
  return Bill;
});

const Bill = require('../../../models/Bill.model');
const billService = require('../../../services/bill.service');
const auditService = require('../../../services/audit.service');
const vendorRepository = require('../../../repositories/vendor.repository');

const USER = { _id: 'u1', fullName: 'Bob Accountant', email: 'bob@x', role: 'accountant' };

beforeEach(() => {
  jest.clearAllMocks();
  Bill.__reset();
  vendorRepository.findByBusinessAndId = jest.fn().mockResolvedValue({
    vendorName: 'Vendor X', email: 'v@x', phone: '+92', taxId: 'V-1', whtProfile: { strn: 'STRN-1' },
  });
  auditService.log       = jest.fn().mockResolvedValue(undefined);
  auditService.logCreate = jest.fn().mockResolvedValue(undefined);
  auditService.logDelete = jest.fn().mockResolvedValue(undefined);
});

describe('billService.createDraft()', () => {
  test('creates a draft below threshold without approval', async () => {
    const bill = await billService.createDraft(
      { businessId: 'biz1', billNumber: 'BILL-202605-00001', amount: 1000, issueDate: new Date(), vendorId: 'v1' },
      USER, '127.0.0.1'
    );
    expect(bill.state).toBe('draft');
    expect(bill.approvalRequired).toBe(false);
    expect(bill.vendorSnapshot.vendorName).toBe('Vendor X');
    expect(bill.vendorSnapshot.strn).toBe('STRN-1');
  });

  test('creates a draft above threshold requiring approval', async () => {
    const bill = await billService.createDraft(
      { businessId: 'biz1', billNumber: 'BILL-AT', amount: 250000, issueDate: new Date() },
      USER, ''
    );
    expect(bill.approvalRequired).toBe(true);
    expect(bill.approvalStatus).toBe('pending');
  });

  test('rejects missing required fields', async () => {
    await expect(billService.createDraft({ businessId: 'biz1' }, USER, ''))
      .rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('billService approval workflow', () => {
  async function aboveThreshold() {
    return billService.createDraft(
      { businessId: 'biz1', billNumber: 'BILL-AT', amount: 250000, issueDate: new Date() }, USER, ''
    );
  }

  test('submit → awaiting_approval; approve → approved', async () => {
    const bill = await aboveThreshold();
    const sub = await billService.submitForApproval(bill._id, USER, '');
    expect(sub.state).toBe('awaiting_approval');
    const ap = await billService.approve(bill._id, USER, 'ok', '');
    expect(ap.state).toBe('approved');
    expect(ap.approvalStatus).toBe('approved');
  });

  test('reject → draft + approvalStatus=rejected', async () => {
    const bill = await aboveThreshold();
    await billService.submitForApproval(bill._id, USER, '');
    const r = await billService.reject(bill._id, USER, 'wrong', '');
    expect(r.state).toBe('draft');
    expect(r.approvalStatus).toBe('rejected');
  });
});

describe('billService illegal transitions + lifecycle', () => {
  test('cannot schedule a draft (must approve first)', async () => {
    const bill = await billService.createDraft(
      { businessId: 'biz1', billNumber: 'BILL-X', amount: 1000, issueDate: new Date() }, USER, ''
    );
    await expect(billService.schedule(bill._id, USER, new Date(), ''))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  test('approve → schedule → paid path', async () => {
    const bill = await billService.createDraft(
      { businessId: 'biz1', billNumber: 'BILL-Y', amount: 1000, issueDate: new Date() }, USER, ''
    );
    await billService.transitionState(bill._id, 'approved', USER, {});
    const sched = await billService.schedule(bill._id, USER, new Date(), '');
    expect(sched.state).toBe('scheduled');
    expect(sched.scheduledPayDate).toBeInstanceOf(Date);
    const paid = await billService.markPaid(bill._id, USER, '');
    expect(paid.state).toBe('paid');
    expect(paid.remainingBalance).toBe(0);
  });

  test('softDelete marks archived', async () => {
    const bill = await billService.createDraft(
      { businessId: 'biz1', billNumber: 'BILL-DEL', amount: 1000, issueDate: new Date() }, USER, ''
    );
    const archived = await billService.softDelete(bill._id, USER, '');
    expect(archived.isArchived).toBe(true);
    expect(auditService.logDelete).toHaveBeenCalled();
  });
});
