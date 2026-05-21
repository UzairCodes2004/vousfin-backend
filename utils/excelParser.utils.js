// utils/excelParser.utils.js
const ExcelJS = require('exceljs');
const { TRANSACTION_TYPES, MAX_EXCEL_ROWS } = require('../config/constants');
const logger = require('../config/logger');

// ── Column header variants (case-insensitive, after normalization) ──────────
const REQUIRED_COLUMNS = {
  date:          ['date', 'transaction date', 'trans date', 'date of transaction', 'voucher date', 'posting date'],
  description:   ['description', 'narration', 'details', 'particulars', 'memo', 'detail', 'narrative'],
  amount:        ['amount', 'value', 'total', 'amount pkr', 'amount (pkr)', 'debit amount', 'credit amount'],
  debitAccount:  ['debit account', 'debit account name', 'dr account', 'dr', 'debit', 'dr.'],
  creditAccount: ['credit account', 'credit account name', 'cr account', 'cr', 'credit', 'cr.'],
};

const OPTIONAL_COLUMNS = {
  transactionType: ['type', 'transaction type', 'trans type', 'entry type'],
  customer:        ['customer', 'customer name', 'client', 'client name'],
  vendor:          ['vendor', 'vendor name', 'supplier', 'supplier name'],
  reference:       ['reference', 'reference #', 'ref no', 'invoice no', 'ref', 'reference number', 'invoice number'],
  notes:           ['notes', 'note', 'remarks', 'comment', 'comments'],
};

const VALID_TYPES = new Set(Object.values(TRANSACTION_TYPES));

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Normalize a column header for matching: lowercase, trim, collapse spaces, strip punctuation */
const normalizeHeader = (raw) => {
  if (raw == null) return '';
  return String(raw).toLowerCase().trim()
    .replace(/[_\-/]+/g, ' ')
    .replace(/\s+/g, ' ');
};

/**
 * Extract the usable value from an ExcelJS cell.
 * Handles formula cells, rich text, and hyperlink objects.
 */
const getCellValue = (cell) => {
  const v = cell.value;
  if (v == null) return null;
  if (typeof v === 'object') {
    // Formula result: { formula: '...', result: ... }
    if ('result' in v) return v.result == null ? null : v.result;
    // Rich text: { richText: [{ text: '...' }, ...] }
    if ('richText' in v) return v.richText.map(r => r.text || '').join('');
    // Hyperlink: { text: '...', hyperlink: '...' }
    if ('text' in v) return v.text;
  }
  return v;
};

/**
 * Parse a date from an Excel cell value.
 * Handles: JS Date objects, Excel serial numbers, ISO strings, DD/MM/YYYY strings.
 */
const parseDate = (raw) => {
  if (!raw) return null;
  if (raw instanceof Date) return isNaN(raw.getTime()) ? null : raw;
  if (typeof raw === 'number') {
    // Excel stores dates as days since 1899-12-30 (Lotus 1-2-3 epoch)
    const ms = Math.round((raw - 25569) * 86400 * 1000);
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d;
  }
  const str = String(raw).trim();
  // Try DD/MM/YYYY or DD-MM-YYYY
  const dmy = str.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/);
  if (dmy) {
    const d = new Date(+dmy[3], +dmy[2] - 1, +dmy[1]);
    if (!isNaN(d.getTime())) return d;
  }
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
};

/**
 * Parse an amount from a cell value.
 * Strips currency symbols (Rs, PKR, $, £) and thousands separators.
 */
const parseAmount = (raw) => {
  if (raw == null) return NaN;
  if (typeof raw === 'number') return raw;
  const cleaned = String(raw).replace(/[^\d.\-]/g, '');
  return parseFloat(cleaned);
};

/**
 * Build column-index map from the header row.
 * Returns { date: colNum, ... } with -1 for missing optional columns.
 */
const findColumnIndices = (headerRow) => {
  const idx = {};
  for (const k of Object.keys(REQUIRED_COLUMNS)) idx[k] = -1;
  for (const k of Object.keys(OPTIONAL_COLUMNS)) idx[k] = -1;

  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const norm = normalizeHeader(getCellValue(cell));
    if (!norm) return;
    for (const [field, variants] of Object.entries(REQUIRED_COLUMNS)) {
      if (idx[field] === -1 && variants.includes(norm)) idx[field] = colNumber;
    }
    for (const [field, variants] of Object.entries(OPTIONAL_COLUMNS)) {
      if (idx[field] === -1 && variants.includes(norm)) idx[field] = colNumber;
    }
  });
  return idx;
};

/**
 * Validate a single data row. Returns { isValid, errors, parsedData }.
 * transactionType is optional — if empty/unknown, backend auto-infers from account types.
 */
const validateRow = (raw, rowNumber) => {
  const errors = [];

  // Date
  const parsedDate = parseDate(raw.date);
  if (!parsedDate) {
    errors.push({ row: rowNumber, field: 'date', message: `Invalid date: "${raw.date}". Use YYYY-MM-DD or DD/MM/YYYY.` });
  }

  // Description
  const desc = raw.description ? String(raw.description).trim() : '';
  if (!desc) {
    errors.push({ row: rowNumber, field: 'description', message: 'Description is required' });
  }

  // Amount
  const numAmt = parseAmount(raw.amount);
  if (isNaN(numAmt) || numAmt <= 0) {
    errors.push({ row: rowNumber, field: 'amount', message: `Amount must be a positive number, got: "${raw.amount}"` });
  }

  // Debit / Credit Account
  const debitName  = raw.debitAccount  ? String(raw.debitAccount).trim()  : '';
  const creditName = raw.creditAccount ? String(raw.creditAccount).trim() : '';
  if (!debitName)  errors.push({ row: rowNumber, field: 'debitAccount',  message: 'Debit account is required'  });
  if (!creditName) errors.push({ row: rowNumber, field: 'creditAccount', message: 'Credit account is required' });
  if (debitName && creditName && debitName.toLowerCase() === creditName.toLowerCase()) {
    errors.push({ row: rowNumber, field: 'general', message: 'Debit and credit accounts must be different' });
  }

  // Transaction Type — OPTIONAL, auto-inferred by backend if absent/unrecognized
  let txType = raw.transactionType ? String(raw.transactionType).trim() : '';
  if (txType) {
    if (VALID_TYPES.has(txType)) {
      // exact match, keep as-is
    } else {
      const caseMatch = [...VALID_TYPES].find(t => t.toLowerCase() === txType.toLowerCase());
      if (caseMatch) {
        txType = caseMatch;
      } else {
        logger.warn(`Row ${rowNumber}: unknown transactionType "${txType}" — will auto-infer from account types`);
        txType = ''; // clear so backend auto-infers
      }
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
    parsedData: {
      transactionDate:      parsedDate || null,
      description:          desc.substring(0, 500),
      amount:               isNaN(numAmt) ? 0 : parseFloat(numAmt.toFixed(2)),
      transactionType:      txType || null,
      debitAccountName:     debitName,
      creditAccountName:    creditName,
      customerName:         raw.customer   ? String(raw.customer).trim()   || null : null,
      vendorName:           raw.vendor     ? String(raw.vendor).trim()     || null : null,
      transactionReference: raw.reference  ? String(raw.reference).trim()  || null : null,
      notes:                raw.notes      ? String(raw.notes).trim().substring(0, 1000) || null : null,
    },
  };
};

// ── Main export ─────────────────────────────────────────────────────────────

/**
 * Parse an Excel (.xlsx) buffer into valid and invalid transaction rows.
 *
 * @param {Buffer} buffer
 * @param {string} businessId
 * @returns {Promise<{ validRows: Array, errors: Array }>}
 */
const parseExcelTransactions = async (buffer, businessId) => {
  let workbook;
  try {
    workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
  } catch (e) {
    throw new Error(
      `Cannot read file: ${e.message}. ` +
      'Only .xlsx format is supported (not .xls). Save your file as .xlsx and try again. ' +
      'Download the template for the correct format.'
    );
  }

  const worksheet = workbook.worksheets[0];
  if (!worksheet) {
    throw new Error('No worksheet found. The Excel file appears to be empty.');
  }

  // Find header row: first row that contains a date-like and amount-like header
  let headerRowIndex = -1;
  worksheet.eachRow((row, rowNumber) => {
    if (headerRowIndex !== -1) return;
    let hasDate = false, hasAmount = false;
    row.eachCell({ includeEmpty: false }, (cell) => {
      const norm = normalizeHeader(getCellValue(cell));
      if (norm.includes('date')) hasDate = true;
      if (norm === 'amount' || norm.includes('amount') || norm === 'value' || norm === 'total') hasAmount = true;
    });
    if (hasDate && hasAmount) headerRowIndex = rowNumber;
  });

  if (headerRowIndex === -1) {
    throw new Error(
      'Could not find a header row. ' +
      'Make sure your file has a row with "Date" and "Amount" columns. ' +
      'Download the template for the correct format.'
    );
  }

  const headerRow = worksheet.getRow(headerRowIndex);
  const colIdx    = findColumnIndices(headerRow);

  logger.info(`Excel import: header at row ${headerRowIndex}`, {
    found: Object.entries(colIdx)
      .filter(([, v]) => v !== -1)
      .map(([k, v]) => `${k}@col${v}`)
      .join(', '),
  });

  // Ensure all required columns were found
  const missingRequired = Object.keys(REQUIRED_COLUMNS).filter(k => colIdx[k] === -1);
  if (missingRequired.length) {
    throw new Error(
      `Missing required columns: ${missingRequired.join(', ')}. ` +
      `Expected: Date, Description, Amount, Debit Account, Credit Account. ` +
      `Download the template for the correct format.`
    );
  }

  const validRows = [];
  const errors    = [];
  let rowCount    = 0;

  for (let i = headerRowIndex + 1; i <= worksheet.rowCount; i++) {
    if (rowCount >= MAX_EXCEL_ROWS) {
      errors.push({ row: i, field: 'general', message: `Row limit reached (max ${MAX_EXCEL_ROWS} rows per import)` });
      break;
    }

    const row = worksheet.getRow(i);

    const dateVal   = getCellValue(row.getCell(colIdx.date));
    const descVal   = getCellValue(row.getCell(colIdx.description));
    const amtVal    = getCellValue(row.getCell(colIdx.amount));
    const debitVal  = getCellValue(row.getCell(colIdx.debitAccount));
    const creditVal = getCellValue(row.getCell(colIdx.creditAccount));

    // Skip completely empty rows
    if (!dateVal && !descVal && !amtVal) continue;

    const typeVal   = colIdx.transactionType !== -1 ? getCellValue(row.getCell(colIdx.transactionType)) : null;
    const custVal   = colIdx.customer         !== -1 ? getCellValue(row.getCell(colIdx.customer))        : null;
    const vendorVal = colIdx.vendor           !== -1 ? getCellValue(row.getCell(colIdx.vendor))          : null;
    const refVal    = colIdx.reference        !== -1 ? getCellValue(row.getCell(colIdx.reference))       : null;
    const notesVal  = colIdx.notes            !== -1 ? getCellValue(row.getCell(colIdx.notes))           : null;

    const validation = validateRow(
      {
        date: dateVal, description: descVal, amount: amtVal,
        transactionType: typeVal, debitAccount: debitVal, creditAccount: creditVal,
        customer: custVal, vendor: vendorVal, reference: refVal, notes: notesVal,
      },
      i
    );

    rowCount++;
    if (validation.isValid) {
      validRows.push({ businessId, ...validation.parsedData, originalRow: i });
    } else {
      errors.push(...validation.errors);
    }
  }

  logger.info(`Excel parse complete: ${validRows.length} valid, ${errors.length} errors, ${rowCount} data rows scanned`);
  return { validRows, errors };
};

module.exports = { parseExcelTransactions };
