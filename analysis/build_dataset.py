"""Turn the MCP export into one analysis table.

Input  : analysis/data/{sessions,trades,contexts.jsonl}
Output : analysis/data/features.csv / features.json
"""

from __future__ import annotations

import json
import os
from typing import Any

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")

CONTRACT = {"XAUUSD": 100.0, "XAGUSD": 5000.0}


def flatten(prefix: str, obj: dict[str, Any] | None) -> dict[str, Any]:
    if not obj:
        return {}
    out = {}
    for k, v in obj.items():
        if k in ("index", "time", "timeIso"):
            continue
        out[f"{prefix}_{k}"] = v
    return out


def load() -> tuple[dict, dict, list[dict]]:
    with open(os.path.join(DATA, "sessions.json"), encoding="utf-8") as f:
        sessions = json.load(f)
    with open(os.path.join(DATA, "trades.json"), encoding="utf-8") as f:
        trades = json.load(f)
    contexts = []
    with open(os.path.join(DATA, "contexts.jsonl"), encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                contexts.append(json.loads(line))
    return sessions, trades, contexts


def build() -> pd.DataFrame:
    _, trades, contexts = load()
    rows = []
    for ctx in contexts:
        t = ctx["trade"]
        uid = t["uid"]
        rec: dict[str, Any] = {
            "uid": uid,
            "session_id": t["sessionId"],
            "session_name": t["sessionName"],
            "trade_id": t["id"],
            "symbol": t["symbol"],
            "direction": t["direction"],
            "type": t.get("type", "buy" if t["direction"] == "long" else "sell"),
            "open_time": t["openTime"] / 1000,
            "close_time": t["closeTime"] / 1000,
            "open_dt": pd.to_datetime(t["openTime"], unit="ms", utc=True).tz_convert("Asia/Shanghai"),
            "close_dt": pd.to_datetime(t["closeTime"], unit="ms", utc=True).tz_convert("Asia/Shanghai"),
            "open_price": t["openPrice"],
            "close_price": t["closePrice"],
            "lot_size": t["lotSize"],
            "contract_size": t["contractSize"],
            "profit": t["profit"],
            "commission": t["commission"],
            "close_reason": t["closeReason"],
            "r_multiple": t["rMultiple"],
            "r_target": t["rOnRiskTarget"],
            "risk_target": t["riskTargetUsd"],
            "initial_sl": t["initialSlPrice"],
            "initial_risk": t["initialRiskUsd"],
            "risk_basis": t["riskBasis"],
            "stop_moved": t["stopMoved"],
            "planned_rr": t["plannedRR"],
            "holding_min": t["holdingMinutes"],
            "hour": t["openHour"],
            "weekday": t["openWeekday"],
            "session_tz": t["sessionTimezone"],
        }
        rec["day"] = rec["open_dt"].date()
        rec["win"] = rec["profit"] > 0

        # 初始止损是否在亏损侧（可采信） / 书：固定止损 vs 移动止损
        sl_side_ok = (
            (t["direction"] == "long" and t["initialSlPrice"] is not None and t["initialSlPrice"] < t["openPrice"])
            or (t["direction"] == "short" and t["initialSlPrice"] is not None and t["initialSlPrice"] > t["openPrice"])
        )
        rec["reliable_initial_risk"] = bool(t["riskBasis"] == "initial_stop" and sl_side_ok)
        rec["book"] = "fixed" if rec["reliable_initial_risk"] else (
            "moved" if t["riskBasis"] == "moved_stop" else "unknown"
        )
        rec["moved_or_unknown"] = rec["book"] != "fixed"

        for tf in ("M30", "M5", "M1"):
            series = ctx.get("series", {}).get(tf)
            rec.update(flatten(tf.lower(), series.get("features") if series else None))
            rec[f"{tf.lower()}_aligned"] = bool(series.get("directionAligned")) if series and series.get("directionAligned") is not None else None
            rec[f"{tf.lower()}_bars"] = len(series.get("bars", [])) if series else 0

        exc = ctx.get("excursions") or {}
        for k, v in exc.items():
            rec[f"exc_{k}"] = v
        # short aliases used by the report
        rec["mfe_price"] = exc.get("mfePrice")
        rec["mae_price"] = exc.get("maePrice")
        rec["mfe_r"] = exc.get("mfeR")
        rec["mae_r"] = exc.get("maeR")
        rec["mfe15"] = exc.get("mfe15R")
        rec["mfe30"] = exc.get("mfe30R")
        rec["mfe60"] = exc.get("mfe60R")
        rec["mae15"] = exc.get("mae15R")
        rec["mae30"] = exc.get("mae30R")
        rec["mae60"] = exc.get("mae60R")
        rec["t_mfe_min"] = exc.get("timeToMfeMinutes")
        rec["t_mae_min"] = exc.get("timeToMaeMinutes")
        rec["capture"] = exc.get("captureRatio")
        rows.append(rec)

    df = pd.DataFrame(rows)
    sign = np.where(df["direction"] == "long", 1.0, -1.0)
    for tf in ("m30", "m5", "m1"):
        if f"{tf}_rangePos20" in df:
            df[f"{tf}_dir_pos"] = np.where(sign > 0, df[f"{tf}_rangePos20"], 1 - df[f"{tf}_rangePos20"])
        for src, dst in (
            ("momentum15", "dir_mom15"),
            ("momentum60", "dir_mom60"),
            ("distEma20Atr", "dir_dist_ema20"),
            ("ema20Slope10Atr", "dir_slope"),
            ("rsi14", "dir_rsi"),
        ):
            col = f"{tf}_{src}"
            if col in df:
                if src == "rsi14":
                    df[f"{tf}_{dst}"] = np.where(sign > 0, df[col], 100 - df[col])
                elif src == "distEma20Atr":
                    df[f"{tf}_{dst}"] = -df[col] * sign
                else:
                    df[f"{tf}_{dst}"] = df[col] * sign
    df["rr_target"] = df["r_target"]
    return df


if __name__ == "__main__":
    df = build()
    out_csv = os.path.join(DATA, "features.csv")
    df.to_csv(out_csv, index=False)
    with open(os.path.join(DATA, "features.json"), "w", encoding="utf-8") as f:
        json.dump(json.loads(df.to_json(orient="records", force_ascii=False)), f, ensure_ascii=False, indent=2)
    print(f"rows={len(df)} cols={len(df.columns)} -> {out_csv}")
    print(df[["profit", "r_target", "r_multiple", "mfe_r", "mae_r", "mfe30"]].describe().round(3).to_string())
    print(df["book"].value_counts().to_string())
