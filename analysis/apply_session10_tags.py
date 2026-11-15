"""Apply M5-framework tags + one-line conclusions to session 10.

Writes `closed_trades.notes` and `tags_json` for the 49 orders in session 10.
The app is running with WAL; this script takes a consistent backup first and
uses a busy timeout so it does not fight the app's connection.
"""

from __future__ import annotations

import json
import os
import shutil
import sqlite3

import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
OUT = os.path.join(HERE, "output")
DB = os.path.expandvars(r"%APPDATA%\TraderRewindDesktop\data\training\training.db")

CLUSTER = {
    "t_1794217736671_1fg3": ("10-05 同一位置第 1 笔", "first"),
    "t_1794217763894_ynpu": ("10-05 同一位置第 2 笔", "second"),
    "t_1794217877610_yk40": ("10-05 同一位置第 3 笔", "third"),
    "t_1794217909827_u7pu": ("10-05 同一位置第 4 笔", "fourth"),
    "t_1794225234077_whd6": ("10-16 同一位置第 1 笔", "first"),
    "t_1794225303623_b3mo": ("10-16 同一位置第 2 笔", "second"),
    "t_1794225368176_whyy": ("10-16 同一位置第 3 笔", "third"),
}


def m5_label(v: int) -> str:
    return {1: "M5同向", 0: "M5混合", -1: "M5逆势"}.get(int(v), "M5未知")


def build_updates(df: pd.DataFrame) -> list[dict]:
    updates = []
    for _, r in df.iterrows():
        tid = r.trade_id
        align = int(r.m5_align)
        cluster, role = CLUSTER.get(tid, ("", ""))
        cut = align <= 0 or role in ("third", "fourth")
        manage = (not cut) and (r.mfe5 < 0.25 and r.mae5 >= 0.5)
        far_tp = bool(r.risk_basis == "initial_stop" and pd.notna(r.planned_rr) and r.planned_rr >= 2)
        standard = (not cut) and (not manage) and align == 1 and r.mfe5 >= 0.5
        q4 = (not cut) and (not manage) and align == 1 and r.m5_dir_pos >= 0.75

        if cut:
            if align == -1:
                tags = ["该砍", "M5逆势"]
            elif align == 0:
                tags = ["该砍", "M5混合"]
            else:
                tags = ["该砍", "M5同向"]
            if role in ("third", "fourth"):
                tags.append("连亏停手")
            if far_tp:
                tags.append("远TP")
            if r.mae15 >= 0.75:
                tags.append("15分深水")
            if role in ("third", "fourth") and align == 1:
                conclusion = "结论：M5 同向，但同一位置已连亏两笔，第三/四笔应停手，不再补单。"
            elif r.profit > 0:
                conclusion = "结论：按 M5 方向/停手规则应砍；事后小赚，属样本内错杀，不改变规则。"
            else:
                conclusion = "结论：按 M5 方向/停手规则应砍，这笔亏损本来可以避免。"
        elif manage:
            tags = ["管理", "5分钟未走"]
            if r.mae15 >= 0.75:
                tags.append("15分深水")
            if role:
                tags.append("连亏第1笔" if role == "first" else "连亏第2笔")
            if far_tp:
                tags.append("远TP")
            conclusion = (
                "结论：5 分钟没走出且已深水，按管理规则应减仓/早退；本次最终小赚，属规则成本。"
                if r.profit > 0
                else "结论：5 分钟没走出且已深水，应减仓/早退，不该扛到 -1R。"
            )
        elif far_tp:
            if r.profit > 0:
                tags = ["远TP", "保留"]
                if role:
                    tags.append("连亏第1笔" if role == "first" else "连亏第2笔")
                conclusion = "结论：本次远 TP 成功（TP），但组内 15 笔仅 2 笔 TP、整体 -661；远 TP 不能当常态，建议改成 1:1 后移动止损保护利润。"
            else:
                tags = ["改出场", "远TP"]
                if role:
                    tags.append("连亏第1笔" if role == "first" else "连亏第2笔")
                conclusion = "结论：远 TP 与早期动能不匹配，改成 1:1 后移动止损。"
        elif standard:
            tags = ["保留", "标准单"]
            if q4:
                tags.append("Q4")
            conclusion = "结论：M5 同向 + 5 分钟走出，标准单，保留；按移动止损持有。"
        elif q4:
            tags = ["保留", "Q4"]
            conclusion = "结论：M5 同向 + Q4，保留；5 分钟不走强则减仓。"
        else:
            tags = ["观察", "等确认"]
            conclusion = "结论：M5 同向但 5 分钟未走强，观察/减仓，等确认。"

        prefix = f"{cluster}；" if cluster else ""
        rr = f"、计划 RR {r.planned_rr:.2f}" if far_tp else ""
        note = (
            f"{prefix}{m5_label(align)}、位置 {r.m5_dir_pos*100:.0f}%、"
            f"MFE5 {r.mfe5:+.2f}R/MAE5 {r.mae5:+.2f}R、"
            f"MFE30 {r.mfe30:+.2f}R/MAE15 {r.mae15:+.2f}R、"
            f"{r.close_reason} {r.profit:+.2f}（{r.r_target:+.2f}R）{rr}。{conclusion}"
        )
        # Keep tags within app limits (<=10, <=12 chars) and dedupe.
        clean = []
        for t in tags:
            t = str(t).strip()[:12]
            if t and t not in clean:
                clean.append(t)
        updates.append(
            {
                "sessionId": 10,
                "tradeId": tid,
                "note": note,
                "tags": clean[:10],
                "action": "砍" if cut else ("管理" if manage else ("改出场" if (far_tp and r.profit <= 0) else "保留")),
            }
        )
    return updates


def main() -> None:
    df = pd.read_csv(os.path.join(DATA, "session10_m5_features.csv"))
    updates = build_updates(df)
    with open(os.path.join(OUT, "session10_tag_updates.json"), "w", encoding="utf-8") as f:
        json.dump(updates, f, ensure_ascii=False, indent=2)
    print("updates", len(updates))
    from collections import Counter
    print("actions", Counter(u["action"] for u in updates))
    print("tags", Counter(t for u in updates for t in u["tags"]))

    if not os.path.exists(DB):
        raise SystemExit(f"DB not found: {DB}")
    backup = os.path.join(OUT, "training.db.bak-before-session10-tags")
    src = sqlite3.connect(DB)
    dst = sqlite3.connect(backup)
    src.backup(dst)
    dst.close()
    src.close()
    print("backup", backup, os.path.getsize(backup))

    con = sqlite3.connect(DB, timeout=30)
    con.execute("PRAGMA busy_timeout = 30000")
    cur = con.cursor()
    cur.execute("BEGIN IMMEDIATE")
    changed = 0
    missing = []
    for u in updates:
        res = cur.execute(
            "UPDATE closed_trades SET notes = ?, tags_json = ? WHERE session_id = ? AND id = ?",
            (u["note"], json.dumps(u["tags"], ensure_ascii=False), u["sessionId"], u["tradeId"]),
        )
        if res.rowcount == 0:
            missing.append(u["tradeId"])
        else:
            changed += res.rowcount
    con.commit()
    print("changed", changed, "missing", missing)
    n_note, n_tags = cur.execute(
        "SELECT SUM(notes IS NOT NULL), SUM(tags_json IS NOT NULL AND tags_json != '[]') FROM closed_trades WHERE session_id = 10"
    ).fetchone()
    print("session10 notes/tags", n_note, n_tags)
    # sample
    for row in cur.execute(
        "SELECT id, notes, tags_json FROM closed_trades WHERE session_id = 10 ORDER BY open_time LIMIT 3"
    ):
        print(row)
    con.close()


if __name__ == "__main__":
    main()
