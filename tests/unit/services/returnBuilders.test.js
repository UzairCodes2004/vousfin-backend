'use strict';

jest.mock('../../../services/taxReport.service', () => ({
  getFilingSummary: jest.fn(), getTaxLedger: jest.fn(), getWhtSummary: jest.fn(),
}));
jest.mock('../../../services/report.service', () => ({ getIncomeStatement: jest.fn() }));

const taxReport = require('../../../services/taxReport.service');
const report    = require('../../../services/report.service');
const { buildGST01 }  = require('../../../services/returnBuilders/gst01.builder');
const { buildWHT165 } = require('../../../services/returnBuilders/wht165.builder');
const { buildITReturn } = require('../../../services/returnBuilders/itReturn.builder');

const RANGE = { startDate: new Date(2026, 4, 1), endDate: new Date(2026, 4, 31) };

beforeEach(() => jest.clearAllMocks());

describe('buildGST01', () => {
  it('maps header boxes from the filing summary and annexes from the ledger', async () => {
    taxReport.getFilingSummary.mockResolvedValue({
      outputTax: 1700, inputTax: 500, netPayable: 1200, status: 'payable',
      reconciliation: { reconciled: true },
    });
    taxReport.getTaxLedger.mockResolvedValue([
      { date: RANGE.startDate, description: 'Sale A', netAmount: 10000, taxRate: 17, taxAmount: 1700, transactionType: 'Cash Sale' },
      { date: RANGE.startDate, description: 'Buy B',  netAmount: 5000,  taxRate: 17, taxAmount: 500,  transactionType: 'Cash Purchase' },
    ]);

    const out = await buildGST01('biz1', RANGE, 'PK');
    expect(out.returnType).toBe('GST-01');
    expect(out.fields.outputTax).toBe(1700);
    expect(out.fields.inputTax).toBe(500);
    expect(out.fields.netPayable).toBe(1200);
    expect(out.annexes.C).toHaveLength(1);          // one taxable sale
    expect(out.annexes.A).toHaveLength(1);          // one taxable purchase
    expect(out.annexes.C[0].salesTax).toBe(1700);
    expect(out.reconciliation.reconciled).toBe(true);
  });

  it('uses the GL reconciliation figures for the header when present (ties out to the books)', async () => {
    // Summary (transactionType-derived) disagrees with the GL — the GL wins.
    taxReport.getFilingSummary.mockResolvedValue({
      outputTax: 0, inputTax: 0, netPayable: 0, status: 'nil',
      reconciliation: { glOutputTax: 2_071_997.47, glInputTax: 0, glNetPayable: 2_071_997.47, reconciled: true },
    });
    taxReport.getTaxLedger.mockResolvedValue([]);

    const out = await buildGST01('biz1', RANGE, 'PK');
    expect(out.fields.outputTax).toBe(2_071_997.47);
    expect(out.fields.netPayable).toBe(2_071_997.47);
    expect(out.fields.status).toBe('payable');
  });
});

describe('buildWHT165', () => {
  it('maps per-vendor withholding into 165 lines', async () => {
    taxReport.getWhtSummary.mockResolvedValue({
      vendors: [
        { vendorName: 'Acme', taxId: 'NTN-1', totalGross: 100000, totalWht: 4000 },
        { vendorName: 'Beta', taxId: null,    totalGross: 50000,  totalWht: 2000 },
      ],
      totalWht: 6000, entryCount: 2,
    });
    const out = await buildWHT165('biz1', RANGE);
    expect(out.returnType).toBe('WHT-165');
    expect(out.lines).toHaveLength(2);
    expect(out.fields.totalWithheld).toBe(6000);
    expect(out.lines[0]).toMatchObject({ vendorName: 'Acme', taxWithheld: 4000, section: '153' });
  });
});

describe('buildITReturn', () => {
  it('computes tax chargeable and adjusts advance tax', async () => {
    report.getIncomeStatement.mockResolvedValue({ netProfit: 1_000_000, totalRevenue: 5_000_000 });
    const out = await buildITReturn('biz1', RANGE, { provisionRate: 0.29, advanceTaxPaid: 100_000 });
    expect(out.fields.taxableIncome).toBe(1_000_000);
    expect(out.fields.taxChargeable).toBe(290_000);     // 0.29 × 1,000,000
    expect(out.fields.advanceTaxAdjusted).toBe(100_000);
    expect(out.fields.balancePayable).toBe(190_000);
    expect(out.fields.status).toBe('payable');
  });

  it('floors a loss to zero chargeable tax', async () => {
    report.getIncomeStatement.mockResolvedValue({ netProfit: -200_000, totalRevenue: 1_000_000 });
    const out = await buildITReturn('biz1', RANGE, { provisionRate: 0.29 });
    expect(out.fields.taxableIncome).toBe(0);
    expect(out.fields.taxChargeable).toBe(0);
  });
});
