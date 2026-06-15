// config/fbrRejectionRules.js
//
// FR-04.3 — catalog of the common reasons FBR rejects a return, run as a
// pre-filing gate so problems are caught (with a fix) before submission, not
// after. Expandable: add a rule object, no validator change needed.
//
// Each rule: { code, returnType ('*' = all), field, message, fix, severity,
//              check(ctx) -> boolean (true = violated) }
// ctx = { data (the builder output), returnType, businessNtn, unpostedCount }
//
'use strict';

const num = (v) => Number(v) || 0;
const digits = (s) => String(s || '').replace(/\D/g, '');
const sumBy = (arr, key) => (Array.isArray(arr) ? arr : []).reduce((s, x) => s + num(x[key]), 0);
// Annex must tie to the header within a rupee (rounding tolerance).
const TOL = 1;

// Messages + fixes are written for a business owner with no accounting
// background: plain language, a concrete next action, no form jargon. The FBR
// `code` is kept for the audit trail / expert drill-down.
const FBR_REJECTION_RULES = [
  {
    code: 'NTN_MISSING', returnType: '*', field: 'businessNtn', severity: 'error',
    message: 'Your tax number (NTN) is missing.',
    fix: 'Add your NTN in Settings → Tax Engine — it’s the number FBR registered your business under. Filing needs it.',
    check: (ctx) => !ctx.businessNtn,
  },
  {
    code: 'NTN_FORMAT', returnType: '*', field: 'businessNtn', severity: 'error',
    message: 'Your tax number (NTN) doesn’t look right.',
    fix: 'An NTN is 7 digits (some businesses have 13). Re-check it in Settings → Tax Engine.',
    check: (ctx) => { const d = digits(ctx.businessNtn); return !!ctx.businessNtn && d.length !== 7 && d.length !== 13; },
  },
  {
    code: 'PERIOD_NOT_CLOSED', returnType: '*', field: 'period', severity: 'error',
    message: 'Some transactions for this month are still waiting for approval.',
    fix: 'Approve or remove the pending transactions first, so the return uses your final figures.',
    check: (ctx) => num(ctx.unpostedCount) > 0,
  },
  {
    code: 'OUTPUT_LT_ANNEX', returnType: 'GST-01', field: 'outputTax', severity: 'error',
    message: 'We can’t see the individual sales behind your sales-tax total.',
    fix: 'Record this month’s sales in VousFin, each with its sales tax. FBR needs the list of sales that adds up to the tax you collected.',
    check: (ctx) => Math.abs(num(ctx.data?.fields?.outputTax) - sumBy(ctx.data?.annexes?.C, 'salesTax')) > TOL,
  },
  {
    code: 'INPUT_LT_ANNEX', returnType: 'GST-01', field: 'inputTax', severity: 'error',
    message: 'We can’t see the individual purchases behind your input-tax total.',
    fix: 'Record this month’s purchases in VousFin, each with the sales tax you paid. FBR needs the list that adds up to it.',
    check: (ctx) => Math.abs(num(ctx.data?.fields?.inputTax) - sumBy(ctx.data?.annexes?.A, 'inputTax')) > TOL,
  },
  {
    code: 'NEGATIVE_LIABILITY_NO_REFUND_FLAG', returnType: 'GST-01', field: 'netPayable', severity: 'warning',
    message: 'You paid more sales tax on purchases than you collected on sales.',
    fix: 'Decide whether to claim the difference back as a refund or carry it to next month, then file.',
    check: (ctx) => num(ctx.data?.fields?.netPayable) < 0 && ctx.data?.refundClaim !== true,
  },
  {
    code: 'ZERO_RATED_NO_EVIDENCE', returnType: 'GST-01', field: 'annexes.C', severity: 'warning',
    message: 'A sale with no tax is missing a reason.',
    fix: 'Add a short note to each zero-tax sale (for example “export”) so FBR accepts it.',
    check: (ctx) => (ctx.data?.annexes?.C || []).some(l => num(l.taxRate) === 0 && !l.description),
  },
  {
    code: 'WHT_VENDOR_CNIC_MISSING', returnType: 'WHT-165', field: 'lines', severity: 'error',
    message: 'A supplier is missing their tax/ID number.',
    fix: 'Add the NTN or CNIC on each supplier’s record before filing.',
    check: (ctx) => (ctx.data?.lines || []).some(l => !l.taxId),
  },
];

/** Rules applicable to a return type (its own + the universal '*' rules). */
function rulesFor(returnType) {
  return FBR_REJECTION_RULES.filter(r => r.returnType === '*' || r.returnType === returnType);
}

module.exports = { FBR_REJECTION_RULES, rulesFor };
