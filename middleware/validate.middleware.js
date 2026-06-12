// middleware/validate.middleware.js
/**
 * Request validation middleware using Joi.
 *
 * Options used:
 *   abortEarly: false   – collect ALL validation errors, not just the first
 *   allowUnknown: true  – silently ignore any extra fields the client sends.
 *                         This future-proofs the API: new frontend fields never
 *                         cause a 400 until the schema is explicitly updated.
 *
 * @param {Joi.Schema} schema - Joi validation schema
 * @param {string} property - Request property to validate ('body', 'query', 'params')
 * @returns {Function} Express middleware
 */
const validate = (schema, property = 'body') => {
  return (req, res, next) => {
    const { error, value } = schema.validate(req[property], {
      abortEarly:   false,
      allowUnknown: true,   // never reject unknown keys — prevents "field is not allowed" 400s
    });
    if (error) {
      const messages = error.details.map(detail => detail.message).join(', ');
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors:  messages,
        details: error.details.map(detail => ({
          field:   detail.path.join('.'),
          message: detail.message,
        })),
      });
    }
    // Write Joi-defaulted values back so controllers see defaults.
    // req.query is a getter on Express's prototype — direct assignment is silently ignored,
    // so we mutate it in-place with Object.assign instead.
    // For req.body and req.params, direct replacement works fine.
    if (value) {
      if (property === 'query') {
        // Merge defaults into the existing query object.
        // Joi returns string values for Joi.date() defaults (it does NOT coerce the
        // default value to a Date object), so no conversion is needed.
        Object.assign(req.query, value);
      } else {
        req[property] = value;
      }
    }
    next();
  };
};

module.exports = validate;