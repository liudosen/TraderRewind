"""What-if: cut a trade at a time checkpoint when it has not moved enough.

Unlike whatif.py this runs on ALL trades and does not need the initial stop:
the rule only uses the early MFE (known at the checkpoint), then either exits
at the checkpoint close or leaves the actual trade untouched.
"""

from __future__ import annotations

import json
import os

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
OUT = os.path.join(HERE, "output")


def load_contexts() -> dict[str, dict]:
    out = {}
    with open(os.path.join(DATA, "contexts.jsonl"), encoding="utf-8") as f:
        for line in f:
            if line.strip():
                ctx = json.loads(line)
                out[ctx["_uid"]] = ctx
    return out


def pnl_at(entry, exit_price, lot, contract, direction, commission):
    move = (exit_price - entry) if direction == "long" else (entry - exit_price)
    return move * lot * contract - commission


def simulate(ctx: dict, minutes: int, threshold: float) -> tuple[float, str]:
    t = ctx["trade"]
    entry_sec = int(t["openTime"] / 1000)
    close_sec = int(t["closeTime"] / 1000)
    checkpoint = entry_sec + minutes * 60
    if close_sec <= checkpoint:
        return float(t["profit"]), "closed_before"
    bars = [b for b in ctx["series"]["M1"]["bars"] if b["time"] >= entry_sec]
    if not bars:
        return float(t["profit"]), "no_bars"
    upto = [b for b in bars if b["time"] <= checkpoint]
    if not upto:
        return float(t["profit"]), "no_bars"
    entry = t["openPrice"]
    lot = t["lotSize"]
    contract = t["contractSize"]
    direction = t["direction"]
    if direction == "long":
        mfe = max(b["high"] for b in upto) - entry
    else:
        mfe = entry - min(b["low"] for b in upto)
    mfe_r = (mfe * lot * contract) / (t["riskTargetUsd"] or 100)
    if mfe_r >= threshold:
        return float(t["profit"]), "kept"
    last = upto[-1]
    return pnl_at(entry, last["close"], lot, contract, direction, t["commission"]), "cut"


def main() -> None:
    df = pd.read_csv(os.path.join(DATA, "features.csv"))
    ctxs = load_contexts()
    actual = df.profit.sum()
    print(f"all trades n={len(df)} actual pnl={actual:.2f}")
    rows = []
    for minutes in (15, 30, 45, 60, 90, 120):
        for th in (0.25, 0.5, 0.75, 1.0, 1.25):
            vals, reasons = [], {}
            for _, r in df.iterrows():
                ctx = ctxs.get(r["uid"])
                if not ctx:
                    vals.append(r["profit"])
                    continue
                pnl, why = simulate(ctx, minutes, th)
                vals.append(pnl)
                reasons[why] = reasons.get(why, 0) + 1
            total = float(np.sum(vals))
            rows.append(
                {
                    "checkpoint_min": minutes,
                    "mfe_threshold_r": th,
                    "pnl": total,
                    "delta_vs_actual": total - actual,
                    "cut": reasons.get("cut", 0),
                    "kept": reasons.get("kept", 0),
                    "closed_before": reasons.get("closed_before", 0),
                }
            )
    out = pd.DataFrame(rows).sort_values("pnl", ascending=False)
    print(out.round(2).to_string(index=False))
    out.to_csv(os.path.join(OUT, "whatif_all.csv"), index=False)
    print("\ntop 5")
    print(out.head(5).round(2).to_string(index=False))


if __name__ == "__main__":
    main()
