// services/returnBuilders/itReturn.builder.js — FR-04.3
//
// Compiles an income-tax return wrapper from the income statement + the
// income-tax provision, adjusting advance tax already paid.
//
'use strict';
const report = require('../report.service');

const r2  = (v) => Math.round((Number(v) || 0) * 100) / 100;
const num = (v) => Number(v) || 0;

/**
 * @param {string} businessId
 * @param {{startDate:Date, endDate:Date}} range  the fiscal (tax) year
 * @param {{provisionRate:number, advanceTaxPaid?:number}} ctx
 */
async function buildITReturn(businessId, range, ctx = {}) {
  const incomeStmt = await report.getIncomeStatement(businessId, range.startDate, range.endDate);

  const netProfit     = num(incomeStmt && (incomeStmt.netProfit ?? incomeStmt.netIncome));
  const taxableIncome = Math.max(0, netProfit);
  const provisionRate = num(ctx.provisionRate) || 0.29;
  const taxChargeable = r2(provisionRate * taxableIncome);
  const advanceTaxAdjusted = r2(ctx.advanceTaxPaid);
  const balancePayable = r2(taxChargeable - advanceTaxAdjusted);

  return {
    returnType: 'IT-RETURN',
    form: 'Income Tax Return (FBR)',
    fields: {
      revenue:            r2(incomeStmt && incomeStmt.totalRevenue),
      incomeFromBusiness: r2(netProfit),
      taxableIncome:      r2(taxableIncome),
      provisionRate,
      taxChargeable,
      advanceTaxAdjusted,
      balancePayable,
      status: balancePayable > 0 ? 'payable' : balancePayable < 0 ? 'refundable' : 'nil',
    },
  };
}

module.exports = { buildITReturn };
