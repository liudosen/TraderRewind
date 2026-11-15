"""Analyze session 10 (2026-10, XAUUSD) through the TraderRewind MCP server.

Outputs a per-trade feature table plus session-only aggregates, then prints
candidate "should have been cut" buckets grounded in the Jianghe KB rules.
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


def fetch_session(session_id: int = 10) -> tuple[list[dict], list[dict]]:
    c = McpClient("http://127.0.0.1:47821/mcp")
    c.initialize()
    trades = c.call("list_trades", {"sessionId": session_id, "limit": 100, "order": "asc"})["trades"]

    def one(t):
        cc = McpClient("http://127.0.0.1:47821/mcp")
        cc.initialize()
        ctx = cc.call(
            "get_trade_context",
            {
                "sessionId": session_id,
                "tradeId": t["id"],
                "timeframes": ["M30", "M15", "M5", "M1"],
                "beforeBars": 120,
                "afterBars": 60,
                "includeBars": False,
            },
        )
        ctx["_uid"] = t["uid"]
        return ctx

    with ThreadPoolExecutor(max_workers=6) as ex:
        contexts = list(ex.map(one, trades))
    return trades, contexts


def build(trades: list[dict], contexts: list[dict]) -> pd.DataFrame:
    rows = []
    for t, c in zip(trades, contexts):
        f30 = c["series"]["M30"]["features"]
        f15 = c["series"]["M15"]["features"]
        f5 = c["series"]["M5"]["features"]
        f1 = c["series"]["M1"]["features"]
        exc = c["excursions"] or {}
        direction = t["direction"]
        sign = 1 if direction == "long" else -1
        align3 = 0
        if f30["trendStack"] == "bull" and direction == "long":
            align3 = 1
        elif f30["trendStack"] == "bear" and direction == "short":
            align3 = 1
        elif f30["trendStack"] == "bear" and direction == "long":
            align3 = -1
        elif f30["trendStack"] == "bull" and direction == "short":
            align3 = -1
        pos = f30["rangePos20"]
        dir_pos = pos if direction == "long" else 1 - pos
        rec = {
            "uid": t["uid"],
            "trade_id": t["id"],
            "direction": direction,
            "open_time": pd.to_datetime(t["openTime"], unit="ms", utc=True).tz_convert("Asia/Shanghai"),
            "close_time": pd.to_datetime(t["closeTime"], unit="ms", utc=True).tz_convert("Asia/Shanghai"),
            "open_price": t["openPrice"],
            "close_price": t["closePrice"],
            "profit": t["profit"],
            "r_target": t["rOnRiskTarget"],
            "r_multiple": t["rMultiple"],
            "close_reason": t["closeReason"],
            "holding_min": t["holdingMinutes"],
            "hour": t["openHour"],
            "weekday": t["openWeekday"],
            "planned_rr": t["plannedRR"],
            "initial_risk": t["initialRiskUsd"],
            "risk_basis": t["riskBasis"],
            "lot": t["lotSize"],
            "align3": align3,
            "m30_trend": f30["trendStack"],
            "m30_atr": f30["atr14"],
            "m30_range_atr": (f30["hi20"] - f30["lo20"]) / f30["atr14"] if f30["atr14"] else np.nan,
            "m30_ema_gap_atr": abs(f30["ema20"] - f30["ema50"]) / f30["atr14"] if f30["atr14"] else np.nan,
            "m30_slope": f30["ema20Slope10Atr"],
            "m30_rsi": f30["rsi14"],
            "dir_pos": dir_pos,
            "dir_rsi": f30["rsi14"] if direction == "long" else 100 - f30["rsi14"],
            "dir_dist_ema20": -f30["distEma20Atr"] * sign,
            "m15_trend": f15["trendStack"],
            "m5_trend": f5["trendStack"],
            "m1_trend": f1["trendStack"],
            "mfe_r": exc.get("mfeR"),
            "mae_r": exc.get("maeR"),
            "mfe30": exc.get("mfe30R"),
            "mae15": exc.get("mae15R"),
            "mfe15": exc.get("mfe15R"),
            "mfe60": exc.get("mfe60R"),
            "t_mfe": exc.get("timeToMfeMinutes"),
            "capture": exc.get("captureRatio"),
        }
        rows.append(rec)
    df = pd.DataFrame(rows)
    df["win"] = df.profit > 0
    df["is_loss"] = df.profit < 0
    df["quick_sl"] = (df.close_reason == "sl") & (df.holding_min <= 15)
    df["far_fixed_tp"] = (df.risk_basis == "initial_stop") & (df.planned_rr >= 2)
    df["weak_trend"] = df.m30_ema_gap_atr < 0.25
    df["range_chop"] = df.m30_range_atr < 3.0
    df["chase"] = df.dir_dist_ema20 > 0.5
    df["no_follow"] = df.mfe30 < 0.5
    df["deep_heat"] = df.mae15 >= 0.75
    return df.sort_values("open_time").reset_index(drop=True)


def agg(df: pd.DataFrame, by: str, order=None):
    g = df.groupby(by, observed=True).agg(
        n=("win", "size"), wins=("win", "sum"), win_rate=("win", "mean"),
        pnl=("profit", "sum"), avg_r=("r_target", "mean"),
        med_hold=("holding_min", "median"), med_mfe30=("mfe30", "median"),
        med_mae15=("mae15", "median"),
    )
    if order:
        g = g.reindex(order)
    return g.round(3)


def main() -> None:
    trades, contexts = fetch_session(10)
    df = build(trades, contexts)
    df.to_csv(os.path.join(DATA, "session10_features.csv"), index=False)
    print("session10", len(df), "pnl", round(df.profit.sum(), 2), "win", round(df.win.mean(), 3), "avgR", round(df.r_target.mean(), 3))
    print("\nby direction\n", agg(df, "direction").to_string())
    print("\nby close reason\n", agg(df, "close_reason").to_string())
    print("\nby align3\n", agg(df, "align3", [-1, 0, 1]).to_string())
    print("\nby range position quartile\n")
    df["pos_q"] = pd.qcut(df.dir_pos, 4, labels=["Q1 low", "Q2", "Q3", "Q4 high"])
    print(agg(df, "pos_q", ["Q1 low", "Q2", "Q3", "Q4 high"]).to_string())
    print("\nby MFE30\n")
    df["mfe30_b"] = pd.cut(df.mfe30, [-0.001, 0.25, 0.5, 0.75, 1.25, 99], labels=["<0.25", "0.25-0.5", "0.5-0.75", "0.75-1.25", ">=1.25"])
    print(agg(df, "mfe30_b").to_string())
    print("\nby MAE15\n")
    df["mae15_b"] = pd.cut(df.mae15, [-0.001, 0.3, 0.5, 0.75, 1.0, 99], labels=["<0.3", "0.3-0.5", "0.5-0.75", "0.75-1.0", ">=1.0"])
    print(agg(df, "mae15_b").to_string())
    print("\nby planned RR (fixed stop)\n")
    fixed = df[df.risk_basis == "initial_stop"].copy()
    fixed["rr_b"] = pd.cut(fixed.planned_rr, [-0.001, 1.5, 2, 3, 5, 99], labels=["<1.5", "1.5-2", "2-3", "3-5", ">=5"])
    print(agg(fixed, "rr_b").to_string())
    print("\nby hour\n", agg(df, "hour").to_string())
    print("\nby weekday\n", agg(df, "weekday").to_string())
    print("\nflag counts")
    for col in ["align3", "far_fixed_tp", "weak_trend", "range_chop", "chase", "no_follow", "deep_heat", "quick_sl"]:
        if col == "align3":
            sub = df[df.align3 == -1]
            print("counter_trend", len(sub), round(sub.win.mean(), 3), round(sub.profit.sum(), 2))
        else:
            sub = df[df[col]]
            print(col, len(sub), round(sub.win.mean(), 3) if len(sub) else None, round(sub.profit.sum(), 2) if len(sub) else None)
    print("\nworst 12")
    cols = ["trade_id", "direction", "open_time", "profit", "r_target", "close_reason", "align3", "m30_trend", "dir_pos", "planned_rr", "mfe30", "mae15", "holding_min", "weak_trend", "range_chop", "chase", "far_fixed_tp"]
    print(df.nsmallest(12, "profit")[cols].to_string(index=False))
    print("\nbest 8")
    print(df.nlargest(8, "profit")[cols].to_string(index=False))
    # write JSON for report
    data = {
        "n": int(len(df)),
        "pnl": float(df.profit.sum()),
        "win_rate": float(df.win.mean()),
        "avg_r": float(df.r_target.mean()),
        "trades": json.loads(df.to_json(orient="records", force_ascii=False)),
    }
    with open(os.path.join(OUT, "session10_facts.json"), "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
