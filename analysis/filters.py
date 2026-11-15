"""In-sample effect of the entry filters suggested by the report."""

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
    return df


def report(name: str, mask_keep: pd.Series, df: pd.DataFrame) -> dict:
    kept = df[mask_keep]
    removed = df[~mask_keep]
    row = {
        "filter": name,
        "kept_n": len(kept),
        "kept_win": kept.win.mean() if len(kept) else None,
        "kept_pnl": kept.profit.sum(),
        "kept_avg_r": kept.r_target.mean() if len(kept) else None,
        "removed_n": len(removed),
        "removed_pnl": removed.profit.sum(),
        "delta_pnl": kept.profit.sum() - df.profit.sum(),
        "sessions_improved": 0,
    }
    for sid, g in df.groupby("session_id"):
        base = g.profit.sum()
        after = g[mask_keep.loc[g.index]].profit.sum()
        if after > base:
            row["sessions_improved"] += 1
    return row


def main() -> None:
    df = load()
    rows = []
    rows.append(report("baseline", pd.Series(True, index=df.index), df))
    rows.append(report("exclude counter-trend (M30)", df.align3 != -1, df))
    rows.append(report("exclude M30 range bottom quintile", df.pos_q != "Q1", df))
    rows.append(report("exclude 13:00 hour", df.hour != 13, df))
    rows.append(report("exclude fixed-stop planned RR >= 2", ~((df.book == "fixed") & (df.planned_rr >= 2)), df))
    rows.append(report("exclude 11-13 window", ~df.hour.isin([11, 12, 13]), df))
    combo = (df.align3 != -1) & (df.pos_q != "Q1") & (df.hour != 13) & ~((df.book == "fixed") & (df.planned_rr >= 2))
    rows.append(report("combined quality gate", combo, df))
    combo2 = (df.align3 != -1) & (df.pos_q != "Q1") & (df.hour != 13)
    rows.append(report("combined (no RR filter)", combo2, df))
    out = pd.DataFrame(rows)
    print(out.round(3).to_string(index=False))
    out.to_csv(os.path.join(OUT, "filters.csv"), index=False)
    with open(os.path.join(OUT, "filters.json"), "w", encoding="utf-8") as f:
        json.dump(out.round(4).to_dict(orient="records"), f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
