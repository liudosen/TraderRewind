"""Backfill Jianghe entry-model + market-state labels into session-10 notes/tags."""

from __future__ import annotations

import json
import os
import sqlite3

import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
OUT = os.path.join(HERE, "output")
DB = os.path.expandvars(r"%APPDATA%\TraderRewindDesktop\data\training\training.db")

MODEL_TAG = {
    "左中左": "左中左",
    "左中右": "左中右",
    "右中左": "右中左",
    "右中右": "右中右",
    "无模型（M5中段）": "无模型",
}
STATE_TAG = {"强趋势": "强趋势", "次强趋势": "次强趋势", "弱趋势": "弱趋势", "震荡": "震荡"}


def main() -> None:
    ms = pd.read_csv(os.path.join(OUT, "session10_model_state.csv"))
    m5 = pd.read_csv(os.path.join(DATA, "session10_m5_features.csv"))
    applied = json.load(open(os.path.join(OUT, "session10_applied.json"), encoding="utf-8"))
    base = {x["id"]: x for x in applied}
    df = ms.merge(m5[["trade_id", "r_target", "mfe5", "mae5", "mfe30", "mae15", "m5_align"]], on="trade_id", how="left")
    assert len(df) == 49, len(df)

    rows = []
    for _, r in df.iterrows():
        tid = r.trade_id
        b = base.get(tid, {"tags": [], "profit": r.profit, "close": r.close})
        tags = list(b.get("tags", []))
        action = "保留"
        if "该砍" in tags:
            action = "砍"
        elif "管理" in tags:
            action = "管理"
        elif "改出场" in tags:
            action = "改出场"
        elif "观察" in tags:
            action = "观察"

        model = r.model
        state = r.state
        # 左中右 in this sample is 0/6; make it a hard cut regardless of old action.
        if model == "左中右":
            action = "砍"

        alignment = "区间"
        if r.struct == "up":
            alignment = "M5同向" if r.direction == "long" else "M5逆势"
        elif r.struct == "down":
            alignment = "M5同向" if r.direction == "short" else "M5逆势"
        # 强/次强趋势里的逆势单，直接砍。
        if alignment == "M5逆势" and state in ("强趋势", "次强趋势"):
            action = "砍"

        if action == "砍":
            for x in ("保留", "标准单", "Q4", "观察", "等确认", "管理", "改出场"):
                if x in tags:
                    tags.remove(x)
            if "该砍" not in tags:
                tags.insert(0, "该砍")
        elif action == "管理":
            for x in ("保留", "标准单", "观察", "等确认", "该砍", "改出场"):
                if x in tags:
                    tags.remove(x)
            if "管理" not in tags:
                tags.insert(0, "管理")
        elif action == "改出场":
            for x in ("保留", "标准单", "该砍", "管理"):
                if x in tags:
                    tags.remove(x)
            if "改出场" not in tags:
                tags.insert(0, "改出场")
        elif action == "观察":
            for x in ("保留", "标准单", "Q4", "该砍", "管理", "改出场"):
                if x in tags:
                    tags.remove(x)
            for x in ("观察", "等确认"):
                if x not in tags:
                    tags.append(x)
        else:
            if "保留" not in tags:
                tags.insert(0, "保留")

        mt = MODEL_TAG.get(model, "无模型")
        st = STATE_TAG.get(state, state)
        for t in (mt, st):
            if t not in tags:
                tags.append(t)
        # de-dupe + app limits
        clean = []
        for t in tags:
            t = str(t).strip()[:12]
            if t and t not in clean:
                clean.append(t)
        tags = clean[:10]

        if action == "砍":
            if model == "左中右":
                conclusion = "左中右在本样本 0/6 全亏：只做到低点抬高、未破前高就左侧接，砍；等 1M 真正破前高/前低再进。"
            elif r.profit > 0:
                conclusion = "按模型/环境规则应砍；事后小赚，属样本内错杀，不改变规则。"
            else:
                conclusion = "按模型/环境规则应砍，这笔亏损本来可以避免。"
        elif action == "管理":
            conclusion = "5 分钟没走出/已深水，减仓或早退；不要扛到 -1R。"
        elif action == "改出场":
            conclusion = "远 TP 与早期动能不匹配，改成 1:1 后移动止损。"
        elif action == "观察":
            conclusion = "模型/方向可做，但 5 分钟没有走强；观察、减仓，等确认，不补单。"
        else:
            if model == "右中左":
                conclusion = "右中左是本样本主模型（20 笔 / 55% / +355），保留；按移动止损持有。"
            elif model == "无模型（M5中段）":
                conclusion = "无模型（M5中段）本样本 11 笔 / 73% / +1047，是利润来源；但不可当标准模型复制，依赖 M5 方向 + 5 分钟跟随。"
            else:
                conclusion = "模型/状态可做，保留；5 分钟不走强则减仓。"

        if state == "弱趋势" and action != "砍":
            conclusion = "弱趋势样本 14 笔 / 43% / -286，降低预期、减仓。" + conclusion

        note = (
            f"【江河模型】{model}｜【市场状态】{state}\n"
            f"【1M】{r.model_reason or 'M5 中段，1M 无有效结构'}\n"
            f"【M5】{r.struct}，EMA20/50 间距 {r.gap:.2f} ATR，10 根斜率 {r.slope:+.2f} ATR，回撤 {r.pullback:.0%}\n"
            f"【结果】{alignment}；MFE5 {r.mfe5:+.2f}R/MAE5 {r.mae5:+.2f}R；{r.close} {r.profit:+.2f}（{r.r_target:+.2f}R）\n"
            f"【结论】{conclusion}"
        )
        rows.append({"trade_id": tid, "action": action, "tags": tags, "note": note, "model": model, "state": state})

    out = pd.DataFrame(rows)
    out.to_csv(os.path.join(OUT, "session10_model_annotations.csv"), index=False, encoding="utf-8-sig")
    with open(os.path.join(OUT, "session10_model_annotations.json"), "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False, indent=2)
    print("actions", out.action.value_counts().to_dict())
    print("tags", pd.Series([t for x in out.tags for t in x]).value_counts().to_dict())

    backup = os.path.join(OUT, "training.db.bak-before-model-notes")
    src = sqlite3.connect(DB)
    dst = sqlite3.connect(backup)
    src.backup(dst)
    dst.close(); src.close()
    print("backup", backup, os.path.getsize(backup))

    con = sqlite3.connect(DB, timeout=30)
    con.execute("PRAGMA busy_timeout = 30000")
    cur = con.cursor()
    cur.execute("BEGIN IMMEDIATE")
    changed = 0
    for x in rows:
        res = cur.execute(
            "UPDATE closed_trades SET notes = ?, tags_json = ? WHERE session_id = 10 AND id = ?",
            (x["note"], json.dumps(x["tags"], ensure_ascii=False), x["trade_id"]),
        )
        changed += res.rowcount
    con.commit()
    print("changed", changed)
    n = cur.execute("SELECT COUNT(*) FROM closed_trades WHERE session_id=10 AND notes IS NOT NULL AND tags_json IS NOT NULL").fetchone()[0]
    print("session10 annotated", n)
    con.close()


if __name__ == "__main__":
    main()
