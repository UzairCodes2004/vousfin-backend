'use strict';

jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../../services/actionRouter.service', () => ({ propose: jest.fn() }));
jest.mock('../../../services/dunning.service', () => ({ daysOverdue: jest.fn(), resolveLevel: jest.fn(), escalateInvoice: jest.fn() }));
jest.mock('../../../models/Invoice.model', () => ({ find: jest.fn(), findOne: jest.fn() }));
jest.mock('../../../repositories/proposedAction.repository', () => ({ latestBySource: jest.fn() }));

const actionRouter = require('../../../services/actionRouter.service');
const dunning = require('../../../services/dunning.service');
const Invoice = require('../../../models/Invoice.model');
const repo = require('../../../repositories/proposedAction.repository');
const collector = require('../../../services/collector.service');

const BIZ = 'biz1';
const inv = (over = {}) => ({ _id: 'inv1', invoiceNumber: 'INV-1', customerSnapshot: { businessName: 'Bilal Traders' },
  dueDate: '2026-05-01', remainingBalance: 20000, dunningLevel: 0, ...over });

function mockFind(arr) { Invoice.find.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(arr) }) }); }

beforeEach(() => {
  jest.clearAllMocks();
  repo.latestBySource.mockResolvedValue(null);
  actionRouter.propose.mockResolvedValue({ _id: 'a1', status: 'queued' });
  dunning.daysOverdue.mockReturnValue(20);
  dunning.resolveLevel.mockReturnValue({ level: 2, key: 'first_notice', label: 'First Notice' });
});

describe('collector.scanBusiness', () => {
  it('proposes the next chase when an invoice is due for a higher ladder step', async () => {
    mockFind([inv()]);
    const n = await collector.scanBusiness(BIZ, { id: 'u1' });
    expect(n).toBe(1);
    expect(actionRouter.propose).toHaveBeenCalledWith(expect.objectContaining({
      capability: 'collections', type: 'escalate_dunning',
      title: expect.stringContaining('Bilal Traders'),
      payload: expect.objectContaining({ invoiceId: 'inv1', targetLevel: 2 }),
      sourceType: 'dunning_step', sourceId: 'inv1:2',
    }));
  });

  it('skips an invoice already at or above the target level', async () => {
    mockFind([inv({ dunningLevel: 2 })]);
    expect(await collector.scanBusiness(BIZ, {})).toBe(0);
    expect(actionRouter.propose).not.toHaveBeenCalled();
  });

  it('skips a step already proposed/handled', async () => {
    mockFind([inv()]);
    repo.latestBySource.mockResolvedValue({ status: 'rejected' });
    expect(await collector.scanBusiness(BIZ, {})).toBe(0);
  });

  it('keeps confidence conservative (≤ 0.9) so chases only auto-send on a high dial', async () => {
    mockFind([inv()]);
    await collector.scanBusiness(BIZ, {});
    expect(actionRouter.propose.mock.calls[0][0].confidence).toBeLessThanOrEqual(0.9);
  });
});

describe('collector executor', () => {
  it('advances the dunning ladder on execute', async () => {
    Invoice.findOne.mockResolvedValue(inv());
    dunning.escalateInvoice.mockResolvedValue({ level: 2 });
    const r = await collector.executeEscalate({ businessId: BIZ, payload: { invoiceId: 'inv1', userId: 'u1' } });
    expect(dunning.escalateInvoice).toHaveBeenCalled();
    expect(r).toMatchObject({ invoiceId: 'inv1', level: 2 });
  });

  it('throws when the invoice is gone', async () => {
    Invoice.findOne.mockResolvedValue(null);
    await expect(collector.executeEscalate({ businessId: BIZ, payload: { invoiceId: 'x' } })).rejects.toThrow(/no longer available/i);
  });
});
