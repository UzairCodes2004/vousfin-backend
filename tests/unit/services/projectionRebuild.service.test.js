/**
 * tests/unit/services/projectionRebuild.service.test.js
 *
 * AR/AP Domain Refactor — Milestone M9 (projection rebuild).
 * Validates that a document's payment projection is rebuilt from its
 * authoritative recognition journal via the shared M1 reconcile path.
 */
'use strict';

jest.mock('../../../models/Invoice.model', () => ({ findOne: jest.fn(), find: jest.fn() }));
jest.mock('../../../models/Bill.model', () => ({ findOne: jest.fn(), find: jest.fn() }));
jest.mock('../../../services/arApReconciliation.service', () => ({ reconcileByJournalEntryId: jest.fn() }));
jest.mock('../../../services/audit.service', () => ({ log: jest.fn().mockResolvedValue(true) }));

const svc = require('../../../services/projectionRebuild.service');
const Invoice = require('../../../models/Invoice.model');
const Bill = require('../../../models/Bill.model');
const reconcile = require('../../../services/arApReconciliation.service');

const BIZ = '507f1f77bcf86cd799439060';
const DOC = '507f1f77bcf86cd799439061';

beforeEach(() => jest.clearAllMocks());

describe('rebuildDocument', () => {
  it('rebuilds from the AR recognition journal (arJournalId)', async () => {
    Invoice.findOne.mockResolvedValue({ _id: DOC, businessId: BIZ, arJournalId: 'je1', createdBy: 'u' });
    reconcile.reconcileByJournalEntryId.mockResolvedValue({ reconciled: true, state: 'paid', remainingBalance: 0 });
    const res = await svc.rebuildDocument(BIZ, 'invoice', DOC);
    expect(reconcile.reconcileByJournalEntryId).toHaveBeenCalledWith(BIZ, 'je1', expect.any(Object));
    expect(res.rebuilt).toBe(true);
    expect(res.state).toBe('paid');
  });

  it('returns not-found when the document is missing', async () => {
    Invoice.findOne.mockResolvedValue(null);
    const res = await svc.rebuildDocument(BIZ, 'invoice', DOC);
    expect(res.rebuilt).toBe(false);
    expect(res.reason).toBe('document_not_found');
  });

  it('skips a document with no recognition journal', async () => {
    Bill.findOne.mockResolvedValue({ _id: DOC, businessId: BIZ, apLiabilityJournalId: null, linkedJournalEntryId: null });
    const res = await svc.rebuildDocument(BIZ, 'bill', DOC);
    expect(res.rebuilt).toBe(false);
    expect(res.reason).toBe('no_recognition_journal');
    expect(reconcile.reconcileByJournalEntryId).not.toHaveBeenCalled();
  });
});

describe('rebuildBusiness', () => {
  it('rebuilds every linked document and tallies outcomes', async () => {
    Invoice.find.mockReturnValue({ select: () => ({ lean: () => Promise.resolve([
      { _id: 'i1', arJournalId: 'je1' },
      { _id: 'i2', linkedJournalEntryId: 'je2' },
    ]) }) });
    Bill.find.mockReturnValue({ select: () => ({ lean: () => Promise.resolve([
      { _id: 'b1', apLiabilityJournalId: 'je3' },
    ]) }) });
    reconcile.reconcileByJournalEntryId
      .mockResolvedValueOnce({ reconciled: true })
      .mockResolvedValueOnce({ reconciled: false, reason: 'already_in_sync' })
      .mockResolvedValueOnce({ reconciled: true });

    const stats = await svc.rebuildBusiness(BIZ);
    expect(stats.scanned).toBe(3);
    expect(stats.rebuilt).toBe(2);
    expect(stats.alreadyInSync).toBe(1);
  });
});
