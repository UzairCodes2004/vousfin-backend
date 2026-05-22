// controllers/transaction.controller.js
const transactionService = require('../services/transaction.service');
const installmentService = require('../services/installment.service');
const parserService = require('../services/nlParser/services/parserService');
const accountRepository = require('../repositories/account.repository');
const { mapParserToPreview } = require('../utils/nlParserPreview.helper');
const ApiResponse = require('../utils/ApiResponse');
const { ApiError } = require('../utils/ApiError');
const { parseExcelTransactions } = require('../utils/excelParser.utils');
const logger = require('../config/logger');

const resolveAccountIds = async (businessId, row) => {
  let debitAccountId = row.debitAccountId;
  let creditAccountId = row.creditAccountId;
  const debitName = row.debitAccountName || row.debitAccount;
  const creditName = row.creditAccountName || row.creditAccount;
  if (!debitAccountId && debitName) {
    const debit = await accountRepository.findByBusinessAndName(businessId, debitName);
    if (!debit) throw new ApiError(400, `Debit account not found: "${debitName}". Please check your Chart of Accounts.`);
    debitAccountId = debit._id;
  }
  if (!creditAccountId && creditName) {
    const credit = await accountRepository.findByBusinessAndName(businessId, creditName);
    if (!credit) throw new ApiError(400, `Credit account not found: "${creditName}". Please check your Chart of Accounts.`);
    creditAccountId = credit._id;
  }
  return { debitAccountId, creditAccountId };
};

/**
 * Build an in-memory account resolver from a pre-loaded accounts array.
 * Replicates the 3-tier fuzzy matching from accountRepository.findByBusinessAndName
 * so bulk imports need only ONE database query instead of N×2-3.
 */
const buildAccountResolver = (accounts) => (name) => {
  const clean = (name || '').trim();
  if (!clean) return null;
  const lower = clean.toLowerCase();
  // 1. Exact case-insensitive
  const exact = accounts.find(a => a.accountName.toLowerCase() === lower);
  if (exact) return exact;
  // 2. Partial / contains
  const partial = accounts.find(
    a => a.accountName.toLowerCase().includes(lower) || lower.includes(a.accountName.toLowerCase())
  );
  if (partial) return partial;
  // 3. Word-overlap fuzzy
  const words = lower.split(/\s+/).filter(w => w.length > 2);
  if (words.length) {
    let best = null, bestScore = 0;
    for (const acc of accounts) {
      const accWords = acc.accountName.toLowerCase().split(/\s+/);
      const score = words.filter(w => accWords.some(aw => aw.includes(w) || w.includes(aw))).length;
      if (score > bestScore) { bestScore = score; best = acc; }
    }
    if (bestScore > 0) return best;
  }
  return null;
};

/**
 * Create a transaction from structured form.
 */
const createFormTransaction = async (req, res, next) => {
  try {
    const transactionData = {
      ...req.body,
      businessId: req.user.businessId,
      inputMethod: 'form',
    };
    const transaction = await transactionService.createTransaction(
      transactionData,
      req.user.id,
      req.ip
    );
    ApiResponse.created(res, transaction, 'Transaction recorded successfully');
  } catch (error) {
    next(error);
  }
};

/**
 * Record a partial or full payment against a parent transaction.
 * POST /api/v1/transactions/payment
 */
const recordPayment = async (req, res, next) => {
  try {
    const { parentTransactionId, ...paymentData } = req.body;
    if (!parentTransactionId) throw new ApiError(400, 'parentTransactionId is required');

    const paymentTx = await transactionService.recordPartialPayment(
      parentTransactionId,
      req.user.businessId,
      paymentData,
      req.user.id,
      req.ip
    );
    ApiResponse.created(res, paymentTx, 'Payment recorded successfully');
  } catch (error) {
    next(error);
  }
};

/**
 * Get outstanding balances (Receivables or Payables).
 * GET /api/v1/transactions/outstanding
 */
const getOutstandingBalances = async (req, res, next) => {
  try {
    const { type, withAging } = req.query; // 'receivable' or 'payable'
    if (!type) throw new ApiError(400, 'type query parameter is required (receivable or payable)');

    const rows = await transactionService.getOutstandingBalances(req.user.businessId, type);

    /* Backward-compat: without withAging the response stays a plain array.
       With ?withAging=true we wrap it as { rows, aging, totals }. */
    if (withAging === 'true' || withAging === '1') {
      const aging = transactionService.computeAgingBuckets(rows);
      return ApiResponse.success(res, { rows, aging }, 'Outstanding balances retrieved');
    }
    ApiResponse.success(res, rows, 'Outstanding balances retrieved');
  } catch (error) {
    next(error);
  }
};

/**
 * Get settlement history for a parent transaction.
 * GET /api/v1/transactions/:id/settlements
 */
const getSettlementHistory = async (req, res, next) => {
  try {
    const { id } = req.params;
    const history = await transactionService.getSettlementHistory(id, req.user.businessId);
    ApiResponse.success(res, history, 'Settlement history retrieved');
  } catch (error) {
    next(error);
  }
};

/**
 * Create an installment transaction (creates entry + plan).
 * POST /api/v1/transactions/installment
 */
const createInstallmentTransaction = async (req, res, next) => {
  try {
    const {
      transactionDate, description, amount, debitAccountId, creditAccountId,
      customerId, vendorId,
      downPayment, installmentCount, installmentFrequency
    } = req.body;

    const transactionData = {
      businessId: req.user.businessId,
      transactionDate,
      description,
      amount,
      debitAccountId,
      creditAccountId,
      customerId,
      vendorId,
      inputMethod: 'form',
    };

    const installmentConfig = {
      downPayment: downPayment || 0,
      installmentCount,
      installmentFrequency
    };

    const result = await installmentService.createInstallmentPlan(
      transactionData,
      installmentConfig,
      req.user.id,
      req.ip
    );

    ApiResponse.created(res, result, 'Installment transaction created successfully');
  } catch (error) {
    next(error);
  }
};

/**
 * Record a payment against an installment plan.
 * POST /api/v1/transactions/installment/:planId/pay
 */
const recordInstallmentPayment = async (req, res, next) => {
  try {
    const { planId } = req.params;
    const paymentData = req.body;
    
    const result = await installmentService.recordInstallmentPayment(
      planId,
      req.user.businessId,
      paymentData,
      req.user.id,
      req.ip
    );

    ApiResponse.success(res, result, 'Installment payment recorded successfully');
  } catch (error) {
    next(error);
  }
};

/**
 * Process natural language input and return a preview.
 */
const processNaturalLanguage = async (req, res, next) => {
  try {
    const { text } = req.body;
    if (!text || text.trim().length < 5) {
      throw new ApiError(400, 'Please provide a longer transaction description');
    }
    const parsed = await parserService.parseTransaction(text);
    const preview = mapParserToPreview(parsed, text);

    if (req.user.businessId && (preview.debitAccount || preview.creditAccount)) {
      // Gracefully resolve — fuzzy match, don't throw if not found
      try {
        if (preview.debitAccount) {
          const debit = await accountRepository.findByBusinessAndName(req.user.businessId, preview.debitAccount);
          preview.debitAccountId = debit?._id || null;
          if (debit) preview.debitAccount = debit.accountName; // normalize to actual name
        }
        if (preview.creditAccount) {
          const credit = await accountRepository.findByBusinessAndName(req.user.businessId, preview.creditAccount);
          preview.creditAccountId = credit?._id || null;
          if (credit) preview.creditAccount = credit.accountName;
        }
      } catch (resolveErr) {
        logger.warn('NL account resolution partial failure (non-fatal):', resolveErr.message);
        // Continue — user will pick accounts manually in preview step
      }
    }

    ApiResponse.success(res, preview, 'Preview generated. Confirm to save.');
  } catch (error) {
    next(error);
  }
};

/**
 * Confirm and save a natural language transaction (after preview).
 */
const confirmNaturalLanguage = async (req, res, next) => {
  try {
    const { transactionDate, description, transactionType, amount } = req.body;
    const { debitAccountId, creditAccountId } = await resolveAccountIds(req.user.businessId, req.body);
    if (!debitAccountId || !creditAccountId) {
      throw new ApiError(400, 'Debit and credit accounts are required. Resolve account names or pass account IDs.');
    }
    const transactionData = {
      transactionDate,
      description,
      transactionType,
      amount,
      debitAccountId,
      creditAccountId,
      businessId: req.user.businessId,
      inputMethod: 'nlp',
    };
    const transaction = await transactionService.createTransaction(
      transactionData,
      req.user.id,
      req.ip
    );
    ApiResponse.created(res, transaction, 'Transaction recorded from natural language');
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/v1/transactions/excel/template
 * Download a sample .xlsx import template.
 */
const downloadExcelTemplate = async (req, res, next) => {
  try {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    wb.creator = 'vousFin';

    // ── Instructions sheet ──────────────────────────────────────────────────
    const info = wb.addWorksheet('Instructions');
    info.getColumn(1).width = 20;
    info.getColumn(2).width = 60;
    const addInfo = (label, value) => {
      const row = info.addRow([label, value]);
      row.getCell(1).font = { bold: true };
    };
    info.addRow(['vousFin Bulk Import Template']);
    info.getRow(1).font = { bold: true, size: 14 };
    info.addRow([]);
    addInfo('Required columns:', 'Date, Description, Amount, Debit Account, Credit Account');
    addInfo('Optional columns:', 'Type, Customer, Vendor, Reference, Notes');
    addInfo('Date format:', 'YYYY-MM-DD or DD/MM/YYYY');
    addInfo('Amount format:', 'Positive numbers only (e.g. 25000 or 25,000.00)');
    addInfo('Debit Account:', 'Exact account name from your Chart of Accounts');
    addInfo('Credit Account:', 'Exact account name from your Chart of Accounts');
    addInfo('Type (optional):', 'Income, Expense, Credit Sale, Credit Purchase, Transfer, Owner Investment, Owner Withdrawal, Loan Disbursement, Loan Repayment, Asset Purchase');
    addInfo('Customer:', 'Required for Credit Sale / Payment Received rows');
    addInfo('Vendor:', 'Required for Credit Purchase / Payment Made rows');

    // ── Transactions sheet ───────────────────────────────────────────────────
    const ws = wb.addWorksheet('Transactions');

    const headers = ['Date', 'Description', 'Amount', 'Debit Account', 'Credit Account', 'Type', 'Customer', 'Vendor', 'Reference', 'Notes'];
    const widths  = [14,     40,             14,       28,              28,               22,     20,         20,       16,          35];
    headers.forEach((h, i) => { ws.getColumn(i + 1).width = widths[i]; });

    const headerRow = ws.addRow(headers);
    headerRow.eachCell(cell => {
      cell.font = { bold: true, color: { argb: 'FFF8FAFC' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
      cell.alignment = { vertical: 'middle' };
    });
    ws.getRow(1).height = 22;

    // Example rows
    const examples = [
      ['2024-01-15', 'Monthly office rent',                  25000, 'Rent Expense',         'Cash',              'Expense',    '',         '',         'RENT-001', 'Office rent January'],
      ['2024-01-16', 'Service revenue from client',          50000, 'Cash',                  'Service Revenue',   'Income',     '',         '',         '',         ''],
      ['2024-01-17', 'Credit sale to Ahmed Khan',            35000, 'Accounts Receivable',   'Sales Revenue',     'Credit Sale','Ahmed Khan','',         'INV-002',  ''],
      ['2024-01-18', 'Salary payment',                       60000, 'Salaries Expense',      'Bank',              'Expense',    '',         '',         '',         'Staff salaries'],
      ['2024-01-19', 'Purchase inventory from supplier',     40000, 'Inventory',             'Accounts Payable',  'Credit Purchase','',    'Ali Traders','PO-005',  ''],
      ['2024-01-20', 'Loan from bank',                      200000, 'Bank',                  'Loan Payable',      'Loan Disbursement','','',            '',         'MCB Business Loan'],
      ['2024-01-21', 'Owner puts in capital',               100000, 'Cash',                  "Owner's Equity",    'Owner Investment','','',            '',         ''],
    ];
    examples.forEach((row, idx) => {
      const r = ws.addRow(row);
      r.eachCell(cell => {
        cell.fill = {
          type: 'pattern', pattern: 'solid',
          fgColor: { argb: idx % 2 === 0 ? 'FFFAFAFA' : 'FFFFFFFF' },
        };
      });
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="vousFin_import_template.xlsx"');
    res.setHeader('Cache-Control', 'no-cache');
    await wb.xlsx.write(res);
    res.end();
  } catch (error) {
    next(error);
  }
};

// ── Allowed MIME types and extensions for Excel/CSV uploads ─────────────────
const ALLOWED_EXCEL_MIMETYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/vnd.ms-excel',                                           // .xls
  'text/csv',
  'application/csv',
  'text/plain',   // some browsers send .csv as text/plain
  'application/octet-stream', // generic binary — rely on extension
]);
const ALLOWED_EXCEL_EXTENSIONS = new Set(['xlsx', 'xls', 'csv']);

/**
 * POST /api/v1/transactions/excel
 * Parse & validate an uploaded Excel file; return a preview without saving.
 */
const uploadExcelPreview = async (req, res, next) => {
  try {
    if (!req.file) {
      throw new ApiError(400, 'Excel file is required. Attach the file as form-data field "file".');
    }

    // ── Security: validate file type ──────────────────────────────────────
    const ext = (req.file.originalname || '').split('.').pop().toLowerCase();
    if (!ALLOWED_EXCEL_EXTENSIONS.has(ext)) {
      throw new ApiError(400, `Unsupported file extension ".${ext}". Please upload .xlsx, .xls, or .csv.`);
    }
    if (req.file.mimetype && !ALLOWED_EXCEL_MIMETYPES.has(req.file.mimetype)) {
      logger.warn(`Excel upload: unexpected MIME type "${req.file.mimetype}" for ${req.file.originalname} — proceeding`);
    }

    const businessId = req.user.businessId;
    logger.info(`Excel upload: "${req.file.originalname}" (${req.file.size} B) by business ${businessId}`);

    // ── Parse file (multi-format: xlsx / xls / csv) ───────────────────────
    const {
      validRows,
      errors,
      duplicatesFound,
      fileInfo,
      confidenceStats,
    } = await parseExcelTransactions(req.file.buffer, businessId, req.file.originalname);

    // ── Resolve account names → IDs (single DB query) ─────────────────────
    const allAccounts = await accountRepository.findByBusiness(businessId);
    const resolve = buildAccountResolver(allAccounts);

    const resolvedRows = [];
    for (const row of validRows) {
      const debit  = resolve(row.debitAccountName);
      const credit = resolve(row.creditAccountName);

      if (!debit) {
        errors.push({
          row:     row.originalRow,
          field:   'debitAccount',
          message: `Debit account not found: "${row.debitAccountName}". Check your Chart of Accounts.`,
        });
        continue;
      }
      if (!credit) {
        errors.push({
          row:     row.originalRow,
          field:   'creditAccount',
          message: `Credit account not found: "${row.creditAccountName}". Check your Chart of Accounts.`,
        });
        continue;
      }
      if (debit._id.toString() === credit._id.toString()) {
        errors.push({
          row:     row.originalRow,
          field:   'general',
          message: `Debit and credit resolved to the same account: "${debit.accountName}"`,
        });
        continue;
      }

      // Downgrade confidence if account was fuzzy-matched
      let rowConf = row.confidenceScore;
      const rowFlags = [...(row.confidenceFlags || [])];
      if (debit.accountName.toLowerCase()  !== row.debitAccountName.toLowerCase())  {
        rowConf  -= 15; rowFlags.push('debit_fuzzy');
      }
      if (credit.accountName.toLowerCase() !== row.creditAccountName.toLowerCase()) {
        rowConf  -= 15; rowFlags.push('credit_fuzzy');
      }
      rowConf = Math.max(0, rowConf);
      const rowConfLabel = rowConf >= 80 ? 'High' : rowConf >= 50 ? 'Medium' : 'Low';

      resolvedRows.push({
        ...row,
        debitAccountId:    debit._id,
        creditAccountId:   credit._id,
        debitAccountName:  debit.accountName,   // normalise to canonical name
        creditAccountName: credit.accountName,
        confidenceScore:   rowConf,
        confidenceLabel:   rowConfLabel,
        confidenceFlags:   rowFlags,
      });
    }

    // ── Re-compute confidence stats after account resolution ─────────────
    const resolvedStats = resolvedRows.reduce(
      (acc, r) => {
        if      (r.confidenceScore >= 80) acc.high++;
        else if (r.confidenceScore >= 50) acc.medium++;
        else                              acc.low++;
        return acc;
      },
      { high: 0, medium: 0, low: 0 }
    );

    logger.info(`Excel preview: ${resolvedRows.length} resolved, ${errors.length} error(s)`);

    ApiResponse.success(res, {
      // Backward-compat fields
      validCount:   resolvedRows.length,
      invalidCount: errors.length,
      validRows:    resolvedRows,
      errors,
      // New fields
      duplicatesFound,
      fileInfo,
      confidenceStats: resolvedStats,
    }, 'Excel preview generated');

  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/v1/transactions/excel/confirm
 * Bulk-save the validated rows that were returned by the preview step.
 */
const confirmExcelImport = async (req, res, next) => {
  try {
    const { rows } = req.body;
    if (!rows || !Array.isArray(rows) || rows.length === 0) {
      throw new ApiError(400, 'No valid rows to import');
    }

    const businessId = req.user.businessId;
    logger.info(`Excel confirm: importing ${rows.length} rows for business ${businessId}`);

    // Pre-load all accounts once for re-validation (accounts may have changed since preview)
    const allAccounts = await accountRepository.findByBusiness(businessId);
    const resolve = buildAccountResolver(allAccounts);

    const transactionsToCreate = [];
    const accountErrors = [];

    for (const row of rows) {
      // Re-resolve by name (authoritative); fall back to the ID from preview if name is missing
      let debitAccountId  = row.debitAccountId;
      let creditAccountId = row.creditAccountId;

      if (row.debitAccountName) {
        const acc = resolve(row.debitAccountName);
        if (!acc) {
          accountErrors.push({ row: row.originalRow, error: `Debit account not found: "${row.debitAccountName}"` });
          continue;
        }
        debitAccountId = acc._id;
      }
      if (row.creditAccountName) {
        const acc = resolve(row.creditAccountName);
        if (!acc) {
          accountErrors.push({ row: row.originalRow, error: `Credit account not found: "${row.creditAccountName}"` });
          continue;
        }
        creditAccountId = acc._id;
      }

      if (!debitAccountId || !creditAccountId) {
        accountErrors.push({ row: row.originalRow, error: 'Could not resolve account IDs' });
        continue;
      }

      transactionsToCreate.push({
        transactionDate:      row.transactionDate,
        description:          row.description,
        transactionType:      row.transactionType      || undefined,
        transactionMode:      row.transactionMode      || undefined,
        amount:               row.amount,
        debitAccountId,
        creditAccountId,
        customerName:         row.customerName         || undefined,
        vendorName:           row.vendorName           || undefined,
        transactionReference: row.transactionReference || undefined,
        notes:                row.notes                || undefined,
        businessId,
        inputMethod:          'excel',
        originalRow:          row.originalRow,
      });
    }

    const results = await transactionService.createBulkTransactions(
      transactionsToCreate,
      req.user.id,
      req.ip
    );

    // Merge account-resolution failures with service-level failures
    results.failed = [...(results.failed || []), ...accountErrors];

    logger.info(`Excel import complete: ${results.successful} saved, ${results.failed.length} failed`);
    ApiResponse.success(res, results, `${results.successful} transactions imported successfully`);
  } catch (error) {
    next(error);
  }
};

/**
 * Get list of transactions with filtering and pagination.
 */
const getTransactions = async (req, res, next) => {
  try {
    const filters = {
      startDate: req.query.startDate,
      endDate: req.query.endDate,
      transactionType: req.query.transactionType,
      minAmount: req.query.minAmount,
      maxAmount: req.query.maxAmount,
      accountId: req.query.accountId,
      customerId: req.query.customerId,
      vendorId: req.query.vendorId,
      status: req.query.status,
      paymentStatus: req.query.paymentStatus,
      hasOutstandingBalance: req.query.hasOutstandingBalance,
      search: req.query.search,
    };
    const pagination = {
      page: parseInt(req.query.page, 10) || 1,
      limit: parseInt(req.query.limit, 10) || 25,
      sortBy: req.query.sortBy || 'transactionDate',
      sortOrder: req.query.sortOrder === 'asc' ? 1 : -1,
    };
    const result = await transactionService.getTransactionHistory(
      req.user.businessId,
      filters,
      pagination
    );
    ApiResponse.success(res, result, 'Transactions retrieved');
  } catch (error) {
    next(error);
  }
};

/**
 * Get a single transaction by ID (with details and audit trail).
 */
const getTransactionById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const transaction = await transactionService.getTransactionById(id, req.user.businessId);
    ApiResponse.success(res, transaction, 'Transaction details retrieved');
  } catch (error) {
    next(error);
  }
};

/**
 * Update an existing transaction.
 */
const updateTransaction = async (req, res, next) => {
  try {
    const { id } = req.params;
    const updateData = req.body;
    const updated = await transactionService.editTransaction(
      id,
      req.user.businessId,
      updateData,
      req.user.id,
      req.ip
    );
    ApiResponse.success(res, updated, 'Transaction updated successfully');
  } catch (error) {
    next(error);
  }
};

/**
 * Delete (reverse) a transaction.
 */
const deleteTransaction = async (req, res, next) => {
  try {
    const { id } = req.params;
    const reversal = await transactionService.deleteTransaction(
      id,
      req.user.businessId,
      req.user.id,
      req.ip
    );
    ApiResponse.success(res, reversal, 'Transaction reversed successfully');
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createFormTransaction,
  recordPayment,
  getOutstandingBalances,
  getSettlementHistory,
  createInstallmentTransaction,
  recordInstallmentPayment,
  processNaturalLanguage,
  confirmNaturalLanguage,
  downloadExcelTemplate,
  uploadExcelPreview,
  confirmExcelImport,
  getTransactions,
  getTransactionById,
  updateTransaction,
  deleteTransaction,
};