// validations/bankReconciliation.validation.js
const Joi = require('joi');

const objectId = /^[0-9a-fA-F]{24}$/;

const lineSchema = Joi.object({
  lineRef:     Joi.string().optional(),
  date:        Joi.date().iso().required(),
  description: Joi.string().allow('', null).max(500),
  reference:   Joi.string().allow('', null).max(100),
  amount:      Joi.number().positive().required(),
  direction:   Joi.string().valid('in', 'out').required(),
  runningBalance: Joi.number().allow(null),
}).unknown(true);

const importSchema = Joi.object({
  bankAccountId:  Joi.string().pattern(objectId).required(),
  name:           Joi.string().trim().max(150).allow('', null),
  fileName:       Joi.string().max(260).allow('', null),
  lines:          Joi.array().items(lineSchema).min(1).required(),
  openingBalance: Joi.number().allow(null),
  closingBalance: Joi.number().allow(null),
  periodStart:    Joi.date().iso().allow(null),
  periodEnd:      Joi.date().iso().allow(null),
});

const matchSchema = Joi.object({
  journalEntryId: Joi.string().pattern(objectId).required(),
});

const createFromLineSchema = Joi.object({
  categoryAccountId: Joi.string().pattern(objectId).required(),
  accountId:         Joi.string().pattern(objectId), // alias
  description:       Joi.string().max(200).allow('', null),
  vendorName:        Joi.string().max(150).allow('', null),
  customerName:      Joi.string().max(150).allow('', null),
}).or('categoryAccountId', 'accountId');

const clearSchema = Joi.object({
  note: Joi.string().max(300).allow('', null),
});

const idParamSchema = Joi.object({
  id: Joi.string().pattern(objectId).required(),
}).unknown(true);

module.exports = {
  importSchema, matchSchema, createFromLineSchema, clearSchema, idParamSchema,
};
