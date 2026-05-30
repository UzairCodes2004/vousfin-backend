# VousFin AI Forecasting Platform — Execution Roadmap (phase by phase)

> Companion to `ai-forecasting-platform.md` (architecture) and
> `forecast-platform-foundation.md` (F1, shipped). This is the *build order*:
> what we do, why, in what sequence, with exit criteria — and **when** scale
> forces each target-stack upgrade (so we never over-build early).

## Guiding principles
1. **Ship value early, infra late.** Stay on Node/Express + MongoDB until measured scale crosses a tipping point; the F1 seams already abstract the backends so migration is swap-not-rewrite.
2. **Every phase is a milestone:** backward-compatible · feature-flagged where behavior changes · unit + backtest tests · commit + push. Same discipline as M1–M9.
3. **Cross-cutting invariants enforced in every phase:** tenant isolation · no future leakage · uncertainty · explainability · baseline validation · model versioning · audit (reuse M9 EventLog).
4. **Dependency-driven order:** data → auditability → accuracy → automation → breadth → trust → scale → governance.

## Dependency graph
```
F1 Foundation (DONE) ──┬─▶ F2 Source coverage ─────────┐
                       └─▶ F3 Registry+persist+baseline ─┼─▶ F4 Ensemble+conformal ─▶ F5 Retraining+drift
                                                         │                                   │
                                                         └────────────────▶ F6 Domains ◀─────┘
                                                                              │
                                                          F7 Explainability ◀─┘
                                          F8 Scale-out infra (TRIGGERED BY METRICS, can start anytime after F4)
                                          F9 MLOps + SaaS productization (after F5/F7; uses F8 at scale)
```

---

## F1 — Foundation Data Layer ✅ SHIPPED
Data lake (read), feature store, dataset builder ETL, tenant isolation, currency/timezone normalization, validation framework, historical snapshots, metadata registry. Daily/weekly/monthly/quarterly. 22 tests. *(see forecast-platform-foundation.md)*

## F2 — Complete source coverage + scheduled materialization  *(next-but-one; breadth of inputs)*
- **Do:** add pluggable extractors for the 8 declared sources — payments, payroll, assets, liabilities, inventory, customer behavior, vendor behavior, macro indicators (external connector: FX/inflation/rates, cached per region). Add a **nightly materialization cron** (per tenant × granularity) so feature snapshots are pre-warmed. Admin dataset/feature explorer (frontend).
- **Why:** richer features → better forecasts; pre-warming removes request-time latency.
- **Exit:** all 11 sources materialize into `ForecastFeatureSnapshot`; nightly refresh job; tests + commit.
- **Risk:** low. **Effort:** M.

## F3 — Model registry + forecast persistence + baseline gate  ◀ **START HERE (highest value / lowest risk now)**
- **Do:** `ModelRegistry`, `ForecastRun`, `ForecastAccuracy` stores. Walk-forward **backtest harness** + baselines (naive / seasonal-naive / drift) + metrics (MAE, RMSE, MAPE, sMAPE, **MASE**, pinball loss, interval coverage). Wrap the existing `lstmForecastService` so **every forecast is persisted** (inputs hash, model version, PIs), scored vs baseline, and **demoted to the baseline if MASE ≥ 1** (the gate). Ex-post **accuracy-capture job** compares predicted vs realized as periods elapse.
- **Why:** turns today's "trust me" forecast into an auditable, versioned, baseline-validated one — directly satisfies *validate-vs-baselines / versioning / no-eval-leakage*. Foundation for drift (F5) and champion/challenger (F9). No ML internals change → low risk.
- **Exit:** 100% of forecasts persisted + versioned + gated; realized accuracy tracked; tests + commit.
- **Risk:** low. **Effort:** M.

## F4 — Multi-model ensemble + calibrated probabilistic intervals  *(kills single-model)*
- **Do:** members = baselines + classical (Holt-Winters/ETS/ARIMA) + GBM (LightGBM via Python worker) + DL (existing Bi-LSTM). Combine via **backtest-weighted stacking**. Wrap in **conformal prediction** for distribution-free, calibrated PIs (replaces heuristic ±% bands). All behind the F3 baseline gate.
- **Why:** satisfies *never single-model* + *uncertainty*; materially better accuracy & honest intervals.
- **Exit:** ensemble beats best single member AND baseline on backtest; conformal coverage ≈ nominal; tests + commit.
- **Risk:** med (needs Python GBM worker — graceful Node fallback kept). **Effort:** L.

## F5 — Incremental retraining + drift detection  *(automation)*
- **Do:** retrain scheduler (nightly/weekly + **drift-triggered**), warm-start from champion, champion/challenger shadow eval. Drift monitor: PSI/KL on features + accuracy-decay trigger reading `ForecastAccuracy`.
- **Why:** *incremental retraining* rule; keeps models fresh without manual ops; safe promotion.
- **Exit:** auto-retrain + drift alerts live; promotion only when challenger beats champion on backtest; leakage tests (walk-forward only). Commit.
- **Risk:** med. **Effort:** L.

## F6 — Expand forecast domains  *(breadth of outputs)*
- **Do:** target adapters on the shared ensemble/feature spine — cash flow & **liquidity stress** (Monte-Carlo VaR), **debt exposure**, **AR payment behavior** (survival/hazard model), **inventory demand** (Croston/TFT for intermittent), **profitability**, **macro sensitivity** (factor regression).
- **Why:** delivers the full objective's forecast surface.
- **Exit:** all requested domains live with per-target validation (e.g. payment-behavior calibration curve, inventory service-level). Commit.
- **Risk:** med. **Effort:** L–XL.

## F7 — Explainability & risk intelligence  *(trust)*
- **Do:** **SHAP** (Python worker, on GBM member) + quantile/attention attribution (DL); scenario engine; risk scoring; persist `drivers[]` + plain-English explanation per run (upgrades today's rule-based proxies).
- **Why:** *explainability always*; auditor/CFO-grade transparency.
- **Exit:** every forecast carries calibrated drivers + narrative + scenario bands. Commit.
- **Risk:** low–med. **Effort:** M.

## F8 — Scale-out infrastructure  *(TRIGGERED BY METRICS, can begin any time after F4)*
- **Do (in order of trigger):** Redis forecast cache → **RabbitMQ + FastAPI inference worker pool** → **TimescaleDB** feature store (F1 schema is hypertable-ready) → **Parquet/MinIO** data lake → **Prefect/Airflow** ETL DAGs → Docker/**Kubernetes** + Prometheus/Grafana. Multi-tenant quotas + API keys.
- **Why:** "serve millions of transactions" + horizontal scale — but only as load demands.
- **Tipping points → action:**
  | Signal | Action |
  |---|---|
  | forecast p95 latency > 2s OR cache hit < 60% | add Redis + batch precompute |
  | Python inference > 1 concurrent / request spikes | RabbitMQ + worker pool + autoscale |
  | feature rows > ~50M OR Mongo aggregate > 5s | migrate feature store → TimescaleDB |
  | ETL > nightly window OR multi-source backfills | Prefect/Airflow DAGs + Parquet/MinIO |
  | > N tenants / multi-region | K8s, per-tenant quotas, regional shards |
- **Exit:** load test passes target throughput; isolation preserved (RLS + partitions). Commit per migration.
- **Risk:** med–high (infra). **Effort:** XL.

## F9 — MLOps governance + SaaS productization  *(the standalone product)*
- **Do:** MLflow model registry, Evidently monitoring dashboards, champion/challenger routing + **auto-rollback** on regression, model-version UI, accuracy SLOs + alerting, A/B. SaaS layer: usage metering, billing hooks, API-key tenancy, standalone onboarding — the "standalone SaaS forecasting product first" objective. ERP-integration adapters (budget-vs-forecast write-back).
- **Why:** productionize + sell standalone + keep ERP-compatible.
- **Exit:** governed, monitored, auto-rolling-back platform; standalone SaaS onboarding live. Commit.
- **Risk:** med. **Effort:** XL.

---

## Recommended execution sequence
**F3 → F4 → F5 → F2 → F6 → F7 → (F8 as metrics trigger) → F9.**
Rationale: make the *existing* forecasts auditable & validated first (F3, lowest risk, unlocks everything), then kill single-model (F4), then automate (F5). Pull source breadth (F2) in once the registry/accuracy loop exists so each new feature's lift is *measurable*. Then domains (F6), trust (F7). F8 runs opportunistically the moment a tipping point fires. F9 productizes.

## F3 step-by-step (so we can start immediately)
1. `models/ModelRegistry.model.js`, `models/ForecastRun.model.js`, `models/ForecastAccuracy.model.js`.
2. `services/forecasting/baselines.js` (naive, seasonal-naive, drift, moving-average) + tests.
3. `services/forecasting/backtest.js` (rolling-origin splitter) + `metrics.js` (MAE/RMSE/MAPE/sMAPE/MASE/pinball/coverage) + tests.
4. `services/forecasting/forecastStore.service.js` (persist run, register model version, compute MASE vs baseline, apply gate) + tests.
5. Wrap `lstmForecastService.generateLSTMForecast` to persist + register + gate (flag `FORECAST_REGISTRY_ENABLED`, dark-launch → shadow → enforce).
6. `jobs/forecastAccuracy.job.js` (cron: capture realized actuals vs past predictions).
7. `controllers/forecastRegistry.controller.js` + routes `/forecast-registry` (runs, accuracy, model versions, backtest report).
8. Frontend: accuracy/baseline badge on the forecast page. Tests, doc, commit + push.

*Each phase: feature-flagged · tested · committed · backward-compatible. Existing `/forecast` responses are preserved and enriched, never broken.*
