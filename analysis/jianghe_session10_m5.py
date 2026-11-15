"""Session-10 diagnosis aligned to the user's framework:

    M5  = main timeframe (trend / structure / position)
    M1  = execution (trigger / early follow-through)
    M30 = major support / resistance (location filter)

This is separate from jianghe_session10.py (which used M30 as the main trend).
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
                "timeframes": ["M30", "M15", "M5", "M1"],
                "beforeBars": 120,
                "afterBars": 60,
                "includeBars": True,
            },
        )
        ctx["_uid"] = t["uid"]
        return ctx

    with ThreadPoolExecutor(max_workers=6) as ex:
        contexts = list(ex.map(one, trades))
    return trades, contexts


def trend_align(trend: str, direction: str) -> int:
    if trend == "bull" and direction == "long":
        return 1
    if trend == "bear" and direction == "short":
        return 1
    if trend == "bear" and direction == "long":
        return -1
    if trend == "bull" and direction == "short":
        return -1
    return 0


def build(trades, contexts) -> pd.DataFrame:
    rows = []
    for t, c in zip(trades, contexts):
        f30 = c["series"]["M30"]["features"]
        f5 = c["series"]["M5"]["features"]
        f1 = c["series"]["M1"]["features"]
        exc = c["excursions"] or {}
        direction = t["direction"]
        sign = 1 if direction == "long" else -1
        entry = t["openPrice"]
        risk = t["riskTargetUsd"] or 100
        notional = t["lotSize"] * t["contractSize"]

        m30_support = (entry - f30["lo20"]) / f30["atr14"] if f30["atr14"] else np.nan
        m30_resist = (f30["hi20"] - entry) / f30["atr14"] if f30["atr14"] else np.nan
        m30_room = m30_resist if direction == "long" else m30_support
        near_m30_support = bool(direction == "long" and m30_support <= 0.5)
        near_m30_resist = bool(direction == "short" and m30_resist <= 0.5)
        m30_mid = bool(m30_support > 0.5 and m30_resist > 0.5)
        at_m30_wall = bool(
            (direction == "long" and m30_resist <= 0.5)
            or (direction == "short" and m30_support <= 0.5)
        )

        # First 5 minutes from M1 bars.
        entry_sec = int(t["openTime"] / 1000)
        bars = c["series"]["M1"]["bars"]
        first = [b for b in bars if entry_sec <= b["time"] <= entry_sec + 300]
        if first:
            if direction == "long":
                mfe5_price = max(b["high"] for b in first) - entry
                mae5_price = entry - min(b["low"] for b in first)
            else:
                mfe5_price = entry - min(b["low"] for b in first)
                mae5_price = max(b["high"] for b in first) - entry
            ret5_price = (first[-1]["close"] - entry) * sign
        else:
            mfe5_price = mae5_price = ret5_price = np.nan

        rec = {
            "uid": t["uid"],
            "trade_id": t["id"],
            "direction": direction,
            "open_time": pd.to_datetime(t["openTime"], unit="ms", utc=True).tz_convert("Asia/Shanghai"),
            "profit": t["profit"],
            "r_target": t["rOnRiskTarget"],
            "r_multiple": t["rMultiple"],
            "close_reason": t["closeReason"],
            "holding_min": t["holdingMinutes"],
            "hour": t["openHour"],
            "weekday": t["openWeekday"],
            "planned_rr": t["plannedRR"],
            "risk_basis": t["riskBasis"],
            "open_price": entry,
            "lot": t["lotSize"],
            # M5 main
            "m5_trend": f5["trendStack"],
            "m5_align": trend_align(f5["trendStack"], direction),
            "m5_range_pos": f5["rangePos20"],
            "m5_dir_pos": f5["rangePos20"] if direction == "long" else 1 - f5["rangePos20"],
            "m5_atr": f5["atr14"],
            "m5_rsi": f5["rsi14"],
            "m5_dir_rsi": f5["rsi14"] if direction == "long" else 100 - f5["rsi14"],
            "m5_dist_ema20": -f5["distEma20Atr"] * sign,
            "m5_slope": f5["ema20Slope10Atr"] * sign,
            "m5_gap_atr": abs(f5["ema20"] - f5["ema50"]) / f5["atr14"] if f5["atr14"] else np.nan,
            "m5_hi20": f5["hi20"],
            "m5_lo20": f5["lo20"],
            # M1 execution
            "m1_trend": f1["trendStack"],
            "m1_align": trend_align(f1["trendStack"], direction),
            "m1_range_pos": f1["rangePos20"],
            "m1_dir_pos": f1["rangePos20"] if direction == "long" else 1 - f1["rangePos20"],
            "m1_atr": f1["atr14"],
            "m1_rsi": f1["rsi14"],
            "m1_dir_rsi": f1["rsi14"] if direction == "long" else 100 - f1["rsi14"],
            "m1_dist_ema20": -f1["distEma20Atr"] * sign,
            "m1_slope": f1["ema20Slope10Atr"] * sign,
            # M30 location
            "m30_trend": f30["trendStack"],
            "m30_align": trend_align(f30["trendStack"], direction),
            "m30_atr": f30["atr14"],
            "m30_support_atr": m30_support,
            "m30_resist_atr": m30_resist,
            "m30_room_atr": m30_room,
            "m30_mid": m30_mid,
            "near_m30_support": near_m30_support,
            "near_m30_resist": near_m30_resist,
            "at_m30_wall": at_m30_wall,
            # excursions
            "mfe_r": exc.get("mfeR"),
            "mae_r": exc.get("maeR"),
            "mfe15": exc.get("mfe15R"),
            "mfe30": exc.get("mfe30R"),
            "mfe60": exc.get("mfe60R"),
            "mae15": exc.get("mae15R"),
            "mae30": exc.get("mae30R"),
            "t_mfe": exc.get("timeToMfeMinutes"),
            "capture": exc.get("captureRatio"),
            "mfe5": (mfe5_price * notional / risk) if pd.notna(mfe5_price) else np.nan,
            "mae5": (mae5_price * notional / risk) if pd.notna(mae5_price) else np.nan,
            "ret5_r": (ret5_price * notional / risk) if pd.notna(ret5_price) else np.nan,
        }
        rows.append(rec)
    df = pd.DataFrame(rows)
    df["win"] = df.profit > 0
    df["m5_counter"] = df.m5_align == -1
    df["m5_bottom"] = df.m5_dir_pos < 0.5
    df["m5_chase"] = df.m5_dist_ema20 > 0.5
    df["m1_chase"] = df.m1_dist_ema20 > 0.5
    df["m30_mid_zone"] = df.m30_mid
    df["m30_wall"] = df.at_m30_wall
    df["m30_near_support_long"] = df.near_m30_support
    df["m30_near_resist_short"] = df.near_m30_resist
    df["no_follow"] = df.mfe30 < 0.5
    df["deep_heat"] = df.mae15 >= 0.75
    df["quick_sl"] = (df.close_reason == "sl") & (df.holding_min <= 15)
    return df.sort_values("open_time").reset_index(drop=True)


def agg(df, col, order=None):
    g = df.groupby(col, observed=True).agg(
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
    df.to_csv(os.path.join(DATA, "session10_m5_features.csv"), index=False)
    print("n", len(df), "pnl", round(df.profit.sum(), 2), "win", round(df.win.mean(), 3), "avgR", round(df.r_target.mean(), 3))
    print("\nM5 align\n", agg(df, "m5_align", [-1, 0, 1]).to_string())
    print("\nM1 align\n", agg(df, "m1_align", [-1, 0, 1]).to_string())
    print("\nM30 align\n", agg(df, "m30_align", [-1, 0, 1]).to_string())
    print("\nM5 dir pos quartile\n")
    df["m5_pos_q"] = pd.qcut(df.m5_dir_pos, 4, labels=["Q1", "Q2", "Q3", "Q4"])
    print(agg(df, "m5_pos_q", ["Q1", "Q2", "Q3", "Q4"]).to_string())
    print("\nM30 location\n")
    df["m30_loc"] = "mid"
    df.loc[(df.direction == "long") & df.near_m30_support, "m30_loc"] = "at_support_long"
    df.loc[(df.direction == "short") & df.near_m30_resist, "m30_loc"] = "at_resist_short"
    df.loc[df.at_m30_wall, "m30_loc"] = "at_wall"
    print(agg(df, "m30_loc").to_string())
    print("\nM5 + M1 alignment\n")
    df["combo"] = df.m5_align.astype(str) + "/" + df.m1_align.astype(str)
    print(agg(df, "combo").to_string())
    print("\nflags")
    for col in ["m5_counter", "m5_bottom", "m5_chase", "m1_chase", "m30_mid_zone", "m30_wall", "no_follow", "deep_heat", "quick_sl"]:
        g = df[df[col]]
        print(col, len(g), round(g.win.mean(), 3) if len(g) else None, round(g.profit.sum(), 2) if len(g) else None)
    print("\nMFE5\n")
    df["mfe5_b"] = pd.cut(df.mfe5, [-99, 0.25, 0.5, 1.0, 99], labels=["<0.25", "0.25-0.5", "0.5-1", ">=1"])
    print(agg(df, "mfe5_b").to_string())
    print("\nMAE5\n")
    df["mae5_b"] = pd.cut(df.mae5, [-99, 0.25, 0.5, 1.0, 99], labels=["<0.25", "0.25-0.5", "0.5-1", ">=1"])
    print(agg(df, "mae5_b").to_string())
    print("\nM5 trend + position + M1 trigger\n")
    df["m5_ok"] = (~df.m5_counter) & (df.m5_dir_pos >= 0.5)
    df["m1_ok"] = (df.m1_align >= 0) & (df.m1_dir_pos >= 0.5) & (~df.m1_chase)
    for label, mask in [
        ("M5 势位都过", df.m5_ok),
        ("M5 势位 + M1 触发", df.m5_ok & df.m1_ok),
        ("M5 势位 + M1 未触发", df.m5_ok & ~df.m1_ok),
        ("M5 势位 + M1 触发 + M30 非中段", df.m5_ok & df.m1_ok & ~df.m30_mid_zone),
    ]:
        g = df[mask]
        print(label, len(g), round(g.win.mean(), 3) if len(g) else None, round(g.profit.sum(), 2) if len(g) else None)
    print("\nM5 势位 + M1 未触发 明细")
    print(df[df.m5_ok & ~df.m1_ok][["trade_id", "direction", "open_time", "profit", "close_reason", "m5_align", "m5_dir_pos", "m1_align", "m1_dir_pos", "m1_dist_ema20", "m30_loc", "mfe30", "mae15", "holding_min"]].to_string(index=False))
    # save
    facts = {
        "n": int(len(df)),
        "pnl": float(df.profit.sum()),
        "win_rate": float(df.win.mean()),
        "avg_r": float(df.r_target.mean()),
        "trades": json.loads(df.to_json(orient="records", force_ascii=False)),
    }
    with open(os.path.join(OUT, "session10_m5_facts.json"), "w", encoding="utf-8") as f:
        json.dump(facts, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
