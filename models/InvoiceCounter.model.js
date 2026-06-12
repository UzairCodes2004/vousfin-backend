const mongoose = require('mongoose');

// Atomic counter for invoice / bill number sequences.
// _id format: "<businessId>:<prefix>:<YYYYMM>"  (e.g. "507f...1:INV:202506")
// seq is incremented via $inc in a single findOneAndUpdate — no race condition.
const invoiceCounterSchema = new mongoose.Schema({
  _id:  { type: String, required: true },
  seq:  { type: Number, default: 0 },
}, { _id: false, versionKey: false });

module.exports = mongoose.model('InvoiceCounter', invoiceCounterSchema);
