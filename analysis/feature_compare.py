"""Feature-level comparisons, effect sizes and a few robustness checks."""

from __future__ import annotations

import json
import os

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
OUT = os.path.join(HERE, "output")


def load() -> pd.DataFrame:
    df = pd.read_csv(os.path.join(DATA, "features.csv"))
    df["win"] = df["profit"] > 0
    df["align3"] = 0
    bull = df["m30_trendStack"] == "bull"
    bear = df["m30_trendStack"] == "bear"
    long = df["direction"] == "long"
    short = df["direction"] == "short"
    df.loc[(long & bull) | (short & bear), "align3"] = 1
    df.loc[(long & bear) | (short & bull), "align3"] = -1
    df["actual_risk"] = np.where(
        df["reliable_initial_risk"],
        (df["open_price"] - df["initial_sl"]).abs() * df["lot_size"] * df["contract_size"],
        np.nan,
    )
    df["sl_atr"] = df["actual_risk"] / (df["m30_atr14"] * df["lot_size"] * df["contract_size"])
    return df


def mw_pvalue(a: np.ndarray, b: np.ndarray) -> float:
    """Two-sided Mann-Whitney U via normal approximation with tie correction."""
    n1, n2 = len(a), len(b)
    if n1 < 3 or n2 < 3:
        return float("nan")
    allv = np.concatenate([a, b])
    ranks = pd.Series(allv).rank(method="average").to_numpy()
    r1 = ranks[:n1].sum()
    u1 = r1 - n1 * (n1 + 1) / 2
    mu = n1 * n2 / 2
    # tie correction
    _, counts = np.unique(allv, return_counts=True)
    tie = np.sum(counts**3 - counts)
    sigma = np.sqrt((n1 * n2 / 12) * ((n1 + n2 + 1) - tie / ((n1 + n2) * (n1 + n2 - 1))))
    if sigma == 0:
        return 1.0
    z = (u1 - mu) / sigma
    # normal CDF
    from math import erf, sqrt

    return float(2 * (1 - 0.5 * (1 + erf(abs(z) / sqrt(2)))))


def cliffs_delta(a: np.ndarray, b: np.ndarray) -> float:
    """P(a > b) - P(a < b), a robust effect size."""
    if len(a) == 0 or len(b) == 0:
        return float("nan")
    # O(n log n) via ranks: U / (n1*n2)
    allv = np.concatenate([a, b])
    ranks = pd.Series(allv).rank(method="average").to_numpy()
    u = ranks[: len(a)].sum() - len(a) * (len(a) + 1) / 2
    return float(2 * u / (len(a) * len(b)) - 1)


def bootstrap_diff(a: np.ndarray, b: np.ndarray, n=5000, seed=7):
    rng = np.random.default_rng(seed)
    diffs = []
    for _ in range(n):
        diffs.append(rng.choice(a, len(a), replace=True).mean() - rng.choice(b, len(b), replace=True).mean())
    return float(np.percentile(diffs, 2.5)), float(np.percentile(diffs, 97.5))


def main() -> None:
    df = load()
    print("align3 counts", df.align3.value_counts().to_dict())
    print(df.groupby("align3").agg(n=("win", "size"), win=("win", "mean"), pnl=("profit", "sum"), r=("r_target", "mean")).round(3).to_string())
    print("\nalign3 by session win")
    print(df.pivot_table(index="session_id", columns="align3", values="win", aggfunc="mean").round(2).to_string())
    print("\nalign3 by session pnl")
    print(df.pivot_table(index="session_id", columns="align3", values="profit", aggfunc="sum").round(0).to_string())

    # Pre-entry feature comparisons
    feats = [
        "m30_dir_pos",
        "m30_dir_rsi",
        "m30_dir_slope",
        "m30_dir_dist_ema20",
        "m30_atr_pct",
        "m30_aligned",
        "align3",
        "planned_rr",
        "sl_atr",
        "hour",
        "weekday",
        "holding_min",
    ]
    rows = []
    for f in feats:
        if f not in df:
            continue
        a = df[df.win][f].dropna().to_numpy(dtype=float)
        b = df[~df.win][f].dropna().to_numpy(dtype=float)
        if len(a) < 5 or len(b) < 5:
            continue
        lo, hi = bootstrap_diff(a, b)
        rows.append(
            {
                "feature": f,
                "n_win": len(a),
                "n_loss": len(b),
                "mean_win": a.mean(),
                "mean_loss": b.mean(),
                "median_win": np.median(a),
                "median_loss": np.median(b),
                "cliffs_delta": cliffs_delta(a, b),
                "p_mw": mw_pvalue(a, b),
                "diff_ci_low": lo,
                "diff_ci_high": hi,
            }
        )
    out = pd.DataFrame(rows).sort_values("cliffs_delta")
    print("\nfeature comparisons")
    print(out.round(3).to_string(index=False))
    out.to_csv(os.path.join(OUT, "feature_compare.csv"), index=False)

    # MFE30 low vs high per session
    df["mfe30_low"] = df["mfe30"] < 0.5
    print("\nMFE30 <0.5 by session")
    print(df.groupby(["session_id", "mfe30_low"]).agg(n=("win", "size"), win=("win", "mean"), pnl=("profit", "sum")).round(2).to_string())

    # planned RR by book
    print("\nplanned RR by book")
    print(df.groupby(["book", "win"]).agg(n=("win", "size"), planned_rr=("planned_rr", "median"), mfe30=("mfe30", "median")).round(2).to_string())
    print("\nplanned RR quantiles (fixed book)")
    fixed = df[df.book == "fixed"]
    print(fixed.planned_rr.describe().round(2).to_string())
    print(fixed.groupby(pd.cut(fixed.planned_rr, [0, 1.5, 2, 3, 5, 99])).agg(n=("win", "size"), win=("win", "mean"), pnl=("profit", "sum")).round(2).to_string())

    # stop distance by alignment / outcome
    print("\nsl_atr by book")
    print(df.groupby("book").sl_atr.describe().round(2).to_string())

    # time of day consistency
    print("\nhour 13 vs rest per session")
    for sid, g in df.groupby("session_id"):
        h = g[g.hour == 13]
        r = g[g.hour != 13]
        if len(h):
            print(sid, "h13", len(h), round(h.win.mean(), 2), round(h.profit.sum(), 0), "rest", len(r), round(r.win.mean(), 2), round(r.profit.sum(), 0))
    print("\nhour 15 vs rest per session")
    for sid, g in df.groupby("session_id"):
        h = g[g.hour == 15]
        r = g[g.hour != 15]
        if len(h):
            print(sid, "h15", len(h), round(h.win.mean(), 2), round(h.profit.sum(), 0), "rest", len(r), round(r.win.mean(), 2), round(r.profit.sum(), 0))

    # Friday
    print("\nFriday per session")
    for sid, g in df.groupby("session_id"):
        f = g[g.weekday == 5]
        print(sid, len(f), round(f.win.mean(), 2) if len(f) else None, round(f.profit.sum(), 0) if len(f) else None)

    # session 1/8/10 same period
    print("\nsame-period sessions 1/8/10")
    print(df[df.session_id.isin([1, 8, 10])].groupby("session_id").agg(n=("win", "size"), win=("win", "mean"), pnl=("profit", "sum"), r=("r_target", "mean"), mfe30=("mfe30", "median")).round(3).to_string())


if __name__ == "__main__":
    main()
