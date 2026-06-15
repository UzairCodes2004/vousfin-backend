'use strict';

jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../../services/autonomyPolicy.service', () => ({ decideForCapability: jest.fn() }));
jest.mock('../../../repositories/proposedAction.repository', () => ({ create: jest.fn(), findOwned: jest.fn(), update: jest.fn() }));
jest.mock('../../../services/audit.service', () => ({ log: jest.fn().mockResolvedValue({}) }));

const policy = require('../../../services/autonomyPolicy.service');
const repo   = require('../../../repositories/proposedAction.repository');
const router = require('../../../services/actionRouter.service');

const BIZ = 'biz1';
const raw = (over = {}) => ({ businessId: BIZ, capability: 'bookkeeping', type: 'post_journal', confidence: 0.9, amount: 1000, ...over });

beforeEach(() => {
  jest.clearAllMocks();
  repo.create.mockImplementation((d) => Promise.resolve({ _id: 'a1', ...d }));
  repo.update.mockImplementation((id, u) => Promise.resolve({ _id: id, ...(u.$set || u) }));
});

describe('actionRouter.propose', () => {
  it('queues an action when policy says queue (default suggest)', async () => {
    policy.decideForCapability.mockResolvedValue({ decision: 'queue', withinLimits: true });
    const a = await router.propose(raw());
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ status: 'queued', decision: 'queue' }));
    expect(a.status).toBe('queued');
  });

  it('logs an observe-level action without queuing it for action', async () => {
    policy.decideForCapability.mockResolvedValue({ decision: 'observe', withinLimits: true });
    const a = await router.propose(raw());
    expect(a.status).toBe('observed');
  });

  it('auto-executes when policy says execute and an executor is supplied', async () => {
    policy.decideForCapability.mockResolvedValue({ decision: 'execute', withinLimits: true });
    const executor = jest.fn().mockResolvedValue({ journalId: 'j1' });
    const a = await router.propose(raw(), { executor });
    expect(executor).toHaveBeenCalled();
    expect(repo.update).toHaveBeenCalledWith('a1', expect.objectContaining({ $set: expect.objectContaining({ status: 'executed' }) }));
    expect(a.status).toBe('executed');
  });

  it('marks the action approved (awaiting execution) when execute but no executor given', async () => {
    policy.decideForCapability.mockResolvedValue({ decision: 'execute', withinLimits: true });
    const a = await router.propose(raw());
    expect(a.status).toBe('approved');
  });

  it('marks the action failed (never throws) when the executor errors', async () => {
    policy.decideForCapability.mockResolvedValue({ decision: 'execute', withinLimits: true });
    const executor = jest.fn().mockRejectedValue(new Error('post failed'));
    const a = await router.propose(raw(), { executor });
    expect(a.status).toBe('failed');
    expect(a.result).toMatchObject({ error: 'post failed' });
  });
});

describe('actionRouter.approve / reject', () => {
  it('executes a queued action on approval and audits it', async () => {
    repo.findOwned.mockResolvedValue({ _id: 'a1', businessId: BIZ, status: 'queued', capability: 'tax', type: 'file_return' });
    const executor = jest.fn().mockResolvedValue({ ack: 'X' });
    const a = await router.approve(BIZ, 'a1', 'u1', executor);
    expect(executor).toHaveBeenCalled();
    expect(a.status).toBe('executed');
    const audit = require('../../../services/audit.service');
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ entityType: 'proposedAction', performedBy: 'u1' }));
  });

  it('refuses to approve an action that is not queued', async () => {
    repo.findOwned.mockResolvedValue({ _id: 'a1', businessId: BIZ, status: 'executed' });
    await expect(router.approve(BIZ, 'a1', 'u1')).rejects.toThrow(/queued/i);
  });

  it('404s on another business’s action', async () => {
    repo.findOwned.mockResolvedValue(null);
    await expect(router.approve(BIZ, 'x', 'u1')).rejects.toThrow(/not found/i);
  });

  it('rejects a queued action', async () => {
    repo.findOwned.mockResolvedValue({ _id: 'a1', businessId: BIZ, status: 'queued' });
    const a = await router.reject(BIZ, 'a1', 'u1');
    expect(a.status).toBe('rejected');
  });
});

describe('actionRouter.reverse', () => {
  it('reverses an executed action via the supplied reverser', async () => {
    repo.findOwned.mockResolvedValue({ _id: 'a1', businessId: BIZ, status: 'executed', reversal: { kind: 'journal' } });
    const reverser = jest.fn().mockResolvedValue({ reversed: true });
    const a = await router.reverse(BIZ, 'a1', 'u1', reverser);
    expect(reverser).toHaveBeenCalled();
    expect(a.status).toBe('reversed');
  });

  it('refuses to reverse an action that was not executed', async () => {
    repo.findOwned.mockResolvedValue({ _id: 'a1', businessId: BIZ, status: 'queued' });
    await expect(router.reverse(BIZ, 'a1', 'u1', jest.fn())).rejects.toThrow(/executed/i);
  });
});
