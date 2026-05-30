# Forecast Platform — F3: Model Registry + Persistence + Baseline Gate

> Turns VousFin's forecasts from "trust me" into **auditable, versioned, and
> baseline-validated** outputs. Foundation for F4 (ensemble), F5 (drift) and F9
> (champion/challenger). Fully backward-compatible and flag-gated
> (`FORECAST_REGISTRY_ENABLED`, default on).

## What it adds
1. **Forecast persistence** — every served forecast is written to `ForecastRun`
   with an inputs hash, model version, prediction + interval, and the gate verdict.
2. **Walk-forward backtesting** — `backtest.js` rolling-origin harness; any
   forecaster (baseline, classical, later the ensemble) is scored through one
   leakage-safe path. Metrics: MAE, RMSE, MAPE, sMAPE, **MASE**, pinball, coverage.
3. **Baseline gate** — the model is backtested against **seasonal-naive** on the
   same folds; it only earns `champion` status if it beats the baseline (else it
   is registered as `baseline` and flagged), enforcing *"validate vs naive baselines."*
4. **Model registry** — `ModelRegistry` versions every model with its backtest
   metrics, the baseline it beat, training window, code hash, and status.
5. **Ex-post accuracy** — a daily job captures realized actuals vs predictions
   per horizon step (`ForecastAccuracy`) → true out-of-sample error + interval coverage.

## Files
**Services (pure science):** `services/forecasting/metrics.js`, `baselines.js`,
`classical.js`, `backtest.js`. **Governance:** `forecastStore.service.js`
(gate · register · persist · capture). **Models:** `ModelRegistry`, `ForecastRun`,
`ForecastAccuracy`. **Job:** `jobs/forecastAccuracy.job.js` (cron 09:00). **API:**
`controllers/forecastRegistry.controller.js` + `routes/v1/forecastRegistry.routes.js`.
**Wired:** `lstmForecastService` (fire-and-forget recording at both real-forecast
returns), `config` (flag), `server.js` (job), `routes/index.js`.

## Database
- **ModelRegistry** `{businessId, key:`target-granularity`, version, modelType, backtest{mae,rmse,mase,…}, baselineMase, modelMase, gatePassed, gateReason, trainWindow, codeHash, status:champion|challenger|baseline|retired}`.
- **ForecastRun** `{businessId, target, granularity, horizon, modelType, modelVersion, inputsHash, predicted[], lower[], upper[], baselineMase, modelMase, gatePassed, servedBaseline, generatedAt}`.
- **ForecastAccuracy** `{businessId, forecastRunId, target, horizonStep, periodKey, predicted, actual, absError, pctError, withinInterval}` (unique per run×step).

## APIs (`/api/v1/forecast-registry`, auth + business scoped)
`GET /runs` · `GET /models` · `GET /accuracy` (realized MAE/MAPE/coverage by target) · `POST /backtest` (backtest classical vs seasonal-naive now, register) · `POST /accuracy/run` (capture realized accuracy on demand).

## Safety / invariants
- **Leakage-safe:** backtest folds always train on the prefix and predict the future slice; MASE per fold scaled by that fold's own training.
- **Never blocks a forecast:** all registry writes are DB-readyState-guarded + fire-and-forget; a registry failure can never slow or break the served forecast.
- **Tenant isolation:** every store query is `businessId`-scoped.
- **Backward compatible:** existing `/forecast` responses unchanged (only enriched with an optional `baselineGate` field).

## Validation
20 unit tests — metrics, baselines, classical, walk-forward harness (train precedes test; drift beats naive; winner ranking), gate logic (beats/loses seasonal-naive, naive floor, fail-safe), register/persist (versioning, inputs hash), fire-and-forget safety. Full backend suite **608 passing**, 4 pre-existing unrelated suites unchanged.

## Next (per roadmap): F4 — multi-model ensemble + conformal intervals
The classical forecaster + backtest harness already plug into the ensemble; F4 adds GBM + LSTM members, backtest-weighted stacking, and conformal-calibrated intervals — all scored through this same gate.
