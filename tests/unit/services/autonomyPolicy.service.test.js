'use strict';

const mockPolicy = { findOne: jest.fn(), findOneAndUpdate: jest.fn() };
jest.mock('mongoose', () => ({ model: () => mockPolicy, Types: { ObjectId: (v) => v } }));

const svc = require('../../../services/autonomyPolicy.service');

const BIZ = 'biz1';
const lean = (v) => ({ lean: () => Promise.resolve(v) });

beforeEach(() => {
  jest.clearAllMocks();
  mockPolicy.findOne.mockReturnValue(lean(null));
  mockPolicy.findOneAndUpdate.mockReturnValue(lean({}));
});

describe('resolveDecision (pure)', () => {
  it('observe → observe; suggest → queue', () => {
    expect(svc.resolveDecision({ level: 'observe' })).toBe('observe');
    expect(svc.resolveDecision({ level: 'suggest', confidence: 0.99 })).toBe('queue');
  });
  it('copilot executes only at/above threshold and within limits', () => {
    expect(svc.resolveDecision({ level: 'copilot', confidence: 0.9, threshold: 0.85, withinLimits: true })).toBe('execute');
    expect(svc.resolveDecision({ level: 'copilot', confidence: 0.5, threshold: 0.85, withinLimits: true })).toBe('queue');
    expect(svc.resolveDecision({ level: 'copilot', confidence: 0.99, threshold: 0.85, withinLimits: false })).toBe('queue');
  });
  it('autopilot has a lower confidence bar but limits still force approval', () => {
    expect(svc.resolveDecision({ level: 'autopilot', confidence: 0.7, threshold: 0.85, withinLimits: true })).toBe('execute'); // ≥ 0.68
    expect(svc.resolveDecision({ level: 'autopilot', confidence: 0.5, threshold: 0.85, withinLimits: true })).toBe('queue');
    expect(svc.resolveDecision({ level: 'autopilot', confidence: 0.99, threshold: 0.85, withinLimits: false })).toBe('queue');
  });
});

describe('getPolicy', () => {
  it('defaults every capability to suggest / 0.85 when nothing is stored', async () => {
    const p = await svc.getPolicy(BIZ);
    expect(p.capabilities.bookkeeping).toEqual({ level: 'suggest', confidenceThreshold: 0.85, maxAutoAmount: null });
    expect(Object.keys(p.capabilities)).toEqual(expect.arrayContaining(['bookkeeping', 'tax', 'payments', 'close']));
  });
  it('merges stored overrides over the defaults', async () => {
    mockPolicy.findOne.mockReturnValue(lean({ capabilities: { tax: { level: 'autopilot' } } }));
    const p = await svc.getPolicy(BIZ);
    expect(p.capabilities.tax.level).toBe('autopilot');
    expect(p.capabilities.tax.confidenceThreshold).toBe(0.85);  // default preserved
    expect(p.capabilities.bookkeeping.level).toBe('suggest');    // others untouched
  });
});

describe('setCapability', () => {
  it('rejects an unknown capability', async () => {
    await expect(svc.setCapability(BIZ, 'nonsense', { level: 'autopilot' })).rejects.toThrow(/capability/i);
  });
  it('rejects an unknown level and an out-of-range threshold', async () => {
    await expect(svc.setCapability(BIZ, 'tax', { level: 'yolo' })).rejects.toThrow(/level/i);
    await expect(svc.setCapability(BIZ, 'tax', { confidenceThreshold: 2 })).rejects.toThrow(/threshold/i);
  });
  it('persists a valid capability patch', async () => {
    await svc.setCapability(BIZ, 'tax', { level: 'copilot', maxAutoAmount: 50000 }, 'u1');
    const [filter, update, opts] = mockPolicy.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ businessId: BIZ });
    expect(update.$set['capabilities.tax.level']).toBe('copilot');
    expect(update.$set['capabilities.tax.maxAutoAmount']).toBe(50000);
    expect(opts).toMatchObject({ upsert: true });
  });
});

describe('decideForCapability', () => {
  it('queues when over the capability’s auto-amount limit even at high confidence', async () => {
    mockPolicy.findOne.mockReturnValue(lean({ capabilities: { payments: { level: 'autopilot', maxAutoAmount: 10000 } } }));
    const r = await svc.decideForCapability(BIZ, 'payments', { confidence: 0.99, amount: 50000 });
    expect(r.decision).toBe('queue');
    expect(r.withinLimits).toBe(false);
  });
  it('executes within limits at high confidence on autopilot', async () => {
    mockPolicy.findOne.mockReturnValue(lean({ capabilities: { payments: { level: 'autopilot', maxAutoAmount: 100000 } } }));
    const r = await svc.decideForCapability(BIZ, 'payments', { confidence: 0.99, amount: 50000 });
    expect(r.decision).toBe('execute');
  });
});
