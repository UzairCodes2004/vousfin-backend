/**
 * tests/unit/services/procurementAudit.service.test.js
 *
 * Phase 3.4 — Unit tests for ProcurementAuditService.
 * Validates append-only log writes, entity history queries,
 * activity feed, and action summary aggregation.
 */
'use strict';

const ID_BUSINESS = '507f1f77bcf86cd799439060';
const ID_ENTITY   = '507f1f77bcf86cd799439061';
const ID_ACTOR    = '507f1f77bcf86cd799439062';

jest.mock('../../../models/ProcurementAuditLog.model', () => ({
  create:       jest.fn(),
  find:         jest.fn(),
  countDocuments: jest.fn(),
  aggregate:    jest.fn(),
}));

const ProcurementAuditLog = require('../../../models/ProcurementAuditLog.model');
const svc = require('../../../services/procurementAudit.service');

afterEach(() => jest.resetAllMocks());

// ── log() ─────────────────────────────────────────────────────────────────────

describe('log()', () => {
  it('creates an audit document with correct fields', async () => {
    ProcurementAuditLog.create.mockResolvedValueOnce({});

    await svc.log({
      businessId: ID_BUSINESS,
      entityType: 'bill',
      entityId:   ID_ENTITY,
      entityRef:  'BILL-001',
      action:     'approved',
      fromState:  'awaiting_approval',
      toState:    'approved',
      actor:      { _id: ID_ACTOR, fullName: 'Alice', role: 'admin' },
      source:     'user',
    });

    expect(ProcurementAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'bill',
        action:     'approved',
        entityRef:  'BILL-001',
        fromState:  'awaiting_approval',
        toState:    'approved',
        actorName:  'Alice',
        source:     'user',
      })
    );
  });

  it('does NOT throw when create fails (fire-and-forget)', async () => {
    ProcurementAuditLog.create.mockRejectedValueOnce(new Error('DB error'));
    await expect(svc.log({ businessId: ID_BUSINESS, entityType: 'bill', entityId: ID_ENTITY, action: 'created' }))
      .resolves.toBeUndefined();
  });
});

// ── getEntityHistory() ────────────────────────────────────────────────────────

describe('getEntityHistory()', () => {
  it('returns paginated audit docs for an entity', async () => {
    const docs = [
      { _id: '1', action: 'created', occurredAt: new Date() },
      { _id: '2', action: 'approved', occurredAt: new Date() },
    ];

    ProcurementAuditLog.find.mockReturnValueOnce({
      sort:  jest.fn().mockReturnThis(),
      skip:  jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean:  jest.fn().mockResolvedValueOnce(docs),
    });
    ProcurementAuditLog.countDocuments.mockResolvedValueOnce(2);

    const result = await svc.getEntityHistory(ID_BUSINESS, 'bill', ID_ENTITY);
    expect(result.docs).toHaveLength(2);
    expect(result.total).toBe(2);
    expect(result.pages).toBe(1);
  });

  it('throws 400 when entityId is missing', async () => {
    await expect(svc.getEntityHistory(ID_BUSINESS, 'bill', null))
      .rejects.toMatchObject({ statusCode: 400 });
  });
});

// ── getRecentActivity() ───────────────────────────────────────────────────────

describe('getRecentActivity()', () => {
  it('returns activity sorted by occurredAt desc', async () => {
    const events = [
      { action: 'bill_paid', occurredAt: new Date() },
    ];
    ProcurementAuditLog.find.mockReturnValueOnce({
      sort:  jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean:  jest.fn().mockResolvedValueOnce(events),
    });

    const result = await svc.getRecentActivity(ID_BUSINESS, { limit: 10 });
    expect(result).toHaveLength(1);
  });

  it('throws 400 when businessId is missing', async () => {
    await expect(svc.getRecentActivity(null))
      .rejects.toMatchObject({ statusCode: 400 });
  });
});

// ── actionSummary() ───────────────────────────────────────────────────────────

describe('actionSummary()', () => {
  it('aggregates action counts into an object', async () => {
    ProcurementAuditLog.aggregate.mockResolvedValueOnce([
      { _id: 'approved', count: 10 },
      { _id: 'created',  count: 25 },
    ]);

    const result = await svc.actionSummary(ID_BUSINESS, { days: 30 });
    expect(result.approved).toBe(10);
    expect(result.created).toBe(25);
  });

  it('returns empty object when no events', async () => {
    ProcurementAuditLog.aggregate.mockResolvedValueOnce([]);
    const result = await svc.actionSummary(ID_BUSINESS);
    expect(Object.keys(result)).toHaveLength(0);
  });
});
