# VousFin AI Financial Forecasting Platform — Institutional Architecture Blueprint

> Standalone SaaS forecasting product first; ERP-integration-compatible second.
> Grounds on the existing stack (`services/forecasting/lstmForecastService.js`,
> `anomalyDetection`, `isolationForest`, `vendorRisk`, `cashFlowForecast`) and the
> M1–M9 ledger architecture (JournalEntry = immutable projection, EventLog = durable log).

---

## 0. Engineering invariants (non-negotiable, enforced everywhere)

| Rule | Mechanism |
|---|---|
| Never mix tenant data | `businessId` in every query/feature row; tenant-scoped feature store partitions; global models use **aggregated, de-identified** series only + a tenant guard at the serving boundary. |
| Never leak future info | Point-in-time ("as-of") feature joins; walk-forward backtests only; target horizon strictly after feature cutoff; `knowledge_date` stamped on every feature row. |
| Never single-model | Every target served by an **ensemble**: baselines + classical + GBM + DL, combined by backtest-weighted stacking. |
| Preserve accounting integrity | Forecasts are read-only projections of the ledger; never write JEs; reconcile against M7/M9 control totals. |
| Uncertainty always | Conformal-calibrated prediction intervals on top of every model. |
| Explainability always | Feature attribution (SHAP/quantile) + plain-English interpretation persisted per run. |
| Validate vs naive baselines | A model **cannot be promoted** unless it beats seasonal-naive on backtest (baseline gate). |
| Horizontal scaling | Stateless Node orchestrator + Python inference worker pool behind a queue; Redis cache; batch precompute. |
| Incremental retraining | Scheduled + drift-triggered retrain; warm-start from prior version. |
| Model versioning | `ModelRegistry` with artifact hash, training window, feature schema, metrics, code hash. |

---

## 1. Target architecture (layers)

```
┌──────────────────────────────────────────────────────────────────────────┐
│ GOVERNANCE: tenant-isolation guard · baseline gate · audit (EventLog) ·    │
│             explainability · model registry/lineage · quotas              │
├──────────────────────────────────────────────────────────────────────────┤
│ SERVING:  Node forecast API (stateless) → queue → Python inference workers │
│           Redis cache · batch precompute · champion/challenger router      │
├──────────────────────────────────────────────────────────────────────────┤
│ MODELS:   per target → [naive, seasonal-naive, drift] (baselines)          │
│           + [Holt-Winters/ETS, ARIMA] (classical)                          │
│           + [LightGBM/XGBoost on lag+calendar feats] (ML)                   │
│           + [Bi-LSTM / Temporal Fusion Transformer] (DL)                    │
│           → stacking meta-learner (weights from backtest) → conformal PIs   │
├──────────────────────────────────────────────────────────────────────────┤
│ ORCHESTRATION: training pipeline · retraining scheduler · drift monitor    │
├──────────────────────────────────────────────────────────────────────────┤
│ FEATURE STORE: point-in-time features from JournalEntry ledger + EventLog  │
│                (lags, rolling stats, calendar, AR/AP aging, anomaly flags)  │
├──────────────────────────────────────────────────────────────────────────┤
│ SOURCE OF TRUTH: MongoDB OLTP (JournalEntry, Invoice/Bill, Customer/Vendor) │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Key architectural decisions (alternatives compared → choice + justification)

**D1 — Inference engine.** (a) Node calls a single Python microservice [current]; (b) port models to JS/tfjs; (c) Python service mesh.
→ **Choose (a) evolved into a Python inference *worker pool* behind a job queue.** DL/TFT need the Python ecosystem; JS can't host them credibly. A queue + stateless workers gives horizontal scale, fault isolation, and lets Node remain the thin orchestrator/auth/tenancy boundary. Node keeps the classical/baseline fallbacks in-process so the product never hard-fails when Python is down (already the pattern).

**D2 — Per-tenant vs global models.** (a) one global model; (b) per-tenant models; (c) hierarchical global model (tenant embeddings) + per-tenant calibration.
→ **Default per-tenant (b) for P1–P3; opt-in hierarchical (c) for cold-start at P4+.** Per-tenant is the safest read of "never mix tenant data" and is correct for established tenants. Hierarchical global (à la DeepAR) trains on **aggregated, de-identified** series so cold-start/new tenants get sensible priors — justified because only *learned parameters* are shared, never another tenant's data or forecasts, and it's gated behind an explicit opt-in + a hard serving-boundary tenant guard.

**D3 — Uncertainty.** (a) Gaussian heuristic bands [current]; (b) quantile regression; (c) conformal prediction; (d) Bayesian.
→ **Choose (c) conformal prediction wrapping every model, plus quantile heads where the model supports them.** Distribution-free, model-agnostic, gives *guaranteed coverage* (institutional requirement), cheap, and works atop the ensemble. Bayesian reserved for specific risk models (liquidity stress) where full posteriors add value.

**D4 — Ensemble combination.** (a) simple average; (b) backtest-weighted average; (c) stacking meta-learner; (d) BMA.
→ **Choose (b)→(c): backtest-weighted average first, graduating to a stacking meta-learner.** Weighted-by-skill is robust and explainable; stacking squeezes more accuracy once enough backtest folds exist. Both sit behind the **baseline gate**.

**D5 — Storage / scale tiers.** Mongo only [current] vs dedicated TSDB vs columnar feature store.
→ **Tiered:** Mongo stays OLTP source of truth + forecast/registry stores; add a **materialized feature store** (Mongo collections → Parquet on object storage → ClickHouse/Timescale as volume grows). Avoids premature infra while giving a clean migration path to "millions of transactions."

---

## 3. Phase roadmap — each phase across the 12 required dimensions

> Legend for the 12: **Arch · Components · Files+ · Files~ · DB · Models · Training · Validation · Scale · Deploy · Edges · Future**

### P0 — Foundation, contracts & baseline harness *(no model change)*
- **Arch:** define platform contracts, registry/forecast-store schemas, the baseline + backtest harness. **Components:** `forecastContracts`, `baselineModels`, `backtest` utils. **Files+:** `services/forecasting/contracts.js`, `services/forecasting/baselines.js`, `services/forecasting/backtest.js`, `docs/ai-forecasting-platform.md`. **Files~:** none (additive). **DB:** none yet. **Models:** naive, seasonal-naive, drift, moving-average (the baselines all future models must beat). **Training:** n/a (closed-form). **Validation:** walk-forward splitter + metrics (MAE, RMSE, MAPE, sMAPE, MASE, pinball loss, interval coverage). **Scale:** pure functions, trivially parallel. **Deploy:** ships dark behind a flag. **Edges:** <2 points, all-zero series, single spike. **Future:** harness reused by every later phase.

### P1 — Forecast persistence + backtesting + baseline gate + model registry *(institutionalize what exists)*  ← **recommended first build**
- **Arch:** persist every forecast + its inputs hash, model version, and PIs; backtest the current LSTM/Holt-Winters against baselines; refuse to serve a model that loses to seasonal-naive (fall back to baseline + flag).
- **Components:** `ModelRegistry`, `ForecastRun` store, `ForecastAccuracy` (ex-post realized vs predicted), `forecastEvaluator`, `baselineGate`.
- **Files+:** `models/ModelRegistry.model.js`, `models/ForecastRun.model.js`, `models/ForecastAccuracy.model.js`, `services/forecasting/forecastStore.service.js`, `services/forecasting/evaluator.service.js`, `controllers/forecastIntegrity.controller.js`, `routes/v1/forecastIntegrity.routes.js`, tests.
- **Files~:** `lstmForecastService.js` (persist runs + register model version + pass through baseline gate), `routes/index.js`, `eventSubscribers` (emit `FORECAST_GENERATED`).
- **DB:** `ForecastRun{businessId, target, horizon, modelVersion, inputsHash, predicted[], lower[], upper[], baselineMASE, generatedAt}` (indexed `{businessId,target,generatedAt}`); `ModelRegistry{key, version, type, trainWindow, featureSchema, metrics, codeHash, status:champion|challenger|retired}`; `ForecastAccuracy{forecastRunId, horizonStep, predicted, actual, error, capturedAt}`.
- **Models:** existing Bi-LSTM + Holt-Winters, now **scored against baselines**.
- **Training:** none new; registers the deployed artifacts.
- **Validation:** rolling-origin backtest; **baseline gate = MASE < 1**; interval coverage check.
- **Scale:** writes are async/fire-and-forget (reuse event engine); reads indexed per tenant.
- **Deploy:** flag `FORECAST_STORE_ENABLED`; dark-launch → shadow → enforce gate.
- **Edges:** model worse than baseline (serve baseline + warn), no realized actuals yet, horizon partially elapsed.
- **Future:** the accuracy store powers drift detection (P3) and champion/challenger (P7).

### P2 — Multi-model ensemble + calibrated probabilistic intervals *(kills single-model)*
- **Arch:** run baselines + classical + GBM + DL, combine via backtest-weighted stacking, wrap in conformal PIs. **Components:** `ensemble.service`, `conformal.service`, GBM trainer (Python worker). **Files+:** `services/forecasting/ensemble.service.js`, `services/forecasting/conformal.service.js`, Python `gbm_forecaster.py`. **Files~:** `lstmForecastService.js` → `forecastOrchestrator` that calls the ensemble. **DB:** ensemble weights versioned in `ModelRegistry`. **Models:** ETS/ARIMA, LightGBM on lag/calendar, Bi-LSTM/TFT, stacking meta-learner. **Training:** per-tenant fit + meta-learner on backtest residuals. **Validation:** ensemble must beat best single member AND baseline; conformal coverage ≈ nominal (e.g. 90%). **Scale:** members computed in parallel workers. **Deploy:** challenger alongside P1 champion. **Edges:** member disagreement (widen PI), one member fails (degrade gracefully). **Future:** add Croston for intermittent demand (inventory).

### P3 — Feature store + leakage-safe pipeline + incremental retraining + drift detection
- **Arch:** materialized point-in-time features; scheduled + drift-triggered retraining; warm-start. **Components:** `featureStore.service`, `retrainScheduler`, `driftMonitor`. **Files+:** `models/FeatureSnapshot.model.js`, `services/forecasting/featureStore.service.js`, `services/forecasting/driftMonitor.service.js`, `jobs/retrain.job.js`. **Files~:** orchestrator reads features from the store. **DB:** `FeatureSnapshot{businessId, asOf, features{}, knowledgeDate}`. **Models:** unchanged; retrained incrementally. **Training:** nightly/weekly per tenant + on drift; warm-start from champion. **Validation:** PSI/KL drift on features + accuracy-decay trigger; leakage unit tests (assert no feature uses data after `asOf`). **Scale:** incremental materialization; backfill via job. **Deploy:** retrain job behind cron (reuse `server.js` block). **Edges:** schema change, late-arriving transactions (recompute window), tenant with frozen data. **Future:** online features for intraday.

### P4 — Expand forecast domains *(the 11 targets)*
- **Arch:** target plug-ins on the shared ensemble/feature spine. **Components:** target adapters. **Files+:** `services/forecasting/targets/{cashflow,liquidityStress,debtExposure,arPaymentBehavior,inventoryDemand,profitability,macroSensitivity}.js`. **DB:** reuse ForecastRun (target dimension). **Models:** survival/hazard model for AR payment timing; Croston/TFT for inventory demand; VaR-style Monte-Carlo for liquidity stress; regression-on-macro-factors for sensitivity. **Training:** per target. **Validation:** target-specific (e.g. payment-behavior calibration curve; inventory service-level). **Scale:** targets share the worker pool. **Edges:** sparse/intermittent series, new customers/SKUs (cold-start via P2 hierarchical). **Future:** scenario-linked stress testing.

### P5 — Explainability & risk intelligence
- **Arch:** attribution + scenario + risk scoring as a governance service. **Files+:** `services/forecasting/explainability.service.js` (SHAP via Python, quantile attribution fallback), `services/forecasting/scenarioEngine.service.js`. **Files~:** responses carry `explanation`+`drivers`. **Models:** SHAP on GBM; integrated-gradients/attention on DL. **Validation:** attribution stability; human-readable sanity checks. **Scale:** explanations cached per run. **Edges:** baseline path (rule-based proxies — already exists). **Future:** counterfactual ("what raises cash flow 10%").

### P6 — Scale & SaaS productionization
- **Arch:** worker pool + queue + Redis + autoscaling + per-tenant quotas + API keys. **Components:** `inferenceQueue`, `forecastCache(redis)`, tenant rate-limiter, SaaS billing hooks. **Files+:** queue/worker infra, `services/forecasting/cache.redis.js`. **DB:** Redis (cache), object storage (artifacts/Parquet). **Scale:** stateless Node replicas; N Python workers; batch precompute popular forecasts off-peak; graduate feature store to ClickHouse/Timescale. **Deploy:** containerized (Node + Python images), HPA on queue depth, blue/green. **Edges:** thundering herd (cache stampede lock), worker crash (retry/DLQ), noisy-neighbor (quotas). **Future:** multi-region, GPU workers for TFT.

### P7 — MLOps & governance
- **Arch:** champion/challenger routing, monitoring, alerting, model-version UI. **Components:** `championChallenger.router`, accuracy dashboards, retrain triggers. **Files+:** monitoring service + admin UI. **Validation:** continuous backtest + live accuracy SLOs; auto-rollback on regression. **Scale:** metrics in time-series store. **Edges:** silent accuracy decay, label delay. **Future:** AutoML model search, feature-importance drift alerts.

---

## 4. Cross-cutting designs

- **Tenant isolation:** every feature row, model artifact, forecast run, and cache key is keyed by `businessId`; the serving boundary asserts `req.user.businessId === payload.businessId`; global models consume only aggregated/de-identified series and are opt-in.
- **Leakage prevention:** `knowledgeDate` on every feature; backtests are walk-forward; CI test fails if any feature references data dated after the forecast cutoff.
- **Uncertainty:** conformal residual quantiles per (tenant, target, horizon-step); coverage monitored in `ForecastAccuracy`.
- **Explainability:** persisted `drivers[]` + plain-English `interpretation` (already present) upgraded with SHAP on the GBM member.
- **Baseline gate:** seasonal-naive computed every run; MASE logged; model demoted to baseline if MASE ≥ 1.
- **Versioning/lineage:** `ModelRegistry` (artifact hash + code hash + train window + feature schema); every `ForecastRun` references the exact `modelVersion`.
- **Accounting integrity:** forecasts never mutate the ledger; totals reconcile to M7/M9 control checks; FX via existing `fx.service`.

---

## 5. Edge cases (platform-wide)
New tenant / cold start · all-zero or single-spike series · intermittent demand · currency switch mid-history · locked accounting period · late-arriving/back-dated transactions · anomaly/fraud contamination (down-weight + widen PI) · Python service down (classical fallback) · horizon longer than history · leap/calendar effects · partial month at request time.

## 6. Future extensions
ERP write-back (budget vs forecast variance) · what-if scenario planner UI · cohort/customer-level CLV · supplier-risk-linked AP forecasting · macro data connectors (FX, inflation, rates) · GPU TFT · AutoML · multi-region SaaS · marketplace of industry-tuned base models.

---

## 7. Recommended execution order
**P1 first** — it makes the *existing* forecasts auditable, persisted, and validated against baselines with model versioning (directly satisfies "validate vs baselines / versioning / no future leakage in evaluation") at low risk and zero new ML infra — then P2 (kill single-model), P3 (leakage-safe retraining), P4 (domains), P5 (explainability), P6 (scale), P7 (MLOps).

*Each phase: feature-flagged where behavior changes · unit + backtest validation · commit + push · backward-compatible (existing `/forecast` responses preserved and enriched).*
