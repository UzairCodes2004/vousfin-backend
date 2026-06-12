// validations/approval.validation.js
const Joi = require('joi');

const objectId = /^[0-9a-fA-F]{24}$/;

const updateSettingsSchema = Joi.object({
  enabled:           Joi.boolean(),
  threshold:         Joi.number().min(0).precision(2),
  allowSelfApproval: Joi.boolean(),
}).min(1);

const decisionSchema = Joi.object({
  note:   Joi.string().trim().max(500).allow('', null),
  reason: Joi.string().trim().max(500).allow('', null),
});

const approvalIdParamSchema = Joi.object({
  id: Joi.string().pattern(objectId).required(),
});

module.exports = {
  updateSettingsSchema,
  decisionSchema,
  approvalIdParamSchema,
};
