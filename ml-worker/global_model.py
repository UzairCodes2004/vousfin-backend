"""
global_model.py — the global / transfer-learning model (B3).

ONE LightGBM model trained across MANY businesses' (de-identified, scaled) monthly
series via Nixtla's mlforecast. Because it has learned cross-business seasonality
and dynamics, it produces a strong forecast for a NEW or thin-data business on day
one (the cold-start win) — by calling `predict(new_df=...)` with just that
business's recent history, no per-tenant training required.

Privacy: training consumes only aggregated monthly series keyed by an opaque
unique_id; no transaction-level or identifying data is shared across tenants, and
inference for one business never reads another's data.

SHAP explanations are computed over the same LightGBM model for the /explain path.
"""
from __future__ import annotations

from typing import Dict, List, Optional
import os
import numpy as np
import pandas as pd

try:
    from mlforecast import MLForecast
    from mlforecast.target_transforms import Differences
    from lightgbm import LGBMRegressor
    _HAVE_ML = True
except Exception:  # pragma: no cover
    _HAVE_ML = False

try:
    import shap
    _HAVE_SHAP = True
except Exception:  # pragma: no cover
    _HAVE_SHAP = False

import joblib

LAGS = [1, 2, 3, 6, 12]
DATE_FEATURES = ["month", "quarter"]


def _make_forecaster() -> "MLForecast":
    return MLForecast(
        models={"lgbm": LGBMRegressor(
            n_estimators=300, learning_rate=0.05, num_leaves=31,
            min_child_samples=20, subsample=0.9, colsample_bytree=0.9,
            reg_alpha=0.1, reg_lambda=0.1, random_state=42, verbosity=-1,
        )},
        freq="MS",
        lags=LAGS,
        date_features=DATE_FEATURES,
        target_transforms=[Differences([1])],  # remove trend so trees can extrapolate
    )


class GlobalModel:
    """Train / persist / forecast / explain the cross-tenant global model."""

    def __init__(self, artifact_dir: str = "artifacts"):
        self.artifact_dir = artifact_dir
        self.path = os.path.join(artifact_dir, "global_mlforecast.joblib")
        self.fcst: Optional["MLForecast"] = None
        os.makedirs(artifact_dir, exist_ok=True)

    @property
    def ready(self) -> bool:
        return self.fcst is not None

    def load(self) -> bool:
        if os.path.exists(self.path):
            try:
                self.fcst = joblib.load(self.path)
                return True
            except Exception:
                self.fcst = None
        return False

    def train(self, panel: pd.DataFrame, min_series_len: int = 8) -> Dict[str, object]:
        """Train on a multi-series panel [unique_id, ds, y]. Returns stats."""
        if not _HAVE_ML:
            return {"trained": False, "reason": "mlforecast/lightgbm not installed"}
        counts = panel.groupby("unique_id").size()
        keep = counts[counts >= min_series_len].index
        panel = panel[panel["unique_id"].isin(keep)].copy()
        n_series = panel["unique_id"].nunique()
        if n_series < 2 or len(panel) < 30:
            return {"trained": False, "reason": "insufficient_panel", "series": int(n_series)}
        self.fcst = _make_forecaster()
        self.fcst.fit(panel[["unique_id", "ds", "y"]], static_features=[])
        joblib.dump(self.fcst, self.path)
        return {"trained": True, "series": int(n_series), "rows": int(len(panel)), "artifact": self.path}

    def forecast(self, series_df: pd.DataFrame, horizon: int) -> Optional[Dict[str, object]]:
        """Forecast one (possibly unseen) series with the global model."""
        if not self.ready:
            return None
        try:
            preds = self.fcst.predict(h=horizon, new_df=series_df[["unique_id", "ds", "y"]])
            yhat = preds["lgbm"].clip(lower=0).round(2).tolist()
            return {"predicted": yhat, "modelType": "Global LightGBM (transfer)"}
        except Exception:
            return None

    def explain(self, series_df: pd.DataFrame) -> Optional[Dict[str, object]]:
        """SHAP attribution of the most-recent feature row for one series."""
        if not self.ready or not _HAVE_SHAP:
            return None
        try:
            prep = self.fcst.preprocess(series_df[["unique_id", "ds", "y"]])
            drop = [c for c in ("unique_id", "ds", "y") if c in prep.columns]
            X = prep.drop(columns=drop)
            if X.empty:
                return None
            model = self.fcst.models_["lgbm"]
            explainer = shap.TreeExplainer(model)
            row = X.iloc[[-1]]
            sv = explainer.shap_values(row)
            vals = np.asarray(sv)[0] if isinstance(sv, list) else np.asarray(sv).reshape(-1)
            base = float(np.asarray(explainer.expected_value).reshape(-1)[0])
            drivers = sorted(
                ({"name": c, "shap": round(float(v), 4)} for c, v in zip(X.columns, vals)),
                key=lambda d: abs(d["shap"]), reverse=True,
            )[:10]
            return {"baseValue": round(base, 4), "drivers": drivers, "method": "SHAP (global LightGBM)"}
        except Exception:
            return None
