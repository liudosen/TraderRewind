"""Render M5/M1 entry charts for selected session-10 trades."""

from __future__ import annotations

import os
import sys
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pandas as pd
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from collect_via_mcp import McpClient  # noqa: E402

OUT = os.path.join(HERE, "output", "charts")
os.makedirs(OUT, exist_ok=True)

TRADES = [
    ("t_1794223408832_yium", "WIN +557.68 long"),
    ("t_1794220369941_0fnr", "WIN +430.44 short"),
    ("t_1794214924391_kd7y", "WIN +386.12 long"),
    ("t_1794217877610_yk40", "LOSS -113.65 short 10-05 #3"),
    ("t_1794217763894_ynpu", "LOSS -98.74 short 10-05 #2"),
    ("t_1794225234077_whd6", "LOSS -97.89 long 10-16 #1"),
    ("t_1794225368176_whyy", "LOSS -106.01 long 10-16 #3"),
    ("t_1794225967363_kho3", "LOSS -141.77 long"),
]

FONT = "C:/Windows/Fonts/arial.ttf"
GREEN = (38, 166, 154)
RED = (239, 83, 80)
BG = (18, 20, 26)
GRID = (45, 48, 58)
TEXT = (220, 224, 232)
MUTED = (150, 156, 168)
BLUE = (80, 160, 255)
ORANGE = (255, 170, 60)
PURPLE = (180, 120, 255)


def ema(vals: np.ndarray, span: int) -> np.ndarray:
    return pd.Series(vals).ewm(span=span, adjust=False).mean().to_numpy()


def draw_panel(draw: ImageDraw.ImageDraw, box, bars, entry_idx, entry_price, title, tf):
    x0, y0, x1, y1 = box
    w, h = x1 - x0, y1 - y0
    pad_l, pad_r, pad_t, pad_b = 70, 90, 34, 24
    pw, ph = w - pad_l - pad_r, h - pad_t - pad_b
    highs = np.array([b["high"] for b in bars], dtype=float)
    lows = np.array([b["low"] for b in bars], dtype=float)
    closes = np.array([b["close"] for b in bars], dtype=float)
    lo, hi = lows.min(), highs.max()
    span = max(hi - lo, 1e-9)
    lo -= span * 0.06
    hi += span * 0.06

    def X(i):
        return x0 + pad_l + (i + 0.5) * pw / len(bars)

    def Y(p):
        return y0 + pad_t + (hi - p) / (hi - lo) * ph

    draw.rectangle([x0, y0, x1, y1], fill=BG, outline=GRID)
    draw.text((x0 + pad_l, y0 + 8), title, fill=TEXT, font=ImageFont.truetype(FONT, 20))
    draw.text((x0 + pad_l, y0 + 30), f"{tf}  entry={entry_price:.2f}  bars={len(bars)}", fill=MUTED, font=ImageFont.truetype(FONT, 13))

    # grid + price labels
    for k in range(5):
        p = lo + (hi - lo) * k / 4
        yy = Y(p)
        draw.line([x0 + pad_l, yy, x1 - pad_r, yy], fill=GRID, width=1)
        draw.text((x1 - pad_r + 8, yy - 7), f"{p:.2f}", fill=MUTED, font=ImageFont.truetype(FONT, 12))

    # candles
    cw = max(3, int(pw / len(bars) * 0.62))
    for i, b in enumerate(bars):
        xx = X(i)
        color = GREEN if b["close"] >= b["open"] else RED
        draw.line([xx, Y(b["high"]), xx, Y(b["low"])], fill=color, width=1)
        top, bot = max(b["open"], b["close"]), min(b["open"], b["close"])
        draw.rectangle([xx - cw / 2, Y(top), xx + cw / 2, Y(bot)], fill=color)

    # EMAs
    for span, color in ((20, BLUE), (50, ORANGE)):
        if len(closes) >= 2:
            vals = ema(closes, span)
            pts = [(X(i), Y(vals[i])) for i in range(len(bars))]
            draw.line(pts, fill=color, width=2)

    # entry line
    ex = X(entry_idx)
    draw.line([ex, y0 + pad_t, ex, y1 - pad_b], fill=PURPLE, width=2)
    ey = Y(entry_price)
    draw.line([x0 + pad_l, ey, x1 - pad_r, ey], fill=PURPLE, width=1)
    draw.text((ex + 3, y0 + pad_t + 2), "ENTRY", fill=PURPLE, font=ImageFont.truetype(FONT, 13))

    # time labels
    for i in [0, len(bars) // 3, 2 * len(bars) // 3, len(bars) - 1]:
        t = bars[i].get("timeIso", "")[11:16]
        draw.text((X(i) - 15, y1 - pad_b + 4), t, fill=MUTED, font=ImageFont.truetype(FONT, 11))


def one(item):
    tid, label = item
    c = McpClient("http://127.0.0.1:47821/mcp")
    c.initialize()
    ctx = c.call(
        "get_trade_context",
        {
            "sessionId": 10,
            "tradeId": tid,
            "timeframes": ["M5", "M1"],
            "beforeBars": 120,
            "afterBars": 60,
            "includeBars": True,
        },
    )
    t = ctx["trade"]
    m5 = ctx["series"]["M5"]
    m1 = ctx["series"]["M1"]
    i5, i1 = m5["entryBarIndex"], m1["entryBarIndex"]
    m5b = m5["bars"][max(0, i5 - 45): min(len(m5["bars"]), i5 + 15)]
    m1b = m1["bars"][max(0, i1 - 60): min(len(m1["bars"]), i1 + 30)]
    e5 = i5 - max(0, i5 - 45)
    e1 = i1 - max(0, i1 - 60)

    img = Image.new("RGB", (1800, 1180), BG)
    d = ImageDraw.Draw(img)
    draw_panel(d, (0, 0, 1800, 560), m5b, e5, t["openPrice"], f"{label}  |  M5 context", "M5")
    draw_panel(d, (0, 580, 1800, 1160), m1b, e1, t["openPrice"], f"{label}  |  M1 execution", "M1")
    path = os.path.join(OUT, f"{tid}.png")
    img.save(path)
    return path


def main():
    with ThreadPoolExecutor(max_workers=4) as ex:
        paths = list(ex.map(one, TRADES))
    for p in paths:
        print(p)


if __name__ == "__main__":
    main()
