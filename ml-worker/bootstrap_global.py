"""
bootstrap_global.py — train the GLOBAL / transfer-learning model on a large,
diverse panel of business archetypes.

Why this exists
---------------
The cold-start win of the platform is a single LightGBM model that has seen the
monthly dynamics of MANY businesses, so a NEW or thin-data tenant (e.g. only 4
months of history) gets a forecast that already "knows" what real businesses do —
seasonality shapes, trend persistence, mean-reversion — instead of a dead-flat
line. That model needs to be TRAINED before it can help.

We do not (and must not) train on other tenants' raw data — tenant isolation is
absolute. Instead we synthesize a broad prior: hundreds of realistic business
archetypes across sectors, scales, growth regimes and seasonal patterns. Each
monthly point stands in for the many transactions that roll up into it. The
transfer value is in the LEARNED monthly dynamics, which generalize; the level of
any real forecast is still anchored to that tenant's own recent history at
inference time (the model differences the series and re-integrates from the
tenant's last value).

Run it once (re-run anytime to refresh):
    python bootstrap_global.py                  # ~400 businesses, 24–36 months
    python bootstrap_global.py --businesses 800 # bigger prior

Produces artifacts/global_mlforecast.joblib, which the worker auto-loads on
startup and uses for the point forecast (dataSource='global').
"""
from __future__ import annotations

import argparse
import sys
import lightgbm  # noqa: F401 — load OpenMP runtime first (Windows), see app.py
import numpy as np
import pandas as pd

from global_model import GlobalModel

# Windows consoles default to cp1252 and crash on non-Latin glyphs; force UTF-8.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# ── Seasonal shapes (12-month multiplicative factors, mean ≈ 1.0) ──────────────
SEASONS = {
    "flat":          np.ones(12),
    "retail_q4":     np.array([0.85, 0.82, 0.90, 0.95, 1.00, 0.98, 1.02, 1.05, 1.00, 1.10, 1.35, 1.48]),
    "summer_peak":   np.array([0.80, 0.82, 0.90, 1.00, 1.15, 1.30, 1.40, 1.35, 1.10, 0.95, 0.85, 0.78]),
    "winter_peak":   np.array([1.35, 1.30, 1.10, 0.95, 0.85, 0.78, 0.75, 0.80, 0.92, 1.05, 1.20, 1.40]),
    "ramadan_eid":   np.array([1.05, 1.00, 1.20, 1.45, 1.10, 0.95, 0.90, 0.95, 1.05, 1.00, 0.98, 1.02]),
    "biweekly_b2b":  np.array([1.10, 0.90, 1.10, 0.90, 1.10, 0.92, 1.08, 0.92, 1.10, 0.90, 1.12, 0.90]),
    "school_year":   np.array([1.30, 1.05, 0.85, 0.80, 0.85, 0.70, 0.65, 1.25, 1.35, 1.10, 1.00, 0.95]),
}

# ── Archetypes: (season, monthly_growth_range, noise_cv_range, weight) ─────────
ARCHETYPES = [
    ("steady_services", "flat",        (0.000, 0.012), (0.03, 0.08), 0.18),
    ("retail_seasonal", "retail_q4",   (0.002, 0.020), (0.05, 0.12), 0.18),
    ("tourism_summer",  "summer_peak", (-0.005, 0.015),(0.06, 0.15), 0.10),
    ("utilities_winter","winter_peak", (0.000, 0.010), (0.04, 0.09), 0.08),
    ("seasonal_eid",    "ramadan_eid", (0.003, 0.022), (0.06, 0.14), 0.10),
    ("b2b_lumpy",       "biweekly_b2b",(0.001, 0.018), (0.10, 0.22), 0.12),
    ("education",       "school_year", (0.000, 0.014), (0.05, 0.12), 0.08),
    ("high_growth",     "flat",        (0.030, 0.075), (0.06, 0.16), 0.08),
    ("declining",       "flat",        (-0.040,-0.008),(0.05, 0.13), 0.08),
]


def _make_business(rng: np.random.Generator, uid: str, season: str,
                   growth_rng, noise_rng, months: int) -> pd.DataFrame:
    base = float(10 ** rng.uniform(3.3, 7.4))          # scale ~2e3 .. 2.5e7
    growth = rng.uniform(*growth_rng)                   # per-month drift
    noise_cv = rng.uniform(*noise_rng)
    season_vec = SEASONS[season]
    phase = int(rng.integers(0, 12))                    # random calendar start

    start = pd.Timestamp("2021-01-01") + pd.DateOffset(months=int(rng.integers(0, 24)))
    ds = pd.date_range(start, periods=months, freq="MS")

    y = np.empty(months)
    level = base
    for i in range(months):
        s = season_vec[(phase + i) % 12]
        shock = rng.normal(1.0, noise_cv)               # multiplicative noise
        y[i] = max(0.0, level * s * max(0.2, shock))
        level *= (1.0 + growth + rng.normal(0.0, 0.01)) # drift + small wobble

    return pd.DataFrame({"unique_id": uid, "ds": ds, "y": np.round(y, 2)})


def build_panel(n_businesses: int, seed: int = 7) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    weights = np.array([a[4] for a in ARCHETYPES], dtype=float)
    weights /= weights.sum()

    frames = []
    for k in range(n_businesses):
        name, season, growth_rng, noise_rng, _ = ARCHETYPES[rng.choice(len(ARCHETYPES), p=weights)]
        months = int(rng.integers(24, 37))              # 2–3 years of history
        frames.append(_make_business(rng, f"{name}_{k:04d}", season, growth_rng, noise_rng, months))
    panel = pd.concat(frames, ignore_index=True)
    return panel


def main() -> None:
    ap = argparse.ArgumentParser(description="Train the global cross-business transfer model.")
    ap.add_argument("--businesses", type=int, default=400, help="number of synthetic businesses")
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()

    print(f"Synthesizing {args.businesses} diverse businesses across "
          f"{len(ARCHETYPES)} archetypes / {len(SEASONS)} seasonal patterns…")
    panel = build_panel(args.businesses, args.seed)
    print(f"Panel: {panel['unique_id'].nunique()} businesses, {len(panel):,} monthly points "
          f"(each aggregates many underlying transactions).")
    print(f"Scale range: {panel['y'].min():,.0f} .. {panel['y'].max():,.0f}")

    gm = GlobalModel(artifact_dir="artifacts")
    stats = gm.train(panel)
    print("Training result:", stats)

    if stats.get("trained"):
        # Smoke-test transfer onto a brand-new thin (4-month) business.
        thin = pd.DataFrame({
            "unique_id": "new_thin_biz",
            "ds": pd.date_range("2026-02-01", periods=4, freq="MS"),
            "y": [5_904_943, 23_266_630, 30_261_510, 13_855_060],  # the user's real revenue
        })
        gm.load()
        out = gm.forecast(thin, 6)
        print("\nTransfer forecast for a 4-month business (your revenue series):")
        print(" ", out["predicted"] if out else None)
        print(" model:", out["modelType"] if out else None)
        print("\n✅ Global model trained and saved. Start the worker — it will load this "
              "artifact and serve dataSource='global' transfer forecasts.")
    else:
        print("\n⚠️  Training did not complete — see reason above.")


if __name__ == "__main__":
    main()
