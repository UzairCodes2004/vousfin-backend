"""
adapters.py — convert the Node forecast payload into model-ready series.

The Node side (lstmForecastService) posts a business's raw transactions. We
collapse them into a monthly series for the requested target, in the exact
panel format statsforecast / mlforecast expect:

    DataFrame[ unique_id, ds, y ]

`unique_id` is the businessId (so the same code handles one series at inference
and many series at global-training time).
"""
from __future__ import annotations

from typing import List, Dict, Any
import pandas as pd

REVENUE_TYPES = {"income", "sale", "receipt", "cash sale", "credit sale", "inventory sale"}
EXPENSE_TYPES = {"expense", "purchase", "payment", "cash purchase", "credit purchase",
                 "inventory purchase", "salary", "fee", "tax"}


def _classify(txn: Dict[str, Any]) -> str:
    """Return 'revenue' | 'expense' | 'other' for a transaction, mirroring Node.

    Ledger truth FIRST: revenue is what is credited to a Revenue/Income account;
    expense is what is debited to an Expense/Cost account. This mirrors the Node
    aggregation (lstmForecastService.fetchMonthlyData) exactly, so the worker and
    the in-process fallback can never disagree on the numbers.

    We must NOT classify by `transactionType` when an account type is known: in a
    double-entry ledger a customer *receipt* (Dr Bank / Cr Accounts Receivable)
    has a "receipt"/"sale" transactionType but credits a balance-sheet account,
    not Revenue. Counting it as revenue double-counts the original sale and
    inflates the series toward the sum of *all* credits. transactionType is only
    a last-resort fallback when neither account type is present on the payload.
    """
    credit = str(txn.get("creditAccountType", "")).strip().lower()
    debit = str(txn.get("debitAccountType", "")).strip().lower()
    if credit in {"revenue", "income"}:
        return "revenue"
    if debit in {"expense", "direct cost", "cost"}:
        return "expense"
    if not credit and not debit:  # account types unknown → fall back to type label
        ttype = str(txn.get("transactionType", "")).strip().lower()
        if ttype in REVENUE_TYPES:
            return "revenue"
        if ttype in EXPENSE_TYPES:
            return "expense"
    return "other"


def to_monthly_series(transactions: List[Dict[str, Any]], target: str, unique_id: str) -> pd.DataFrame:
    """Aggregate transactions → one monthly series for `target`.

    target ∈ {Revenue, Expenses, Net Cash Flow / Profit}.
    Returns a tidy panel frame [unique_id, ds, y] sorted by ds (month start).
    """
    if not transactions:
        return pd.DataFrame(columns=["unique_id", "ds", "y"])

    rows = []
    for t in transactions:
        date = str(t.get("transactionDate", ""))[:7]  # YYYY-MM
        if len(date) < 7:
            continue
        amount = float(t.get("amount") or 0.0)
        rows.append({"month": date, "kind": _classify(t), "amount": amount})

    if not rows:
        return pd.DataFrame(columns=["unique_id", "ds", "y"])

    df = pd.DataFrame(rows)
    pivot = df.pivot_table(index="month", columns="kind", values="amount", aggfunc="sum", fill_value=0.0)
    for col in ("revenue", "expense"):
        if col not in pivot.columns:
            pivot[col] = 0.0

    tl = target.strip().lower()
    if tl in ("expenses", "expense"):
        y = pivot["expense"]
    elif tl in ("net cash flow", "profit", "profitability", "cash flow"):
        y = pivot["revenue"] - pivot["expense"]
    else:  # Revenue (default)
        y = pivot["revenue"]

    out = pd.DataFrame({
        "unique_id": unique_id,
        "ds": pd.to_datetime(pivot.index + "-01"),
        "y": y.values.astype(float),
    }).sort_values("ds").reset_index(drop=True)
    return out


def horizon_labels(last_ds: pd.Timestamp, horizon: int) -> List[str]:
    """Month labels (Jan, Feb, …) for the forecast horizon after `last_ds`."""
    months = pd.date_range(last_ds, periods=horizon + 1, freq="MS")[1:]
    return [m.strftime("%b") for m in months]
