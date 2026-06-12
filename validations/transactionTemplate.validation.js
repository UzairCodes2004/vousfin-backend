// validations/transactionTemplate.validation.js
const Joi = require('joi');
const { RECURRENCE_PATTERNS } = require('../config/constants');

const objectId = /^[0-9a-fA-F]{24}$/;
const patterns = Object.values(RECURRENCE_PATTERNS);

const baseFields = {
  name:            Joi.string().trim().min(2).max(120),
  description:     Joi.string().trim().min(2).max(500),
  transactionType: Joi.string().max(50).allow(null, ''),
  amount:          Joi.number().positive().precision(2),
  debitAccountId:  Joi.string().pattern(objectId),
  creditAccountId: Joi.string().pattern(objectId),
  partyType:       Joi.string().valid('customer', 'vendor').allow(null, ''),
  partyName:       Joi.string().trim().max(150).allow(null, ''),
  paymentMethod:   Joi.string().max(50).allow(null, ''),
  transactionReference: Joi.string().max(100).allow(null, ''),
  notes:           Joi.string().max(1000).allow(null, ''),
  currencyCode:    Joi.string().length(3).uppercase().allow(null, ''),
  isRecurring:     Joi.boolean(),
  recurrencePattern: Joi.string().valid(...patterns).allow(null),
  startDate:       Joi.date().iso().allow(null),
  // endDate must not be before startDate when both are supplied.
  endDate:         Joi.date().iso().min(Joi.ref('startDate')).allow(null)
    .messages({ 'date.min': 'End date cannot be before the start date' }),
  isActive:        Joi.boolean(),
};

const createTemplateSchema = Joi.object(baseFields)
  .fork(['name', 'description', 'amount', 'debitAccountId', 'creditAccountId'], (s) => s.required())
  // When recurring, a pattern is required.
  .when(Joi.object({ isRecurring: Joi.valid(true).required() }).unknown(), {
    then: Joi.object({ recurrencePattern: Joi.required() }),
  });

const updateTemplateSchema = Joi.object(baseFields).min(1);

const applyTemplateSchema = Joi.object({
  transactionDate: Joi.date().iso().optional(),
  amount:          Joi.number().positive().precision(2).optional(),
  description:     Joi.string().trim().max(500).optional(),
  partyName:       Joi.string().trim().max(150).optional(),
});

const templateIdParamSchema = Joi.object({
  id: Joi.string().pattern(objectId).required(),
});

module.exports = {
  createTemplateSchema,
  updateTemplateSchema,
  applyTemplateSchema,
  templateIdParamSchema,
};
