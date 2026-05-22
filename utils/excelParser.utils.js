/**
 * utils/excelParser.utils.js — v2
 *
 * Multi-format Excel/CSV parser with intelligent field inference.
 *
 * Supported formats  : .xlsx, .xls, .csv
 * Key features       :
 *   ✓ SheetJS (xlsx) reads all three formats from a Buffer
 *   ✓ Fuzzy column-header matching with Levenshtein distance
 *   ✓ Formula-injection protection (strips = + - @ | prefix chars)
 *   ✓ Per-row confidence scoring (0–100) with breakdown flags
 *   ✓ Duplicate detection (MD5 of date+amount+description)
 *   ✓ Smart transaction-type inference from description keywords
 *   ✓ Non-fatal warnings (rows stay in validRows with a warning flag)
 *   ✓ Negative-amount handling (debit/credit flipped columns)
 *   ✓ Multi-currency amount parsing (PKR, Rs, $, £ … stripped)
 */

'use strict';

const XLSX    = require('xlsx');
const crypto  = require('crypto');
const logger  = require('../config/logger');
const { TRANSACTION_TYPES, MAX_EXCEL_ROWS } = require('../config/constants');

// ── Column-header alias lists ─────────────────────────────────────────────────
const REQUIRED_COL_VARIANTS = {
  date:          ['date', 'transaction date', 'trans date', 'date of transaction',
                  'voucher date', 'posting date', 'entry date', 'txn date', 'dated'],
  description:   ['description', 'narration', 'details', 'particulars', 'memo',
                  'detail', 'narrative', 'remarks', 'purpose', 'transaction details'],
  amount:        ['amount', 'value', 'total', 'amount pkr', 'amount (pkr)', 'sum',
                  'transaction amount', 'debit amount', 'credit amount', 'net amount'],
  debitAccount:  ['debit account', 'debit account name', 'dr account', 'dr account name',
                  'dr', 'debit', 'dr.', 'debit a/c', 'from account', 'account dr'],
  creditAccount: ['credit account', 'credit account name', 'cr account', 'cr account name',
                  'cr', 'credit', 'cr.', 'credit a/c', 'to account', 'account cr'],
};

const OPTIONAL_COL_VARIANTS = {
  transactionType: ['type', 'transaction type', 'trans type', 'entry type', 'txn type', 'category'],
  transactionMode: ['mode', 'payment mode', 'mode of payment', 'payment method', 'method'],
  customer:        ['customer', 'customer name', 'client', 'client name', 'buyer'],
  vendor:          ['vendor', 'vendor name', 'supplier', 'supplier name', 'seller'],
  reference:       ['reference', 'reference #', 'ref no', 'invoice no', 'ref',
                    'reference number', 'invoice number', 'voucher no', 'voucher number', 'cheque no'],
  notes:           ['notes', 'note', 'remark', 'remarks', 'comment', 'comments', 'additional info'],
};

const VALID_TYPES = new Set(Object.values(TRANSACTION_TYPES));

// ── Description → transaction-type keyword hints ──────────────────────────────
// NOTE: order matters — more specific entries must come BEFORE general ones
// (e.g. 'asset purchase' / 'laptop' before generic 'purchase' → Expense)
const TYPE_KEYWORDS = [
  // ── Specific types first ───────────────────────────────────────────────────
  { words: ['asset purchase', 'equipment', 'machinery', 'vehicle', 'computer',
            'laptop', 'furniture', 'fixture', 'motor'],                               type: 'Asset Purchase' },
  { words: ['credit sale', 'receivable', 'invoice raised', 'billed customer',
            'sale on credit'],                                                         type: 'Credit Sale' },
  { words: ['credit purchase', 'supplier invoice', 'purchase on credit'],             type: 'Credit Purchase' },
  { words: ['owner invest', 'capital inject', 'capital contribution', 'proprietor',
            'owner capital'],                                                          type: 'Owner Investment' },
  { words: ['owner withdraw', 'drawings', 'withdrawal by owner'],                     type: 'Owner Withdrawal' },
  { words: ['loan from', 'borrowed', 'loan disburs', 'obtained loan',
            'proceeds of loan'],                                                       type: 'Loan Disbursement' },
  { words: ['loan repay', 'loan payment', 'bank loan payment', 'repaid loan'],        type: 'Loan Repayment' },
  { words: ['installment paid', 'emi paid'],                                          type: 'Loan Repayment' },
  { words: ['transfer', 'fund transfer', 'bank transfer', 'interbank', 'inter-bank'], type: 'Transfer' },
  // ── Revenue ────────────────────────────────────────────────────────────────
  { words: ['interest income', 'profit on', 'dividend', 'commission income',
            'rental income'],                                                          type: 'Income' },
  { words: ['sales', 'sold', 'revenue', 'service income', 'service fee',
            'fee received', 'cash received', 'received from client',
            'payment received from'],                                                  type: 'Income' },
  // ── Expenses ────────────────────────────────────────────────────────────────
  { words: ['salary', 'salaries', 'wage', 'payroll', 'stipend', 'staff pay',
            'staff salary'],                                                           type: 'Expense' },
  { words: ['rent paid', 'rent expense', 'office rent', 'shop rent', 'lease paid'],   type: 'Expense' },
  { words: ['utilities', 'electricity', 'gas bill', 'water bill', 'internet bill',
            'telephone', 'phone bill', 'sui gas', 'wapda', 'ptcl', 'utility'],        type: 'Expense' },
  { words: ['insurance premium', 'insurance paid'],                                   type: 'Expense' },
  { words: ['marketing', 'advertising', 'ads', 'promotion', 'social media'],          type: 'Expense' },
  { words: ['repair', 'maintenance', 'servicing', 'overhauling'],                     type: 'Expense' },
  { words: ['purchase', 'bought', 'procurement', 'supply', 'stock',
            'raw material', 'material purchased'],                                     type: 'Expense' },
];

// ── Pure-JS Levenshtein distance ──────────────────────────────────────────────
function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const prev = Array.from({ length: n + 1 }, (_, i) => i);
  const curr = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
    }
    prev.splice(0, n + 1, ...curr);
  }
  return prev[n];
}

// ── Header normalisation ──────────────────────────────────────────────────────
const normalizeHeader = (raw) => {
  if (raw == null) return '';
  return String(raw).toLowerCase().trim()
    .replace(/[_\-/\\|]+/g, ' ')
    .replace(/\s+/g, ' ');
};

// ── Fuzzy header-to-field matching ────────────────────────────────────────────
function fuzzyMatchColumn(norm, variants) {
  if (!norm) return false;
  // 1. Exact match (always)
  if (variants.includes(norm)) return true;
  // 2. Substring match — require BOTH strings to be > 3 chars to avoid false
  //    positives like 'cr' matching 'description' or 'date' matching 'update'
  if (norm.length > 3 && variants.some(v => v.length > 3 && (norm.includes(v) || v.includes(norm)))) return true;
  // 3. Levenshtein ≤ 2 — only for longer strings (≥6 chars on both sides)
  //    to avoid 'date'↔'note' or 'dr'↔'cr' false positives
  if (norm.length >= 6 && variants.some(v => v.length >= 6 && levenshtein(norm, v) <= 2)) return true;
  return false;
}

// ── Formula-injection protection ─────────────────────────────────────────────
const INJECTION_PREFIX = /^[=+\-@|]/;
function sanitize(val) {
  if (typeof val !== 'string') return val;
  const s = val.trim();
  return INJECTION_PREFIX.test(s) ? "'" + s : s;
}

// ── Smart date parsing ────────────────────────────────────────────────────────
function parseDate(raw) {
  if (raw == null || raw === '') return { date: null, parsed: false };
  // Already a JS Date
  if (raw instanceof Date) {
    return isNaN(raw.getTime()) ? { date: null, parsed: false } : { date: raw, parsed: false };
  }
  // Number → Excel serial
  if (typeof raw === 'number') {
    const ms = Math.round((raw - 25569) * 86400 * 1000);
    const d  = new Date(ms);
    return isNaN(d.getTime()) ? { date: null, parsed: false } : { date: d, parsed: true };
  }
  const str = String(raw).trim();
  // DD/MM/YYYY or DD-MM-YYYY
  const dmy = str.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/);
  if (dmy) {
    const d = new Date(+dmy[3], +dmy[2] - 1, +dmy[1]);
    if (!isNaN(d.getTime())) return { date: d, parsed: true };
  }
  // YYYY/MM/DD
  const ymd = str.match(/^(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})$/);
  if (ymd) {
    const d = new Date(+ymd[1], +ymd[2] - 1, +ymd[3]);
    if (!isNaN(d.getTime())) return { date: d, parsed: false };
  }
  // ISO / natural language fallback
  const d = new Date(str);
  if (!isNaN(d.getTime())) return { date: d, parsed: true };
  return { date: null, parsed: false };
}

// ── Smart amount parsing ──────────────────────────────────────────────────────
const CURRENCY_STRIP = /[^\d.\-]/g;
function parseAmount(raw) {
  if (raw == null || raw === '') return { amount: NaN, parsed: false };
  if (typeof raw === 'number')    return { amount: raw, parsed: false };
  const cleaned = String(raw).replace(CURRENCY_STRIP, '');
  const num = parseFloat(cleaned);
  return { amount: num, parsed: !isNaN(num) };
}

// ── Transaction-type keyword inference ───────────────────────────────────────
function inferTypeFromDescription(description) {
  if (!description) return null;
  const lower = description.toLowerCase();
  for (const { words, type } of TYPE_KEYWORDS) {
    if (words.some(w => lower.includes(w))) return type;
  }
  return null;
}

// ── Confidence scoring ────────────────────────────────────────────────────────
/**
 * @param {object} meta
 * @returns {{ score: number, label: 'High'|'Medium'|'Low', flags: string[] }}
 */
function calcConfidence(meta) {
  let score = 100;
  const flags = [];

  if (meta.dateParsed)          { score -= 5;  flags.push('date_parsed');        }
  if (meta.amountParsed)        { score -= 5;  flags.push('amount_parsed');       }
  if (meta.typeInferred)        { score -= 10; flags.push('type_inferred');       }
  if (meta.debitFuzzy)          { score -= 15; flags.push('debit_fuzzy');         }
  if (meta.creditFuzzy)         { score -= 15; flags.push('credit_fuzzy');        }
  if (meta.debitMissing)        { score -= 30; flags.push('debit_account_missing');}
  if (meta.creditMissing)       { score -= 30; flags.push('credit_account_missing');}
  if (meta.isDuplicate)         { score -= 30; flags.push('duplicate');            }
  if (meta.hasWarning)          { score -= 10; flags.push('has_warning');          }

  score = Math.max(0, score);
  const label = score >= 80 ? 'High' : score >= 50 ? 'Medium' : 'Low';
  return { score, label, flags };
}

// ── Duplicate-detection hash ──────────────────────────────────────────────────
function getDupHash(date, amount, description) {
  const str = [
    date instanceof Date ? date.toISOString().split('T')[0] : String(date || ''),
    typeof amount === 'number'  ? amount.toFixed(2) : '0',
    String(description || '').toLowerCase().trim().substring(0, 60),
  ].join('||');
  return crypto.createHash('md5').update(str).digest('hex');
}

// ── Read workbook from Buffer (all formats) ───────────────────────────────────
function readWorkbook(buffer, filename) {
  const ext = (filename || '').split('.').pop().toLowerCase();

  // Detect XLS by magic bytes (D0 CF = MS-CFB)
  const isXLS = (buffer[0] === 0xD0 && buffer[1] === 0xCF);
  // Detect XLSX by PK magic
  const isZIP = (buffer[0] === 0x50 && buffer[1] === 0x4B);
  // CSV has no magic — rely on extension or content
  const isCSV = ext === 'csv' || (!isXLS && !isZIP);

  // cellDates: true  → date cells become JS Date objects (not serial numbers)
  // raw: not set     → numeric cells stay as JS numbers, not strings
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true, WTF: false });

  if (!wb || !wb.SheetNames || !wb.SheetNames.length) {
    throw new Error('The file appears to be empty or corrupt.');
  }

  // Prefer a sheet named "Transactions", else take first sheet
  const sheetName = wb.SheetNames.find(n =>
    n.toLowerCase().includes('transaction') ||
    n.toLowerCase().includes('data') ||
    n.toLowerCase().includes('entries')
  ) || wb.SheetNames[0];

  const ws = wb.Sheets[sheetName];

  // Convert to array-of-arrays; defval=null so empty cells are null
  // raw: true keeps native JS types (numbers stay numbers, dates stay Dates)
  const rawRows = XLSX.utils.sheet_to_json(ws, {
    header: 1,
    defval: null,
    raw:    true,
  });

  return { rawRows, sheetName, totalSheets: wb.SheetNames.length, format: isXLS ? 'xls' : isCSV ? 'csv' : 'xlsx' };
}

// ── Find header row (first row that looks like a header) ─────────────────────
function findHeaderRow(rawRows) {
  for (let i = 0; i < Math.min(rawRows.length, 20); i++) {
    const row = rawRows[i];
    if (!row) continue;
    const cells  = row.map(c => normalizeHeader(c));
    const hasDate   = cells.some(c => c.includes('date'));
    const hasAmount = cells.some(c => c === 'amount' || c.includes('amount') || c === 'value' || c === 'total');
    if (hasDate && hasAmount) return i;
  }
  return -1;
}

// ── Map header row to column indices ─────────────────────────────────────────
function buildColMap(headerRow) {
  const map = {};
  // Init all fields to -1
  for (const k of Object.keys(REQUIRED_COL_VARIANTS))  map[k] = -1;
  for (const k of Object.keys(OPTIONAL_COL_VARIANTS))  map[k] = -1;

  // Each column index must map to at most one field.
  // Process fields in priority order so debitAccount wins over creditAccount
  // when headers like "dr account" / "cr account" are 1 edit apart.
  const usedCols = new Set();

  // Required first (higher priority), then optional
  const allVariants = [
    ...Object.entries(REQUIRED_COL_VARIANTS),
    ...Object.entries(OPTIONAL_COL_VARIANTS),
  ];

  // Two-pass approach:
  //   Pass 1: exact + substring matches only (no Levenshtein)
  //   Pass 2: Levenshtein fuzzy for still-unresolved fields
  // This ensures that "dr account" (exact match for debitAccount) is locked in
  // before Levenshtein can accidentally match it to creditAccount.

  for (let pass = 1; pass <= 2; pass++) {
    headerRow.forEach((cell, colIdx) => {
      if (usedCols.has(colIdx)) return;
      const norm = normalizeHeader(cell);
      if (!norm) return;

      for (const [field, variants] of allVariants) {
        if (map[field] !== -1) continue; // already assigned
        if (usedCols.has(colIdx)) break; // column claimed mid-loop

        let matched = false;
        if (pass === 1) {
          // Exact or substring only
          matched = variants.includes(norm) ||
            (norm.length > 3 && variants.some(v => v.length > 3 && (norm.includes(v) || v.includes(norm))));
        } else {
          // Levenshtein fuzzy
          matched = norm.length >= 6 &&
            variants.some(v => v.length >= 6 && levenshtein(norm, v) <= 2);
        }

        if (matched) {
          map[field] = colIdx;
          usedCols.add(colIdx);
          break; // one field per column per pass iteration
        }
      }
    });
  }

  return map;
}

// ── Safe cell getter from a raw row array ─────────────────────────────────────
function getCell(row, colIdx) {
  if (colIdx === -1 || colIdx >= row.length) return null;
  const v = row[colIdx];
  return v === '' ? null : v;
}

// ── Validate and parse a single raw row ──────────────────────────────────────
function processRow(rawRow, colMap, rowNumber, seenHashes) {
  const errors   = [];
  const warnings = [];
  const inferredFields = [];

  // Extract raw cell values
  const rawDate   = getCell(rawRow, colMap.date);
  const rawDesc   = getCell(rawRow, colMap.description);
  const rawAmt    = getCell(rawRow, colMap.amount);
  const rawDebit  = getCell(rawRow, colMap.debitAccount);
  const rawCredit = getCell(rawRow, colMap.creditAccount);
  const rawType   = getCell(rawRow, colMap.transactionType);
  const rawMode   = getCell(rawRow, colMap.transactionMode);
  const rawCust   = getCell(rawRow, colMap.customer);
  const rawVendor = getCell(rawRow, colMap.vendor);
  const rawRef    = getCell(rawRow, colMap.reference);
  const rawNotes  = getCell(rawRow, colMap.notes);

  // Skip completely empty rows
  if (!rawDate && !rawDesc && !rawAmt) return null;

  // ── Date ──
  const { date: parsedDate, parsed: dateParsed } = parseDate(rawDate);
  if (!parsedDate) {
    errors.push({ row: rowNumber, field: 'date', message: `Invalid date: "${rawDate}". Use YYYY-MM-DD, DD/MM/YYYY, or DD-MM-YYYY.` });
  }

  // ── Description ──
  const desc = rawDesc ? sanitize(String(rawDesc).trim()).substring(0, 500) : '';
  if (!desc) {
    errors.push({ row: rowNumber, field: 'description', message: 'Description / narration is required.' });
  }

  // ── Amount ──
  const { amount: numAmt, parsed: amountParsed } = parseAmount(rawAmt);
  if (isNaN(numAmt)) {
    errors.push({ row: rowNumber, field: 'amount', message: `Amount must be a number, got: "${rawAmt}".` });
  } else if (numAmt === 0) {
    errors.push({ row: rowNumber, field: 'amount', message: 'Amount must not be zero.' });
  } else if (numAmt < 0) {
    warnings.push(`Negative amount (${numAmt}) — check if debit/credit accounts are swapped.`);
  }

  // ── Debit / Credit account names ──
  const debitName  = rawDebit  ? sanitize(String(rawDebit).trim())  : '';
  const creditName = rawCredit ? sanitize(String(rawCredit).trim()) : '';

  if (!debitName)  errors.push({ row: rowNumber, field: 'debitAccount',  message: 'Debit account name is required.' });
  if (!creditName) errors.push({ row: rowNumber, field: 'creditAccount', message: 'Credit account name is required.' });
  if (debitName && creditName && debitName.toLowerCase() === creditName.toLowerCase()) {
    errors.push({ row: rowNumber, field: 'general', message: 'Debit and credit accounts must be different.' });
  }

  // ── Transaction type (optional — auto-inferred if missing) ──
  let txType = rawType ? sanitize(String(rawType).trim()) : '';
  if (txType) {
    if (VALID_TYPES.has(txType)) {
      // Exact match — good
    } else {
      const ci = [...VALID_TYPES].find(t => t.toLowerCase() === txType.toLowerCase());
      if (ci) {
        txType = ci;
      } else {
        const inferred = inferTypeFromDescription(desc);
        if (inferred) {
          txType = inferred;
          inferredFields.push('transactionType');
        } else {
          txType = '';
        }
        warnings.push(`Unknown transaction type "${rawType}" — will auto-infer from accounts.`);
      }
    }
  } else if (desc) {
    const inferred = inferTypeFromDescription(desc);
    if (inferred) {
      txType = inferred;
      inferredFields.push('transactionType');
    }
  }

  // ── Transaction mode (optional) ──
  const MODE_MAP = { cash: 'cash', credit: 'credit', cheque: 'credit',
                     installment: 'installment', 'partial settlement': 'partial_settlement' };
  let txMode = null;
  if (rawMode) {
    const norm = String(rawMode).toLowerCase().trim();
    txMode = MODE_MAP[norm] || null;
  }

  // ── Duplicate detection ──
  let isDuplicate = false;
  if (parsedDate && !isNaN(numAmt)) {
    const hash = getDupHash(parsedDate, Math.abs(numAmt), desc);
    if (seenHashes.has(hash)) {
      isDuplicate = true;
      warnings.push('Possible duplicate — same date, amount, and description as another row.');
    } else {
      seenHashes.add(hash);
    }
  }

  // ── Confidence scoring ──
  const conf = calcConfidence({
    dateParsed,
    amountParsed,
    typeInferred:   inferredFields.includes('transactionType'),
    debitFuzzy:     false, // resolved later in controller
    creditFuzzy:    false,
    debitMissing:   !debitName,
    creditMissing:  !creditName,
    isDuplicate,
    hasWarning:     warnings.length > 0,
  });

  const parsedData = {
    transactionDate:      parsedDate  || null,
    description:          desc        || '',
    amount:               isNaN(numAmt) ? 0 : parseFloat(Math.abs(numAmt).toFixed(2)),
    transactionType:      txType      || null,
    transactionMode:      txMode      || null,
    debitAccountName:     debitName,
    creditAccountName:    creditName,
    customerName:         rawCust   ? sanitize(String(rawCust).trim())   || null : null,
    vendorName:           rawVendor ? sanitize(String(rawVendor).trim()) || null : null,
    transactionReference: rawRef    ? sanitize(String(rawRef).trim())   || null : null,
    notes:                rawNotes  ? sanitize(String(rawNotes).trim()).substring(0, 1000) || null : null,
    // Metadata for frontend
    originalRow:          rowNumber,
    confidenceScore:      conf.score,
    confidenceLabel:      conf.label,
    confidenceFlags:      conf.flags,
    inferredFields,
    warnings,
    isDuplicate,
  };

  return {
    isValid:    errors.length === 0,
    errors,
    parsedData,
  };
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Parse an Excel (.xlsx / .xls) or CSV buffer into transaction rows.
 *
 * @param {Buffer}  buffer
 * @param {string}  businessId
 * @param {string}  [filename]   - original filename (used for format detection)
 * @returns {Promise<{
 *   validRows:      object[],
 *   errors:         object[],
 *   duplicatesFound:number,
 *   fileInfo:       object,
 *   confidenceStats:object,
 * }>}
 */
async function parseExcelTransactions(buffer, businessId, filename = 'upload.xlsx') {
  // ── 1. Read workbook ──────────────────────────────────────────────────────
  let rawRows, sheetName, totalSheets, format;
  try {
    ({ rawRows, sheetName, totalSheets, format } = readWorkbook(buffer, filename));
  } catch (e) {
    throw new Error(
      `Cannot read file: ${e.message}. ` +
      'Supported formats: .xlsx, .xls, .csv. ' +
      'Download the template for the correct format.'
    );
  }

  if (!rawRows || rawRows.length < 2) {
    throw new Error('The file appears to be empty — no data rows found.');
  }

  // ── 2. Find header row ────────────────────────────────────────────────────
  const headerIdx = findHeaderRow(rawRows);
  if (headerIdx === -1) {
    throw new Error(
      'Could not find a header row. ' +
      'Make sure your file has a row with "Date" and "Amount" columns.'
    );
  }

  const colMap = buildColMap(rawRows[headerIdx]);

  logger.info(`Excel parse: format=${format}, sheet="${sheetName}", header@row${headerIdx + 1}`, {
    found: Object.entries(colMap)
      .filter(([, v]) => v !== -1)
      .map(([k, v]) => `${k}@col${v + 1}`)
      .join(', '),
  });

  // ── 3. Check required columns ─────────────────────────────────────────────
  const missingRequired = Object.keys(REQUIRED_COL_VARIANTS).filter(k => colMap[k] === -1);
  if (missingRequired.length) {
    throw new Error(
      `Missing required columns: ${missingRequired.join(', ')}. ` +
      'Expected: Date, Description, Amount, Debit Account, Credit Account. ' +
      'Download the template for the correct format.'
    );
  }

  // ── 4. Process data rows ──────────────────────────────────────────────────
  const validRows   = [];
  const errors      = [];
  const seenHashes  = new Set();
  let rowCount      = 0;
  let duplicateCount = 0;

  for (let i = headerIdx + 1; i < rawRows.length; i++) {
    if (rowCount >= MAX_EXCEL_ROWS) {
      errors.push({ row: i + 1, field: 'general',
        message: `Row limit reached (max ${MAX_EXCEL_ROWS} rows per import).` });
      break;
    }

    const rawRow = rawRows[i];
    if (!rawRow || rawRow.every(c => c == null || c === '')) continue;

    const result = processRow(rawRow, colMap, i + 1, seenHashes);
    if (!result) continue; // completely empty row

    rowCount++;
    if (result.isValid) {
      if (result.parsedData.isDuplicate) duplicateCount++;
      validRows.push({ businessId, ...result.parsedData });
    } else {
      errors.push(...result.errors);
    }
  }

  // ── 5. Confidence stats ───────────────────────────────────────────────────
  const confidenceStats = validRows.reduce(
    (acc, r) => {
      if      (r.confidenceScore >= 80) acc.high++;
      else if (r.confidenceScore >= 50) acc.medium++;
      else                              acc.low++;
      return acc;
    },
    { high: 0, medium: 0, low: 0 }
  );

  logger.info(`Excel parse complete: ${validRows.length} valid, ${errors.length} error(s), ` +
              `${duplicateCount} duplicate(s), ${rowCount} scanned`);

  return {
    validRows,
    errors,
    duplicatesFound: duplicateCount,
    fileInfo:        { format, sheet: sheetName, totalSheets, dataRows: rowCount },
    confidenceStats,
  };
}

module.exports = { parseExcelTransactions };
