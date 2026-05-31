# VousFin ML Inference Worker (F8)

Python/FastAPI service for the heavy/non-linear forecasting models (Bi-LSTM, TFT,
LightGBM, SHAP). The Node backend (`services/forecasting/infra/inferenceClient.js`)
calls it; a circuit breaker on the Node side means the product falls back to the
in-process classical ensemble whenever this worker is unavailable.

## Run locally
```bash
pip install -r requirements.txt
uvicorn app:app --host 0.0.0.0 --port 8000
```
Point the backend at it with `INFERENCE_URL=http://localhost:8000`.

## Contract (keep stable — Node depends on it)
| Method | Path | Response |
|---|---|---|
| GET | `/api/v1/vousfin/health` | `{ ready: bool }` |
| POST | `/api/v1/vousfin/forecast` | `{ predicted[], lower[], upper[], labels[], modelType }` |
| POST | `/api/v1/vousfin/explain` | `{ baseValue, drivers[] }` (SHAP) |

`app.py` ships a runnable placeholder (health is real; forecast/explain return
clearly-labelled stubs) so the end-to-end wiring is testable before trained
artifacts are added. Replace the endpoint bodies with PyTorch-Forecasting /
LightGBM / SHAP implementations and set `MODEL_READY` after loading them.

## Container
`docker build -f ../deploy/Dockerfile.worker -t vousfin-ml-worker .`
(or via `deploy/docker-compose.yml` / `deploy/k8s/forecast-platform.yaml`).
