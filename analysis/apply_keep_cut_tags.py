"""Add the binary decision tags (保留 / 该砍) on top of Jianghe model+state tags.

Final tags per order:
  [model if any] + [state] + [保留 | 该砍]

Only these tags are kept. Notes are not changed.
"""

from __future__ import annotations

import json
import os
import sqlite3
from collections import Counter

import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "output")
DB = os.path.expandvars(r"%APPDATA%\TraderRewindDesktop\data\training\training.db")

MODELS = {"左中左", "左中右", "右中左", "右中右"}
STATES = {"强趋势", "次强趋势", "弱趋势", "震荡"}


def main() -> None:
    ms = pd.read_csv(os.path.join(OUT, "session10_model_state.csv"))
    ann = pd.read_csv(os.path.join(OUT, "session10_model_annotations.csv"))
    action = dict(zip(ann.trade_id, ann.action))
    rows = []
    for r in ms.itertuples():
        model = r.model if r.model in MODELS else ""
        state = r.state if r.state in STATES else ""
        decision = "该砍" if action.get(r.trade_id) == "砍" else "保留"
        tags = [t for t in (model, state, decision) if t]
        rows.append({"trade_id": r.trade_id, "time": r.time, "model": model, "state": state, "decision": decision, "tags": "、".join(tags)})

    df = pd.DataFrame(rows)
    df.to_csv(os.path.join(OUT, "session10_final_tags.csv"), index=False, encoding="utf-8-sig")
    with open(os.path.join(OUT, "session10_final_tags.json"), "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False, indent=2)
    print("decisions", Counter(r["decision"] for r in rows))
    print("models", Counter(r["model"] for r in rows if r["model"]))
    print("states", Counter(r["state"] for r in rows if r["state"]))
    print("examples", df.head(5).to_string(index=False))

    backup = os.path.join(OUT, "training.db.bak-before-keep-cut-tags")
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
    for r in rows:
        res = cur.execute(
            "UPDATE closed_trades SET tags_json = ? WHERE session_id = 10 AND id = ?",
            (json.dumps([x for x in r["tags"].split("、") if x], ensure_ascii=False), r["trade_id"]),
        )
        changed += res.rowcount
    con.commit()
    print("changed", changed)
    print("notes intact", cur.execute("SELECT COUNT(*) FROM closed_trades WHERE session_id=10 AND notes IS NOT NULL").fetchone()[0])
    con.close()


if __name__ == "__main__":
    main()
