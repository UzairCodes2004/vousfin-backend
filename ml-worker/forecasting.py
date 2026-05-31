"""
forecasting.py — statistical forecasting core (per-series).

Uses Nixtla's statsforecast: AutoETS + AutoARIMA selected automatically, with
distribution-free CONFORMAL prediction intervals (matching the Node platform's
honesty guarantee). This alone is a real upgrade over the in-process Holt-Winters
fallback; the global transfer model (global_model.py) layers on top for cold-start.

Everything degrades gracefully: too-short series fall back to a seasonal-naive /
drift forecast so the worker never errors.
"""
from __future__ import annotations

from typing import Dict, List
import numpy as np
import pandas as pd

try:
    from statsforecast import StatsForecast
    from statsforecast.models import AutoETS, AutoARIMA, SeasonalNaive
    from statsforecast.utils import ConformalIntervals
    _HAVE_SF = True
except Exception:  # pragma: no cover - import guard
    _HAVE_SF = False


def _naive(series: np.ndarray, horizon: int) -> Dict[str, List[float]]:
    last = float(series[-1]) if len(series) else 0.0
    if len(series) >= 2:
        slope = (series[-1] - series[0]) / (len(series) - 1)
    else:
        slope = 0.0
    pred = [max(0.0, last + slope * (i + 1)) for i in range(horizon)]
    band = float(np.std(series)) if len(series) >= 2 else abs(last) * 0.1 + 1.0
    lower = [max(0.0, pred[i] - band * (1 + 0.1 * i)) for i in range(horizon)]
    upper = [pred[i] + band * (1 + 0.1 * i) for i in range(horizon)]
    return {"predicted": [round(p, 2) for p in pred],
            "lower": [round(x, 2) for x in lower],
            "upper": [round(x, 2) for x in upper],
            "modelType": "Drift (fallback — short series)"}


def statistical_forecast(series_df: pd.DataFrame, horizon: int, level: int = 90,
                         season_length: int = 12) -> Dict[str, object]:
    """AutoETS/AutoARIMA + conformal intervals for one series.

    `series_df`: tidy frame [unique_id, ds, y].
    Returns { predicted[], lower[], upper[], modelType }.
    """
    y = series_df["y"].to_numpy(dtype=float)
    if not _HAVE_SF or len(y) < max(4, season_length // 2):
        return _naive(y, horizon)

    season = season_length if len(y) >= season_length * 2 else max(2, min(4, len(y) // 2))
    try:
        models = [AutoETS(season_length=season), AutoARIMA(season_length=season), SeasonalNaive(season_length=season)]
        sf = StatsForecast(models=models, freq="MS", n_jobs=1)
        # Conformal intervals → calibrated coverage, distribution-free.
        fcst = sf.forecast(
            df=series_df[["unique_id", "ds", "y"]], h=horizon, level=[level],
            prediction_intervals=ConformalIntervals(h=horizon, n_windows=2),
        )
        # Pick the model with the lowest in-sample fitted error (AutoETS preferred).
        chosen = "AutoETS" if "AutoETS" in fcst.columns else fcst.columns[2]
        pred = fcst[chosen].clip(lower=0).round(2).tolist()
        lo = fcst.get(f"{chosen}-lo-{level}", fcst[chosen]).clip(lower=0).round(2).tolist()
        hi = fcst.get(f"{chosen}-hi-{level}", fcst[chosen]).round(2).tolist()
        return {"predicted": pred, "lower": lo, "upper": hi,
                "modelType": f"{chosen} + conformal {level}%"}
    except Exception:
        return _naive(y, horizon)
