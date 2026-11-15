"""Render the final Chinese report to Markdown and a self-contained HTML page."""

from __future__ import annotations

import json
import os
import re
import shutil
import statistics

import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
OUT = os.path.join(HERE, "output")
FIG = os.path.join(OUT, "figures")
REPORTS = os.path.join(os.path.dirname(HERE), "reports")
FIG_OUT = os.path.join(REPORTS, "figures")
os.makedirs(REPORTS, exist_ok=True)
os.makedirs(FIG_OUT, exist_ok=True)
for name in os.listdir(FIG):
    if name.endswith(".png"):
        shutil.copy2(os.path.join(FIG, name), os.path.join(FIG_OUT, name))

TITLE = "TraderRewind 交易复盘：379 笔 XAUUSD 训练的亏损共性与盈利共性"
DATE = "2026-11-09"
BASENAME = "TraderRewind_交易复盘_2026-11-09"


def load():
    with open(os.path.join(OUT, "report_facts.json"), encoding="utf-8") as f:
        facts = json.load(f)
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
    return facts, df


def money(v, sign=False):
    if v is None:
        return "—"
    return f"{v:+,.0f} USD" if sign else f"{v:,.0f} USD"


def pct(v, digits=1):
    return "—" if v is None else f"{v*100:.{digits}f}%"


def rfmt(v):
    return "—" if v is None else f"{v:+.2f}R"


def table(headers, rows, align=None):
    return {"type": "table", "headers": headers, "rows": rows, "align": align or ["l"] * len(headers)}


def h(level, text):
    return {"type": "h", "level": level, "text": text}


def p(text):
    return {"type": "p", "text": text}


def ul(items):
    return {"type": "ul", "items": items}


def img(src, caption):
    return {"type": "img", "src": src, "caption": caption}


def callout(title, text):
    return {"type": "callout", "title": title, "text": text}


def build_blocks(facts, df):
    overall = facts["overall"]
    book = {x["book"]: x for x in facts["book"]}
    mfe30 = {x["mfe30_b"]: x for x in facts["mfe30"]}
    mae15 = {x["mae15_b"]: x for x in facts["mae15"]}
    align = {x["align3"]: x for x in facts["align3"]}
    posq = {x["pos_q"]: x for x in facts["pos_q"]}
    rr = {x["rr_b"]: x for x in facts["planned_rr"]}
    filters = {x["filter"]: x for x in facts["filters"]}
    whatif = facts["whatif"]
    dq = facts["data_quality"]

    low_mfe = df[df.mfe30 < 0.5]
    high_mfe = df[df.mfe30 >= 0.75]
    deep_mae = df[df.mae15 > 0.75]
    counter = df[df.align3 == -1]
    q1 = df[df.pos_q == "Q1"]
    fixed_rr2 = df[(df.book == "fixed") & (df.planned_rr >= 2)]
    h13 = df[df.hour == 13]
    h15 = df[df.hour == 15]

    def agg(d):
        return len(d), int(d.win.sum()), d.win.mean(), d.profit.sum(), d.r_target.mean()

    blocks: list[dict] = []
    blocks.append(h(1, TITLE))
    blocks.append(p(f"生成日期：{DATE}　|　样本：8 个有交易的训练/回测集，379 笔已平仓订单　|　品种：XAUUSD　|　周期：2026-01 至 2026-10"))
    blocks.append(callout(
        "一句话结论",
        "这套交易系统的利润不是来自「进场很准」，而是来自「少数进场后立刻走出来的单子，被移动止损/趋势持有放大」。"
        "亏损单的共同点非常集中：30 分钟内没有走出 +0.5R、15 分钟内先亏到 -0.75R、逆着 M30 结构、"
        "以及把固定止盈设得太远。把入场过滤和「30 分钟不证明自己就退出」做好，比调仓位、换周期更重要。"
    ))

    blocks.append(h(2, "1. 数据与方法"))
    blocks.append(p(
        "本次分析不是直接读 SQLite，而是走本次新增的应用内 MCP 服务："
        "`list_sessions` → `list_trades` → 对 379 笔订单逐笔 `get_trade_context`（M30/M5/M1 各 120 根进场前 K 线、"
        "EMA20/50/200、ATR14、RSI14、20 根区间位置、动量、趋势结构，以及进场后到平仓的 MFE/MAE 与 15/30/60 分钟早期偏移）。"
        "行情来自本机 market.db 的 M1 数据，M5/M30 由 M1 聚合，指标只使用进场时点及之前的数据，避免未来函数。"
    ))
    blocks.append(p(
        "**口径说明**：金额均为净盈亏（已含手续费，来自 closed_trades.profit）；"
        "`R` 统一按会话设定的单笔风险预算折算（`profit / risk_per_trade`，默认 $100），而不是应用里那个按「平仓时止损距离」算的 r_multiple。"
        "原因见第 5 节：移动过止损的单，r_multiple 会严重失真。"
    ))
    blocks.append(p(
        "**样本边界**：10 个回测集中 6、7 号没有平仓记录，实际分析 8 个；"
        "1、8、10 号交易的是同一个 2026-10 区间（重复挑战），所以「同一段行情」的盈亏差异可以反映执行差异。"
    ))
    blocks.append(table(
        ["指标", "数值"],
        [
            ["订单数", f"{overall['n']}"],
            ["胜 / 负", f"{overall['wins']} / {overall['losses']}"],
            ["胜率", pct(overall["win_rate"])],
            ["净盈亏", money(overall["pnl"], True)],
            ["盈亏比 PF", f"{overall['pf']:.2f}"],
            ["单笔期望", f"{overall['avg_pnl']:+.2f} USD（{overall['avg_r']:+.3f}R）"],
            ["平均盈利 / 平均亏损", f"{overall['avg_win']:.2f} / {overall['avg_loss']:.2f} USD"],
            ["单样本最大回撤（中位数）", money(statistics.median(s["max_dd"] for s in facts["sessions"]))],
        ],
        ["l", "r"],
    ))
    session_rows = []
    for s in facts["sessions"]:
        session_rows.append([
            f"S{s['session_id']}",
            str(s["n"]),
            pct(s["win_rate"]),
            money(s["pnl"], True),
            f"{s['avg_r']:+.3f}R",
            money(s["max_dd"]),
            f"{s['median_hold']:.0f}m",
        ])
    blocks.append(p("各回测集的明细如下（S6/S7 无平仓记录，未列出）："))
    blocks.append(table(
        ["样本", "笔数", "胜率", "净盈亏", "平均 R", "最大回撤", "持仓中位数"],
        session_rows,
        ["l", "r", "r", "r", "r", "r", "r"],
    ))
    blocks.append(img("figures/fig1_session_equity.png", "图 1：8 个回测集的已实现权益曲线。S1/S3/S8 基本打平或小亏，S5/S10 靠少数大赢家拉开。"))

    blocks.append(h(2, "2. 先把账拆成两本：固定止损书 vs 移动止损书"))
    blocks.append(p(
        "同一批交易，按「平仓时止损是否已经移到开仓价的盈利侧」可以拆成两本账。"
        "这不是两个可选的策略，而是同一套打法按结果分出来的两组：没有走出来的单子被固定止损打掉，"
        "走出来的单子被移动止损/趋势持有放大。它回答的是「利润到底从哪里来」。"
    ))
    blocks.append(table(
        ["分组", "笔数", "胜率", "净盈亏", "平均 R", "持仓中位数"],
        [
            ["固定止损书（初始止损可还原）", f"{book['fixed']['n']:.0f}", pct(book["fixed"]["win_rate"]), money(book["fixed"]["pnl"], True), rfmt(book["fixed"]["avg_r"]), f"{book['fixed']['median_hold']:.0f} 分钟"],
            ["移动止损书（trail / 止损已移动）", f"{book['moved']['n']:.0f}", pct(book["moved"]["win_rate"]), money(book["moved"]["pnl"], True), rfmt(book["moved"]["avg_r"]), f"{book['moved']['median_hold']:.0f} 分钟"],
            ["未知（manual 且止损仍在亏损侧）", f"{book['unknown']['n']:.0f}", pct(book["unknown"]["win_rate"]), money(book["unknown"]["pnl"], True), rfmt(book["unknown"]["avg_r"]), f"{book['unknown']['median_hold']:.0f} 分钟"],
        ],
        ["l", "r", "r", "r", "r", "r"],
    ))
    blocks.append(p(
        f"固定止损书 {book['fixed']['n']:.0f} 笔，只赢了 {book['fixed']['wins']:.0f} 笔（{pct(book['fixed']['win_rate'])}），"
        f"净盈亏 {money(book['fixed']['pnl'], True)}；移动止损书 {book['moved']['n']:.0f} 笔全部盈利，"
        f"净盈亏 {money(book['moved']['pnl'], True)}。"
        "注意这是**按结果分组**，不是两个可选的策略：它说明「没有走出来的那批」是负期望，"
        "而利润来自「已经走出来、并且让利润跑下去」的那批，而不是说入场前就能预知哪一批会赢。"
    ))
    blocks.append(img("figures/fig5_books.png", "图 2：按回测集拆开看，固定止损书在 7/8 个样本里亏损（S2 小幅盈利），移动止损书在 8/8 个样本里盈利。"))

    blocks.append(h(2, "3. 亏损的共性"))
    blocks.append(p("下面每一条都给出样本量、胜率、盈亏和跨样本一致性。样本量小于 30 的结论只作观察，不当作硬规则。"))

    blocks.append(h(3, "3.1 共性一：30 分钟内没有走出来（MFE30 < 0.5R）"))
    blocks.append(p(
        "MFE30 是开仓后 30 分钟内最大有利偏移，按单笔风险预算折成 R。它不是一个「进场前」指标，"
        "而是一个 30 分钟时点就能观察到的「这笔单子有没有立刻证明自己」的信号。"
    ))
    rows = []
    for key in ["<0.25", "0.25-0.5", "0.5-0.75", "0.75-1.25", ">=1.25"]:
        x = mfe30[key]
        rows.append([key, f"{x['n']:.0f}", pct(x["win_rate"]), money(x["pnl"], True), rfmt(x["avg_r"])])
    blocks.append(table(["MFE30 区间", "笔数", "胜率", "净盈亏", "平均 R"], rows, ["l", "r", "r", "r", "r"]))
    blocks.append(p(
        f"MFE30 < 0.5R 的 {len(low_mfe)} 笔，只有 {int(low_mfe.win.sum())} 笔盈利（{pct(low_mfe.win.mean())}），"
        f"合计 {money(low_mfe.profit.sum(), True)}；MFE30 ≥ 0.75R 的 {len(high_mfe)} 笔，"
        f"胜率 {pct(high_mfe.win.mean())}，合计 {money(high_mfe.profit.sum(), True)}。"
        "分样本看，MFE30 < 0.5R 的胜率在 8 个样本里全部落在 5%–25%，且全部为负；MFE30 ≥ 0.5R 的胜率在 50%–86%，全部为正。"
    ))
    blocks.append(img("figures/fig2_mfe30.png", "图 3：MFE30 五个区间的累计盈亏与胜率，几乎是一条单调的分界线。"))
    blocks.append(callout(
        "这条最值得变成规则",
        "开仓 30 分钟时，如果 MFE30 还不到 +0.5R，这笔单子大概率不会成为赢家。把它当作「减仓/离场」的检查点，"
        "而不是继续扛、加仓或把止损往外推。"
    ))

    blocks.append(h(3, "3.2 共性二：一开始就深水（MAE15 ≥ 0.75R）"))
    blocks.append(p("MAE15 是开仓后 15 分钟内最大不利偏移。好单子通常很快脱离成本区；一开始就深水的单子，后面很难翻身。"))
    rows = []
    for key in ["<0.3", "0.3-0.5", "0.5-0.75", "0.75-1.0", ">=1.0"]:
        x = mae15[key]
        rows.append([key, f"{x['n']:.0f}", pct(x["win_rate"]), money(x["pnl"], True), rfmt(x["avg_r"])])
    blocks.append(table(["MAE15 区间", "笔数", "胜率", "净盈亏", "平均 R"], rows, ["l", "r", "r", "r", "r"]))
    blocks.append(p(
        f"MAE15 ≥ 0.75R 的 {len(deep_mae)} 笔，只赢了 {int(deep_mae.win.sum())} 笔（{pct(deep_mae.win.mean())}），"
        f"合计 {money(deep_mae.profit.sum(), True)}；MAE15 < 0.3R 的 113 笔胜率 {pct(mae15['<0.3']['win_rate'])}，"
        f"合计 {money(mae15['<0.3']['pnl'], True)}。亏损单里有 88 笔（占 217 笔亏损的 40.6%）在 15 分钟内就先亏到 0.75R 以上。"
    ))
    blocks.append(img("figures/fig3_mae15.png", "图 4：MAE15 越大，胜率与盈亏越差；≥1R 的 51 笔只赢了 2 笔。"))

    blocks.append(h(3, "3.3 共性三：逆着 M30 结构做"))
    blocks.append(p(
        "把 M30 的 EMA20/EMA50 与收盘价关系定义成 bull / bear / mixed，再和订单方向比较："
        "顺势 = 多头遇 bull、空头遇 bear；逆势 = 多头遇 bear、空头遇 bull；mixed 单独一组。"
    ))
    rows = []
    for key, label in [("-1", "逆势"), ("0", "混合"), ("1", "顺势")]:
        x = align[key]
        rows.append([label, f"{x['n']:.0f}", pct(x["win_rate"]), money(x["pnl"], True), rfmt(x["avg_r"])])
    blocks.append(table(["M30 结构 × 方向", "笔数", "胜率", "净盈亏", "平均 R"], rows, ["l", "r", "r", "r", "r"]))
    blocks.append(p(
        f"逆势 {int(counter.shape[0])} 笔，胜率 {pct(counter.win.mean())}，净亏 {money(counter.profit.sum(), True)}，平均 {counter.r_target.mean():+.2f}R；"
        f"顺势 + 混合合计 {int(len(df) - len(counter))} 笔，净赚 {money(df[df.align3 != -1].profit.sum(), True)}。"
        "把逆势单剔除后，8 个样本里有 7 个改善。注意：顺势（45.8%）和混合（46.9%）的胜率差不多，"
        "所以真正要避免的是「明确逆势」，而不是「必须完美顺势」。"
    ))
    blocks.append(img("figures/fig4_entry_structure.png", "图 5：左为 M30 结构与方向是否一致；右为进场价在 M30 20 根区间中的方向调整位置（Q5 最有利）。"))

    blocks.append(h(3, "3.4 共性四：在 M30 区间的错误一侧进场"))
    blocks.append(p(
        "`dir_pos` 把「进场价在最近 20 根 M30 区间中的位置」按方向调整：1 = 多头在区间上沿 / 空头在区间下沿，0 = 相反。"
        "Q5 是最有利的一侧，Q1 是「多单买在区间底部、空单卖在区间顶部」的逆向位置。"
    ))
    rows = []
    for key in ["Q1", "Q2", "Q3", "Q4", "Q5"]:
        x = posq[key]
        rows.append([key, f"{x['n']:.0f}", pct(x["win_rate"]), money(x["pnl"], True), rfmt(x["avg_r"])])
    blocks.append(table(["M30 区间位置", "笔数", "胜率", "净盈亏", "平均 R"], rows, ["l", "r", "r", "r", "r"]))
    blocks.append(p(
        f"Q1 的 {len(q1)} 笔胜率 {pct(q1.win.mean())}，净亏 {money(q1.profit.sum(), True)}；Q5 的 75 笔胜率 {pct(posq['Q5']['win_rate'])}，"
        f"净赚 {money(posq['Q5']['pnl'], True)}。Q1 在 7/8 个样本里为负，Q5 在 6/8 个样本里为正。"
        "另一个容易误读的细节：赢家进场时价格反而更常在 EMA20 的「回踩侧」（多头在 EMA20 下方、空头在上方，"
        f"方向调整距离 {facts['feature_compare'][1]['mean_win']:+.2f} ATR），而不是追在 EMA20 外侧。"
        "所以更准确的画像是「趋势向上 + 回踩到区间内有利位置再进」，不是「无脑追突破」。"
    ))

    blocks.append(h(3, "3.5 共性五：固定止盈设得太远"))
    blocks.append(p(
        "这一条只统计初始止损可还原的 283 笔固定止损单。计划 RR = 计划止盈距离 ÷ 初始止损距离。"
        "注意：移动止损/手动平仓的单没有可靠的初始止损，不纳入这张表。"
    ))
    rows = []
    for key in ["<1.5", "1.5-2", "2-3", "3-5", ">=5"]:
        x = rr[key]
        rows.append([key, f"{x['n']:.0f}", pct(x["win_rate"]), money(x["pnl"], True), rfmt(x["avg_r"])])
    blocks.append(table(["计划 RR", "笔数", "胜率", "净盈亏", "平均 R"], rows, ["l", "r", "r", "r", "r"]))
    blocks.append(p(
        f"计划 RR 越高，固定止损书亏得越多：<1.5R 胜率 {pct(rr['<1.5']['win_rate'])}，≥5R 的 9 笔全亏。"
        f"固定止损书里赢家的计划 RR 中位数 {facts['feature_compare'][0]['median_win']:.2f}R，"
        f"输家 {facts['feature_compare'][0]['median_loss']:.2f}R（Cliff's δ {facts['feature_compare'][0]['cliffs_delta']:+.2f}，p<0.001）。"
        "这不是说「目标越近越好」，而是说：**在一个还没证明自己会走远的单子上，挂一个很远的固定止盈，等于把胜率让给止损。**"
        "真正的大利润来自「先走出来、再移动止损跟随」，不是来自一开始就挂在 5R 外。"
    ))
    blocks.append(img("figures/fig6_planned_rr.png", "图 6：固定止损书的计划 RR 与胜率/盈亏几乎单调负相关。"))

    blocks.append(h(3, "3.6 次要观察：13 点最差，15 点最好"))
    blocks.append(p(
        f"13:00 开仓的 {len(h13)} 笔胜率 {pct(h13.win.mean())}，合计 {money(h13.profit.sum(), True)}；"
        f"15:00 开仓的 {len(h15)} 笔胜率 {pct(h15.win.mean())}，合计 {money(h15.profit.sum(), True)}。"
        "13 点在 7/8 个样本里为负（S2 例外），15 点在所有有样本的 7 个样本里为正。"
        "但每小时只有 18–34 笔，且没有控制行情 regime，只能作为「观察项」，不要当成硬性时段规则。"
        "周五 70 笔胜率 34.3%、净亏 686 USD，但分样本 5 负 3 正，不构成稳定共性，暂不采信。"
    ))
    blocks.append(img("figures/fig7_hour.png", "图 7：按开仓小时的盈亏与胜率；13 点与 15 点是两端，但样本量有限。"))

    blocks.append(h(2, "4. 盈利的共性"))
    blocks.append(p(
        "盈利单不是「运气好」这么简单。把赢家和平行对照放在一起，能看到五个可复用的特征："
    ))
    blocks.append(ul([
        "**早期就走出方向**：赢家 MFE30 中位数 1.00R，输家 0.31R；MFE30 ≥ 0.75R 的 137 笔胜率 78.8%，合计 +14,313 USD。",
        "**回撤浅**：赢家 MAE15 中位数 0.33R，输家 0.65R；MAE15 < 0.3R 的 113 笔胜率 62.8%，合计 +6,194 USD。",
        "**顺着 M30 结构、在区间有利侧、等回踩**：赢家方向调整区间位置中位数 0.723（输家 0.607），方向调整 RSI 中位数 56.7（输家 53.6，p=0.001），价格更常回踩到 EMA20 的另一侧（p<0.001）。",
        "**让利润奔跑**：移动止损书 77 笔全部盈利，平均 +156.7 USD/笔，持仓中位数 55 分钟；固定止损书持仓中位数 26 分钟。",
        "**赢家 MFE 捕获率中位数 88.3%**：不是卖在最高点，而是让止损跟随，把大部分趋势段拿到。输家的 capture 为负（先赚后亏）。",
    ]))
    blocks.append(callout(
        "盈利的底层结构",
        "先用「早期是否走出来」筛掉大部分不会赢的单子，再让少数走出来的单子用移动止损跑完。"
        "这套结构里，胜率不需要高（42.7% 就够），但必须让平均盈利（147.6 USD）显著大于平均亏损（94.7 USD），"
        "并且不能让「本来 +1R 的单子」变成 -1R。"
    ))

    blocks.append(h(2, "5. 一个必须先修的数据质量问题：r_multiple 对移动止损单失真"))
    blocks.append(p(
        f"应用里的 `closed_trades.r_multiple` 是「盈亏 ÷ 平仓时止损距离」。对没有移动过止损的固定单，这个值可信；"
        f"但对 trail、部分 tp/manual（止损已经移到盈利侧）的单，分母不再是初始风险，R 会严重失真。"
        f"本样本 379 笔里，只有 {dq['reliable']} 笔（{pct(dq['reliable_pct'])}）的初始止损可可靠还原；"
        f"{dq['moved']} 笔是移动止损、{dq['unknown']} 笔是 manual 且止损仍在亏损侧（无法确认是否初始），"
        f"合计 {dq['moved'] + dq['unknown']} 笔（{pct(dq['moved_pct'])}）不能直接采信 r_multiple。"
    ))
    blocks.append(p(
        "举一个具体的例子：一笔 trail 单盈利 +523 USD，按会话 $100 风险预算应该是 +5.23R；"
        "但因为它平仓时止损已经移到成本价附近，r_multiple 只显示约 +0.99R。"
        "反过来，一些真正亏损的单子 r_multiple 是 -1.01R，看起来「只亏了 1R」，但按 $100 预算可能亏了 1.7R。"
        "这会让复盘时「R 分布」和「平均 R」都偏向好看，也会让「大赢家」的贡献被低估。"
    ))
    blocks.append(p(
        "**建议**：在持仓表/成交表里增加 `initial_sl` 与 `initial_risk_amount`（开仓时写入），"
        "平仓时用初始止损算 R；MCP 目前已经同时返回 `rOnRiskTarget`（按会话风险预算）与 `riskBasis`（initial_stop / moved_stop / unknown），"
        "分析时请以 `rOnRiskTarget` 为准。"
    ))
    blocks.append(p(
        "另一个数据缺口：379 笔的 notes、entry_reason、strategy_name、tags 全部为空，mae/mfe 也全部为 NULL。"
        "这意味着本次只能从「价格行为」找共性，无法验证「计划内/追单/复仇单/情绪」这类主观标签。"
        "如果把这些字段用起来，下一版复盘可以做得更细。"
    ))

    blocks.append(h(2, "6. 可执行规则（按优先级）"))
    blocks.append(h(3, "6.1 入场前：四条过滤"))
    blocks.append(ul([
        "**不逆势**：M30 的 EMA20/EMA50 结构与方向相反时，不做。样本内逆势 72 笔，胜率 27.8%，净亏 1,668 USD；剔除后 7/8 个样本改善。",
        "**不在 M30 区间错误一侧**：`dir_pos` 处于最低五分位（多单买在区间底、空单卖在区间顶）时，不做；样本内 76 笔胜率 27.6%，净亏 2,344 USD。要求 `dir_pos ≥ 0.4`，最好 ≥ 0.6。",
        "**固定止盈优先 1–1.5R，最多不超过 2R**：固定止损书里计划 RR ≥ 2 的 109 笔，胜率约 14%，净亏 5,310 USD。想做趋势，用移动止损，不要用远固定 TP。",
        "**避开 11:00–13:00**：13:00 单独看 30 笔胜率 23.3%、净亏 986 USD；11–13 整体也不佳。10:00 与 15:00 相对更好，但样本小，先观察。",
    ]))
    blocks.append(h(3, "6.2 持仓中：三个检查点"))
    blocks.append(ul([
        "**30 分钟检查**：MFE30 < +0.5R 且 MAE15 > 0.5R，减仓或离场；不要加仓、不要外推止损。MFE30 < 0.5R 的 179 笔胜率只有 16.8%。",
        "**+0.75R 之后**：不要急着在 1R 固定止盈；把止损移到成本/ +0.2R，让它跑。移动止损书 77 笔全部盈利，平均 +156.7 USD。",
        "**+1R 之后**：不允许回到 -1R。最差也要在 +0.2R 附近锁住；样本里“先赚后亏”的单子对心态和账户伤害最大。",
    ]))
    blocks.append(h(3, "6.3 仓位：不用改，别用加仓救亏损"))
    blocks.append(p(
        f"初始止损可还原的 {dq['reliable']} 笔，实际风险均值 {df[df.book == 'fixed'].pipe(lambda x: ((x.open_price - x.initial_sl).abs() * x.lot_size * x.contract_size)).mean():.1f} USD，"
        "中位数约 98.7 USD，四分位 94.8–102.8 USD；赢家与输家的平均风险几乎一样（97.0 vs 97.8）。"
        "**没有证据表明「亏钱是因为仓位太大」**。问题在入场质量，不在仓位。不要用「亏了以后加仓」去救，"
        "样本里亏损后手数翻倍以上的 13 笔，胜率只有 23%。"
    ))
    blocks.append(h(3, "6.4 复盘流程：把 MCP 用起来"))
    blocks.append(ul([
        "每周拉一次 `list_trades` + 逐笔 `get_trade_context`，给每笔打上四个标签：`align3`、`dir_pos`、`MFE30`、`MAE15`。",
        "统计「逆势单」「Q1 单」「固定 RR≥2 单」「13 点单」的数量，目标不是立刻归零，而是逐周下降。",
        "把 notes / entry_reason / tags 填起来，下一版才能分析「计划内 vs 追单 vs 复仇单」。",
    ]))

    blocks.append(h(2, "7. 样本内规则回放：如果当时按这些规则做"))
    blocks.append(p(
        "下面不是「未来收益预测」，而是把同一批 379 笔交易按规则做一次事后筛选，看看这些共性如果变成硬规则，"
        "在这段历史里会是什么结果。**存在明显的样本内过拟合与多重比较问题，只能作为假设，不能直接实盘。**"
    ))
    rows = []
    for key in ["baseline", "exclude counter-trend (M30)", "exclude M30 range bottom quintile", "exclude 13:00 hour", "exclude fixed-stop planned RR >= 2", "combined quality gate"]:
        x = filters[key]
        rows.append([
            {
                "baseline": "基线（全部）",
                "exclude counter-trend (M30)": "剔除逆势",
                "exclude M30 range bottom quintile": "剔除 Q1",
                "exclude 13:00 hour": "剔除 13 点",
                "exclude fixed-stop planned RR >= 2": "剔除固定 RR≥2",
                "combined quality gate": "四条合并",
            }[key],
            f"{x['kept_n']:.0f}",
            pct(x["kept_win"]),
            money(x["kept_pnl"], True),
            f"{x['kept_avg_r']:+.3f}R",
            f"{x['sessions_improved']:.0f}/8",
        ])
    blocks.append(table(["方案", "保留笔数", "胜率", "净盈亏", "平均 R", "改善样本"], rows, ["l", "r", "r", "r", "r", "r"]))
    blocks.append(p(
        f"四条合并后保留 184 笔（48.5%），胜率 {pct(filters['combined quality gate']['kept_win'])}，"
        f"净盈亏 {money(filters['combined quality gate']['kept_pnl'], True)}，平均 {filters['combined quality gate']['kept_avg_r']:+.3f}R，"
        "8/8 个样本都改善。代价是丢掉一半交易机会；如果这些规则真的有效，应该先用小仓位、固定规则、至少 50–100 笔前向验证，"
        "而不是直接放大仓位。"
    ))
    blocks.append(p(
        "另外两个「管理动作」的样本内回放："
        f"① 30 分钟时 MFE30 < 0.25R 就离场，总盈亏从 +3,370 提高到 +4,011（+642，34 笔被提前切掉）；"
        f"② 只把固定止盈改成 0.75R，固定止损书从 -9,256 改善到 -6,544（+2,712），但仍然亏损。"
        "这说明**出场优化只能减亏，不能把负期望的入场变成正期望**；核心还是入场过滤。"
    ))

    blocks.append(h(2, "8. 局限与下一步"))
    blocks.append(ul([
        "样本只有 379 笔、8 个回测集、一个品种（XAUUSD）、一个年度区间；结论可能只适用于这段行情的波动结构。",
        "1/8/10 是同一段 2026-10 行情的重复挑战，不能当作三个独立市场样本；不过它们的盈亏差异（-204 / -33 / +1,048）反而说明执行差异很重要。",
        "MFE/MAE 由 M1 K 线计算；同一分钟内先止损还是先止盈无法还原，本文按「先止损」保守处理。",
        "移动止损/手动平仓的单，初始止损未知；本文用会话风险预算 $100 折算 MFE/MAE，并在固定止损子集上做对照。",
        "没有 notes / tags / entry_reason，无法区分「计划内亏损」和「违纪亏损」；这是下一步最值得补的数据。",
        "所有「共性」都是描述性统计，不是因果；样本内规则回放有过拟合风险，需要前向验证。",
    ]))

    blocks.append(h(2, "附录：复现方式与文件"))
    blocks.append(p(
        "应用内 MCP 端点：`http://127.0.0.1:47821/mcp`（设置 → MCP 可改端口/关闭）。"
        "工具：`list_sessions`、`list_trades`、`get_trade`、`get_trade_context`、`get_candles`、`analyze_trades`。"
        "本次数据由 `analysis/collect_via_mcp.py` 通过 MCP 拉取，`analysis/build_dataset.py` 生成特征表，"
        "`analysis/analyze.py` / `feature_compare.py` / `whatif*.py` 产出统计，`analysis/charts.py` 产图。"
    ))
    blocks.append(p(
        "附件：`analysis/output/report_facts.json`（全部引用数字）、`analysis/data/features.csv`（379 笔逐笔特征）、"
        "`reports/figures/`（7 张图）、`analysis/output/whatif_*.csv`（规则回放明细）。"
    ))
    return blocks


def inline_md(text: str) -> str:
    text = re.sub(r"\*\*(.+?)\*\*", r"**\1**", text)
    return text


def inline_html(text: str) -> str:
    text = (text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))
    text = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", text)
    text = re.sub(r"`([^`]+)`", r"<code>\1</code>", text)
    return text


def render_md(blocks) -> str:
    out = []
    for b in blocks:
        t = b["type"]
        if t == "h":
            out.append("#" * b["level"] + " " + b["text"])
            out.append("")
        elif t == "p":
            out.append(inline_md(b["text"]))
            out.append("")
        elif t == "ul":
            for item in b["items"]:
                out.append("- " + inline_md(item))
            out.append("")
        elif t == "table":
            headers = b["headers"]
            out.append("| " + " | ".join(headers) + " |")
            out.append("|" + "|".join(["---"] * len(headers)) + "|")
            for row in b["rows"]:
                out.append("| " + " | ".join(str(x) for x in row) + " |")
            out.append("")
        elif t == "img":
            out.append(f"![{b['caption']}]({b['src']})")
            out.append("")
            out.append(f"*{b['caption']}*")
            out.append("")
        elif t == "callout":
            out.append(f"> **{b['title']}**")
            out.append(">")
            out.append("> " + inline_md(b["text"]))
            out.append("")
    return "\n".join(out).strip() + "\n"


def render_html(blocks) -> str:
    body = []
    for b in blocks:
        t = b["type"]
        if t == "h":
            body.append(f"<h{b['level']}>{inline_html(b['text'])}</h{b['level']}>")
        elif t == "p":
            body.append(f"<p>{inline_html(b['text'])}</p>")
        elif t == "ul":
            body.append("<ul>" + "".join(f"<li>{inline_html(i)}</li>" for i in b["items"]) + "</ul>")
        elif t == "table":
            head = "".join(f"<th>{inline_html(str(x))}</th>" for x in b["headers"])
            rows = "".join(
                "<tr>" + "".join(f"<td>{inline_html(str(x))}</td>" for x in row) + "</tr>" for row in b["rows"]
            )
            body.append(f"<div class='table-wrap'><table><thead><tr>{head}</tr></thead><tbody>{rows}</tbody></table></div>")
        elif t == "img":
            body.append(
                f"<figure><img src='{b['src']}' alt='{inline_html(b['caption'])}'/>"
                f"<figcaption>{inline_html(b['caption'])}</figcaption></figure>"
            )
        elif t == "callout":
            body.append(
                f"<div class='callout'><div class='callout-title'>{inline_html(b['title'])}</div>"
                f"<p>{inline_html(b['text'])}</p></div>"
            )
    css = """
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #0d0f13; color: #e6e8ec; font-family: "Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif; line-height: 1.85; }
    .page { max-width: 1120px; margin: 0 auto; padding: 56px 40px 96px; }
    h1 { font-size: 34px; line-height: 1.35; margin: 0 0 12px; letter-spacing: .2px; }
    h2 { font-size: 24px; margin: 52px 0 16px; padding-bottom: 10px; border-bottom: 1px solid #2a2e38; }
    h3 { font-size: 18px; margin: 32px 0 12px; color: #c4b5fd; }
    p { margin: 12px 0; color: #d3d7de; }
    strong { color: #fff; }
    code { background: #1b1e26; border: 1px solid #2a2e38; border-radius: 4px; padding: 1px 5px; font-size: .92em; color: #a5b4fc; }
    .meta { color: #9aa0aa; font-size: 13px; margin-bottom: 28px; }
    .callout { margin: 26px 0; padding: 18px 22px; background: linear-gradient(135deg, rgba(139,92,246,.12), rgba(56,189,248,.06)); border: 1px solid rgba(139,92,246,.35); border-left: 4px solid #8b5cf6; border-radius: 10px; }
    .callout-title { font-weight: 700; color: #c4b5fd; margin-bottom: 6px; }
    .callout p { margin: 0; }
    .table-wrap { overflow-x: auto; margin: 18px 0 26px; border: 1px solid #2a2e38; border-radius: 10px; }
    table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
    th, td { padding: 10px 14px; border-bottom: 1px solid #22262f; text-align: left; white-space: nowrap; }
    th { background: #171a21; color: #9aa0aa; font-weight: 600; font-size: 12.5px; letter-spacing: .4px; }
    tr:last-child td { border-bottom: none; }
    tbody tr:hover { background: rgba(139,92,246,.06); }
    td:not(:first-child), th:not(:first-child) { text-align: right; }
    figure { margin: 26px 0 34px; }
    figure img { width: 100%; height: auto; border-radius: 10px; border: 1px solid #2a2e38; display: block; }
    figcaption { color: #8f96a3; font-size: 12.5px; margin-top: 8px; text-align: center; }
    ul { margin: 12px 0 18px; padding-left: 22px; }
    li { margin: 7px 0; color: #d3d7de; }
    hr { border: none; border-top: 1px solid #2a2e38; margin: 36px 0; }
    @media print { body { background: #fff; color: #111; } .page { padding: 20px; } h2 { border-color: #ddd; } p, li { color: #222; } .callout { background: #f5f3ff; } figure img { border-color: #ddd; } }
    """
    return f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>{TITLE}</title><style>{css}</style></head>
<body><div class="page">
<div class="meta">TraderRewind · 生成日期 {DATE} · 379 笔 XAUUSD 训练订单 · 数据经本地 MCP 服务读取</div>
{''.join(body)}
</div></body></html>"""


def main() -> None:
    facts, df = load()
    blocks = build_blocks(facts, df)
    md = render_md(blocks)
    md_path = os.path.join(REPORTS, BASENAME + ".md")
    with open(md_path, "w", encoding="utf-8") as f:
        f.write(md)
    html = render_html(blocks)
    html_path = os.path.join(REPORTS, BASENAME + ".html")
    with open(html_path, "w", encoding="utf-8") as f:
        f.write(html)
    print("wrote", md_path, len(md), "chars")
    print("wrote", html_path, len(html), "chars")


if __name__ == "__main__":
    main()
