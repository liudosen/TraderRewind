"""Generate the report figures with Pillow (no matplotlib in this runtime)."""

from __future__ import annotations

import os

import numpy as np
import pandas as pd
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
FIG = os.path.join(HERE, "output", "figures")
os.makedirs(FIG, exist_ok=True)

BG = (15, 17, 21)
PANEL = (23, 26, 33)
GRID = (42, 46, 56)
TEXT = (230, 232, 236)
MUTED = (154, 160, 170)
GREEN = (34, 197, 94)
RED = (239, 68, 68)
ACCENT = (139, 92, 246)
BLUE = (56, 189, 248)
AMBER = (245, 158, 11)
PINK = (236, 72, 153)

FONT_PATH = r"C:\Windows\Fonts\msyh.ttc"
FONT_BOLD = r"C:\Windows\Fonts\msyhbd.ttc"


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(FONT_BOLD if bold else FONT_PATH, size)


def canvas(w: int = 1400, h: int = 820, title: str = "", subtitle: str = "") -> tuple[Image.Image, ImageDraw.ImageDraw]:
    img = Image.new("RGB", (w, h), BG)
    d = ImageDraw.Draw(img)
    d.text((64, 36), title, font=font(32, True), fill=TEXT)
    if subtitle:
        d.text((64, 80), subtitle, font=font(15), fill=MUTED)
    d.line((64, 116, w - 64, 116), fill=GRID, width=1)
    d.text((64, h - 34), "TraderRewind · 仅用于历史复盘，不构成投资建议", font=font(12), fill=MUTED)
    return img, d


def nice_ticks(lo: float, hi: float, n: int = 5) -> list[float]:
    if hi == lo:
        return [lo]
    raw = (hi - lo) / max(1, n - 1)
    mag = 10 ** np.floor(np.log10(abs(raw))) if raw else 1
    step = mag * (1 if raw / mag <= 1 else 2 if raw / mag <= 2 else 5 if raw / mag <= 5 else 10)
    start = np.floor(lo / step) * step
    ticks = []
    v = start
    while v <= hi + step * 0.001:
        ticks.append(float(v))
        v += step
    # 保证最大值 / 最小值落在坐标轴内，否则柱子会画到面板外面
    if ticks and ticks[-1] < hi:
        ticks.append(float(ticks[-1] + step))
    if ticks and ticks[0] > lo:
        ticks.insert(0, float(ticks[0] - step))
    return ticks


def bar_panel(
    d: ImageDraw.ImageDraw,
    box: tuple[int, int, int, int],
    labels: list[str],
    values: list[float],
    title: str,
    y_label: str = "",
    colors: list[tuple[int, int, int]] | None = None,
) -> None:
    x0, y0, x1, y1 = box
    d.rounded_rectangle(box, radius=14, fill=PANEL)
    d.text((x0 + 20, y0 + 14), title, font=font(17, True), fill=TEXT)
    if y_label:
        d.text((x0 + 20, y0 + 42), y_label, font=font(11), fill=MUTED)
    left, right = x0 + 56, x1 - 24
    top, bottom = y0 + 74, y1 - 58
    lo = min(0.0, min(values))
    hi = max(0.0, max(values))
    if hi == lo:
        hi = lo + 1
    ticks = nice_ticks(lo, hi, 5)
    lo, hi = min(ticks), max(ticks)
    for t in ticks:
        yy = bottom - (t - lo) / (hi - lo) * (bottom - top)
        d.line((left, yy, right, yy), fill=GRID, width=1)
        d.text((left - 8, yy), f"{t:,.0f}", font=font(10), fill=MUTED, anchor="rm")
    zero = bottom - (0 - lo) / (hi - lo) * (bottom - top)
    d.line((left, zero, right, zero), fill=(80, 86, 98), width=1)

    n = len(values)
    slot = (right - left) / max(1, n)
    bw = min(58, slot * 0.58)
    for i, (lab, v) in enumerate(zip(labels, values)):
        cx = left + slot * (i + 0.5)
        yy = bottom - (v - lo) / (hi - lo) * (bottom - top)
        color = colors[i] if colors else (GREEN if v >= 0 else RED)
        d.rounded_rectangle((cx - bw / 2, min(yy, zero), cx + bw / 2, max(yy, zero)), radius=4, fill=color)
        d.text((cx, yy - 5 if v >= 0 else yy + 5), f"{v:,.0f}", font=font(10, True), fill=TEXT, anchor="mb" if v >= 0 else "mt")
        d.text((cx, bottom + 14), lab, font=font(10), fill=MUTED, anchor="ma")


def line_panel(
    d: ImageDraw.ImageDraw,
    box: tuple[int, int, int, int],
    labels: list[str],
    values: list[float],
    title: str,
    y_label: str = "",
    color: tuple[int, int, int] = BLUE,
    fmt: str = "{:.0f}",
    y_max: float | None = None,
) -> None:
    x0, y0, x1, y1 = box
    d.rounded_rectangle(box, radius=14, fill=PANEL)
    d.text((x0 + 20, y0 + 14), title, font=font(17, True), fill=TEXT)
    if y_label:
        d.text((x0 + 20, y0 + 42), y_label, font=font(11), fill=MUTED)
    left, right = x0 + 58, x1 - 28
    top, bottom = y0 + 74, y1 - 58
    lo = 0.0
    hi = y_max if y_max is not None else max(values) * 1.15
    ticks = nice_ticks(lo, hi, 5)
    hi = max(ticks)
    for t in ticks:
        yy = bottom - (t - lo) / (hi - lo) * (bottom - top)
        d.line((left, yy, right, yy), fill=GRID, width=1)
        d.text((left - 8, yy), fmt.format(t), font=font(10), fill=MUTED, anchor="rm")
    n = len(values)
    slot = (right - left) / max(1, n - 1) if n > 1 else (right - left)
    pts = [(left + slot * i, bottom - (v - lo) / (hi - lo) * (bottom - top)) for i, v in enumerate(values)]
    if len(pts) > 1:
        d.line(pts, fill=color, width=3, joint="curve")
    for p, v, lab in zip(pts, values, labels):
        d.ellipse((p[0] - 4, p[1] - 4, p[0] + 4, p[1] + 4), fill=color)
        d.text((p[0], p[1] - 9), fmt.format(v), font=font(9, True), fill=TEXT, anchor="mb")
        d.text((p[0], bottom + 14), lab, font=font(10), fill=MUTED, anchor="ma")


def save(img: Image.Image, name: str) -> None:
    path = os.path.join(FIG, name)
    img.save(path, "PNG")
    print("saved", path)


def main() -> None:
    df = pd.read_csv(os.path.join(DATA, "features.csv"))
    df["win"] = df["profit"] > 0
    df["align3"] = 0
    bull = df["m30_trendStack"] == "bull"
    bear = df["m30_trendStack"] == "bear"
    long = df["direction"] == "long"
    short = df["direction"] == "short"
    df.loc[(long & bull) | (short & bear), "align3"] = 1
    df.loc[(long & bear) | (short & bull), "align3"] = -1
    df["pos_q"] = pd.qcut(df["m30_dir_pos"], 5, labels=["Q1", "Q2", "Q3", "Q4", "Q5"])
    df["mfe30_b"] = pd.cut(df["mfe30"], [-0.001, 0.25, 0.5, 0.75, 1.25, 99], labels=["<0.25", "0.25-0.5", "0.5-0.75", "0.75-1.25", ">=1.25"])
    df["mae15_b"] = pd.cut(df["mae15"], [-0.001, 0.3, 0.5, 0.75, 1.0, 99], labels=["<0.3", "0.3-0.5", "0.5-0.75", "0.75-1.0", ">=1.0"])
    df["rr_b"] = pd.cut(df["planned_rr"], [-0.001, 1.5, 2, 3, 5, 99], labels=["<1.5", "1.5-2", "2-3", "3-5", ">=5"])

    # 1. Session equity small multiples
    img, d = canvas(1500, 900, "各回测集权益曲线", "按平仓顺序累计已实现盈亏（USD）· 8 个有交易的样本，共 379 笔")
    sessions = [1, 2, 3, 4, 5, 8, 9, 10]
    cw, ch = 330, 300
    for i, sid in enumerate(sessions):
        g = df[df.session_id == sid].sort_values("close_time")
        cum = g.profit.cumsum().to_numpy()
        col, row = i % 4, i // 4
        x0 = 64 + col * (cw + 20)
        y0 = 146 + row * (ch + 22)
        x1, y1 = x0 + cw, y0 + ch
        d.rounded_rectangle((x0, y0, x1, y1), radius=12, fill=PANEL)
        d.text((x0 + 16, y0 + 12), f"S{sid} · {len(g)} 笔", font=font(14, True), fill=TEXT)
        d.text((x0 + 16, y0 + 34), f"胜率 {g.win.mean()*100:.0f}% · 盈亏 {g.profit.sum():+.0f} USD", font=font(10), fill=MUTED)
        left, right = x0 + 36, x1 - 16
        top, bottom = y0 + 64, y1 - 24
        lo = min(0.0, cum.min())
        hi = max(0.0, cum.max()) or 1
        pad = (hi - lo) * 0.08 or 1
        lo -= pad
        hi += pad
        zero = bottom - (0 - lo) / (hi - lo) * (bottom - top)
        d.line((left, zero, right, zero), fill=GRID, width=1)
        if cum.max() > 0:
            p = bottom - (cum.max() - lo) / (hi - lo) * (bottom - top)
            d.text((right, p - 3), f"{cum.max():.0f}", font=font(8), fill=MUTED, anchor="rb")
        if cum.min() < 0:
            p = bottom - (cum.min() - lo) / (hi - lo) * (bottom - top)
            d.text((right, p + 3), f"{cum.min():.0f}", font=font(8), fill=MUTED, anchor="rt")
        n = len(cum)
        step = (right - left) / max(1, n - 1)
        pts = [(left + step * j, bottom - (v - lo) / (hi - lo) * (bottom - top)) for j, v in enumerate(cum)]
        if len(pts) > 1:
            d.line(pts, fill=GREEN if cum[-1] >= 0 else RED, width=2)
        d.ellipse((pts[-1][0] - 3, pts[-1][1] - 3, pts[-1][0] + 3, pts[-1][1] + 3), fill=GREEN if cum[-1] >= 0 else RED)
    save(img, "fig1_session_equity.png")

    # 2. MFE30
    g = df.groupby("mfe30_b", observed=True).agg(n=("win", "size"), win=("win", "mean"), pnl=("profit", "sum"))
    img, d = canvas(1400, 820, "进场后 30 分钟的顺势幅度（MFE30）决定结局", "MFE30 = 开仓后 30 分钟内最大有利偏移 ÷ 单笔风险预算（$100）· 379 笔")
    bar_panel(d, (64, 146, 680, 700), list(g.index.astype(str)), list(g.pnl), "按 MFE30 分组的累计盈亏", "USD")
    line_panel(d, (720, 146, 1336, 700), list(g.index.astype(str)), list(g.win * 100), "按 MFE30 分组的胜率", "胜率 %", color=ACCENT, fmt="{:.0f}%", y_max=100)
    for i, n in enumerate(g.n):
        d.text((64 + 56 + (680 - 64 - 80) / len(g) * (i + 0.5), 726), f"n={n}", font=font(9), fill=MUTED, anchor="ma")
        d.text((720 + 58 + (1336 - 720 - 86) / (len(g) - 1) * i, 726), f"n={n}", font=font(9), fill=MUTED, anchor="ma")
    save(img, "fig2_mfe30.png")

    # 3. MAE15
    g = df.groupby("mae15_b", observed=True).agg(n=("win", "size"), win=("win", "mean"), pnl=("profit", "sum"))
    img, d = canvas(1400, 820, "进场后 15 分钟的不利偏移（MAE15）同样是分水岭", "MAE15 = 开仓后 15 分钟内最大不利偏移 ÷ 风险预算 · 越早深水，越难翻身")
    bar_panel(d, (64, 146, 680, 700), list(g.index.astype(str)), list(g.pnl), "按 MAE15 分组的累计盈亏", "USD")
    line_panel(d, (720, 146, 1336, 700), list(g.index.astype(str)), list(g.win * 100), "按 MAE15 分组的胜率", "胜率 %", color=AMBER, fmt="{:.0f}%", y_max=100)
    for i, n in enumerate(g.n):
        d.text((64 + 56 + (680 - 64 - 80) / len(g) * (i + 0.5), 726), f"n={n}", font=font(9), fill=MUTED, anchor="ma")
        d.text((720 + 58 + (1336 - 720 - 86) / (len(g) - 1) * i, 726), f"n={n}", font=font(9), fill=MUTED, anchor="ma")
    save(img, "fig3_mae15.png")

    # 4. Entry structure
    img, d = canvas(1400, 820, "进场结构：别逆着 M30 做，也别在区间错误一侧进场", "左：M30 均线结构与方向是否一致；右：进场价在 M30 20 根区间中的方向调整位置（Q5=最有利一侧）")
    a = df.groupby("align3").agg(n=("win", "size"), win=("win", "mean"), pnl=("profit", "sum")).reindex([-1, 0, 1])
    labels = ["逆势", "混合", "顺势"]
    bar_panel(d, (64, 146, 680, 700), labels, list(a.pnl), "M30 结构 × 方向", "累计盈亏 USD", colors=[RED, MUTED, GREEN])
    for i, (n, w) in enumerate(zip(a.n, a.win * 100)):
        d.text((64 + 56 + (680 - 64 - 80) / 3 * (i + 0.5), 726), f"n={int(n)} · 胜率 {w:.0f}%", font=font(9), fill=MUTED, anchor="ma")
    b = df.groupby("pos_q", observed=True).agg(n=("win", "size"), win=("win", "mean"), pnl=("profit", "sum"))
    bar_panel(d, (720, 146, 1336, 700), list(b.index.astype(str)), list(b.pnl), "M30 区间位置五分位", "累计盈亏 USD")
    for i, (n, w) in enumerate(zip(b.n, b.win * 100)):
        d.text((720 + 56 + (1336 - 720 - 80) / 5 * (i + 0.5), 726), f"n={int(n)} · {w:.0f}%", font=font(9), fill=MUTED, anchor="ma")
    save(img, "fig4_entry_structure.png")

    # 5. Fixed vs moved book by session
    img, d = canvas(1400, 820, "利润几乎全部来自「移动止损 / 让利润奔跑」的那部分", "同一批交易按结果分成两本账：固定止损书 285 笔在每个样本里都亏；移动止损/未知书 94 笔在每个样本里都赚")
    piv = df.pivot_table(index="session_id", columns="book", values="profit", aggfunc="sum").fillna(0)
    sessions = list(piv.index)
    d.rounded_rectangle((64, 146, 1336, 700), radius=14, fill=PANEL)
    left, right, top, bottom = 120, 1300, 200, 620
    lo = min(0, piv.min().min())
    hi = max(0, piv.max().max())
    ticks = nice_ticks(lo, hi, 6)
    for t in ticks:
        yy = bottom - (t - lo) / (hi - lo) * (bottom - top)
        d.line((left, yy, right, yy), fill=GRID, width=1)
        d.text((left - 10, yy), f"{t:,.0f}", font=font(10), fill=MUTED, anchor="rm")
    zero = bottom - (0 - lo) / (hi - lo) * (bottom - top)
    d.line((left, zero, right, zero), fill=(90, 96, 108), width=1)
    bw = 26
    for i, sid in enumerate(sessions):
        cx = left + (right - left) / len(sessions) * (i + 0.5)
        for j, (book, color) in enumerate((("fixed", RED), ("moved", GREEN), ("unknown", BLUE))):
            v = float(piv.loc[sid].get(book, 0))
            yy = bottom - (v - lo) / (hi - lo) * (bottom - top)
            d.rounded_rectangle((cx - bw * 1.5 + j * bw, min(yy, zero), cx - bw * 1.5 + j * bw + bw - 4, max(yy, zero)), radius=3, fill=color)
        d.text((cx, bottom + 16), f"S{sid}", font=font(11), fill=MUTED, anchor="ma")
    for j, (book, color) in enumerate((("固定止损", RED), ("移动止损", GREEN), ("未知", BLUE))):
        d.rectangle((940 + j * 120, 164, 956 + j * 120, 180), fill=color)
        d.text((962 + j * 120, 172), book, font=font(11), fill=TEXT, anchor="lm")
    save(img, "fig5_books.png")

    # 6. Planned RR (fixed book)
    fixed = df[df.book == "fixed"]
    g = fixed.groupby("rr_b", observed=True).agg(n=("win", "size"), win=("win", "mean"), pnl=("profit", "sum"))
    img, d = canvas(1400, 820, "计划盈亏比越贪，固定止损书亏得越多", "只统计初始止损可还原的 283 笔固定止损单；RR = 计划止盈距离 ÷ 初始止损距离")
    bar_panel(d, (64, 146, 680, 700), list(g.index.astype(str)), list(g.pnl), "按计划 RR 分组的累计盈亏", "USD")
    line_panel(d, (720, 146, 1336, 700), list(g.index.astype(str)), list(g.win * 100), "按计划 RR 分组的胜率", "胜率 %", color=PINK, fmt="{:.0f}%", y_max=100)
    for i, n in enumerate(g.n):
        d.text((64 + 56 + (680 - 64 - 80) / len(g) * (i + 0.5), 726), f"n={n}", font=font(9), fill=MUTED, anchor="ma")
        d.text((720 + 58 + (1336 - 720 - 86) / (len(g) - 1) * i, 726), f"n={n}", font=font(9), fill=MUTED, anchor="ma")
    save(img, "fig6_planned_rr.png")

    # 7. Hour
    g = df[(df.hour >= 7) & (df.hour <= 22)].groupby("hour").agg(n=("win", "size"), win=("win", "mean"), pnl=("profit", "sum"))
    img, d = canvas(1400, 820, "时段分布：13 点最差，15 点最好（样本量有限，仅作观察）", "UTC+8，按开仓小时统计；每个小时样本 18–34 笔，不要单独据此做决策")
    bar_panel(d, (64, 146, 1336, 470), [f"{h:02d}" for h in g.index], list(g.pnl), "按开仓小时的累计盈亏", "USD")
    line_panel(d, (64, 500, 1336, 700), [f"{h:02d}" for h in g.index], list(g.win * 100), "按开仓小时的胜率", "胜率 %", color=ACCENT, fmt="{:.0f}%", y_max=100)
    save(img, "fig7_hour.png")


if __name__ == "__main__":
    main()
