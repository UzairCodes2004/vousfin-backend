'use strict';

jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../../services/actionRouter.service', () => ({ propose: jest.fn() }));
jest.mock('../../../services/bankReconciliation.service', () => ({ getStatement: jest.fn(), list: jest.fn(), confirmMatch: jest.fn(), unmatch: jest.fn() }));
jest.mock('../../../repositories/proposedAction.repository', () => ({ latestBySource: jest.fn() }));

const actionRouter = require('../../../services/actionRouter.service');
const bankRec = require('../../../services/bankReconciliation.service');
const repo = require('../../../repositories/proposedAction.repository');
const reconciler = require('../../../services/reconciler.service');

const BIZ = 'biz1';
const line = (over = {}) => ({ lineRef: 'L1', status: 'unmatched', direction: 'out', amount: 5000, date: '2026-06-01',
  candidates: [{ journalEntryId: 'je1', description: 'Rent payment', amount: 5000, score: 78, amountExact: true }], ...over });

beforeEach(() => {
  jest.clearAllMocks();
  repo.latestBySource.mockResolvedValue(null);
  actionRouter.propose.mockResolvedValue({ _id: 'a1', status: 'queued' });
});

describe('reconciler.scanStatement', () => {
  it('proposes a clear_bank_match for a strong, unambiguous line', async () => {
    bankRec.getStatement.mockResolvedValue({ lines: [line()] });
    const n = await reconciler.scanStatement(BIZ, 'stmt1', { id: 'u1' });
    expect(n).toBe(1);
    expect(actionRouter.propose).toHaveBeenCalledWith(expect.objectContaining({
      capability: 'reconciliation', type: 'clear_bank_match', confidence: 0.78,
      payload: expect.objectContaining({ statementId: 'stmt1', lineRef: 'L1', journalEntryId: 'je1' }),
      sourceType: 'bank_line', sourceId: 'stmt1:L1',
    }));
  });

  it('skips a weak best candidate (below the propose floor)', async () => {
    bankRec.getStatement.mockResolvedValue({ lines: [line({ candidates: [{ journalEntryId: 'je1', score: 50, amount: 5000 }] })] });
    expect(await reconciler.scanStatement(BIZ, 'stmt1', {})).toBe(0);
    expect(actionRouter.propose).not.toHaveBeenCalled();
  });

  it('skips an ambiguous line (runner-up too close)', async () => {
    bankRec.getStatement.mockResolvedValue({ lines: [line({ candidates: [
      { journalEntryId: 'je1', score: 72, amount: 5000 }, { journalEntryId: 'je2', score: 70, amount: 5000 },
    ] })] });
    expect(await reconciler.scanStatement(BIZ, 'stmt1', {})).toBe(0);
  });

  it('skips already-matched lines and already-handled proposals', async () => {
    bankRec.getStatement.mockResolvedValue({ lines: [line({ status: 'matched' }), line({ lineRef: 'L2' })] });
    repo.latestBySource.mockResolvedValue({ status: 'queued' }); // L2 already proposed
    expect(await reconciler.scanStatement(BIZ, 'stmt1', {})).toBe(0);
  });
});

describe('reconciler executor / reverser', () => {
  it('confirms the match on execute', async () => {
    bankRec.confirmMatch.mockResolvedValue({});
    const r = await reconciler.executeClearMatch({ businessId: BIZ, payload: { statementId: 's1', lineRef: 'L1', journalEntryId: 'je1', userId: 'u1' } });
    expect(bankRec.confirmMatch).toHaveBeenCalledWith('s1', 'L1', 'je1', BIZ, expect.objectContaining({ id: 'u1' }));
    expect(r).toMatchObject({ statementId: 's1', lineRef: 'L1' });
  });

  it('un-links the line on reverse', async () => {
    bankRec.unmatch.mockResolvedValue({});
    await reconciler.reverseClearMatch({ businessId: BIZ, payload: { statementId: 's1', lineRef: 'L1' } });
    expect(bankRec.unmatch).toHaveBeenCalledWith('s1', 'L1', BIZ);
  });
});
