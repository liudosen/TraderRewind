"""Collect every trade and its multi-timeframe context through the TraderRewind MCP server.

The point of this script is that the analysis data really comes over MCP, not
from a private SQLite shortcut.  It speaks the Streamable HTTP transport with
only the Python standard library.

Usage:
    python analysis/collect_via_mcp.py [--url http://127.0.0.1:47821/mcp]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
os.makedirs(DATA, exist_ok=True)

DEFAULT_URL = "http://127.0.0.1:47821/mcp"


class McpClient:
    def __init__(self, url: str):
        self.url = url
        self.session_id: str | None = None
        self.protocol: str | None = None
        self._id = 0
        self._lock = threading.Lock()
        # Never route 127.0.0.1 through the system proxy
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def _post(self, payload: dict) -> dict | None:
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        }
        if self.session_id:
            headers["Mcp-Session-Id"] = self.session_id
        if self.protocol:
            headers["MCP-Protocol-Version"] = self.protocol
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(self.url, data=data, headers=headers, method="POST")
        try:
            with self._opener.open(req, timeout=120) as res:
                sid = res.headers.get("Mcp-Session-Id")
                if sid:
                    self.session_id = sid
                pv = res.headers.get("MCP-Protocol-Version")
                if pv:
                    self.protocol = pv
                if res.status == 202:
                    return None
                body = res.read().decode("utf-8")
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")
            raise RuntimeError(f"HTTP {e.code}: {body}") from e
        if not body.strip():
            return None
        ctype = res.headers.get("Content-Type", "")
        if "text/event-stream" in ctype:
            last = None
            for line in body.splitlines():
                line = line.strip()
                if line.startswith("data:"):
                    chunk = line[5:].strip()
                    if chunk and chunk != "[DONE]":
                        try:
                            last = json.loads(chunk)
                        except json.JSONDecodeError:
                            pass
            return last
        return json.loads(body)

    def _next_id(self) -> int:
        with self._lock:
            self._id += 1
            return self._id

    def initialize(self) -> dict:
        res = self._post(
            {
                "jsonrpc": "2.0",
                "id": self._next_id(),
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-06-18",
                    "capabilities": {},
                    "clientInfo": {"name": "traderrewind-analysis", "version": "1.0.0"},
                },
            }
        )
        if not res or "error" in (res or {}):
            raise RuntimeError(f"initialize failed: {res}")
        self._post({"jsonrpc": "2.0", "method": "notifications/initialized"})
        return res["result"]

    def call(self, name: str, args: dict) -> dict:
        res = self._post(
            {
                "jsonrpc": "2.0",
                "id": self._next_id(),
                "method": "tools/call",
                "params": {"name": name, "arguments": args},
            }
        )
        if not res:
            raise RuntimeError(f"{name}: empty response")
        if "error" in res:
            raise RuntimeError(f"{name}: {res['error']}")
        result = res["result"]
        if result.get("isError"):
            text = "\n".join(c.get("text", "") for c in result.get("content", []))
            raise RuntimeError(f"{name}: {text}")
        return result.get("structuredContent", result)


def write_json(path: str, value) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(value, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=os.environ.get("TR_MCP_URL", DEFAULT_URL))
    ap.add_argument("--workers", type=int, default=6)
    args = ap.parse_args()

    t0 = time.time()
    client = McpClient(args.url)
    info = client.initialize()
    print(f"[mcp] {info['serverInfo']['name']} {info['serverInfo']['version']} protocol={info['protocolVersion']}")

    sessions = client.call("list_sessions", {"includeEmpty": True})
    write_json(os.path.join(DATA, "sessions.json"), sessions)
    print(f"[mcp] {sessions['count']} sessions, {sessions['totals']['trades']} trades in summary")

    trades = client.call("list_trades", {"limit": 1000, "order": "asc"})
    write_json(os.path.join(DATA, "trades.json"), trades)
    trade_list = trades["trades"]
    print(f"[mcp] fetched {len(trade_list)} trades")

    path = os.path.join(DATA, "contexts.jsonl")
    done_path = os.path.join(DATA, "contexts.done")
    done = set()
    if os.path.exists(done_path) and os.path.exists(path):
        with open(done_path, encoding="utf-8") as f:
            done = {line.strip() for line in f if line.strip()}
        print(f"[mcp] resuming, {len(done)} contexts already collected")

    pending = [t for t in trade_list if t["uid"] not in done]
    lock = threading.Lock()

    def fetch(trade: dict) -> dict:
        c = McpClient(args.url)
        c.initialize()
        ctx = c.call(
            "get_trade_context",
            {
                "sessionId": trade["sessionId"],
                "tradeId": trade["id"],
                "timeframes": ["M30", "M5", "M1"],
                "beforeBars": 120,
                "afterBars": 60,
                "includeBars": True,
            },
        )
        ctx["_uid"] = trade["uid"]
        return ctx

    mode = "a" if done else "w"
    with open(path, mode, encoding="utf-8") as out, open(done_path, "a", encoding="utf-8") as dl:
        with ThreadPoolExecutor(max_workers=max(1, args.workers)) as ex:
            futs = {ex.submit(fetch, t): t for t in pending}
            failed = []
            for i, fut in enumerate(as_completed(futs), 1):
                t = futs[fut]
                try:
                    ctx = fut.result()
                except Exception as e:  # noqa: BLE001 - report and continue
                    failed.append((t["uid"], str(e)))
                    print(f"[mcp] FAILED {t['uid']}: {e}", file=sys.stderr)
                    continue
                with lock:
                    out.write(json.dumps(ctx, ensure_ascii=False) + "\n")
                    out.flush()
                    dl.write(t["uid"] + "\n")
                    dl.flush()
                if i % 25 == 0 or i == len(pending):
                    print(f"[mcp] contexts {i}/{len(pending)} ({time.time() - t0:.1f}s)")
    if failed:
        write_json(os.path.join(DATA, "contexts.failed.json"), failed)
        print(f"[mcp] {len(failed)} failed; rerun to retry only missing", file=sys.stderr)

    print(f"[mcp] done in {time.time() - t0:.1f}s -> {path}")
    return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main())
