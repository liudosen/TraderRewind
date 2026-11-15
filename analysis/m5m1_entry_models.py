"""Entry-model analysis for session 10, using the user's framework:

    M5  = main timeframe: structure + location (pullback / breakout / mid)
    M1  = execution: trigger at the M5 level, no chase
    M30 = higher-level support / resistance context

No future bars are used for the entry classification: M5 swing levels and
M1/M5 EMA/ATR are computed from bars strictly before the entry bar.
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

DATA = os.path.join(HERE, "data")
OUT = os.path.join(HERE, "output")
os.makedirs(DATA, exist_ok=True)
os.makedirs(OUT, exist_ok=True)


def fetch():
    c = McpClient("http://127.0.0.1:47821/mcp")
    c.initialize()
    trades = c.call("list_trades", {"sessionId": 10, "limit": 100, "order": "asc"})["trades"]

    def one(t):
        cc = McpClient("http://127.0.0.1:47821/mcp")
        cc.initialize()
        ctx = cc.call(
            "get_trade_context",
            {
                "sessionId": 10,
                "tradeId": t["id"],
                "timeframes": ["M30", "M5", "M1"],
                "beforeBars": 120,
                "afterBars": 60,
                "includeBars": True,
            },
        )
        return ctx

    with ThreadPoolExecutor(max_workers=6) as ex:
        contexts = list(ex.map(one, trades))
    return trades, contexts


def ema_last(values: np.ndarray, span: int) -> float:
    if len(values) == 0:
        return float("nan")
    return float(pd.Series(values).ewm(span=span, adjust=False).mean().iloc[-1])


def atr_last(bars: list[dict], period: int = 14) -> float:
    if len(bars) < 2:
        return float("nan")
    high = np.array([b["high"] for b in bars], dtype=float)
    low = np.array([b["low"] for b in bars], dtype=float)
    close = np.array([b["close"] for b in bars], dtype=float)
    prev_close = np.r_[close[0], close[:-1]]
    tr = np.maximum(high - low, np.maximum(np.abs(high - prev_close), np.abs(low - prev_close)))
    n = min(period, len(tr))
    return float(np.mean(tr[-n:]))


def swings(bars: list[dict], left: int = 2, right: int = 2):
    highs, lows = [], []
    for i in range(left, len(bars) - right):
        window = range(i - left, i + right + 1)
        if all(bars[i]["high"] >= bars[j]["high"] for j in window if j != i):
            highs.append(i)
        if all(bars[i]["low"] <= bars[j]["low"] for j in window if j != i):
            lows.append(i)
    return highs, lows


def structure(highs, lows, bars, ema20, ema50, ema200):
    if len(highs) >= 2 and len(lows) >= 2:
        h1, h2 = bars[highs[-2]]["high"], bars[highs[-1]]["high"]
        l1, l2 = bars[lows[-2]]["low"], bars[lows[-1]]["low"]
        if h2 > h1 and l2 > l1:
            return "up"
        if h2 < h1 and l2 < l1:
            return "down"
        return "range"
    if ema20 > ema50 > ema200:
        return "up"
    if ema20 < ema50 < ema200:
        return "down"
    return "range"


def build(trades, contexts) -> pd.DataFrame:
    rows = []
    for t, c in zip(trades, contexts):
        direction = t["direction"]
        sign = 1 if direction == "long" else -1
        entry = float(t["openPrice"])
        m5 = c["series"]["M5"]
        m1 = c["series"]["M1"]
        m30 = c["series"]["M30"]

        m5b = m5["bars"][: m5["entryBarIndex"]]
        m1b = m1["bars"][: m1["entryBarIndex"]]
        m30b = m30["bars"][: m30["entryBarIndex"]]

        m5_ema20 = ema_last(np.array([b["close"] for b in m5b]), 20)
        m5_ema50 = ema_last(np.array([b["close"] for b in m5b]), 50)
        m5_ema200 = ema_last(np.array([b["close"] for b in m5b]), 200)
        m5_atr = atr_last(m5b)
        m5_highs, m5_lows = swings(m5b)
        m5_struct = structure(m5_highs, m5_lows, m5b, m5_ema20, m5_ema50, m5_ema200)
        last_high = m5b[m5_highs[-1]]["high"] if m5_highs else max(b["high"] for b in m5b[-20:])
        last_low = m5b[m5_lows[-1]]["low"] if m5_lows else min(b["low"] for b in m5b[-20:])

        # M5 location at entry.
        if direction == "long":
            breakout = entry >= last_high - 0.10 * m5_atr
            pullback = (entry <= m5_ema20 + 0.20 * m5_atr) and (entry > last_low)
        else:
            breakout = entry <= last_low + 0.10 * m5_atr
            pullback = (entry >= m5_ema20 - 0.20 * m5_atr) and (entry < last_high)
        if breakout:
            m5_loc = "breakout"
        elif pullback:
            m5_loc = "pullback"
        else:
            m5_loc = "mid"
        m5_aligned = (m5_struct == "up" and direction == "long") or (m5_struct == "down" and direction == "short")
        m5_counter = (m5_struct == "up" and direction == "short") or (m5_struct == "down" and direction == "long")

        # M1 execution: only completed bars before entry are used.
        m1_closes = np.array([b["close"] for b in m1b])
        m1_ema20 = ema_last(m1_closes, 20)
        m1_atr = atr_last(m1b)
        prev = m1b[-1] if m1b else None
        prev2 = m1b[-2] if len(m1b) >= 2 else None
        ext = ((entry - m1_ema20) * sign) / m1_atr if m1_atr else 0.0
        break_prev = bool(
            (direction == "long" and prev and entry > prev["high"])
            or (direction == "short" and prev and entry < prev["low"])
        )
        reclaim = bool(
            prev
            and (
                (direction == "long" and entry > m1_ema20 and prev["close"] <= m1_ema20)
                or (direction == "short" and entry < m1_ema20 and prev["close"] >= m1_ema20)
            )
        )
        reject = bool(
            prev
            and (
                (direction == "long" and prev["close"] > prev["open"] and min(prev["open"], prev["close"]) - prev["low"] > abs(prev["close"] - prev["open"]) * 0.5)
                or (direction == "short" and prev["close"] < prev["open"] and prev["high"] - max(prev["open"], prev["close"]) > abs(prev["close"] - prev["open"]) * 0.5)
            )
        )
        chase = ext > 0.60 or (break_prev and ext > 0.30)
        m1_good = (break_prev or reclaim or reject) and not chase and ext <= 0.60
        if chase:
            m1_model = "chase"
        elif m1_good and ext <= 0.20:
            m1_model = "pullback_trigger"
        elif m1_good and break_prev:
            m1_model = "breakout_trigger"
        elif m1_good:
            m1_model = "trigger"
        else:
            m1_model = "none"

        # M30 levels: last swing high/low before entry.
        m30_highs, m30_lows = swings(m30b)
        m30_high = m30b[m30_highs[-1]]["high"] if m30_highs else max(b["high"] for b in m30b[-20:])
        m30_low = m30b[m30_lows[-1]]["low"] if m30_lows else min(b["low"] for b in m30b[-20:])
        m30_atr = atr_last(m30b)
        m30_support_dist = (entry - m30_low) / m30_atr if m30_atr else np.nan
        m30_resist_dist = (m30_high - entry) / m30_atr if m30_atr else np.nan
        m30_room = m30_resist_dist if direction == "long" else m30_support_dist
        m30_at_level = bool(
            (direction == "long" and m30_support_dist <= 0.5)
            or (direction == "short" and m30_resist_dist <= 0.5)
        )
        m30_wall = bool(
            (direction == "long" and m30_resist_dist <= 0.5)
            or (direction == "short" and m30_support_dist <= 0.5)
        )

        exc = c["excursions"] or {}
        if m5_counter:
            m5_arch = "M5逆势"
        elif m5_struct == "range":
            m5_arch = "M5区间"
        elif m5_loc == "breakout":
            m5_arch = "M5顺势突破"
        elif m5_loc == "pullback":
            m5_arch = "M5顺势回踩"
        else:
            m5_arch = "M5顺势中段"

        rows.append(
            {
                "trade_id": t["id"],
                "direction": direction,
                "open_time": pd.to_datetime(t["openTime"], unit="ms", utc=True).tz_convert("Asia/Shanghai"),
                "profit": t["profit"],
                "r_target": t["rOnRiskTarget"],
                "close_reason": t["closeReason"],
                "holding_min": t["holdingMinutes"],
                "planned_rr": t["plannedRR"],
                "risk_basis": t["riskBasis"],
                "entry": entry,
                "m5_struct": m5_struct,
                "m5_arch": m5_arch,
                "m5_loc": m5_loc,
                "m5_aligned": m5_aligned,
                "m5_counter": m5_counter,
                "m5_atr": m5_atr,
                "m5_ema20": m5_ema20,
                "m5_dist_ema20": ((entry - m5_ema20) * sign) / m5_atr if m5_atr else np.nan,
                "m5_last_high": last_high,
                "m5_last_low": last_low,
                "m5_support_dist": (entry - last_low) / m5_atr if m5_atr else np.nan,
                "m5_resist_dist": (last_high - entry) / m5_atr if m5_atr else np.nan,
                "m1_model": m1_model,
                "m1_ext": ext,
                "m1_break_prev": break_prev,
                "m1_reclaim": reclaim,
                "m1_reject": reject,
                "m1_ema20": m1_ema20,
                "m1_atr": m1_atr,
                "m30_at_level": m30_at_level,
                "m30_wall": m30_wall,
                "m30_support_dist": m30_support_dist,
                "m30_resist_dist": m30_resist_dist,
                "m30_room": m30_room,
                "mfe5": exc.get("mfe15R") if False else np.nan,
                "mfe15": exc.get("mfe15R"),
                "mfe30": exc.get("mfe30R"),
                "mae15": exc.get("mae15R"),
                "mae30": exc.get("mae30R"),
            }
        )
    df = pd.DataFrame(rows)
    df["win"] = df.profit > 0
    df["mfe5"] = np.nan
    return df.sort_values("open_time").reset_index(drop=True)


def agg(df, by, order=None):
    g = df.groupby(by, observed=True).agg(
        n=("win", "size"), wins=("win", "sum"), win_rate=("win", "mean"),
        pnl=("profit", "sum"), avg_r=("r_target", "mean"),
        med_hold=("holding_min", "median"), med_mfe30=("mfe30", "median"),
        med_mae15=("mae15", "median"),
    )
    if order is not None:
        g = g.reindex(order)
    return g.round(3)


def main() -> None:
    trades, contexts = fetch()
    df = build(trades, contexts)
    df.to_csv(os.path.join(DATA, "session10_entry_models.csv"), index=False)
    print("n", len(df), "pnl", round(df.profit.sum(), 2), "win", round(df.win.mean(), 3))
    print("\nM5 structure\n", agg(df, "m5_struct").to_string())
    print("\nM5 location\n", agg(df, "m5_loc").to_string())
    print("\nM5 archetype\n", agg(df, "m5_arch").to_string())
    print("\nM1 model\n", agg(df, "m1_model").to_string())
    print("\nM5 archetype x M1 model\n", agg(df, "m5_arch").to_string())
    print("\ncross m5_arch / m1_model\n")
    print(pd.crosstab(df.m5_arch, df.m1_model, values=df.profit, aggfunc="sum").round(1).to_string())
    print("\nm30 level\n", agg(df, "m30_at_level").to_string())
    print("\nworst 15")
    cols = ["trade_id", "direction", "open_time", "profit", "close_reason", "m5_arch", "m5_loc", "m1_model", "m5_dist_ema20", "m1_ext", "m30_at_level", "mfe30", "mae15"]
    print(df.nsmallest(15, "profit")[cols].to_string(index=False))
    print("\nbest 8")
    print(df.nlargest(8, "profit")[cols].to_string(index=False))
    # write facts
    facts = {
        "n": int(len(df)),
        "pnl": float(df.profit.sum()),
        "win_rate": float(df.win.mean()),
        "trades": json.loads(df.to_json(orient="records", force_ascii=False)),
    }
    with open(os.path.join(OUT, "session10_entry_facts.json"), "w", encoding="utf-8") as f:
        json.dump(facts, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
