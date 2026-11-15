"""Prototype: classify 1M entry models from swing structure before entry."""

from __future__ import annotations

import os
import sys
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from collect_via_mcp import McpClient  # noqa: E402

OUT = os.path.join(HERE, "output")
os.makedirs(OUT, exist_ok=True)

IDS = [
    "t_1794223408832_yium",
    "t_1794220369941_0fnr",
    "t_1794214924391_kd7y",
    "t_1794217877610_yk40",
    "t_1794217763894_ynpu",
    "t_1794225234077_whd6",
    "t_1794225303623_b3mo",
    "t_1794225368176_whyy",
    "t_1794225967363_kho3",
    "t_1794215300694_mqty",
]


def swings(bars, left=3, right=3):
    highs, lows = [], []
    for i in range(left, len(bars) - right):
        win = range(i - left, i + right + 1)
        if all(bars[i]["high"] >= bars[j]["high"] for j in win if j != i):
            highs.append(i)
        if all(bars[i]["low"] <= bars[j]["low"] for j in win if j != i):
            lows.append(i)
    return highs, lows


def classify(direction, entry, bars, entry_idx, atr):
    highs, lows = swings(bars[:entry_idx])
    hh = [bars[i]["high"] for i in highs]
    ll = [bars[i]["low"] for i in lows]
    info = {"highs": list(zip(highs[-4:], [round(x, 2) for x in hh[-4:]])), "lows": list(zip(lows[-4:], [round(x, 2) for x in ll[-4:]]))}
    if len(highs) < 2 or len(lows) < 2:
        return "数据不足", info
    if direction == "long":
        # last down move: last swing low, defense = swing high before it
        li = lows[-1]
        prior_highs = [i for i in highs if i < li]
        if not prior_highs:
            return "数据不足", info
        defense = bars[prior_highs[-1]]["high"]
        prev_low = ll[-2]
        higher_low = ll[-1] > prev_low
        info.update({"defense": round(defense, 2), "last_low": round(ll[-1], 2), "prev_low": round(prev_low, 2), "higher_low": higher_low})
        if entry > defense:
            return ("右中右" if higher_low else "右中左"), info
        return ("左中右" if higher_low else "左中左"), info
    else:
        hi = highs[-1]
        prior_lows = [i for i in lows if i < hi]
        if not prior_lows:
            return "数据不足", info
        defense = bars[prior_lows[-1]]["low"]
        prev_high = hh[-2]
        lower_high = hh[-1] < prev_high
        info.update({"defense": round(defense, 2), "last_high": round(hh[-1], 2), "prev_high": round(prev_high, 2), "lower_high": lower_high})
        if entry < defense:
            return ("右中右" if lower_high else "右中左"), info
        return ("左中右" if lower_high else "左中左"), info


def one(tid):
    c = McpClient("http://127.0.0.1:47821/mcp")
    c.initialize()
    ctx = c.call("get_trade_context", {"sessionId": 10, "tradeId": tid, "timeframes": ["M5", "M1"], "beforeBars": 120, "afterBars": 60, "includeBars": True})
    t = ctx["trade"]
    bars = ctx["series"]["M1"]["bars"]
    idx = ctx["series"]["M1"]["entryBarIndex"]
    atr = float(np.mean([b["high"] - b["low"] for b in bars[max(0, idx - 14):idx]])) if idx else 0
    model, info = classify(t["direction"], t["openPrice"], bars, idx, atr)
    return {"id": tid, "dir": t["direction"], "entry": t["openPrice"], "time": t["openTimeLocal"], "profit": t["profit"], "model": model, **info}


def main():
    with ThreadPoolExecutor(max_workers=4) as ex:
        rows = list(ex.map(one, IDS))
    df = pd.DataFrame(rows)
    print(df.to_string(index=False))
    df.to_csv(os.path.join(OUT, "model_prototype.csv"), index=False, encoding="utf-8-sig")


if __name__ == "__main__":
    main()
