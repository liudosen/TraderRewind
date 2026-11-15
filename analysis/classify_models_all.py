"""Classify all session-10 entries into Jianghe models + market state.

Output is a review table; DB writes happen in a separate script after review.
"""

from __future__ import annotations

import json
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


def fetch():
    c = McpClient("http://127.0.0.1:47821/mcp")
    c.initialize()
    trades = c.call("list_trades", {"sessionId": 10, "limit": 100, "order": "asc"})["trades"]

    def one(t):
        cc = McpClient("http://127.0.0.1:47821/mcp")
        cc.initialize()
        return cc.call(
            "get_trade_context",
            {"sessionId": 10, "tradeId": t["id"], "timeframes": ["M5", "M1"], "beforeBars": 120, "afterBars": 60, "includeBars": True},
        )

    with ThreadPoolExecutor(max_workers=6) as ex:
        contexts = list(ex.map(one, trades))
    return trades, contexts


def ema_last(vals, span):
    return float(pd.Series(vals).ewm(span=span, adjust=False).mean().iloc[-1]) if len(vals) else float("nan")


def atr_last(bars, period=14):
    if len(bars) < 2:
        return float("nan")
    h = np.array([b["high"] for b in bars], float)
    l = np.array([b["low"] for b in bars], float)
    c = np.array([b["close"] for b in bars], float)
    pc = np.r_[c[0], c[:-1]]
    tr = np.maximum(h - l, np.maximum(np.abs(h - pc), np.abs(l - pc)))
    return float(np.mean(tr[-min(period, len(tr)):]))


def swings(bars, left=3, right=3):
    highs, lows = [], []
    for i in range(left, len(bars) - right):
        win = range(i - left, i + right + 1)
        if all(bars[i]["high"] >= bars[j]["high"] for j in win if j != i):
            highs.append(i)
        if all(bars[i]["low"] <= bars[j]["low"] for j in win if j != i):
            lows.append(i)
    return highs, lows


def m5_state(bars, direction):
    closes = np.array([b["close"] for b in bars], float)
    ema20 = ema_last(closes, 20)
    ema50 = ema_last(closes, 50)
    ema200 = ema_last(closes, 200)
    atr = atr_last(bars)
    highs, lows = swings(bars, 3, 3)
    if len(highs) >= 2 and len(lows) >= 2:
        h1, h2 = bars[highs[-2]]["high"], bars[highs[-1]]["high"]
        l1, l2 = bars[lows[-2]]["low"], bars[lows[-1]]["low"]
        if h2 > h1 and l2 > l1:
            struct = "up"
        elif h2 < h1 and l2 < l1:
            struct = "down"
        else:
            struct = "range"
    else:
        struct = "up" if ema20 > ema50 > ema200 else ("down" if ema20 < ema50 < ema200 else "range")

    gap = abs(ema20 - ema50) / atr if atr else 0
    ema10 = ema_last(closes[:-10], 20) if len(closes) > 10 else ema20
    slope = (ema20 - ema10) / atr if atr else 0
    rng = (max(b["high"] for b in bars[-20:]) - min(b["low"] for b in bars[-20:])) / atr if atr else 0

    pullback = 0.5
    if len(highs) >= 2 and len(lows) >= 2:
        if struct == "up":
            impulse = max(bars[highs[-1]]["high"] - bars[lows[-2]]["low"], 1e-9)
            retrace = bars[highs[-1]]["high"] - bars[lows[-1]]["low"]
            pullback = float(np.clip(retrace / impulse, 0, 1))
        elif struct == "down":
            impulse = max(bars[highs[-2]]["high"] - bars[lows[-1]]["low"], 1e-9)
            retrace = bars[highs[-1]]["high"] - bars[lows[-1]]["low"]
            pullback = float(np.clip(retrace / impulse, 0, 1))

    if struct == "range" or (gap < 0.20 and rng < 3.0):
        state = "震荡"
    elif gap >= 0.45 and abs(slope) >= 0.15 and pullback <= 0.45:
        state = "强趋势"
    elif gap >= 0.20 and pullback <= 0.65:
        state = "次强趋势"
    else:
        state = "弱趋势"

    # M5 location at entry: near EMA20/50 or swing level; breakout beyond last swing.
    entry = None  # filled by caller
    return {"struct": struct, "ema20": ema20, "ema50": ema50, "ema200": ema200, "atr": atr, "gap": gap, "slope": slope, "pullback": pullback, "range": rng, "state": state, "highs": highs, "lows": lows}


def classify(t, c):
    direction = t["direction"]
    entry = float(t["openPrice"])
    m5 = c["series"]["M5"]
    m1 = c["series"]["M1"]
    m5b = m5["bars"][: m5["entryBarIndex"]]
    m1b = m1["bars"][: m1["entryBarIndex"]]
    st = m5_state(m5b, direction)
    atr5 = st["atr"]
    last_high = m5b[st["highs"][-1]]["high"] if st["highs"] else max(b["high"] for b in m5b[-20:])
    last_low = m5b[st["lows"][-1]]["low"] if st["lows"] else min(b["low"] for b in m5b[-20:])
    near_ema = min(abs(entry - st["ema20"]), abs(entry - st["ema50"])) <= 1.0 * atr5 if atr5 else False
    near_swing = bool(
        (direction == "long" and (entry - last_low) <= 0.5 * atr5)
        or (direction == "short" and (last_high - entry) <= 0.5 * atr5)
    )
    breakout = (direction == "long" and entry >= last_high - 0.10 * atr5) or (direction == "short" and entry <= last_low + 0.10 * atr5)
    if breakout:
        loc = "breakout"
    elif near_ema or near_swing:
        loc = "pullback"
    else:
        loc = "mid"

    atr1 = atr_last(m1b)
    highs, lows = swings(m1b, 3, 3)
    model = "无模型（1M结构不足）"
    reason = ""
    if len(highs) >= 2 and len(lows) >= 2:
        if direction == "long":
            li = lows[-1]
            prior_highs = [i for i in highs if i < li]
            if prior_highs:
                defense = m1b[prior_highs[-1]]["high"]
                prev_low = m1b[lows[-2]]["low"]
                last_low = m1b[li]["low"]
                higher_low = last_low > prev_low + 0.05 * atr1
                double_bottom = abs(last_low - prev_low) <= 0.10 * atr1 or last_low < prev_low
                break_up = entry > defense + 0.15 * atr1
                if break_up:
                    model = "右中右" if higher_low and entry <= defense + 0.50 * atr1 else "右中左"
                    reason = f"1M 破前高 {defense:.2f}，回抽 {'守住' if higher_low else '未确认'}，{'二次确认' if model == '右中右' else '破位直接进'}"
                elif higher_low:
                    model = "左中右"
                    reason = f"1M 未破前高 {defense:.2f}，但低点抬高（{prev_low:.2f}→{last_low:.2f}），左侧偏强"
                elif double_bottom:
                    model = "左中左"
                    reason = f"1M 未破前高 {defense:.2f}，二次下探 {last_low:.2f} 与前低 {prev_low:.2f} 基本平行，左侧二推不破"
                else:
                    model = "左中"
                    reason = f"1M 未破前高 {defense:.2f}，低点未抬高，左侧提前"
        else:
            hi = highs[-1]
            prior_lows = [i for i in lows if i < hi]
            if prior_lows:
                defense = m1b[prior_lows[-1]]["low"]
                prev_high = m1b[highs[-2]]["high"]
                last_high = m1b[hi]["high"]
                lower_high = last_high < prev_high - 0.05 * atr1
                double_top = abs(last_high - prev_high) <= 0.10 * atr1 or last_high > prev_high
                break_down = entry < defense - 0.15 * atr1
                if break_down:
                    model = "右中右" if lower_high and entry >= defense - 0.50 * atr1 else "右中左"
                    reason = f"1M 破前低 {defense:.2f}，反抽 {'未创新高' if lower_high else '未确认'}，{'二次确认' if model == '右中右' else '破位直接进'}"
                elif lower_high:
                    model = "左中右"
                    reason = f"1M 未破前低 {defense:.2f}，但高点降低（{prev_high:.2f}→{last_high:.2f}），左侧偏强"
                elif double_top:
                    model = "左中左"
                    reason = f"1M 未破前低 {defense:.2f}，二次上探 {last_high:.2f} 与前高 {prev_high:.2f} 基本平行，左侧二推不破"
                else:
                    model = "左中"
                    reason = f"1M 未破前低 {defense:.2f}，高点未降低，左侧提前"

    if loc == "mid":
        model = "无模型（M5中段）"
        reason = "M5 不在 EMA20/50 或前高前低附近，位置本身不构成江河的进场模型"

    if t["id"] == "t_1794214924391_kd7y":
        loc = "pullback"
        model = "左中左"
        reason = "M5 回踩 EMA20，1M 二次下探不破前低，左侧二推不破"

    # Manual state overrides for cases where swing overlap hides an obvious
    # M5 trend/range on the chart (reviewed against the rendered M5/M1 charts).
    overrides = {
        "t_1794214924391_kd7y": "强趋势",
        "t_1794223408832_yium": "震荡",
        "t_1794220369941_0fnr": "次强趋势",
        "t_1794217877610_yk40": "弱趋势",
        "t_1794217763894_ynpu": "弱趋势",
        "t_1794225234077_whd6": "强趋势",
        "t_1794225303623_b3mo": "强趋势",
        "t_1794225368176_whyy": "强趋势",
        "t_1794225967363_kho3": "震荡",
        "t_1794219528928_wi2l": "强趋势",
        "t_1794225130522_4zhw": "强趋势",
        "t_1794220048983_rrvv": "强趋势",
        "t_1794218330057_v7jt": "强趋势",
    }
    state = overrides.get(t["id"], st["state"])
    struct = st["struct"]
    struct_overrides = {
        "t_1794223408832_yium": "range",
        "t_1794220369941_0fnr": "down",
        "t_1794217877610_yk40": "down",
        "t_1794217763894_ynpu": "down",
        "t_1794225234077_whd6": "up",
        "t_1794225303623_b3mo": "up",
        "t_1794225368176_whyy": "up",
        "t_1794225967363_kho3": "range",
        "t_1794219528928_wi2l": "up",
        "t_1794225130522_4zhw": "up",
        "t_1794220048983_rrvv": "down",
        "t_1794218330057_v7jt": "down",
    }
    struct = struct_overrides.get(t["id"], struct)

    return {
        "trade_id": t["id"],
        "direction": direction,
        "time": t["openTimeLocal"],
        "profit": t["profit"],
        "close": t["closeReason"],
        "state": state,
        "struct": struct,
        "gap": st["gap"],
        "slope": st["slope"],
        "pullback": st["pullback"],
        "range": st["range"],
        "loc": loc,
        "model": model,
        "model_reason": reason,
        "entry": entry,
        "m5_ema20": st["ema20"],
        "m5_last_high": last_high,
        "m5_last_low": last_low,
    }


def main():
    trades, contexts = fetch()
    rows = [classify(t, c) for t, c in zip(trades, contexts)]
    df = pd.DataFrame(rows).sort_values("time").reset_index(drop=True)
    df.to_csv(os.path.join(OUT, "session10_model_state.csv"), index=False, encoding="utf-8-sig")
    print("state counts\n", df.state.value_counts().to_string())
    print("\nmodel counts\n", df.model.value_counts().to_string())
    print("\nmodel × result\n", df.groupby("model").agg(n=("profit", "size"), win=("profit", lambda s: (s > 0).mean()), pnl=("profit", "sum")).round(2).to_string())
    print("\nstate × result\n", df.groupby("state").agg(n=("profit", "size"), win=("profit", lambda s: (s > 0).mean()), pnl=("profit", "sum")).round(2).to_string())
    print("\nall rows")
    print(df[["time", "direction", "state", "struct", "loc", "model", "profit", "close", "model_reason"]].to_string(index=False))


if __name__ == "__main__":
    main()
