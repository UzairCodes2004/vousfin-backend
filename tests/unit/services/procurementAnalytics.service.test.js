/**
 * tests/unit/services/procurementAnalytics.service.test.js
 *
 * Phase 3.4 — Unit tests for ProcurementAnalyticsService and
 * CashFlowForecastService.
 * DB interactions and the reportCache are mocked.
 */
'use strict';

const ID_BUSINESS = '507f1f77bcf86cd799439050';
const ID_VENDOR   = '507f1f77bcf86cd799439051';

jest.mock('../../../models/Bill.model', () => ({
  aggregate: jest.fn(),
  find:       jest.fn(),
  countDocuments: jest.fn(),
}));
jest.mock('../../../models/PurchaseOrder.model', () => ({
  aggregate: jest.fn(),
}));
// Silence the reportCache so tests don't share cached state
jest.mock('../../../utils/reportCache', () => ({
  get: jest.fn().mockReturnValue(null),  // always miss
  set: jest.fn(),
  invalidate: jest.fn(),
}));

const Bill   = require('../../../models/Bill.model');
const analytSvc = require('../../../services/procurementAnalytics.service');
const forecastSvc = require('../../../services/cashFlowForecast.service');

afterEach(() => jest.resetAllMocks());

// ── ProcurementAnalyticsService ───────────────────────────────────────────────

describe('ProcurementAnalyticsService', () => {

  // ── vendorSpendAnalysis ──────────────────────────────────────────────────────

  describe('vendorSpendAnalysis()', () => {
    it('returns topVendors and grandTotal', async () => {
      Bill.aggregate
        .mockResolvedValueOnce([                            // vendor group pipeline
          { vendorId: ID_VENDOR, vendorName: 'Acme', totalSpend: 1000, billCount: 5, paidAmount: 500, outstanding: 500, avgBillValue: 200, lastBillDate: new Date() },
        ])
        .mockResolvedValueOnce([                           // category pipeline
          { category: 'Office Supplies', totalSpend: 600, billCount: 3 },
        ]);

      const result = await analytSvc.vendorSpendAnalysis(ID_BUSINESS, { months: 6 });
      expect(result.topVendors).toHaveLength(1);
      expect(result.topVendors[0].sharePercent).toBe(100);
      expect(result.grandTotal).toBe(1000);
      expect(result.categoryBreakdown[0].category).toBe('Office Supplies');
    });

    it('throws 400 for invalid businessId', async () => {
      await expect(analytSvc.vendorSpendAnalysis('bad-id'))
        .rejects.toMatchObject({ statusCode: 400 });
    });
  });

  // ── cycleTimeAnalysis ────────────────────────────────────────────────────────

  describe('cycleTimeAnalysis()', () => {
    it('returns on-time rate 100% when all paid bills were on time', async () => {
      Bill.aggregate
        .mockResolvedValueOnce([{ avgBillToPayDays: 14, avgPaymentTermDays: 30, onTimeCount: 5, lateCount: 0, totalPaid: 5 }])
        .mockResolvedValueOnce([{ avgPoToBillDays: 7, count: 5 }]);

      const result = await analytSvc.cycleTimeAnalysis(ID_BUSINESS);
      expect(result.onTimeRate).toBe(100);
      expect(result.avgBillToPayDays).toBe(14);
    });

    it('returns null onTimeRate when no paid bills', async () => {
      Bill.aggregate
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const result = await analytSvc.cycleTimeAnalysis(ID_BUSINESS);
      expect(result.onTimeRate).toBeNull();
    });
  });

  // ── overdueStats ─────────────────────────────────────────────────────────────

  describe('overdueStats()', () => {
    it('aggregates overdue buckets correctly', async () => {
      Bill.aggregate.mockResolvedValueOnce([
        { _id: 0,         count: 2, amount: 500  },
        { _id: 31,        count: 1, amount: 300  },
        { _id: '90_plus', count: 1, amount: 200  },
      ]);

      const result = await analytSvc.overdueStats(ID_BUSINESS);
      expect(result.buckets['1_30'].amount).toBe(500);
      expect(result.buckets['31_60'].amount).toBe(300);
      expect(result.buckets['90_plus'].amount).toBe(200);
      expect(result.totalOverdueAmount).toBe(1000);
      expect(result.totalOverdueCount).toBe(4);
    });

    it('returns zero totals when no overdue bills', async () => {
      Bill.aggregate.mockResolvedValueOnce([]);
      const result = await analytSvc.overdueStats(ID_BUSINESS);
      expect(result.totalOverdueAmount).toBe(0);
      expect(result.totalOverdueCount).toBe(0);
    });
  });

  // ── purchasingEfficiency ─────────────────────────────────────────────────────

  describe('purchasingEfficiency()', () => {
    it('computes poBackedRate and matchPassRate correctly', async () => {
      Bill.aggregate.mockResolvedValueOnce([{
        total: 10, poBacked: 8, matched: 6, matchIssues: 2,
        totalSpend: 50000, poBackedSpend: 40000,
      }]);

      const result = await analytSvc.purchasingEfficiency(ID_BUSINESS);
      expect(result.poBackedRate).toBe(80);
      expect(result.matchPassRate).toBe(75);
      expect(result.adHocBills).toBe(2);
    });

    it('returns null rates when no bills exist', async () => {
      Bill.aggregate.mockResolvedValueOnce([{ total: 0, poBacked: 0, matched: 0, matchIssues: 0, totalSpend: 0, poBackedSpend: 0 }]);
      const result = await analytSvc.purchasingEfficiency(ID_BUSINESS);
      expect(result.poBackedRate).toBeNull();
      expect(result.matchPassRate).toBeNull();
    });
  });

  // ── paymentBehaviorStats ──────────────────────────────────────────────────────

  describe('paymentBehaviorStats()', () => {
    it('reshapes aggregation rows into monthly timeline', async () => {
      Bill.aggregate.mockResolvedValueOnce([
        { _id: { month: '2025-01', status: 'early'   }, count: 3, amount: 3000 },
        { _id: { month: '2025-01', status: 'late'    }, count: 1, amount: 1000 },
        { _id: { month: '2025-02', status: 'on_time' }, count: 4, amount: 4000 },
      ]);

      const result = await analytSvc.paymentBehaviorStats(ID_BUSINESS);
      expect(result).toHaveLength(2);
      const jan = result.find(r => r.month === '2025-01');
      expect(jan.early).toBe(3);
      expect(jan.late).toBe(1);
      expect(jan.onTimeRate).toBe(75); // 3/(3+1) = 75%
    });
  });
});

// ── CashFlowForecastService ───────────────────────────────────────────────────

describe('CashFlowForecastService', () => {

  // ── cashRequirements ─────────────────────────────────────────────────────────

  describe('cashRequirements()', () => {
    it('returns 30/60/90 day and overdue buckets', async () => {
      Bill.aggregate
        .mockResolvedValueOnce([{ amount: 100, count: 1 }])  // r30
        .mockResolvedValueOnce([{ amount: 200, count: 2 }])  // r60
        .mockResolvedValueOnce([{ amount: 300, count: 3 }])  // r90
        .mockResolvedValueOnce([{ amount:  50, count: 1 }]); // overdue

      const result = await forecastSvc.cashRequirements(ID_BUSINESS);
      expect(result.next30.amount).toBe(100);
      expect(result.next60.amount).toBe(200);
      expect(result.next90.amount).toBe(300);
      expect(result.overdue.amount).toBe(50);
    });

    it('returns zero when no open bills', async () => {
      Bill.aggregate
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const result = await forecastSvc.cashRequirements(ID_BUSINESS);
      expect(result.next30.amount).toBe(0);
      expect(result.overdue.count).toBe(0);
    });

    it('throws 400 for invalid businessId', async () => {
      await expect(forecastSvc.cashRequirements('bad-id'))
        .rejects.toMatchObject({ statusCode: 400 });
    });
  });

  // ── payableObligations ────────────────────────────────────────────────────────

  describe('payableObligations()', () => {
    it('maps bucket ids to human-readable labels', async () => {
      Bill.aggregate.mockResolvedValueOnce([
        { _id: 0,  amount: 500,  billCount: 2 },
        { _id: 31, amount: 1000, billCount: 4 },
      ]);

      const result = await forecastSvc.payableObligations(ID_BUSINESS);
      expect(result[0].bucket).toBe('This week (1–7d)');
      expect(result[1].bucket).toBe('31–60 days');
    });
  });

  // ── upcomingDueBills ──────────────────────────────────────────────────────────

  describe('upcomingDueBills()', () => {
    it('returns paginated docs and total', async () => {
      const mockBills = [
        { _id: '1', billNumber: 'BILL-001', dueDate: new Date(), remainingBalance: 1000 },
      ];
      Bill.find.mockReturnValueOnce({
        select: jest.fn().mockReturnThis(),
        sort:   jest.fn().mockReturnThis(),
        skip:   jest.fn().mockReturnThis(),
        limit:  jest.fn().mockReturnThis(),
        lean:   jest.fn().mockResolvedValueOnce(mockBills),
      });
      Bill.countDocuments.mockResolvedValueOnce(1);

      const result = await forecastSvc.upcomingDueBills(ID_BUSINESS, { days: 14 });
      expect(result.docs).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.pages).toBe(1);
    });
  });
});

// ── Multi-user isolation ──────────────────────────────────────────────────────

describe('Multi-user isolation', () => {
  it('two different businessIds produce independent analytics calls', async () => {
    const ID_B2 = '507f1f77bcf86cd799439099';

    Bill.aggregate
      .mockResolvedValue([]);  // both calls return empty — important: scoped by businessId in $match

    await analytSvc.overdueStats(ID_BUSINESS);
    await analytSvc.overdueStats(ID_B2);

    // Both calls must have been made with their own businessId in the pipeline
    const calls = Bill.aggregate.mock.calls;
    expect(calls).toHaveLength(2);
    const match1 = calls[0][0][0].$match;
    const match2 = calls[1][0][0].$match;
    expect(match1.businessId.toString()).toBe(ID_BUSINESS);
    expect(match2.businessId.toString()).toBe(ID_B2);
  });
});
