// services/returnPrepare.service.js — FR-04.3
//
// Compiles a return for a period by picking the right builder, then persists it
// as a draft TaxReturn (idempotent per business/type/period). Zero manual entry.
//
'use strict';
const mongoose = require('mongoose');
const { ApiError } = require('../utils/ApiError');
const { TAX_RETURN_TYPES } = require('../config/constants');
const taxReturnRepo = require('../repositories/taxReturn.repository');
const { buildGST01 }   = require('./returnBuilders/gst01.builder');
const { buildWHT165 }  = require('./returnBuilders/wht165.builder');
const { buildITReturn } = require('./returnBuilders/itReturn.builder');
const taxAdvisor = require('./taxAdvisor.service');

const Business = () => mongoose.model('Business');

/** First..last instant of a calendar month (month is 1–12). */
function monthlyRange(year, month) {
  return {
    startDate: new Date(year, month - 1, 1),
    endDate:   new Date(year, month, 0, 23, 59, 59, 999),
  };
}

/** The fiscal (tax) year labelled `year`, from the business's fiscalYearStartMonth. */
function annualRange(year, fyStartMonth) {
  const sm = (fyStartMonth >= 1 && fyStartMonth <= 12) ? fyStartMonth : 1;
  const startYear = sm === 1 ? year : year - 1;
  return {
    startDate: new Date(startYear, sm - 1, 1),
    endDate:   new Date(startYear + 1, sm - 1, 0, 23, 59, 59, 999),
  };
}

/**
 * Build + persist a draft return for the given period.
 * @param {string} businessId
 * @param {string} returnType  one of TAX_RETURN_TYPES
 * @param {{year:number, month?:number}} period
 * @param {string|null} createdBy
 */
async function prepare(businessId, returnType, period, createdBy = null) {
  if (!period || !period.year) throw new ApiError(400, 'period.year is required');

  const biz = await Business().findById(businessId).select('taxConfig fiscalYearStartMonth').lean();
  const country = (biz && biz.taxConfig && biz.taxConfig.country) || 'PK';

  let data;
  if (returnType === TAX_RETURN_TYPES.GST01) {
    if (!period.month) throw new ApiError(400, 'GST-01 requires period.month');
    data = await buildGST01(businessId, monthlyRange(period.year, period.month), country);
  } else if (returnType === TAX_RETURN_TYPES.WHT165) {
    if (!period.month) throw new ApiError(400, 'WHT-165 requires period.month');
    data = await buildWHT165(businessId, monthlyRange(period.year, period.month));
  } else if (returnType === TAX_RETURN_TYPES.IT_RETURN) {
    const range = annualRange(period.year, biz && biz.fiscalYearStartMonth);
    const ctx = await taxAdvisor.buildContext(businessId, range.endDate).catch(() => ({}));
    data = await buildITReturn(businessId, range, { provisionRate: ctx.provisionRate, advanceTaxPaid: ctx.advanceTaxPaid });
  } else {
    throw new ApiError(400, `Unsupported return type: ${returnType}`);
  }

  const normPeriod = { year: period.year, month: period.month ?? null };
  return taxReturnRepo.upsertDraft(businessId, returnType, normPeriod, data, createdBy);
}

module.exports = { prepare, monthlyRange, annualRange };
