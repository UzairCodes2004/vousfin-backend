// utils/pdfBusinessHeader.js
//
// Builds the { businessName, address, phone, email, website, taxId, regNumber,
// logoUrl } header object that invoicePdf.service expects, from a Business
// document. Shared by the invoice and bill PDF download controllers so the
// branding block is identical on both documents.

/**
 * @param {Object} biz - a lean Business document (or null)
 * @returns {Object} header fields for the PDF generator
 */
function buildBusinessHeader(biz = {}) {
  const b = biz || {};
  const tax = b.taxConfig || {};
  return {
    businessName: b.businessName || '',
    address:      b.address || '',
    phone:        b.phone || '',
    email:        b.email || '',
    website:      b.website || '',
    // Prefer the tax-registration number from tax config; fall back to legacy fields
    taxId:        tax.taxRegistrationNumber || b.taxId || b.ntn || '',
    regNumber:    b.registrationNumber || '',
    logoUrl:      b.logoUrl || '',
  };
}

module.exports = { buildBusinessHeader };
