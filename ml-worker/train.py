"""
train.py — offline trainer for the global model.

Usage:
    python train.py                     # train from the accumulated store panel
    python train.py --csv panel.csv     # train from a CSV with columns unique_id,ds,y

The CSV/parquet must be a multi-series panel: one row per (business, month) with
columns [unique_id, ds, y]. Saves artifacts/global_mlforecast.joblib, which the
running worker auto-loads on its next /train call or restart.
"""
from __future__ import annotations

import argparse
import pandas as pd

from global_model import GlobalModel
from store import TrainingStore


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", help="path to a multi-series panel CSV (unique_id,ds,y)")
    ap.add_argument("--artifacts", default="artifacts")
    args = ap.parse_args()

    if args.csv:
        panel = pd.read_csv(args.csv, parse_dates=["ds"])
    else:
        panel = TrainingStore().panel()

    print(f"[train] panel: {panel['unique_id'].nunique() if len(panel) else 0} series, {len(panel)} rows")
    stats = GlobalModel(artifact_dir=args.artifacts).train(panel)
    print(f"[train] {stats}")


if __name__ == "__main__":
    main()
