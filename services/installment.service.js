// services/installment.service.js
/**
 * InstallmentService — Phase 3 GAAP/IFRS Rewrite
 *
 * Proper accounting treatment for financed asset purchases:
 *
 *   AT PURCHASE DATE (compound journal):
 *     DR  Asset Account          (full purchase price)
 *         CR  Cash / Bank        (down payment, if any)
 *         CR  Loan Payable       (financed amount = total − down payment)
 *
 *   FOR EACH EMI PAYMENT:
 *     DR  Loan Payable           (principal portion)
 *     DR  Interest Expense       (interest portion, if applicable)
 *         CR  Cash / Bank        (total payment)
 *
 * The parent transaction tracks the outstanding loan liability:
 *   paymentStatus  = 'unpaid' (until all EMIs are paid)
 *   remainingBalance = financed amount (decreases with each EMI)
 *
 * For Credit Sale / Credit Purchase installment plans, the original
 * single-entry + recordPartialPayment() path is preserved unchanged.
 */
const installmentPlanRepository = require('../repositories/installmentPlan.repository');
const transactionRepository     = require('../repositories/transaction.repository');
const accountRepository         = require('../repositories/account.repository');
const { ApiError }              = require('../utils/ApiError');
const logger                    = require('../config/logger');
const InstallmentPlan           = require('../models/InstallmentPlan.model');
const {
  TRANSACTION_TYPES,
  TRANSACTION_MODES,
  TRANSACTION_SOURCES,
  PAYMENT_STATUS,
  JOURNAL_STATUS,
  INPUT_METHODS,
} = require('../config/constants');

class InstallmentService {

  /* ──────────────────────────────────────────────────────────────────────── */
  /* createInstallmentPlan                                                    */
  /* ──────────────────────────────────────────────────────────────────────── */

  /**
   * Create an installment plan with a proper GAAP compound journal entry.
   *
   * @param {Object} transactionData   Core transaction fields (businessId, amount, debitAccountId, creditAccountId, …)
   * @param {Object} installmentConfig { downPayment, installmentCount, installmentFrequency, downPaymentAccountId? }
   * @param {string} userId            Creating user's ID
   * @param {string} ipAddress         Client IP (for audit log)
   * @returns {Promise<InstallmentPlan>}
   */
  async createInstallmentPlan(transactionData, installmentConfig, userId, ipAddress) {
    // Dynamic import avoids circular dependency (installment ↔ transaction services)
    const transactionService = require('./transaction.service');

    if (!transactionData.businessId) {
      throw new ApiError(400, 'Business ID is required');
    }

    const downPayment    = Number(installmentConfig.downPayment    || 0);
    const totalAmount    = Number(transactionData.amount);
    const financedAmount = totalAmount - downPayment;

    if (downPayment < 0) {
      throw new ApiError(400, 'Down payment cannot be negative');
    }
    if (financedAmount < 0) {
      throw new ApiError(400, 'Down payment cannot exceed total amount');
    }

    const installmentCount = Number(installmentConfig.installmentCount || 0);
    if (!installmentCount || installmentCount < 1) {
      throw new ApiError(400, 'Installment count must be at least 1');
    }

    // ── Determine transaction type ──────────────────────────────────────────
    let txType;
    if (transactionData.customerId) {
      txType = TRANSACTION_TYPES.CREDIT_SALE;
    } else if (transactionData.vendorId) {
      txType = TRANSACTION_TYPES.CREDIT_PURCHASE;
    } else {
      txType = transactionData.transactionType || TRANSACTION_TYPES.ASSET_PURCHASE;
    }

    let parentTx;

    /* ── GAAP/IFRS path: financed asset purchase ─────────────────────────── */
    if (txType === TRANSACTION_TYPES.ASSET_PURCHASE && financedAmount > 0) {
      parentTx = await this._createFinancedAssetPurchase(
        transactionData,
        installmentConfig,
        totalAmount,
        downPayment,
        financedAmount,
        transactionService,
        userId,
        ipAddress
      );
    } else {
      /* ── Standard path: Credit Sale / Credit Purchase ─────────────────── */
      transactionData.transactionType = txType;
      transactionData.dueDate         = transactionData.transactionDate || new Date();
      parentTx = await transactionService.createTransaction(transactionData, userId, ipAddress);
    }

    // ── Generate EMI amortization schedule (Phase B) ────────────────────────
    const amountToFinance = txType === TRANSACTION_TYPES.ASSET_PURCHASE ? financedAmount : totalAmount - downPayment;
    const interestRate    = Number(installmentConfig.interestRate || 0);
    const frequency       = installmentConfig.installmentFrequency || 'monthly';
    const interestMethod  = installmentConfig.interestMethod || 'reducing_balance';

    // buildAmortization computes per-row principal/interest split and validates inputs.
    // If firstPaymentDate is provided, anchor the schedule one period before it so
    // the first row's dueDate lands exactly on firstPaymentDate (advanceDate adds 1 period).
    const startAnchor = (() => {
      if (installmentConfig.firstPaymentDate) {
        // Walk back one period from firstPaymentDate to use as the anchor
        const fpd = new Date(installmentConfig.firstPaymentDate);
        const freq = frequency;
        if (freq === 'weekly')         fpd.setDate(fpd.getDate() - 7);
        else if (freq === 'biweekly')  fpd.setDate(fpd.getDate() - 14);
        else if (freq === 'quarterly') fpd.setMonth(fpd.getMonth() - 3);
        else                           fpd.setMonth(fpd.getMonth() - 1);
        return fpd;
      }
      return transactionData.transactionDate || new Date();
    })();

    const { schedule, installmentAmount, totalInterest } = InstallmentPlan.buildAmortization({
      startDate:     startAnchor,
      principal:     amountToFinance,
      count:         installmentCount,
      frequency,
      annualRatePct: interestRate,
      method:        interestMethod,
    });

    // ── Create the InstallmentPlan document ────────────────────────────────
    const plan = await installmentPlanRepository.create({
      businessId:            transactionData.businessId,
      linkedTransactionId:   parentTx._id,
      customerId:            transactionData.customerId || null,
      vendorId:              transactionData.vendorId   || null,
      totalAmount,
      downPayment,
      remainingAmount:       amountToFinance,
      installmentCount,
      installmentFrequency:  frequency,
      installmentAmount,
      nextDueDate:           schedule[0]?.dueDate || null,
      status:                'active',
      paidInstallments:      0,
      remainingInstallments: installmentCount,
      schedule,
      // Interest / financing metadata (Phase 3 + B)
      interestRate:        interestRate > 0 ? interestRate : null,
      interestMethod,
      principalAmount:     amountToFinance,
      outstandingPrincipal:amountToFinance,
      totalInterest:       totalInterest > 0 ? totalInterest : null,
      overdueStatus:       'current',
    });

    // ── Link plan back to parent transaction ───────────────────────────────
    await transactionRepository.updateTransaction(parentTx._id, transactionData.businessId, {
      installmentPlanId: plan._id,
    });

    // ── For Credit Sale / Purchase: record the down payment via settlement ─
    // (For Asset Purchase the downpayment is already captured in the journal lines
    //  — recording it again would double-count the cash outflow.)
    //
    // BUG FIX (Phase A): previously this branch also did
    //   plan.remainingAmount = Math.max(0, plan.remainingAmount - downPayment);
    // which double-decremented the financed amount, because plan.remainingAmount
    // was already initialised to (totalAmount − downPayment). The downpayment is
    // applied against the PARENT's remainingBalance by recordPartialPayment, and
    // the PLAN's remainingAmount should stay at the financed total — it represents
    // the EMI schedule, not the parent invoice.
    if (txType !== TRANSACTION_TYPES.ASSET_PURCHASE && downPayment > 0) {
      const paymentAccountId = transactionData.creditAccountId;
      await transactionService.recordPartialPayment(
        parentTx._id,
        transactionData.businessId,
        {
          amount:          downPayment,
          paymentAccountId,
          transactionDate: transactionData.transactionDate || new Date(),
          description:     `Down payment for plan ${plan._id}`,
        },
        userId,
        ipAddress
      );
      // NOTE: do NOT subtract downPayment from plan.remainingAmount again — it is
      // already the post-downpayment financed total. EMI payments will decrement it.
    }

    logger.info(`Installment plan created [${plan._id}] for business ${transactionData.businessId}`);
    return plan;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /* _createFinancedAssetPurchase (private)                                  */
  /* ──────────────────────────────────────────────────────────────────────── */

  /**
   * Build the compound journal for a financed asset purchase and save it.
   *
   * Journal:
   *   DR  Asset Account       totalAmount
   *       CR  Cash / Bank     downPayment     (only when downPayment > 0)
   *       CR  Loan Payable    financedAmount
   *
   * @private
   */
  async _createFinancedAssetPurchase(
    transactionData,
    installmentConfig,
    totalAmount,
    downPayment,
    financedAmount,
    transactionService,
    userId,
    ipAddress
  ) {
    const { businessId } = transactionData;

    // 1. Look up Loan Payable (must exist — seeded by default accounts migration)
    const loanPayableAccount = await accountRepository.findByBusinessAndName(
      businessId,
      'Loan Payable'
    );
    if (!loanPayableAccount) {
      throw new ApiError(
        400,
        'Loan Payable account not found. Run: node migrations/add_missing_accounts.js'
      );
    }

    // 2. Resolve cash account for down payment (three-tier priority)
    let cashAccountId = null;
    if (downPayment > 0) {
      // Priority 1 — caller supplies explicit account
      if (installmentConfig.downPaymentAccountId) {
        cashAccountId = installmentConfig.downPaymentAccountId;

      } else if (transactionData.creditAccountId) {
        // Priority 2 — check if creditAccountId is a Bank and Cash account
        const acct = await accountRepository.findOneByBusinessAndId(
          businessId,
          transactionData.creditAccountId
        );
        if (acct && acct.accountSubtype === 'Bank and Cash') {
          cashAccountId = transactionData.creditAccountId;
        }
      }

      // Priority 3 — default to 'Cash at Bank'
      if (!cashAccountId) {
        const defaultCash = await accountRepository.findByBusinessAndName(
          businessId,
          'Cash at Bank'
        );
        cashAccountId = defaultCash?._id || null;
      }

      if (!cashAccountId) {
        throw new ApiError(
          400,
          'Cash/bank account not found for down payment recording. ' +
          'Ensure a Cash at Bank account exists in your Chart of Accounts.'
        );
      }
    }

    // 3. Build journal lines
    const journalLines = [];

    // Line 1: DR Asset (full purchase price)
    journalLines.push({
      accountId:   transactionData.debitAccountId,
      type:        'debit',
      amount:      totalAmount,
      description: `Asset acquisition — ${transactionData.description}`,
    });

    // Line 2: CR Cash (down payment) — only when downPayment > 0
    if (downPayment > 0) {
      journalLines.push({
        accountId:   cashAccountId,
        type:        'credit',
        amount:      downPayment,
        description: `Down payment — ${transactionData.description}`,
      });
    }

    // Line 3: CR Loan Payable (financed amount)
    journalLines.push({
      accountId:   loanPayableAccount._id,
      type:        'credit',
      amount:      financedAmount,
      description: `Loan created — ${transactionData.description}`,
    });

    // 4. Sanity check: Σ(DR) must equal Σ(CR)
    const sumDebits  = journalLines.filter(l => l.type === 'debit' ).reduce((s, l) => s + l.amount, 0);
    const sumCredits = journalLines.filter(l => l.type === 'credit').reduce((s, l) => s + l.amount, 0);
    if (Math.abs(sumDebits - sumCredits) > 0.01) {
      throw new ApiError(400, `Journal is unbalanced: DR ${sumDebits} ≠ CR ${sumCredits}`);
    }

    // 5. Primary 1:1 pair (required by JournalEntry schema for backward compatibility)
    //    debitAccountId  = Asset (first / only debit line)
    //    creditAccountId = Cash (when downPayment > 0) | Loan Payable (zero-down)
    const primaryCreditId = downPayment > 0 ? cashAccountId : loanPayableAccount._id;

    // 6. Assemble parent transaction data
    //    Explicitly set paymentStatus + remainingBalance so transaction.service.js
    //    persists them (the Asset Purchase branch does NOT set these defaults).
    const parentData = {
      ...transactionData,
      transactionType:     TRANSACTION_TYPES.ASSET_PURCHASE,
      transactionMode:     TRANSACTION_MODES.INSTALLMENT,
      transactionSource:   TRANSACTION_SOURCES.INSTALLMENT_ENGINE,
      // Override with new 3-line journal (replaces any 2-line NLP preview lines)
      journalLines,
      // Primary 1:1 accounts
      debitAccountId:      transactionData.debitAccountId,
      creditAccountId:     primaryCreditId,
      // Liability tracking: remainingBalance = outstanding loan principal
      paymentStatus:       financedAmount > 0 ? PAYMENT_STATUS.UNPAID : PAYMENT_STATUS.PAID,
      remainingBalance:    financedAmount,
      partiallyPaidAmount: 0,           // EMIs haven't started yet
      dueDate:             transactionData.transactionDate || new Date(),
      // Reporting: only the downpayment hits cash flow; liability creation is non-cash
      affectsCashFlow:    downPayment > 0,
      affectsBalanceSheet: true,
      affectsProfitLoss:   false,       // asset capitalised, not expensed
    };

    const parentTx = await transactionService.createTransaction(parentData, userId, ipAddress);
    logger.info(`Financed asset purchase journal created: ${parentTx._id}`);
    return parentTx;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /* recordInstallmentPayment                                                 */
  /* ──────────────────────────────────────────────────────────────────────── */

  /**
   * Record an EMI payment against an installment plan.
   *
   * For Asset Purchase plans (loan repayment):
   *   DR  Loan Payable     (principal portion = payment − interest)
   *   DR  Interest Expense (interest portion, optional — pass interestAmount in paymentData)
   *       CR  Cash / Bank  (total payment)
   *
   * For Credit Sale / Purchase plans:
   *   Delegates to transactionService.recordPartialPayment() (unchanged).
   *
   * @param {string} planId       InstallmentPlan document _id
   * @param {string} businessId   Business _id
   * @param {Object} paymentData  { amount, paymentAccountId, transactionDate?, description?, interestAmount? }
   * @param {string} userId
   * @param {string} ipAddress
   * @returns {Promise<InstallmentPlan>}
   */
  async recordInstallmentPayment(planId, businessId, paymentData, userId, ipAddress) {
    const transactionService = require('./transaction.service');

    const plan = await installmentPlanRepository.findByIdAndBusiness(planId, businessId);
    if (!plan) throw new ApiError(404, 'Installment plan not found');
    if (plan.status === 'completed') throw new ApiError(400, 'Installment plan is already completed');

    // Fetch linked parent to decide which accounting path to use.
    // plan.linkedTransactionId may be a populated doc (object with ._id) or a raw ObjectId.
    const linkedTxId = plan.linkedTransactionId?._id || plan.linkedTransactionId;
    const parent = await transactionRepository.findByIdWithDetails(linkedTxId, businessId);
    if (!parent) throw new ApiError(404, 'Linked parent transaction not found');

    let childTx;

    if (parent.transactionType === TRANSACTION_TYPES.ASSET_PURCHASE) {
      // ── EMI against asset loan ──────────────────────────────────────────
      childTx = await this._recordAssetLoanPayment(
        plan,
        parent,
        businessId,
        paymentData,
        transactionService,
        userId,
        ipAddress
      );
    } else {
      // ── Standard Credit Sale / Credit Purchase settlement ───────────────
      childTx = await transactionService.recordPartialPayment(
        linkedTxId,
        businessId,
        {
          amount:          paymentData.amount,
          paymentAccountId: paymentData.paymentAccountId,
          transactionDate: paymentData.transactionDate || new Date(),
          description:     paymentData.description || `Installment payment for plan ${plan._id}`,
        },
        userId,
        ipAddress
      );
    }

    // Update the plan schedule (mark next unpaid item)
    plan.recordPayment(paymentData.amount, childTx._id);
    await plan.save();

    logger.info(`Payment of ${paymentData.amount} recorded for installment plan ${planId}`);
    return plan;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /* _recordAssetLoanPayment (private)                                        */
  /* ──────────────────────────────────────────────────────────────────────── */

  /**
   * Record an EMI against an Asset Purchase installment plan.
   *
   * Journal (with optional interest split):
   *   DR  Loan Payable      principal
   *   DR  Interest Expense  interest    (only when interestAmount > 0)
   *       CR  Cash / Bank   total EMI
   *
   * @private
   */
  async _recordAssetLoanPayment(plan, parent, businessId, paymentData, transactionService, userId, ipAddress) {
    const totalPayment = Number(paymentData.amount);

    if (totalPayment <= 0) {
      throw new ApiError(400, 'Payment amount must be greater than zero');
    }

    const paymentAccountId = paymentData.paymentAccountId;
    if (!paymentAccountId) {
      throw new ApiError(400, 'paymentAccountId (cash/bank account) is required for EMI payment');
    }

    // ── Phase B: Auto-allocate principal/interest from the active schedule row ──
    // The caller may still override by passing explicit interestAmount (e.g. for
    // early repayment / partial payment scenarios where the user manually splits).
    let interestAmount, principalAmount;
    if (paymentData.interestAmount != null && Number(paymentData.interestAmount) >= 0) {
      // Explicit override
      interestAmount  = Number(paymentData.interestAmount);
      principalAmount = totalPayment - interestAmount;
      if (principalAmount < 0) {
        throw new ApiError(400, 'Interest amount cannot exceed total payment amount');
      }
    } else {
      // Auto-derive from the active schedule row's outstanding split
      const activeRow = typeof plan.getActiveScheduleRow === 'function'
        ? plan.getActiveScheduleRow()
        : plan.schedule.find(
            (r) => r.status === 'unpaid' || r.status === 'partially_paid'
          );
      if (activeRow) {
        const interestOutstanding  = Math.max(0, (activeRow.interestDue  || 0) - (activeRow.paidInterest  || 0));
        const principalOutstanding = Math.max(0, (activeRow.principalDue || 0) - (activeRow.paidPrincipal || 0));
        // Interest-first allocation (standard waterfall)
        interestAmount  = Math.min(totalPayment, interestOutstanding);
        const afterInterest = totalPayment - interestAmount;
        principalAmount = Math.min(afterInterest, principalOutstanding);
        // If payment exceeds row's outstanding total, spill the rest to principal
        // (it will roll into the next row via plan.recordPayment)
        const allocated = interestAmount + principalAmount;
        if (totalPayment > allocated) {
          principalAmount += (totalPayment - allocated);
        }
        // Round to cents
        interestAmount  = Math.round(interestAmount  * 100) / 100;
        principalAmount = Math.round(principalAmount * 100) / 100;
      } else {
        // No schedule row available — treat full payment as principal
        interestAmount  = 0;
        principalAmount = totalPayment;
      }
    }

    // Look up Loan Payable
    const loanPayableAccount = await accountRepository.findByBusinessAndName(businessId, 'Loan Payable');
    if (!loanPayableAccount) {
      throw new ApiError(400, 'Loan Payable account not found');
    }

    // Look up Interest Expense (only needed when interest > 0)
    let interestExpenseAccount = null;
    if (interestAmount > 0) {
      interestExpenseAccount = await accountRepository.findByBusinessAndName(businessId, 'Interest Expense');
      if (!interestExpenseAccount) {
        throw new ApiError(400, 'Interest Expense account not found');
      }
    }

    // Build journal lines
    const journalLines = [];

    if (principalAmount > 0) {
      journalLines.push({
        accountId:   loanPayableAccount._id,
        type:        'debit',
        amount:      principalAmount,
        description: `Loan principal — plan ${plan._id}`,
      });
    }
    if (interestAmount > 0) {
      journalLines.push({
        accountId:   interestExpenseAccount._id,
        type:        'debit',
        amount:      interestAmount,
        description: `Loan interest expense — plan ${plan._id}`,
      });
    }
    journalLines.push({
      accountId:   paymentAccountId,
      type:        'credit',
      amount:      totalPayment,
      description: `EMI payment — plan ${plan._id}`,
    });

    // Create the EMI child transaction
    const emiData = {
      businessId,
      transactionDate:     paymentData.transactionDate || new Date(),
      description:         paymentData.description || `Installment payment — ${parent.description}`,
      transactionType:     TRANSACTION_TYPES.INSTALLMENT_PAYMENT,
      transactionMode:     TRANSACTION_MODES.PARTIAL_SETTLEMENT,
      transactionSource:   TRANSACTION_SOURCES.INSTALLMENT_ENGINE,
      amount:              totalPayment,
      // Primary 1:1 pair (backward compatible)
      debitAccountId:      loanPayableAccount._id,
      creditAccountId:     paymentAccountId,
      // Multi-line lines
      journalLines,
      parentTransactionId: parent._id,
      installmentPlanId:   plan._id,
      inputMethod:         paymentData.inputMethod || INPUT_METHODS.FORM,
    };

    const childTx = await transactionService.createTransaction(emiData, userId, ipAddress);

    // Update parent's outstanding loan balance
    const prevRemaining       = parent.remainingBalance || 0;
    const newRemainingBalance = Math.max(0, prevRemaining - principalAmount);
    const newPartiallyPaid    = (parent.partiallyPaidAmount || 0) + totalPayment;
    const isFullyPaid         = newRemainingBalance <= 0;

    await transactionRepository.updateTransaction(parent._id, businessId, {
      remainingBalance:    newRemainingBalance,
      partiallyPaidAmount: newPartiallyPaid,
      paymentStatus:       isFullyPaid ? PAYMENT_STATUS.PAID          : PAYMENT_STATUS.PARTIALLY_PAID,
      status:              isFullyPaid ? JOURNAL_STATUS.SETTLED        : JOURNAL_STATUS.PARTIALLY_SETTLED,
      $push: {
        relatedTransactions: childTx._id,
        settlements: {
          transactionId: childTx._id,
          amount:        totalPayment,
          date:          paymentData.transactionDate || new Date(),
        },
      },
    });

    // Update plan's accumulated interest paid
    if (interestAmount > 0) {
      plan.totalInterestPaid = (plan.totalInterestPaid || 0) + interestAmount;
      // don't save here — caller saves after recordPayment()
    }

    return childTx;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /* Read methods (unchanged)                                                 */
  /* ──────────────────────────────────────────────────────────────────────── */

  async getInstallmentPlan(planId, businessId) {
    const plan = await installmentPlanRepository.findByIdAndBusiness(planId, businessId);
    if (!plan) throw new ApiError(404, 'Installment plan not found');
    return plan;
  }

  async getInstallmentsByBusiness(businessId, filters = {}) {
    if (!businessId) throw new ApiError(400, 'Business ID is required');
    return installmentPlanRepository.findByBusiness(businessId, filters);
  }

  async getOverduePlans(businessId) {
    if (!businessId) throw new ApiError(400, 'Business ID is required');
    return installmentPlanRepository.getOverduePlans(businessId);
  }

  /**
   * Refresh overdueStatus for all active plans of a business.
   * Lightweight scan — call from a daily cron or on demand from the UI.
   * Does not generate any journal entries.
   *
   * @param {string} businessId
   * @returns {Promise<{ scanned: number, updated: number }>}
   */
  async refreshOverdueStatuses(businessId) {
    if (!businessId) throw new ApiError(400, 'Business ID is required');
    const plans = await InstallmentPlan.find({
      businessId,
      status: { $in: ['active', 'overdue', 'restructured'] },
    });
    let updated = 0;
    for (const plan of plans) {
      const before = plan.overdueStatus;
      plan.refreshOverdueStatus();

      // Sync plan-level status with overdueStatus for easier filtering
      if (plan.overdueStatus === 'defaulted' && plan.status === 'active') {
        plan.status = INSTALLMENT_STATUS.DEFAULTED;
      } else if (plan.overdueStatus === 'overdue' && plan.status === 'active') {
        plan.status = INSTALLMENT_STATUS.OVERDUE;
      }

      if (plan.overdueStatus !== before || plan.isModified('status')) {
        await plan.save();
        updated++;
      }
    }
    return { scanned: plans.length, updated };
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /* accrueInstallmentPenalty                                                 */
  /* ──────────────────────────────────────────────────────────────────────── */

  /**
   * Accrue late-payment penalties on a single installment plan.
   *
   * For each overdue unpaid row, computes penalty based on:
   *   - plan.penaltyRate (annual %) OR opts.flatPenaltyPerRow (fixed amount)
   *   - Days past due for prorated calculation
   *
   * Accounting:
   *   Customer plan (customerId set):
   *     DR  Accounts Receivable        penaltyAmount
   *         CR  Penalty Income         penaltyAmount
   *
   *   Vendor plan (vendorId set) / loan:
   *     DR  Penalty Expense            penaltyAmount
   *         CR  Accounts Payable       penaltyAmount
   *
   * @param {string}  planId
   * @param {string}  businessId
   * @param {Object}  opts
   * @param {number}  [opts.flatPenaltyPerRow]  - fixed amount per overdue row (overrides rate)
   * @param {number}  [opts.annualPenaltyRate]  - annual % rate (overrides plan.penaltyRate)
   * @param {string}  userId
   * @param {string}  ipAddress
   * @returns {Promise<{ plan: InstallmentPlan, penaltiesApplied: Array, totalPenalty: number }>}
   */
  async accrueInstallmentPenalty(planId, businessId, opts = {}, userId, ipAddress) {
    const transactionService = require('./transaction.service');

    const plan = await installmentPlanRepository.findByIdAndBusiness(planId, businessId);
    if (!plan) throw new ApiError(404, 'Installment plan not found');

    const activeStatuses = ['active', 'overdue', 'restructured', 'defaulted'];
    if (!activeStatuses.includes(plan.status)) {
      throw new ApiError(400, `Cannot accrue penalty on a plan with status "${plan.status}"`);
    }

    const now         = new Date();
    const penaltyRate = opts.annualPenaltyRate ?? plan.penaltyRate ?? 0;
    const flatPerRow  = opts.flatPenaltyPerRow ?? null;
    const round2      = (n) => Math.round(n * 100) / 100;

    // ── Determine accounting accounts ────────────────────────────────────
    const isCustomerPlan = !!plan.customerId;
    const isVendorPlan   = !!plan.vendorId;

    const debitAcctName  = isCustomerPlan ? 'Accounts Receivable' : 'Penalty Expense';
    const creditAcctName = isCustomerPlan ? 'Penalty Income'       : 'Accounts Payable';

    const debitAcct  = await accountRepository.findByBusinessAndName(businessId, debitAcctName);
    const creditAcct = await accountRepository.findByBusinessAndName(businessId, creditAcctName);

    // Graceful fallback if Penalty Income / Penalty Expense accounts don't exist yet
    if (!debitAcct)  throw new ApiError(400, `Account "${debitAcctName}" not found in Chart of Accounts`);
    if (!creditAcct) throw new ApiError(400, `Account "${creditAcctName}" not found in Chart of Accounts`);

    // ── Find overdue rows ────────────────────────────────────────────────
    const overdueRows = plan.schedule.filter(
      (row) =>
        (row.status === PAYMENT_STATUS.UNPAID || row.status === PAYMENT_STATUS.PARTIALLY_PAID) &&
        row.dueDate < now
    );

    if (overdueRows.length === 0) {
      return { plan, penaltiesApplied: [], totalPenalty: 0 };
    }

    const penaltiesApplied = [];
    let totalPenalty       = 0;

    for (const row of overdueRows) {
      // Calculate penalty for this row
      let penaltyAmount;
      if (flatPerRow != null && flatPerRow > 0) {
        penaltyAmount = round2(flatPerRow);
      } else if (penaltyRate > 0) {
        const daysLate   = Math.max(1, Math.floor((now - new Date(row.dueDate)) / (1000 * 60 * 60 * 24)));
        const rowBalance = round2(
          Math.max(0, (row.principalDue || 0) - (row.paidPrincipal || 0))
        );
        penaltyAmount = round2(rowBalance * (penaltyRate / 100) * (daysLate / 365));
      } else {
        continue; // No penalty configured
      }

      if (penaltyAmount <= 0) continue;

      // Create journal entry for this penalty
      const penaltyTx = await transactionService.createTransaction(
        {
          businessId,
          transactionDate:   now,
          description:       `Late payment penalty — installment #${row.installmentNumber} (plan ${plan._id})`,
          transactionType:   TRANSACTION_TYPES.JOURNAL_ENTRY,
          amount:            penaltyAmount,
          debitAccountId:    debitAcct._id,
          creditAccountId:   creditAcct._id,
          parentTransactionId: plan.linkedTransactionId,
          installmentPlanId: plan._id,
          notes:             `Penalty for EMI #${row.installmentNumber} due ${row.dueDate.toISOString().slice(0, 10)}`,
        },
        userId,
        ipAddress
      );

      // Update plan row
      plan.applyPenaltyToRow(row._id, penaltyAmount);
      totalPenalty += penaltyAmount;

      penaltiesApplied.push({
        installmentNumber: row.installmentNumber,
        dueDate:           row.dueDate,
        penaltyAmount,
        transactionId:     penaltyTx._id,
      });
    }

    // Refresh overdue status & save
    plan.refreshOverdueStatus();
    await plan.save();

    logger.info(
      `Penalties accrued on plan ${planId}: ${penaltiesApplied.length} rows, total ${totalPenalty}`
    );
    return { plan, penaltiesApplied, totalPenalty: round2(totalPenalty) };
  }

  /**
   * Accrue penalties across ALL overdue plans for a business.
   * Designed for cron-job invocation (daily penalty run).
   *
   * @param {string}  businessId
   * @param {Object}  opts        - same as accrueInstallmentPenalty opts
   * @param {string}  userId
   * @param {string}  ipAddress
   * @returns {Promise<{ plansProcessed: number, totalPenalty: number, errors: Array }>}
   */
  async accrueAllPenalties(businessId, opts = {}, userId, ipAddress) {
    if (!businessId) throw new ApiError(400, 'Business ID is required');

    const now          = new Date();
    const overduePlans = await InstallmentPlan.find({
      businessId,
      status:      { $in: ['active', 'overdue', 'restructured', 'defaulted'] },
      nextDueDate: { $lt: now },
    });

    let plansProcessed = 0;
    let totalPenalty   = 0;
    const errors       = [];

    for (const plan of overduePlans) {
      try {
        const result = await this.accrueInstallmentPenalty(
          plan._id.toString(),
          businessId,
          opts,
          userId,
          ipAddress
        );
        if (result.totalPenalty > 0) {
          plansProcessed++;
          totalPenalty += result.totalPenalty;
        }
      } catch (err) {
        logger.error(`Penalty accrual failed for plan ${plan._id}: ${err.message}`);
        errors.push({ planId: plan._id.toString(), error: err.message });
      }
    }

    return {
      plansProcessed,
      totalPenalty: Math.round(totalPenalty * 100) / 100,
      errors,
    };
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /* restructurePlan                                                          */
  /* ──────────────────────────────────────────────────────────────────────── */

  /**
   * Restructure an installment plan mid-term.
   * Rebuilds the unpaid portion of the schedule with new terms.
   * Preserves all paid rows for audit trail.
   *
   * No new journal entries are created — the liability account balance remains
   * unchanged; only the repayment cadence changes.
   *
   * @param {string}  planId
   * @param {string}  businessId
   * @param {Object}  newConfig
   * @param {number}  newConfig.installmentCount        - remaining number of EMIs
   * @param {string}  [newConfig.installmentFrequency]  - new frequency
   * @param {number}  [newConfig.interestRate]          - new annual rate %
   * @param {string}  [newConfig.interestMethod]        - 'reducing_balance' | 'flat'
   * @param {Date}    [newConfig.firstPaymentDate]      - anchor for new schedule
   * @param {string}  [newConfig.reason]                - free-text reason for audit
   * @param {string}  userId
   * @param {string}  ipAddress
   * @returns {Promise<InstallmentPlan>}
   */
  async restructurePlan(planId, businessId, newConfig, userId, ipAddress) {
    const plan = await installmentPlanRepository.findByIdAndBusiness(planId, businessId);
    if (!plan) throw new ApiError(404, 'Installment plan not found');

    const allowedStatuses = ['active', 'overdue', 'defaulted', 'restructured'];
    if (!allowedStatuses.includes(plan.status)) {
      throw new ApiError(400, `Cannot restructure plan with status "${plan.status}"`);
    }

    const {
      installmentCount,
      installmentFrequency,
      interestRate,
      interestMethod,
      firstPaymentDate,
      reason,
    } = newConfig;

    if (!installmentCount || installmentCount < 1) {
      throw new ApiError(400, 'installmentCount must be ≥ 1');
    }

    // Compute start anchor for new schedule
    const frequency = installmentFrequency || plan.installmentFrequency;
    const startAnchor = (() => {
      if (firstPaymentDate) {
        const fpd = new Date(firstPaymentDate);
        if (frequency === 'weekly')         fpd.setDate(fpd.getDate() - 7);
        else if (frequency === 'biweekly')  fpd.setDate(fpd.getDate() - 14);
        else if (frequency === 'quarterly') fpd.setMonth(fpd.getMonth() - 3);
        else                                fpd.setMonth(fpd.getMonth() - 1);
        return fpd;
      }
      return new Date();
    })();

    // Invoke model method (builds new schedule, logs history)
    const { newEMI, newTotalInterest } = plan.restructure({
      count:         installmentCount,
      frequency,
      annualRatePct: interestRate != null ? Number(interestRate) : (plan.interestRate || 0),
      method:        interestMethod || plan.interestMethod || 'reducing_balance',
      startDate:     startAnchor,
      reason:        reason || null,
    });

    await plan.save();

    logger.info(
      `Plan ${planId} restructured → ${installmentCount} EMIs × ${newEMI}, rate ${interestRate ?? plan.interestRate}%`
    );
    return plan;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /* settleEarly                                                              */
  /* ──────────────────────────────────────────────────────────────────────── */

  /**
   * Record an early settlement of an installment plan.
   *
   * Accounting (asset loan):
   *   DR  Loan Payable         outstandingPrincipal
   *       CR  Cash / Bank      (outstandingPrincipal − discount)
   *       CR  Settlement Discount Income  discount  [only when discount > 0]
   *
   * Accounting (credit sale — receiving payment):
   *   DR  Cash / Bank          (outstandingBalance − discount)
   *   DR  Settlement Discount Expense  discount    [only when discount > 0]
   *       CR  Accounts Receivable      outstandingBalance
   *
   * @param {string}  planId
   * @param {string}  businessId
   * @param {Object}  paymentData
   * @param {number}  paymentData.amount             - actual cash paid (after discount)
   * @param {number}  [paymentData.discountAmount]   - waived amount
   * @param {string}  paymentData.paymentAccountId   - cash/bank account
   * @param {Date}    [paymentData.transactionDate]
   * @param {string}  [paymentData.description]
   * @param {string}  userId
   * @param {string}  ipAddress
   * @returns {Promise<{ plan: InstallmentPlan, settlementTx: Object }>}
   */
  async settleEarly(planId, businessId, paymentData, userId, ipAddress) {
    const transactionService = require('./transaction.service');

    const plan = await installmentPlanRepository.findByIdAndBusiness(planId, businessId);
    if (!plan) throw new ApiError(404, 'Installment plan not found');

    const allowedStatuses = ['active', 'overdue', 'defaulted', 'restructured'];
    if (!allowedStatuses.includes(plan.status)) {
      throw new ApiError(400, `Cannot settle plan with status "${plan.status}"`);
    }

    const round2         = (n) => Math.round(n * 100) / 100;
    const cashPaid       = round2(Number(paymentData.amount || 0));
    const discountAmount = round2(Number(paymentData.discountAmount || 0));
    const settledDate    = paymentData.transactionDate ? new Date(paymentData.transactionDate) : new Date();

    if (cashPaid <= 0) {
      throw new ApiError(400, 'Payment amount must be greater than zero');
    }
    if (!paymentData.paymentAccountId) {
      throw new ApiError(400, 'paymentAccountId (cash/bank) is required');
    }

    // Outstanding principal (loan) or outstanding balance (AR)
    const outstanding = round2(plan.outstandingPrincipal || plan.remainingAmount || 0);
    const expectedCash = round2(outstanding - discountAmount);
    if (Math.abs(cashPaid - expectedCash) > 0.02) {
      throw new ApiError(
        400,
        `Payment amount ${cashPaid} does not match outstanding ${outstanding} − discount ${discountAmount} = ${expectedCash}`
      );
    }

    const linkedTxId = plan.linkedTransactionId?._id || plan.linkedTransactionId;
    const parent     = await transactionRepository.findByIdWithDetails(linkedTxId, businessId);
    if (!parent) throw new ApiError(404, 'Linked parent transaction not found');

    const isAssetLoan    = parent.transactionType === TRANSACTION_TYPES.ASSET_PURCHASE;
    const isCustomerPlan = !!plan.customerId;

    // ── Look up accounts ────────────────────────────────────────────────
    const paymentAcct = paymentData.paymentAccountId;

    let loanPayableAcct = null, arAcct = null, discountAcct = null;

    if (isAssetLoan) {
      loanPayableAcct = await accountRepository.findByBusinessAndName(businessId, 'Loan Payable');
      if (!loanPayableAcct) throw new ApiError(400, 'Loan Payable account not found');
      if (discountAmount > 0) {
        discountAcct = await accountRepository.findByBusinessAndName(businessId, 'Settlement Discount Income');
        if (!discountAcct) {
          // Fallback to Other Income
          discountAcct = await accountRepository.findByBusinessAndName(businessId, 'Other Income');
        }
      }
    } else if (isCustomerPlan) {
      arAcct = await accountRepository.findByBusinessAndName(businessId, 'Accounts Receivable');
      if (!arAcct) throw new ApiError(400, 'Accounts Receivable account not found');
      if (discountAmount > 0) {
        discountAcct = await accountRepository.findByBusinessAndName(businessId, 'Settlement Discount Expense');
        if (!discountAcct) {
          discountAcct = await accountRepository.findByBusinessAndName(businessId, 'Other Expense');
        }
      }
    }

    // ── Build journal lines ──────────────────────────────────────────────
    const journalLines = [];
    const txDesc = paymentData.description || `Early settlement — ${parent.description}`;

    if (isAssetLoan) {
      // DR Loan Payable (full outstanding)
      journalLines.push({ accountId: loanPayableAcct._id, type: 'debit', amount: outstanding, description: 'Loan payable cleared' });
      // CR Cash (actual payment)
      journalLines.push({ accountId: paymentAcct, type: 'credit', amount: cashPaid, description: 'Early settlement payment' });
      // CR Settlement Discount Income (if applicable)
      if (discountAmount > 0 && discountAcct) {
        journalLines.push({ accountId: discountAcct._id, type: 'credit', amount: discountAmount, description: 'Early settlement discount granted' });
      }
    } else if (isCustomerPlan) {
      // DR Cash (payment received)
      journalLines.push({ accountId: paymentAcct, type: 'debit', amount: cashPaid, description: 'Early settlement received' });
      // DR Settlement Discount Expense (if applicable)
      if (discountAmount > 0 && discountAcct) {
        journalLines.push({ accountId: discountAcct._id, type: 'debit', amount: discountAmount, description: 'Early settlement discount allowed' });
      }
      // CR Accounts Receivable (full outstanding)
      journalLines.push({ accountId: arAcct._id, type: 'credit', amount: outstanding, description: 'AR cleared by early settlement' });
    } else {
      // Vendor / unclassified plan — simple cash payment
      journalLines.push({ accountId: paymentAcct, type: 'debit', amount: cashPaid, description: 'Early settlement payment' });
      journalLines.push({ accountId: paymentAcct, type: 'credit', amount: cashPaid, description: 'Early settlement contra' });
    }

    // Validate balance
    const sumDR = journalLines.filter(l => l.type === 'debit' ).reduce((s, l) => s + l.amount, 0);
    const sumCR = journalLines.filter(l => l.type === 'credit').reduce((s, l) => s + l.amount, 0);
    if (Math.abs(sumDR - sumCR) > 0.02) {
      throw new ApiError(500, `Early settlement journal unbalanced: DR ${sumDR} ≠ CR ${sumCR}`);
    }

    // ── Create settlement transaction ────────────────────────────────────
    const settlementTx = await transactionService.createTransaction(
      {
        businessId,
        transactionDate:     settledDate,
        description:         txDesc,
        transactionType:     TRANSACTION_TYPES.INSTALLMENT_PAYMENT,
        transactionMode:     TRANSACTION_MODES.PARTIAL_SETTLEMENT,
        transactionSource:   TRANSACTION_SOURCES.INSTALLMENT_ENGINE,
        amount:              cashPaid,
        debitAccountId:      journalLines.find(l => l.type === 'debit')?.accountId,
        creditAccountId:     journalLines.find(l => l.type === 'credit')?.accountId,
        journalLines,
        parentTransactionId: linkedTxId,
        installmentPlanId:   plan._id,
      },
      userId,
      ipAddress
    );

    // ── Mark plan as settled early ───────────────────────────────────────
    plan.settleEarly(discountAmount, settledDate);
    await plan.save();

    // ── Close the parent transaction ─────────────────────────────────────
    await transactionRepository.updateTransaction(linkedTxId, businessId, {
      remainingBalance:    0,
      partiallyPaidAmount: (parent.partiallyPaidAmount || 0) + cashPaid,
      paymentStatus:       PAYMENT_STATUS.PAID,
      status:              JOURNAL_STATUS.SETTLED,
      $push: {
        relatedTransactions: settlementTx._id,
        settlements: {
          transactionId: settlementTx._id,
          amount:        cashPaid,
          date:          settledDate,
        },
      },
    });

    logger.info(`Plan ${planId} settled early. Cash paid: ${cashPaid}, Discount: ${discountAmount}`);
    return { plan, settlementTx };
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /* Reminder & Alert Queries                                                 */
  /* ──────────────────────────────────────────────────────────────────────── */

  /**
   * Get upcoming installment reminders — plans with a due date within `daysAhead` days.
   * No journal entries. Pure query for notification hooks / dashboard widget.
   *
   * @param {string}  businessId
   * @param {number}  [daysAhead=7]  - look-ahead window in days
   * @returns {Promise<Array>}       - array of reminder objects with plan + row info
   */
  async getUpcomingReminders(businessId, daysAhead = 7) {
    if (!businessId) throw new ApiError(400, 'Business ID is required');

    const now     = new Date();
    const horizon = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);

    const plans = await InstallmentPlan.find({
      businessId,
      status:      { $in: ['active', 'overdue', 'restructured'] },
      nextDueDate: { $gte: now, $lte: horizon },
    })
      .populate('linkedTransactionId', 'description amount')
      .populate('customerId', 'fullName email')
      .populate('vendorId', 'vendorName email')
      .lean();

    return plans.map((plan) => {
      const nextRow = (plan.schedule || []).find(
        (r) => r.status === 'unpaid' || r.status === 'partially_paid'
      );
      const daysUntilDue = nextRow
        ? Math.ceil((new Date(nextRow.dueDate) - now) / (1000 * 60 * 60 * 24))
        : null;

      return {
        planId:           plan._id,
        linkedTx:         plan.linkedTransactionId,
        party:            plan.customerId || plan.vendorId || null,
        partyType:        plan.customerId ? 'customer' : plan.vendorId ? 'vendor' : 'internal',
        nextDueDate:      plan.nextDueDate,
        daysUntilDue,
        amountDue:        nextRow?.amount || plan.installmentAmount,
        installmentNo:    nextRow?.installmentNumber,
        remainingCount:   plan.remainingInstallments,
        remainingBalance: plan.remainingAmount,
        planStatus:       plan.status,
      };
    });
  }

  /**
   * Get overdue alert details for a business — all plans with past-due EMIs.
   * Includes per-plan severity (overdue / defaulted), total overdue amount,
   * and per-row detail for display in a dashboard panel.
   *
   * @param {string}  businessId
   * @returns {Promise<{ alerts: Array, totalOverdueAmount: number, planCount: number }>}
   */
  async getOverdueAlerts(businessId) {
    if (!businessId) throw new ApiError(400, 'Business ID is required');

    const now = new Date();
    const plans = await InstallmentPlan.find({
      businessId,
      status:      { $in: ['active', 'overdue', 'defaulted', 'restructured'] },
      nextDueDate: { $lt: now },
    })
      .populate('linkedTransactionId', 'description amount transactionDate')
      .populate('customerId', 'fullName email phone')
      .populate('vendorId', 'vendorName email phone')
      .lean();

    let totalOverdueAmount = 0;
    const alerts = plans.map((plan) => {
      const overdueRows = (plan.schedule || []).filter(
        (r) =>
          (r.status === 'unpaid' || r.status === 'partially_paid') &&
          new Date(r.dueDate) < now
      );

      const overdueAmount = overdueRows.reduce(
        (sum, r) => sum + Math.max(0, (r.amount || 0) - (r.paidAmount || 0)),
        0
      );
      totalOverdueAmount += overdueAmount;

      const maxDaysLate = overdueRows.reduce((max, r) => {
        const days = Math.floor((now - new Date(r.dueDate)) / (1000 * 60 * 60 * 24));
        return Math.max(max, days);
      }, 0);

      let severity = 'low';
      if      (plan.overdueStatus === 'defaulted' || maxDaysLate > 90) severity = 'critical';
      else if (maxDaysLate > 30)  severity = 'high';
      else if (maxDaysLate > 14)  severity = 'medium';

      return {
        planId:           plan._id,
        linkedTx:         plan.linkedTransactionId,
        party:            plan.customerId || plan.vendorId || null,
        partyType:        plan.customerId ? 'customer' : plan.vendorId ? 'vendor' : 'internal',
        overdueStatus:    plan.overdueStatus,
        planStatus:       plan.status,
        severity,
        overdueRowCount:  overdueRows.length,
        overdueAmount:    Math.round(overdueAmount * 100) / 100,
        maxDaysLate,
        overdueRows:      overdueRows.map((r) => ({
          installmentNo: r.installmentNumber,
          dueDate:       r.dueDate,
          amountDue:     r.amount,
          paidAmount:    r.paidAmount,
          outstanding:   Math.round(Math.max(0, r.amount - r.paidAmount) * 100) / 100,
          daysLate:      Math.floor((now - new Date(r.dueDate)) / (1000 * 60 * 60 * 24)),
          penaltyAmount: r.penaltyAmount || 0,
        })),
        totalPenaltiesAccrued: plan.totalPenaltiesAccrued || 0,
        remainingBalance:      plan.remainingAmount,
        remainingInstallments: plan.remainingInstallments,
      };
    });

    return {
      alerts: alerts.sort((a, b) => b.overdueAmount - a.overdueAmount),
      totalOverdueAmount: Math.round(totalOverdueAmount * 100) / 100,
      planCount: alerts.length,
    };
  }
}

module.exports = new InstallmentService();
