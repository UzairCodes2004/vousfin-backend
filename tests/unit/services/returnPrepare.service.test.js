'use strict';

const mockBusiness = { findById: jest.fn() };
jest.mock('mongoose', () => ({ model: () => mockBusiness, Types: { ObjectId: (v) => v } }));
jest.mock('../../../services/returnBuilders/gst01.builder',  () => ({ buildGST01: jest.fn() }));
jest.mock('../../../services/returnBuilders/wht165.builder', () => ({ buildWHT165: jest.fn() }));
jest.mock('../../../services/returnBuilders/itReturn.builder', () => ({ buildITReturn: jest.fn() }));
jest.mock('../../../services/taxAdvisor.service', () => ({ buildContext: jest.fn() }));
jest.mock('../../../repositories/taxReturn.repository', () => ({ upsertDraft: jest.fn() }));

const { buildGST01 }  = require('../../../services/returnBuilders/gst01.builder');
const { buildWHT165 } = require('../../../services/returnBuilders/wht165.builder');
const { buildITReturn } = require('../../../services/returnBuilders/itReturn.builder');
const taxAdvisor = require('../../../services/taxAdvisor.service');
const repo       = require('../../../repositories/taxReturn.repository');
const prepareSvc = require('../../../services/returnPrepare.service');

const BIZ = 'biz1';

beforeEach(() => {
  jest.clearAllMocks();
  mockBusiness.findById.mockReturnValue({
    select: () => ({ lean: () => Promise.resolve({ taxConfig: { country: 'PK' }, fiscalYearStartMonth: 7 }) }),
  });
  buildGST01.mockResolvedValue({ returnType: 'GST-01', fields: {} });
  buildWHT165.mockResolvedValue({ returnType: 'WHT-165', fields: {} });
  buildITReturn.mockResolvedValue({ returnType: 'IT-RETURN', fields: {} });
  taxAdvisor.buildContext.mockResolvedValue({ provisionRate: 0.29, advanceTaxPaid: 50000 });
  repo.upsertDraft.mockImplementation((b, t, p, d) => Promise.resolve({ _id: 'r1', businessId: b, returnType: t, period: p, data: d, status: 'draft' }));
});

describe('returnPrepare.prepare', () => {
  it('builds GST-01 for a month and upserts a draft', async () => {
    const out = await prepareSvc.prepare(BIZ, 'GST-01', { year: 2026, month: 5 }, 'u1');
    const range = buildGST01.mock.calls[0][1];
    expect(range.startDate.getMonth()).toBe(4);      // May
    expect(range.startDate.getDate()).toBe(1);
    expect(repo.upsertDraft).toHaveBeenCalledWith(BIZ, 'GST-01', { year: 2026, month: 5 }, expect.any(Object), 'u1');
    expect(out.status).toBe('draft');
  });

  it('requires a month for GST-01', async () => {
    await expect(prepareSvc.prepare(BIZ, 'GST-01', { year: 2026 })).rejects.toThrow(/month/);
  });

  it('builds IT-RETURN over the fiscal year and supplies provision context', async () => {
    await prepareSvc.prepare(BIZ, 'IT-RETURN', { year: 2026 });
    const [, range, ctx] = buildITReturn.mock.calls[0];
    expect(range.startDate.getFullYear()).toBe(2025);  // July-start FY → prior year
    expect(range.startDate.getMonth()).toBe(6);
    expect(ctx.provisionRate).toBe(0.29);
    expect(ctx.advanceTaxPaid).toBe(50000);
    // annual return persists with month null
    expect(repo.upsertDraft).toHaveBeenCalledWith(BIZ, 'IT-RETURN', { year: 2026, month: null }, expect.any(Object), null);
  });

  it('rejects an unsupported return type', async () => {
    await expect(prepareSvc.prepare(BIZ, 'NONSENSE', { year: 2026, month: 1 })).rejects.toThrow(/Unsupported/);
  });
});
