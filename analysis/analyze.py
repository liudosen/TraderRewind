"""Core statistics for the report (reads the MCP-derived features.csv)."""

from __future__ import annotations

import json
import os
import sys

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
OUT = os.path.join(HERE, "output")
os.makedirs(OUT, exist_ok=True)

pd.set_option("display.width", 200)
pd.set_option("display.max_columns", 60)


def load() -> pd.DataFrame:
    df = pd.read_csv(os.path.join(DATA, "features.csv"))
    df["win"] = df["profit"] > 0
    df["m30_aligned_n"] = df["m30_aligned"].map({True: 1, False: -1}).fillna(0)
    df["dir_pos"] = df["m30_dir_pos"]
    df["risk_target"] = df["risk_target"].fillna(100)
    df["actual_risk"] = np.where(
        df["reliable_initial_risk"],
        (df["open_price"] - df["initial_sl"]).abs() * df["lot_size"] * df["contract_size"],
        np.nan,
    )
    df["sl_atr"] = df["actual_risk"] / (df["m30_atr14"] * df["lot_size"] * df["contract_size"])
    df["mfe_r"] = df["exc_mfeR"]
    df["mae_r"] = df["exc_maeR"]
    df["r_target"] = df["r_target"]
    df["book"] = df["book"].fillna("unknown")
    return df


def wc(df: pd.DataFrame) -> str:
    return f"{len(df)}"


def group(df: pd.DataFrame, col: str, order=None, min_n=1) -> pd.DataFrame:
    g = (
        df.groupby(col, observed=True)
        .agg(
            n=("win", "size"),
            wins=("win", "sum"),
            win_rate=("win", "mean"),
            pnl=("profit", "sum"),
            avg_pnl=("profit", "mean"),
            avg_r=("r_target", "mean"),
            med_hold=("holding_min", "median"),
            med_mfe30=("mfe30", "median"),
            med_mae15=("mae15", "median"),
        )
        .reset_index()
    )
    g = g[g["n"] >= min_n]
    if order:
        g["__o"] = g[col].map({k: i for i, k in enumerate(order)})
        g = g.sort_values("__o").drop(columns="__o")
    return g


def main() -> None:
    df = load()
    print("N", len(df), "sessions", df.session_id.nunique())
    print("overall", df.profit.sum().round(2), "win", df.win.mean().round(4), "avgR", df.r_target.mean().round(4))
    print("\nby session")
    print(group(df, "session_id").round(3).to_string(index=False))

    print("\nbook")
    print(group(df, "book").round(3).to_string(index=False))
    print("\nbook x session pnl")
    print(df.pivot_table(index="session_id", columns="book", values="profit", aggfunc="sum").round(0).fillna(0).to_string())

    print("\nMFE30 buckets")
    df["mfe30_b"] = pd.cut(df["mfe30"], [-0.001, 0.25, 0.5, 0.75, 1.25, 99], labels=["<0.25", "0.25-0.5", "0.5-0.75", "0.75-1.25", ">=1.25"])
    print(group(df, "mfe30_b").round(3).to_string(index=False))
    print("\nMFE30 by session (win rate, pnl)")
    print(df.pivot_table(index="session_id", columns="mfe30_b", values="win", aggfunc="mean", observed=True).round(2).to_string())

    print("\nMAE15 buckets")
    df["mae15_b"] = pd.cut(df["mae15"], [-0.001, 0.3, 0.5, 0.75, 1.0, 99], labels=["<0.3", "0.3-0.5", "0.5-0.75", "0.75-1.0", ">=1.0"])
    print(group(df, "mae15_b").round(3).to_string(index=False))

    print("\nM30 alignment")
    print(group(df, "m30_aligned").round(3).to_string(index=False))
    print("\nalignment by session win")
    print(df.pivot_table(index="session_id", columns="m30_aligned", values="win", aggfunc="mean").round(2).to_string())

    print("\nM30 dir pos quintiles")
    df["pos_q"] = pd.qcut(df["dir_pos"], 5, labels=["Q1 low", "Q2", "Q3", "Q4", "Q5 high"])
    print(group(df, "pos_q", order=["Q1 low", "Q2", "Q3", "Q4", "Q5 high"]).round(3).to_string(index=False))
    print("\ndir pos Q1/Q5 by session pnl")
    print(df[df.pos_q.isin(["Q1 low", "Q5 high"])].pivot_table(index="session_id", columns="pos_q", values="profit", aggfunc="sum", observed=True).round(0).to_string())

    print("\nplanned RR buckets")
    df["rr_b"] = pd.cut(df["planned_rr"], [-0.001, 1.5, 2, 3, 5, 99], labels=["<1.5", "1.5-2", "2-3", "3-5", ">=5"])
    print(group(df, "rr_b").round(3).to_string(index=False))

    print("\nhour")
    print(group(df, "hour").round(3).to_string(index=False))
    print("\nhour13/15 by session")
    for sid, g in df.groupby("session_id"):
        h13 = g[g.hour == 13]
        h15 = g[g.hour == 15]
        print(sid, "h13", len(h13), round(h13.win.mean(), 2) if len(h13) else None, round(h13.profit.sum(), 0) if len(h13) else None,
              "h15", len(h15), round(h15.win.mean(), 2) if len(h15) else None, round(h15.profit.sum(), 0) if len(h15) else None)

    print("\nweekday")
    print(group(df, "weekday").round(3).to_string(index=False))

    print("\nstop distance in M30 ATR (reliable only)")
    sub = df[df.actual_risk.notna()].copy()
    sub["sl_atr_b"] = pd.cut(sub["sl_atr"], [0, 0.5, 0.75, 1.0, 1.25, 1.5, 99], labels=["<0.5", "0.5-0.75", "0.75-1.0", "1.0-1.25", "1.25-1.5", ">=1.5"])
    print(group(sub, "sl_atr_b", order=["<0.5", "0.5-0.75", "0.75-1.0", "1.0-1.25", "1.25-1.5", ">=1.5"]).round(3).to_string(index=False))

    print("\nactual risk reliable")
    print(sub["actual_risk"].describe().round(2).to_string())
    print("win risk", sub[sub.win].actual_risk.mean().round(2), "loss risk", sub[~sub.win].actual_risk.mean().round(2))
    print("pnl", sub.profit.sum().round(2), "normalized", (sub.r_target * 100).sum().round(2))

    print("\nMFE/MAE distributions")
    for col in ["mfe_r", "mae_r", "mfe30", "mae15", "capture"]:
        print(col, df.groupby("win")[col].median().round(3).to_dict())

    # Save key tables as JSON for report
    tables = {
        "overall": {
            "n": int(len(df)),
            "sessions": int(df.session_id.nunique()),
            "pnl": float(df.profit.sum()),
            "win_rate": float(df.win.mean()),
            "avg_r": float(df.r_target.mean()),
            "pf": float(df[df.profit > 0].profit.sum() / abs(df[df.profit < 0].profit.sum())),
            "avg_win": float(df[df.win].profit.mean()),
            "avg_loss": float(df[~df.win].profit.mean()),
            "max_dd": float(max_drawdown(df)),
        },
        "sessions": group(df, "session_id").round(4).to_dict(orient="records"),
        "book": group(df, "book").round(4).to_dict(orient="records"),
        "mfe30": group(df, "mfe30_b").round(4).to_dict(orient="records"),
        "mae15": group(df, "mae15_b").round(4).to_dict(orient="records"),
        "align": group(df, "m30_aligned").round(4).to_dict(orient="records"),
        "posq": group(df, "pos_q", order=["Q1 low", "Q2", "Q3", "Q4", "Q5 high"]).round(4).to_dict(orient="records"),
        "rr": group(df, "rr_b").round(4).to_dict(orient="records"),
        "hour": group(df, "hour").round(4).to_dict(orient="records"),
        "weekday": group(df, "weekday").round(4).to_dict(orient="records"),
        "sl_atr": group(sub, "sl_atr_b", order=["<0.5", "0.5-0.75", "0.75-1.0", "1.0-1.25", "1.25-1.5", ">=1.5"]).round(4).to_dict(orient="records"),
    }
    with open(os.path.join(OUT, "stats.json"), "w", encoding="utf-8") as f:
        json.dump(tables, f, ensure_ascii=False, indent=2)
    df.to_csv(os.path.join(OUT, "analysis.csv"), index=False)
    print("\nwrote", os.path.join(OUT, "stats.json"))


def max_drawdown(df: pd.DataFrame) -> float:
    ordered = df.sort_values("close_time")
    cum = ordered.profit.cumsum()
    peak = cum.cummax()
    return float((peak - cum).max())


if __name__ == "__main__":
    main()
