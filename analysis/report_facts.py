"""Assemble every number the written report cites into report_facts.json."""

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
    df["pos_q"] = pd.qcut(df["m30_dir_pos"], 5, labels=["Q1", "Q2", "Q3", "Q4", "Q5"])
    df["mfe30_b"] = pd.cut(df["mfe30"], [-0.001, 0.25, 0.5, 0.75, 1.25, 99], labels=["<0.25", "0.25-0.5", "0.5-0.75", "0.75-1.25", ">=1.25"])
    df["mae15_b"] = pd.cut(df["mae15"], [-0.001, 0.3, 0.5, 0.75, 1.0, 99], labels=["<0.3", "0.3-0.5", "0.5-0.75", "0.75-1.0", ">=1.0"])
    df["rr_b"] = pd.cut(df["planned_rr"], [-0.001, 1.5, 2, 3, 5, 99], labels=["<1.5", "1.5-2", "2-3", "3-5", ">=5"])
    return df


def metrics(d: pd.DataFrame) -> dict:
    wins = d[d.profit > 0]
    losses = d[d.profit < 0]
    order = d.sort_values("close_time")
    cum = order.profit.cumsum()
    dd = float((cum.cummax() - cum).max()) if len(order) else 0.0
    return {
        "n": int(len(d)),
        "wins": int(len(wins)),
        "losses": int(len(losses)),
        "win_rate": float(d.win.mean()) if len(d) else None,
        "pnl": float(d.profit.sum()),
        "avg_pnl": float(d.profit.mean()) if len(d) else None,
        "avg_r": float(d.r_target.mean()) if len(d) else None,
        "gross_profit": float(wins.profit.sum()),
        "gross_loss": float(losses.profit.sum()),
        "pf": float(wins.profit.sum() / abs(losses.profit.sum())) if len(losses) else None,
        "avg_win": float(wins.profit.mean()) if len(wins) else None,
        "avg_loss": float(losses.profit.mean()) if len(losses) else None,
        "max_dd": dd,
        "median_hold": float(d.holding_min.median()) if len(d) else None,
        "median_mfe30": float(d.mfe30.median()) if len(d) else None,
        "median_mae15": float(d.mae15.median()) if len(d) else None,
    }


def group(d: pd.DataFrame, col: str, order=None) -> list[dict]:
    g = d.groupby(col, observed=True).agg(
        n=("win", "size"),
        wins=("win", "sum"),
        win_rate=("win", "mean"),
        pnl=("profit", "sum"),
        avg_r=("r_target", "mean"),
        median_hold=("holding_min", "median"),
        median_mfe30=("mfe30", "median"),
        median_mae15=("mae15", "median"),
    )
    if order:
        g = g.reindex(order)
    return [{col: str(i), **{k: (float(v) if not isinstance(v, (int, np.integer)) else int(v)) for k, v in row.items()}} for i, row in g.iterrows()]


def main() -> None:
    df = load()
    facts = {
        "generated_at": "2026-11-09",
        "overall": metrics(df),
        "sessions": [],
        "book": group(df, "book", ["fixed", "moved", "unknown"]),
        "mfe30": group(df, "mfe30_b", ["<0.25", "0.25-0.5", "0.5-0.75", "0.75-1.25", ">=1.25"]),
        "mae15": group(df, "mae15_b", ["<0.3", "0.3-0.5", "0.5-0.75", "0.75-1.0", ">=1.0"]),
        "align3": group(df, "align3", [-1, 0, 1]),
        "pos_q": group(df, "pos_q", ["Q1", "Q2", "Q3", "Q4", "Q5"]),
        "planned_rr": group(df[df.book == "fixed"], "rr_b", ["<1.5", "1.5-2", "2-3", "3-5", ">=5"]),
        "hour": group(df, "hour"),
        "weekday": group(df, "weekday"),
        "same_period": {},
        "data_quality": {},
        "whatif": {},
        "filters": {},
    }
    for sid, g in df.groupby("session_id"):
        m = metrics(g)
        m["session_id"] = int(sid)
        m["name"] = str(g.session_name.iloc[0])
        facts["sessions"].append(m)
    facts["sessions"].sort(key=lambda x: x["session_id"])

    same = df[df.session_id.isin([1, 8, 10])]
    for sid, g in same.groupby("session_id"):
        facts["same_period"][str(sid)] = metrics(g)

    facts["data_quality"] = {
        "reliable": int((df.book == "fixed").sum()),
        "moved": int((df.book == "moved").sum()),
        "unknown": int((df.book == "unknown").sum()),
        "reliable_pct": float((df.book == "fixed").mean()),
        "moved_pct": float((df.book != "fixed").mean()),
    }

    with open(os.path.join(OUT, "filters.csv"), encoding="utf-8") as f:
        facts["filters"] = pd.read_csv(f).round(4).to_dict(orient="records")
    with open(os.path.join(OUT, "whatif_all.csv"), encoding="utf-8") as f:
        w = pd.read_csv(f)
        facts["whatif"]["time_stop"] = w.iloc[0].round(4).to_dict()
    with open(os.path.join(OUT, "whatif_tp.csv"), encoding="utf-8") as f:
        t = pd.read_csv(f)
        facts["whatif"]["take_profit"] = t.iloc[0].round(4).to_dict()
    with open(os.path.join(OUT, "feature_compare.csv"), encoding="utf-8") as f:
        fc = pd.read_csv(f)
        facts["feature_compare"] = fc.round(4).to_dict(orient="records")

    with open(os.path.join(OUT, "report_facts.json"), "w", encoding="utf-8") as f:
        json.dump(facts, f, ensure_ascii=False, indent=2, default=str)

    print(json.dumps(facts["overall"], ensure_ascii=False, indent=2))
    print("\nsessions")
    for s in facts["sessions"]:
        print(s["session_id"], s["n"], round(s["win_rate"], 3), round(s["pnl"], 0), round(s["avg_r"], 3), round(s["max_dd"], 0))
    print("\nbook")
    print(json.dumps(facts["book"], ensure_ascii=False, indent=2))
    print("\ndata quality", facts["data_quality"])
    print("\nfilters")
    for x in facts["filters"]:
        print(x)


if __name__ == "__main__":
    main()
