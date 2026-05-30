# Forecast Platform — F5: Incremental Retraining + Drift Detection

> Closes the MLOps loop: the platform watches its own forecasts for drift/decay
> and retrains automatically, promoting a new model only when it provably beats
> the incumbent. Flag-gated (`FORECAST_RETRAIN_ENABLED`, default on), backward-
> compatible, fully audited.

## Drift detection (`drift.js`, pure)
- **Data/concept drift** — Population Stability Index (PSI) + KL divergence
  between a reference window and a recent window of the target series.
  Bands: `<0.1 none · 0.1–0.25 moderate · >0.25 severe`.
- **Accuracy decay** — compares the model's realized error (from the F3
  `ForecastAccuracy` store) in an earlier vs recent window; a material rise flags decay.

## Drift monitor (`driftMonitor.service.js`)
`checkDrift(businessId, {target})` → PSI/severity + accuracy-decay → `shouldRetrain`,
logged to **`ForecastDriftEvent`** for an auditable retrain rationale. Uses
**adaptive bin counts** (~3 points/bin, capped) so small windows don't manufacture
spurious drift.

## Champion / challenger (`championChallenger.service.js`)
`retrain(businessId, {target})` rebuilds the ensemble's skill weights on the
freshest data, backtests it, and registers a new **`ModelRegistry`** version as a
**challenger**. It is promoted to **champion** only if it **(a) passes the F3
baseline gate AND (b) beats the current champion's MASE**; otherwise the champion
stays and the challenger is retired/kept. Old champion → `retired`. Every decision
is audited + emits `forecast.retrained`.

## Scheduling (`jobs/forecastRetrain.job.js`)
Weekly (Mon 03:00) sweep: for each business with recent forecasts, per target →
`checkDrift` then retrain (weekly cadence forces a refit; drift/decay also triggers
mid-week via the same path). One tenant/target failure never aborts the batch.

## Files
**New:** `services/forecasting/drift.js`, `driftMonitor.service.js`,
`championChallenger.service.js`, `models/ForecastDriftEvent.model.js`,
`jobs/forecastRetrain.job.js`. **Wired:** `config` (flag), `server.js` (cron),
`controllers/forecastRegistry.controller.js` + routes.

## API
`POST /forecast-registry/retrain` (retrain + promotion decision) ·
`GET /forecast-registry/drift?target=` (drift + decay check) ·
`GET /forecast-registry/champion?target=` (current champion model).

## Safety / invariants
- **Safe promotion:** never promotes a model that fails the baseline gate or loses
  to the champion. **Versioned + audited:** every challenger is a registry version
  with metrics + a logged decision.
- **DB-guarded + isolated:** all writes guarded by connection state and scoped to
  `businessId`; the sweep is per-tenant.
- **No leakage:** retrain weights + drift residuals come from walk-forward folds.

## Validation
15 new unit tests — drift science (PSI ~0 identical / large shifted, KL, severity
bands, accuracy decay flag/stable/short-safe), champion/challenger (first champion,
promote-over-worse, keep-on-worse, reject-on-failed-gate, insufficient-history),
drift monitor (severe→retrain, stable→no-retrain, accuracy-decay→retrain). Full
backend suite **632 passing**, 4 pre-existing unrelated suites unchanged.

## Next (roadmap): F2 source coverage, then F6 domains / F7 explainability
With the registry + accuracy + retrain loop in place, new feature sources (F2) and
forecast domains (F6) now show *measurable* lift, and explainability (F7) attaches
to the gated champion.
