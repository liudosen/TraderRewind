"""Keep only Jianghe-system tags on session 10.

Allowed tags are exactly the app's default Jianghe tag library:
  左中左 / 左中右 / 右中左 / 右中右 / 强趋势 / 次强趋势 / 弱趋势 / 震荡

Each order gets its model (if it has one) + its market state. Orders with no
valid model get only the state tag. Notes are left untouched.
"""

from __future__ import annotations

import json
import os
import sqlite3

import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "output")
DB = os.path.expandvars(r"%APPDATA%\TraderRewindDesktop\data\training\training.db")

MODELS = {"左中左", "左中右", "右中左", "右中右"}
STATES = {"强趋势", "次强趋势", "弱趋势", "震荡"}


def main() -> None:
    ms = pd.read_csv(os.path.join(OUT, "session10_model_state.csv"))
    rows = []
    for _, r in ms.iterrows():
        model = r.model if r.model in MODELS else ""
        state = r.state if r.state in STATES else ""
        tags = [t for t in (model, state) if t]
        rows.append({"trade_id": r.trade_id, "time": r.time, "model": model, "state": state, "tags": tags})

    df = pd.DataFrame(rows)
    df.to_csv(os.path.join(OUT, "session10_jianghe_tags.csv"), index=False, encoding="utf-8-sig")
    with open(os.path.join(OUT, "session10_jianghe_tags.json"), "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False, indent=2)

    from collections import Counter
    print("model tags", Counter(r["model"] for r in rows if r["model"]))
    print("state tags", Counter(r["state"] for r in rows if r["state"]))
    print("tag pairs", Counter(tuple(r["tags"]) for r in rows))

    backup = os.path.join(OUT, "training.db.bak-before-jianghe-only-tags")
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
            (json.dumps(r["tags"], ensure_ascii=False), r["trade_id"]),
        )
        changed += res.rowcount
    con.commit()
    print("changed", changed)

    allowed = MODELS | STATES
    bad = []
    for tid, raw in cur.execute("SELECT id, tags_json FROM closed_trades WHERE session_id = 10"):
        tags = json.loads(raw) if raw else []
        if any(t not in allowed for t in tags):
            bad.append((tid, tags))
    print("non-jianghe tags remaining", bad)
    print("notes intact", cur.execute("SELECT COUNT(*) FROM closed_trades WHERE session_id=10 AND notes IS NOT NULL").fetchone()[0])
    con.close()


if __name__ == "__main__":
    main()
