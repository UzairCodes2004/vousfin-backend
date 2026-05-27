// validations/fxRate.validation.js
const Joi = require('joi');

const objectIdPattern = /^[0-9a-fA-F]{24}$/;
const currencyPattern = /^[A-Z]{3}$/;

/** Create or upsert a single exchange rate record */
const createFxRateSchema = Joi.object({
  fromCurrency: Joi.string().pattern(currencyPattern).uppercase().required()
    .messages({ 'string.pattern.base': 'fromCurrency must be a 3-letter ISO 4217 code (e.g. USD)' }),
  toCurrency: Joi.string().pattern(currencyPattern).uppercase().required()
    .messages({ 'string.pattern.base': 'toCurrency must be a 3-letter ISO 4217 code (e.g. PKR)' }),
  rate: Joi.number().positive().required()
    .messages({ 'number.positive': 'rate must be a positive number' }),
  rateDate: Joi.date().iso().required(),
  source: Joi.string().valid('manual', 'imported').default('manual').optional(),
  notes: Joi.string().max(200).allow('', null).trim().optional(),
}).custom((value, helpers) => {
  if (value.fromCurrency === value.toCurrency) {
    return helpers.message('fromCurrency and toCurrency must be different');
  }
  return value;
});

/** Update an existing rate record */
const updateFxRateSchema = Joi.object({
  rate:     Joi.number().positive().optional(),
  rateDate: Joi.date().iso().optional(),
  source:   Joi.string().valid('manual', 'imported').optional(),
  notes:    Joi.string().max(200).allow('', null).trim().optional(),
}).min(1);

/** Bulk upsert — array of rate objects */
const bulkUpsertFxRatesSchema = Joi.object({
  rates: Joi.array().items(createFxRateSchema).min(1).max(200).required(),
});

/** Query filters for listing rates */
const listFxRatesSchema = Joi.object({
  fromCurrency: Joi.string().pattern(currencyPattern).uppercase().optional(),
  toCurrency:   Joi.string().pattern(currencyPattern).uppercase().optional(),
  startDate:    Joi.date().iso().optional(),
  endDate:      Joi.date().iso().optional(),
  page:         Joi.number().integer().min(1).default(1),
  limit:        Joi.number().integer().min(1).max(200).default(50),
});

/** Month-end revaluation trigger */
const revaluationSchema = Joi.object({
  revaluationDate: Joi.date().iso().default(() => new Date()),
});

const rateIdParamSchema = Joi.object({
  id: Joi.string().pattern(objectIdPattern).required(),
});

module.exports = {
  createFxRateSchema,
  updateFxRateSchema,
  bulkUpsertFxRatesSchema,
  listFxRatesSchema,
  revaluationSchema,
  rateIdParamSchema,
};
