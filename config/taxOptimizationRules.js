// config/taxOptimizationRules.js
//
// FR-04.2 — deterministic, auditable tax-optimisation rule catalog (Pakistan).
//
// Each rule is data, not magic: it cites a real legal provision, computes a PKR
// saving from the supplied context, and declares its risk level. `detect(ctx)`
// returns null (no advisory) or { estimatedSavingPKR, explanation }. The catalog
// is intentionally expandable — add rules here, no service change needed.
//
// riskLevel: 'safe'   — your money / a clear entitlement, low judgement.
//            'review' — depends on projections or facts to verify first; the
//                       advisor attaches a prominent warning to these.
//
'use strict';

const r0    = (v) => Math.round(Number(v) || 0);                 // whole rupees
const money = (v) => `Rs ${r0(v).toLocaleString('en-PK')}`;
const pct   = (f) => `${Math.round(f * 100)}%`;

// Conservative blended first-year tax depreciation. PK Third Schedule rates vary
// (furniture 10%, plant & machinery 15%, computers 30%); 10% is a safe lower bound.
const DEPRECIATION_RATE = 0.10;

const TAX_OPTIMIZATION_RULES = [
  {
    id: 'DEPRECIATION_UNCLAIMED',
    taxType: 'INCOME_TAX',
    title: 'Claim wear-and-tear on your equipment',
    legalRef: 'Income Tax Ordinance 2001, s.22 & Third Schedule',
    riskLevel: 'safe',
    detect(ctx) {
      if (!(ctx.fixedAssetsGross > 0)) return null;
      if (ctx.depreciationBookedYTD > 0) return null;      // already depreciating
      const annualDepreciation = r0(DEPRECIATION_RATE * ctx.fixedAssetsGross);
      const saving = r0((ctx.provisionRate || 0.29) * annualDepreciation);
      if (saving <= 0) return null;
      return {
        estimatedSavingPKR: saving,
        explanation: `You own ${money(ctx.fixedAssetsGross)} of equipment and assets but haven't claimed any wear-and-tear (depreciation) this year. Claiming it (about ${pct(DEPRECIATION_RATE)} of cost) lowers the profit you're taxed on by roughly ${money(annualDepreciation)}, saving about ${money(saving)} in income tax.`,
      };
    },
  },

  {
    id: 'INPUT_TAX_UNCLAIMED',
    taxType: 'GST',
    title: 'Claim back the extra sales tax you paid',
    legalRef: 'Sales Tax Act 1990, s.7 & s.10',
    riskLevel: 'safe',
    detect(ctx) {
      if (!(ctx.glNetPayable < 0)) return null;            // input already exceeds output
      const claimable = r0(-ctx.glNetPayable);
      if (claimable <= 0) return null;
      return {
        estimatedSavingPKR: claimable,
        explanation: `You paid ${money(claimable)} more sales tax on your purchases than you collected on your sales this period. Don't leave it with FBR — carry it to next month or claim it back as a refund.`,
      };
    },
  },

  {
    id: 'ADVANCE_TAX_OVERPAID',
    taxType: 'INCOME_TAX',
    title: 'You may have paid too much tax in advance',
    legalRef: 'Income Tax Ordinance 2001, s.147 & s.170 (refund)',
    riskLevel: 'review',
    detect(ctx) {
      if (!(ctx.advanceTaxPaid > 0)) return null;
      const expectedLiability = r0((ctx.provisionRate || 0.29) * Math.max(0, ctx.projectedAnnualIncome || 0));
      const excess = r0(ctx.advanceTaxPaid - expectedLiability);
      if (excess <= 0) return null;
      return {
        estimatedSavingPKR: excess,
        explanation: `You've already paid ${money(ctx.advanceTaxPaid)} in tax this year (in advance and withheld) — more than your likely full-year income tax of ${money(expectedLiability)}. You can put the extra ${money(excess)} towards your next payment or claim it back as a refund.`,
      };
    },
  },

  {
    id: 'WHT_SECTION_OPTIMISATION',
    taxType: 'WHT',
    title: 'Check your suppliers are registered tax filers',
    legalRef: 'Income Tax Ordinance 2001, s.153 & Tenth Schedule (non-filer rates)',
    riskLevel: 'review',
    detect(ctx) {
      if (!(ctx.whtWithheldYTD > 1000)) return null;       // ignore trivial amounts
      const potential = r0(ctx.whtWithheldYTD * 0.5);      // non-filer rates ~2× filer rates
      return {
        estimatedSavingPKR: potential,
        explanation: `You held back ${money(ctx.whtWithheldYTD)} in tax from supplier payments this year. Non-filers are charged roughly double — so if your suppliers are registered active tax filers, checking before you pay could cut the tax you hold back by up to ${money(potential)}.`,
      };
    },
  },
];

module.exports = { TAX_OPTIMIZATION_RULES, DEPRECIATION_RATE };
