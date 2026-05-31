"""
VousFin ML Inference Worker — FastAPI (F8).

The Python side of the forecasting platform. The Node API (inferenceClient.js)
calls these endpoints for the heavy/non-linear models (Bi-LSTM / TFT / LightGBM /
SHAP); when this worker is down or slow, Node's circuit breaker falls back to the
in-process classical ensemble, so the product never hard-fails.

Contract (must stay stable — Node depends on it):
  GET  /api/v1/vousfin/health   -> { "ready": true }
  POST /api/v1/vousfin/forecast -> { predicted[], lower[], upper[], labels[], modelType }
  POST /api/v1/vousfin/explain  -> { drivers[], baseValue }   (SHAP)

Runnable skeleton: health is real; forecast/explain return a clearly labelled
placeholder so the wiring is testable before trained models drop in. Replace the
bodies with PyTorch-Forecasting / LightGBM / SHAP implementations.
"""
from __future__ import annotations

from typing import List
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI(title="VousFin ML Worker", version="0.1.0")

MODEL_READY = True  # set True once trained artifacts load at startup


class Txn(BaseModel):
    transactionDate: str
    amount: float
    transactionType: str = "Income"


class ForecastRequest(BaseModel):
    businessId: str
    target: str = "Revenue"
    horizonMonths: int = 6
    returnUncertainty: bool = True
    transactions: List[Txn] = []


class ExplainRequest(BaseModel):
    businessId: str
    target: str = "Revenue"
    features: dict = {}


@app.get("/api/v1/vousfin/health")
def health():
    return {"ready": MODEL_READY}


@app.post("/api/v1/vousfin/forecast")
def forecast(req: ForecastRequest):
    """Placeholder: monthly aggregate + naive carry-forward with a widening band.
    Swap for the Bi-LSTM/TFT inference. Shape matches what Node expects."""
    monthly: dict = {}
    for t in req.transactions:
        key = t.transactionDate[:7]
        monthly[key] = monthly.get(key, 0.0) + (t.amount or 0.0)
    series = [monthly[k] for k in sorted(monthly)]
    last = series[-1] if series else 0.0
    predicted = [round(last, 2) for _ in range(req.horizonMonths)]
    lower = [round(v * (1 - 0.05 * (i + 1)), 2) for i, v in enumerate(predicted)]
    upper = [round(v * (1 + 0.05 * (i + 1)), 2) for i, v in enumerate(predicted)]
    return {
        "predicted": predicted, "lower": lower, "upper": upper,
        "labels": [f"M+{i+1}" for i in range(req.horizonMonths)],
        "modelType": "ML Worker (placeholder — install trained Bi-LSTM/TFT)",
    }


@app.post("/api/v1/vousfin/explain")
def explain(req: ExplainRequest):
    """Placeholder SHAP: rank provided features by absolute magnitude.
    Swap for shap.Explainer over the GBM/DL member."""
    items = sorted(req.features.items(), key=lambda kv: abs(kv[1] or 0), reverse=True)
    return {
        "baseValue": 0.0,
        "drivers": [{"name": k, "shap": round(v, 4)} for k, v in items[:10]],
        "method": "placeholder — install SHAP over the GBM member",
    }
