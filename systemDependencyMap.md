# systemDependencyMap.md

**VousFin — Core ERP Integration Audit (Step 1 of the ERP Integration Refactor)**
Generated: 2026-05-29 · Status: **AUDIT ONLY — no code changed in this step**

This document maps every module in VousFin, the data each one owns, and — for
every meaningful business action — **what updates today (`NOW`)** versus **what
*should* update in a fully connected ERP (`SHOULD`)**. The gap between those two
columns is the work plan for Steps 2–13.

---

## 0. How to read this document

- **NOW** = behaviour verified by reading the source this session.
- **SHOULD** = the connected-ERP target (SAP/NetSuite/Odoo parity).
- **GAP** = `SHOULD − NOW`; the integration the event engine must add.
- ⚠ = a structural disconnect (not just a missing call — a missing pipeline).
- ❌ = module/model does **not exist yet** in the codebase.

---

## 1. Module inventory

### 1.1 Modules that EXIST (verified)

| # | Module | Primary service(s) | Owns / persists |
|---|--------|--------------------|-----------------|
| 1 | **Transactions (core ledger)** | `transaction.service.js` (1374 ln) | `JournalEntry` docs; the orchestration hub |
| 2 | **Journal / Double-entry** | `journalGenerator.service.js` | DR/CR lines, FX gain/loss (IAS 21) |
| 3 | **Chart of Accounts** | `account.repository.js` | `ChartOfAccount`, running balances (`$inc`) |
| 4 | **Inventory** | `inventory.service.js` (307 ln) | `InventoryItem` (stock, weighted-avg cost, valuation) |
| 5 | **Vendors / AP** | `vendor.service.js`, `bill.service.js` | `Vendor`, `Bill`, `BillSchedule`, `BillAllocation`, `BillDocument` |
| 6 | **Customers / AR** | `customer.service.js`, `invoice.service.js` | `Customer`, `Invoice`, `CreditNote` |
| 7 | **Procurement** | `purchaseOrder.service.js`, `goodsReceipt.service.js`, `billMatching.service.js`, `vendorCredit.service.js` | `PurchaseOrder`, `GoodsReceipt`, `VendorCredit` |
| 8 | **Installments / Loans** | `installment.service.js` (1203 ln) | `InstallmentPlan` (amortization, penalties, restructure) |
| 9 | **Tax Engine** | `taxEngine.service.js`, `taxReport.service.js` | tax journal lines, lazy tax CoA accounts (1170–1177 / 2121–2130) |
| 10 | **FX / Currency** | `fx.service.js`, `rateSync.service.js` | `CurrencyRate`, FX fields on journal |
| 11 | **Fiscal Year / Periods** | `fiscalYear.service.js`, `accountingPeriod.service.js` | `FiscalYear`, `AccountingPeriod` (period locks) |
| 12 | **Reports** | `report.service.js` | Income Statement, Balance Sheet, Cash Flow, Trial Balance, KPI summary |
| 13 | **Dashboard** | `dashboard.service.js` | KPIs + 2 chart series, cached `dashboard-all` |
| 14 | **Cash Flow Forecast (AP)** | `cashFlowForecast.service.js` (Phase 3.4) | payable obligations, cash requirements, upcoming due bills |
| 15 | **Procurement Analytics** | `procurementAnalytics.service.js` (Phase 3.4) | vendor spend, cycle time, overdue, efficiency, payment behaviour |
| 16 | **General Audit** | `audit.service.js` | `AuditLog` (state transitions, before/after) |
| 17 | **Procurement Audit** | `procurementAudit.service.js` (Phase 3.4) | `ProcurementAuditLog` (append-only) |
| 18 | **AI Insights** | `aiAssistant.service.js`, `financialIntelligence.service.js`, `accountantSuggestions.service.js` | NL parsing, suggestions |
| 19 | **Anomaly Detection** | `anomalyDetection.service.js`, `isolationForest.service.js` | `AnomalyAlert` |
| 20 | **Payment Reminders** | `paymentReminder.service.js`, `billScheduler.service.js` | reminder state, scheduled emails |
| 21 | **Business / Settings** | `business.service.js` | `Business`, `taxConfig`, currency |

### 1.2 Modules referenced in the refactor brief that DO **NOT** exist

| Module | Status | Closest existing surrogate |
|--------|--------|----------------------------|
| **Payroll** | ❌ no model/service | `SALARY` transaction type only (manual journal) |
| **Fixed Assets register** | ❌ no `Asset` model | `ASSET_PURCHASE` txn type; `installment.service` books the acquisition journal but tracks no asset lifecycle |
| **Depreciation** | ❌ no model/schedule/cron | none — must be built or explicitly de-scoped |
| **Forecasting (live)** | ⚠ exists but **disconnected** | `forecasting/dataLoader.js` loads **static pre-trained CSVs** (Favorita `store_1..54`), **not** live `JournalEntry` data |

> **Decision required (record in Step 2 plan):** Payroll / Fixed-Asset / Depreciation
> are net-new modules. They should be **de-scoped from the event wiring** for now and
> listed under "remaining disconnected areas," OR explicitly green-lit as new builds.

---

## 2. The orchestration reality today

There is **no event bus**. All cross-module propagation is **imperative call chains**
concentrated inside `transaction.service.createTransaction()`. That one method already
performs most of the "ERP propagation," but it does so inline, which is why the system
*feels* disconnected: anything that does **not** flow through `createTransaction` (a
PO approval, a GRN, a bill state change, a dashboard view) gets **none** of the
side effects automatically.

### 2.1 What `createTransaction()` already orchestrates (verified)

```
createTransaction(data, userId, ip)
  ├─ derive debit/credit accounts from journalLines
  ├─ period-lock check ............................ accountingPeriod.service
  ├─ FX field prep (IAS 21) ....................... fxService.prepareFxFields
  ├─ tax resolution + journal lines ............... taxEngine.resolve/generate  (unless skipTax)
  ├─ auto-number INV-/BILL- ....................... internal counters
  ├─ findOrCreate customer / vendor ............... customer/vendorRepository
  ├─ AR/AP detection by account pair .............. isARSaleByAccount / isAPPurchaseByAccount
  ├─ COGS auto-gen (if inventoryItemId+qty) ....... inventoryService.reduceStock → DR COGS / CR Inventory
  ├─ balance validation (ΣDR == ΣCR)
  ├─ persist JournalEntry
  ├─ update account running balances .............. _updateAccountBalance ($inc, normalBalance-aware)
  ├─ write audit log .............................. auditService.log
  ├─ invalidate report cache ...................... reportCache.invalidate(businessId)
  └─ mirror Invoice/Bill doc ...................... _mirrorInvoiceOrBill (dual-write)
```

### 2.2 What it does **NOT** do (the GAP, even on the happy path)

- ❌ Does not refresh **inventory valuation snapshot** (recomputed on read only).
- ❌ Does not push to **forecasting datasets** (forecasting is static CSV — see ⚠ §1.2).
- ❌ Does not recompute **dashboard / analytics** — relies on cache *invalidation* +
  lazy recompute on next read (acceptable, but no precompute/warm).
- ❌ Does not update **tax filing summaries** (tax liability accrues in CoA, but
  `taxReport.service` recomputes from journals on demand; no running filing ledger).
- ❌ Does not write the **procurement audit log** (`ProcurementAuditLog`) — only the
  general `AuditLog`. The two audit trails are **not unified**.
- ❌ Does not emit any **notification** (reminders are cron-driven, decoupled).
- ❌ Cross-module effects triggered **outside** `createTransaction` (PO approve, GRN
  receive, bill approve) do **not** funnel back through this orchestration.

---

## 3. Dependency graph — "what should update when X changes?"

Legend: `→` = triggers · `⇒` = should-also-trigger (GAP)

```
                         ┌─────────────────────────────┐
                         │   BUSINESS EVENT (source)    │
                         └──────────────┬──────────────┘
                                        │
              ┌─────────────────────────┼──────────────────────────┐
              ▼                         ▼                           ▼
        JournalEntry              Domain doc                  Party balance
       (ledger truth)        (Bill/Invoice/PO/GRN)         (Vendor/Customer)
              │                         │                           │
   ┌──────────┼──────────┐             │                           │
   ▼          ▼          ▼             ▼                           ▼
 Account   Inventory   Tax CoA     State machine              AR/AP aging
 balances  stock+COGS  liability   (canTransition)            buckets
   │          │          │             │                           │
   └──────────┴────┬─────┴─────────────┴───────────────┬───────────┘
                   ▼                                    ▼
            reportCache.invalidate(businessId)   audit log (general + procurement)
                   │
        ┌──────────┼───────────┬──────────────┬─────────────────┐
        ▼          ▼           ▼              ▼                 ▼
    Dashboard   Reports   Cash-flow      Procurement      Forecasting
    (lazy)      (lazy)    forecast (AP)  analytics        ⚠ STATIC CSV (no live feed)
```

### 3.1 Per-action propagation matrix

#### A. Inventory Purchase (`INVENTORY_PURCHASE`, credit)  — *the flagship test*

| Effect | NOW | SHOULD | Gap |
|--------|-----|--------|-----|
| Journal DR Inventory / CR AP | ✅ | ✅ | — |
| Inventory stock qty ↑ | ✅ (`addStock`, weighted-avg) | ✅ | — |
| Weighted-avg unit cost recompute | ✅ | ✅ | — |
| AP liability (account balance) ↑ | ✅ (`$inc`) | ✅ | — |
| Vendor balance / payables ↑ | ✅ (AR/AP detect) | ✅ | — |
| Bill doc mirror | ✅ (`_mirrorInvoiceOrBill`) | ✅ | — |
| Tax input credit (if enabled) | ✅ (tax engine) | ✅ | — |
| Inventory **valuation snapshot** | ❌ recompute-on-read | precomputed/cached | **fill** |
| AP **aging buckets** refresh | lazy (read) | event-warmed | minor |
| Dashboard / analytics | invalidate→lazy | invalidate→lazy (OK) | OK |
| Cash-flow projection (due date) | ✅ via Bill dueDate | ✅ | — |
| **Procurement audit log** | ❌ | ✅ append-only | **fill** |
| **Forecasting dataset** | ⚠ never | live demand signal | **pipeline** |
| Reorder alert (if below level) | ✅ fire-and-forget email | ✅ + notification record | partial |

#### B. Credit Sale / Invoice (`CREDIT_SALE`)

| Effect | NOW | SHOULD |
|--------|-----|--------|
| Journal DR AR / CR Revenue (+CR Tax) | ✅ | ✅ |
| COGS auto-gen (DR COGS / CR Inventory) | ✅ when `inventoryItemId`+qty | ✅ |
| Inventory stock ↓ (`reduceStock`) | ✅ | ✅ |
| Customer balance / AR ↑ | ✅ | ✅ |
| Invoice doc mirror | ✅ | ✅ |
| AR aging / risk scoring | lazy read; ⚠ no risk-score writeback | event-warmed + risk update |
| Revenue recognition schedule | ❌ point-in-time only | deferred-revenue support (future) |

#### C. Customer / Vendor Payment (`recordPartialPayment`)

| Effect | NOW | SHOULD |
|--------|-----|--------|
| Settlement journal (DR Cash / CR AR, or DR AP / CR Cash) | ✅ | ✅ |
| Parent txn `remainingBalance`, `paymentStatus`, `settlements[]` | ✅ | ✅ |
| Account balances | ✅ | ✅ |
| Bill/Invoice status sync | ✅ (`syncFromJournalEntry`) | ✅ |
| Installment plan row mark | ✅ (installment path) | ✅ |
| Cash-flow forecast | lazy | event-warmed |
| Payment-behaviour analytics | lazy | event-warmed |

#### D. Purchase Order approved → GRN received → Bill (`PO → GRN → Bill`)

| Effect | NOW | SHOULD | Gap |
|--------|-----|--------|-----|
| PO state machine (`PO_TRANSITIONS`) | ✅ | ✅ | — |
| Vendor snapshot frozen on PO | ✅ | ✅ | — |
| GRN receive → inventory stock ↑ | ⚠ **verify** GRN posts stock | ✅ must add stock | **confirm/fill** |
| 3-way match (±5% tol) | ✅ `billMatching` | ✅ | — |
| Bill created against GRN only | ✅ (rule) | ✅ | — |
| Procurement audit at each hop | partial | ✅ unified | **fill** |
| Analytics (cycle time, efficiency) | lazy read | event-warmed | minor |
| **GRN → no transaction.createTransaction** | ⚠ bypasses core orchestration | route stock + journal through engine | **fill** |

#### E. Installment / Loan EMI (`INSTALLMENT_PAYMENT`)

| Effect | NOW | SHOULD |
|--------|-----|--------|
| EMI journal (DR Loan/Interest, CR Cash) | ✅ via `createTransaction` | ✅ |
| Plan schedule row, `outstandingPrincipal` | ✅ | ✅ |
| Parent loan balance | ✅ | ✅ |
| Penalty accrual journal | ✅ | ✅ |
| Dashboard liability / cash-flow | lazy | event-warmed |
| ⚠ Asset register / depreciation on financed asset | ❌ no module | new build or de-scope |

#### F. Tax filing / period close

| Effect | NOW | SHOULD | Gap |
|--------|-----|--------|-----|
| Tax accrues in CoA (Payable/Receivable) | ✅ per-txn | ✅ | — |
| Tax report recompute | ✅ on demand from journals | ✅ | — |
| Filing summary ledger (filed vs accrued) | ❌ | running filing state | **fill** |
| Period lock blocks back-dated writes | ✅ | ✅ | — |

---

## 4. Caching & recomputation dependencies

| Consumer | Cache key | TTL | Invalidated by |
|----------|-----------|-----|----------------|
| Dashboard | `dashboard-all::<biz>::<range>` | 30 s | `reportCache.invalidate(biz)` on every txn write |
| Reports | `income-statement` / `balance-sheet` / … | 30 s | same |
| Procurement analytics | per-method keys | 5 min (60 s overdue) | `reportCache.invalidate` |

**Finding:** invalidation is correct and centralized, but ⚠ **per-process only**
(in-memory `Map`). On multi-instance deploy (Render 2+ workers) a write on worker A is
invisible on worker B for up to TTL. **Documented mitigation:** short TTL; **proper
fix:** Redis-backed cache — relevant to Step 10 (performance) on multi-instance.

---

## 5. Critical disconnects (ranked)

1. ⚠⚠ **Forecasting is not wired to live data.** `dataLoader.js` reads pre-trained
   CSVs from a retail dataset. The brief's "update forecasting datasets when X
   changes" is **impossible without a new live-data pipeline**. *Live* AP forecasting
   (`cashFlowForecast.service`) is real and good; the ML demand forecast is not.
2. ⚠ **GRN / PO state changes bypass `createTransaction`.** Procurement hops mutate
   docs and (likely) stock without the central orchestration → no unified audit, no
   cache warm, easy to drift. **Confirm GRN stock posting in Step 5.**
3. ⚠ **Two audit trails, not unified.** `AuditLog` (general) and `ProcurementAuditLog`
   (append-only) are written by different code paths. Step 9 must unify under one
   cross-module trail keyed by source event.
4. ⚠ **No event source-of-truth.** Effects are scattered across `transaction`,
   `installment`, `bill`, `invoice`, `inventory` services. Adding a new effect means
   editing N services. Step 2's `businessEventEngine` is the fix.
5. **Valuation / analytics are read-time recompute.** Correct but not "warmed";
   acceptable short-term, optimize in Step 10.
6. ❌ **Payroll / Fixed-Asset / Depreciation absent** — must build or de-scope.

---

## 6. Target event taxonomy (input to Step 2)

Events the central engine should publish (each carries `{businessId, userId, entityType, entityId, before, after, sourceTxnId}`):

```
TRANSACTION_CREATED        INVENTORY_RECEIVED        TAX_CALCULATED
TRANSACTION_REVERSED       INVENTORY_REDUCED         TAX_FILED
PAYMENT_RECORDED           INVENTORY_ADJUSTED        PERIOD_CLOSED
BILL_CREATED               PURCHASE_ORDER_APPROVED   FX_RATE_UPDATED
BILL_APPROVED              GOODS_RECEIVED            INSTALLMENT_PAID
BILL_PAID                  THREE_WAY_MATCH_DONE      INSTALLMENT_PENALTY_ACCRUED
INVOICE_CREATED            VENDOR_BALANCE_CHANGED    LOW_STOCK_REACHED
INVOICE_PAID               CUSTOMER_BALANCE_CHANGED  ANOMALY_DETECTED
```

**Subscribers (handlers) the engine routes to:** account-balance updater, inventory
valuation refresher, AR/AP aging warmer, dashboard/analytics cache warmer, unified
audit writer, notification dispatcher, (future) forecasting feeder, (future)
depreciation scheduler.

---

## 7. Connected-ERP target (one line per module)

| When this changes… | …these must stay consistent |
|--------------------|-----------------------------|
| **Transaction** | Journal ⇄ Account balances ⇄ Inventory ⇄ Tax ⇄ AR/AP ⇄ Bill/Invoice ⇄ Cache ⇄ Audit ⇄ (Forecast) |
| **Inventory** | Stock ⇄ Weighted-avg cost ⇄ Valuation ⇄ COGS ⇄ Reorder alert ⇄ PO/GRN/Bill qty |
| **Vendor/Bill** | AP ledger ⇄ Vendor balance ⇄ Aging ⇄ Cash-flow ⇄ Procurement analytics ⇄ Audit |
| **Customer/Invoice** | AR ledger ⇄ Customer balance ⇄ Aging ⇄ Risk score ⇄ Revenue ⇄ Cash-flow |
| **PO/GRN** | Inventory ⇄ Vendor snapshot ⇄ 3-way match ⇄ Bill ⇄ Cycle-time analytics ⇄ Audit |
| **Installment** | Loan liability ⇄ EMI journal ⇄ Penalty ⇄ Cash-flow ⇄ (Asset/Depreciation) |
| **Tax** | Journal split lines ⇄ Tax CoA liability ⇄ Tax reports ⇄ (Filing summary) |
| **FX rate** | Open FX balances ⇄ Gain/Loss journal ⇄ Reports |
| **Period close** | Lock writes ⇄ Reports finalize ⇄ Fiscal-year rollover |

---

## 8. Step-by-step readiness (which refactor steps this audit unblocks)

- **Step 2** (event engine) — taxonomy in §6; subscribers in §6; hub already exists in `createTransaction` (§2.1) → wrap, don't rewrite.
- **Step 3** (inventory↔txn) — mostly DONE in `createTransaction` (§3.1.A/B); fill valuation refresh + audit + (forecast feed flagged).
- **Step 4** (AP/AR↔party) — DONE for balances; add aging warm + risk writeback.
- **Step 5** (Bill/Invoice↔Inventory↔Procurement) — **confirm GRN posts stock through engine** (§5.2); wire PO/GRN hops to engine.
- **Step 6** (tax) — engine exists; add filing-summary ledger + live preview UI.
- **Step 7** (dashboard/forecast/report sync) — cache invalidation exists; add warming; **forecasting needs a live pipeline or explicit de-scope** (§5.1).
- **Step 9** (audit) — unify `AuditLog` + `ProcurementAuditLog` under event source.
- **Step 10** (perf) — Redis for multi-instance cache (§4); event queueing.
- **Step 11** (tests) — 10 scenarios already map cleanly onto §3.1 A–F.

---

## 9. Out-of-scope flags (must be decided before deep wiring)

| Item | Recommendation |
|------|----------------|
| Payroll module | De-scope now; list as "next enterprise upgrade." |
| Fixed-Asset register + Depreciation | De-scope now; `ASSET_PURCHASE` journal stays manual. |
| Live ML demand forecasting | Keep static demo; **do not claim** it's transaction-driven. Optionally add a *separate* live AP/cash forecast feed (already exists for AP). |
| Multi-instance cache | Redis is a Step-10 concern, not blocking Steps 2–9. |

---

*End of audit. No application code was modified in Step 1. Proceed to Step 2 —
`vousfin-backend-main/services/businessEventEngine.service.js` — using §6 (taxonomy)
and §2.1 (wrap the existing orchestration hub rather than rewriting it).*
