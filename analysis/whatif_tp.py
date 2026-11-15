"""What-if: replace the far fixed take-profit with a nearer one (fixed book only)."""

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


def pnl(entry, exit_price, lot, contract, direction, commission):
    move = (exit_price - entry) if direction == "long" else (entry - exit_price)
    return move * lot * contract - commission


def simulate(ctx: dict, rr: float) -> tuple[float, str]:
    t = ctx["trade"]
    if t.get("initialSlPrice") is None:
        return float(t["profit"]), "actual"
    entry = t["openPrice"]
    sl = t["initialSlPrice"]
    risk = abs(entry - sl)
    tp = entry + risk * rr if t["direction"] == "long" else entry - risk * rr
    lot, contract, commission = t["lotSize"], t["contractSize"], t["commission"]
    entry_sec = int(t["openTime"] / 1000)
    close_sec = int(t["closeTime"] / 1000)
    bars = [b for b in ctx["series"]["M1"]["bars"] if b["time"] >= entry_sec]
    if not bars:
        return float(t["profit"]), "actual"
    # Replay until the original close time.  A nearer TP that did not trigger by
    # then is treated as "still open at original close" and valued at that close,
    # so the simulation never assumes information after the trade ended.
    for b in bars:
        if b["time"] > close_sec:
            break
        if t["direction"] == "long":
            if b["low"] <= sl:
                return pnl(entry, sl, lot, contract, "long", commission), "sl"
            if b["high"] >= tp:
                return pnl(entry, tp, lot, contract, "long", commission), "tp"
        else:
            if b["high"] >= sl:
                return pnl(entry, sl, lot, contract, "short", commission), "sl"
            if b["low"] <= tp:
                return pnl(entry, tp, lot, contract, "short", commission), "tp"
    last = max((b for b in bars if b["time"] <= close_sec), key=lambda b: b["time"])
    return pnl(entry, last["close"], lot, contract, t["direction"], commission), "close"


def main() -> None:
    df = pd.read_csv(os.path.join(DATA, "features.csv"))
    fixed = df[df.book == "fixed"].copy()
    ctxs = load_contexts()
    actual = fixed.profit.sum()
    print(f"fixed n={len(fixed)} actual={actual:.2f}")
    rows = []
    for rr in (0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0):
        vals, reasons = [], {}
        for _, r in fixed.iterrows():
            ctx = ctxs.get(r["uid"])
            if not ctx:
                vals.append(r["profit"])
                continue
            p, why = simulate(ctx, rr)
            vals.append(p)
            reasons[why] = reasons.get(why, 0) + 1
        total = float(np.sum(vals))
        wins = sum(1 for v in vals if v > 0)
        rows.append(
            {
                "target_rr": rr,
                "pnl": total,
                "delta_vs_actual": total - actual,
                "win_rate": wins / len(vals),
                "tp": reasons.get("tp", 0),
                "sl": reasons.get("sl", 0),
                "close": reasons.get("close", 0),
            }
        )
    out = pd.DataFrame(rows)
    print(out.round(2).to_string(index=False))
    out.to_csv(os.path.join(OUT, "whatif_tp.csv"), index=False)


if __name__ == "__main__":
    main()
