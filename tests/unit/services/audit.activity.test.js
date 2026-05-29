/**
 * tests/unit/services/audit.activity.test.js
 *
 * ERP Integration Refactor — Step 9 (Cross-module unified audit trail).
 * Verifies getActivityTimeline merges durable AuditLog rows with the live
 * business-event history into one newest-first, business-scoped feed, and can
 * scope to a single entity.
 */
'use strict';

jest.mock('../../../repositories/auditLog.repository', () => ({
  getByBusiness: jest.fn(),
  getForEntity:  jest.fn(),
}));
jest.mock('../../../repositories/user.repository', () => ({ findById: jest.fn() }));
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const auditService       = require('../../../services/audit.service');
const auditLogRepository  = require('../../../repositories/auditLog.repository');
const { businessEvents }  = require('../../../services/businessEventEngine.service');

const BIZ = '507f1f77bcf86cd799439060';

beforeEach(() => jest.clearAllMocks());
afterEach(() => jest.restoreAllMocks());

describe('auditService.getActivityTimeline()', () => {
  it('merges durable audit logs + live events, newest-first', async () => {
    const now = Date.now();
    auditLogRepository.getByBusiness.mockResolvedValue({
      data: [
        { timestamp: new Date(now - 1000), action: 'state_changed', entityType: 'bill',
          entityId: 'b1', performedByName: 'Alice', afterState: { state: 'approved' } },
      ],
    });
    jest.spyOn(businessEvents, 'getHistory').mockReturnValue([
      { occurredAt: new Date(now),        eventName: 'vendor.balance_changed', entityType: 'vendor', entityId: 'v1' },
      { occurredAt: new Date(now - 5000), eventName: 'bill.approved',           entityType: 'bill',   entityId: 'b1' },
    ]);

    const res = await auditService.getActivityTimeline(BIZ, { limit: 10 });

    expect(res.auditCount).toBe(1);
    expect(res.eventCount).toBe(2);
    expect(res.items).toHaveLength(3);
    // newest → oldest: event(now) > audit(now-1000) > event(now-5000)
    expect(res.items[0].source).toBe('event');
    expect(res.items[0].action).toBe('vendor.balance_changed');
    expect(res.items[1].source).toBe('audit');
    expect(res.items[1].summary).toContain('approved');
    expect(res.items[2].action).toBe('bill.approved');
  });

  it('scopes to a single entity (uses getForEntity + filters events)', async () => {
    auditLogRepository.getForEntity.mockResolvedValue({ data: [] });
    jest.spyOn(businessEvents, 'getHistory').mockReturnValue([
      { occurredAt: new Date(), eventName: 'bill.paid',    entityType: 'bill',    entityId: 'b1' },
      { occurredAt: new Date(), eventName: 'invoice.paid', entityType: 'invoice', entityId: 'i9' },
    ]);

    const res = await auditService.getActivityTimeline(BIZ, { entityType: 'bill', entityId: 'b1', limit: 10 });

    expect(auditLogRepository.getForEntity).toHaveBeenCalledWith('bill', 'b1', expect.any(Object));
    expect(res.eventCount).toBe(1);
    expect(res.items.every((i) => i.entityType === 'bill')).toBe(true);
  });

  it('caps the result to the requested limit', async () => {
    auditLogRepository.getByBusiness.mockResolvedValue({
      data: Array.from({ length: 5 }, (_, i) => ({
        timestamp: new Date(Date.now() - i * 1000), action: 'edited', entityType: 'invoice', entityId: `i${i}`,
      })),
    });
    jest.spyOn(businessEvents, 'getHistory').mockReturnValue(
      Array.from({ length: 5 }, (_, i) => ({
        occurredAt: new Date(Date.now() - i * 1000), eventName: 'transaction.created', entityType: 'journal_entry', entityId: `t${i}`,
      }))
    );

    const res = await auditService.getActivityTimeline(BIZ, { limit: 3 });
    expect(res.items).toHaveLength(3);
  });
});
