"""
store.py — training-data store for the global model.

Accumulates de-identified monthly series (keyed by opaque unique_id) from
forecast/ingest calls into a single panel parquet, which the training job reads.
Only aggregated monthly (unique_id, ds, y) rows are kept — never transactions.
"""
from __future__ import annotations

import os
import pandas as pd


class TrainingStore:
    def __init__(self, data_dir: str = "data"):
        os.makedirs(data_dir, exist_ok=True)
        self.path = os.path.join(data_dir, "panel.parquet")

    def ingest(self, series_df: pd.DataFrame) -> int:
        """Upsert a series into the panel (dedupe by unique_id+ds, keep newest)."""
        if series_df is None or series_df.empty:
            return 0
        incoming = series_df[["unique_id", "ds", "y"]].copy()
        if os.path.exists(self.path):
            existing = pd.read_parquet(self.path)
            combined = pd.concat([existing, incoming], ignore_index=True)
        else:
            combined = incoming
        combined = combined.drop_duplicates(subset=["unique_id", "ds"], keep="last")
        combined.to_parquet(self.path, index=False)
        return int(len(incoming))

    def panel(self) -> pd.DataFrame:
        if os.path.exists(self.path):
            return pd.read_parquet(self.path)
        return pd.DataFrame(columns=["unique_id", "ds", "y"])

    def stats(self) -> dict:
        p = self.panel()
        return {"series": int(p["unique_id"].nunique()) if len(p) else 0, "rows": int(len(p))}
