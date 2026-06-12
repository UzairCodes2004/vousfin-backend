// validations/recognitionSchedule.validation.js
const Joi = require('joi');

const objectId = Joi.string().pattern(/^[0-9a-fA-F]{24}$/);

const createRecognitionScheduleSchema = Joi.object({
  type: Joi.string().valid('deferred_revenue', 'prepaid_expense').required().messages({
    'any.only': 'type must be deferred_revenue or prepaid_expense',
    'any.required': 'type is required',
  }),
  description: Joi.string().max(300).allow('', null).trim().optional(),
  totalAmount: Joi.number().positive().required().messages({
    'number.positive': 'totalAmount must be greater than zero',
    'any.required': 'totalAmount is required',
  }),
  startDate: Joi.date().required(),
  periods: Joi.number().integer().min(1).max(600).required().messages({
    'number.min': 'periods must be at least 1',
    'any.required': 'periods is required',
  }),
  // The P&L account to recognize into (revenue or expense). Required.
  recognitionAccountId: objectId.required().messages({ 'any.required': 'recognitionAccountId is required' }),
  // The balance-sheet holding account. Optional — defaults to 2170 / 1120.
  deferralAccountId: objectId.allow(null).optional(),
  currencyCode: Joi.string().length(3).uppercase().optional(),
  sourceType: Joi.string().valid('manual', 'invoice', 'bill', 'transaction').optional(),
  sourceId: objectId.allow(null).optional(),
});

module.exports = { createRecognitionScheduleSchema };
