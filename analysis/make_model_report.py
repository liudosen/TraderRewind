"""Build the model/state annotation report for session 10."""

from __future__ import annotations

import os

import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "output")
REPORTS = os.path.join(os.path.dirname(HERE), "reports")
os.makedirs(REPORTS, exist_ok=True)


def money(v):
    return f"{v:+,.2f}"


def pct(v):
    return f"{v*100:.1f}%"


def main():
    ms = pd.read_csv(os.path.join(OUT, "session10_model_state.csv"))
    ann = pd.read_csv(os.path.join(OUT, "session10_model_annotations.csv"))
    df = ms.merge(ann[["trade_id", "action", "tags"]], on="trade_id", how="left")
    df["time"] = pd.to_datetime(df.time)
    df = df.sort_values("time").reset_index(drop=True)

    model_stats = (
        df.groupby("model").agg(n=("profit", "size"), wins=("profit", lambda s: (s > 0).sum()),
                                win=("profit", lambda s: (s > 0).mean()), pnl=("profit", "sum"))
        .sort_values("n", ascending=False)
    )
    state_stats = (
        df.groupby("state").agg(n=("profit", "size"), wins=("profit", lambda s: (s > 0).sum()),
                                win=("profit", lambda s: (s > 0).mean()), pnl=("profit", "sum"))
        .reindex(["强趋势", "次强趋势", "弱趋势", "震荡"])
    )
    lmr = df[df.model == "左中右"].sort_values("time")
    cut = df[df.action == "砍"].sort_values("time")

    L = []
    L.append("# 江河模型 × 2016-10：49 笔逐单标注")
    L.append("")
    L.append("生成日期：2026-11-09　|　样本：`2016-10`（实际 2026-10）XAUUSD　|　49 笔")
    L.append("")
    L.append("> 口径：M5 定主周期（方向/位置/强弱），1M 定入场结构（左/右、是否破位），M30 只作大级别支撑压力背景。")
    L.append("> 模型判定使用进场前的 M5/M1 K 线，不使用未来数据；边界单（差 0.1–0.3 ATR 的破位）已人工复核并在备注里写明。")
    L.append("")
    L.append("## 一、江河的四个进场模型")
    L.append("")
    L.append("| 模型 | 一句话定义 | 出处 |")
    L.append("|---|---|---|")
    L.append("| **左中左** | 关键位附近，1M 二次下探不破前低（或二次上探不破前高），形成二推不破；左侧提前进，赌回调结束。 | 《课程12》00:04:13–00:06:08（v006）；《课程16》00:09:57–00:13:40（v010） |")
    L.append("| **左中右** | 仍未破前高/前低，但 1M 内部低点抬高（多头）或高点降低（空头），比左中左更强的左侧形态。 | 《课程12》00:05:53–00:08:00（v006）；《课程16》00:14:12–00:15:15（v010） |")
    L.append("| **右中左** | 前一段下跌/上涨的最后一个防守位被打破，价格回抽确认后进；右侧偏早，不等完整趋势反转。 | 《课程16》00:16:17–00:17:22（v010）；《2026.7.7学员复盘回测答疑》01:55:51–01:58:00（v057） |")
    L.append("| **右中右** | 防守位被打破后，1M 走出延续/小趋势反转，再回踩确认；顺大顺小，确定性最高。 | 《课程16》00:21:04–00:23:09（v010）；《课程12》00:12:12–00:13:30（v006） |")
    L.append("")
    L.append("四个模型的核心区别：**左 = 防守位还没被打破，靠二推不破预判；右 = 防守位已经被打破，靠回抽确认。** "
             "左中左/左中右是“猜底/猜顶”，右中左/右中右是“等市场先证明”。")
    L.append("")
    L.append("## 二、强趋势 / 次强趋势 / 弱趋势 / 震荡")
    L.append("")
    L.append("| 状态 | 判定要点 | 出处 |")
    L.append("|---|---|---|")
    L.append("| **强趋势** | 新高与新高低点拉开距离、回撤浅、创新高后有跟随；EMA20/50/200 同向，斜率大。 | 《20260324200124》02:19:52–02:21:25（v071） |")
    L.append("| **次强趋势** | 强趋势之后 1–3 根小幅回调，再以强姿态恢复；典型“一推—一根回撤—二推”。 | 《课程5》00:07:57–00:08:30（v012） |")
    L.append("| **弱趋势** | 回撤非常深、创新高后无跟随马上收回、多空都能赚；涨多少回多少。 | 《20260324200124》02:19:52–02:21:25（v071）；《课程5》00:09:00（v012） |")
    L.append("| **震荡** | 既不创新高也不创新低，横向移动；要有宽度和时间，K 线重叠区不做。 | 《2026.7.7学员复盘回测答疑》00:34:00–00:34:36（v057）；《20261006…》00:42:06（v062） |")
    L.append("")
    L.append("## 三、这 49 笔的模型分布")
    L.append("")
    L.append("| 模型 | 笔数 | 胜率 | 净盈亏 |")
    L.append("|---|---:|---:|---:|")
    for name, r in model_stats.iterrows():
        L.append(f"| {name} | {int(r.n)} | {pct(r.win)} | {money(r.pnl)} |")
    L.append("")
    L.append("**最刺眼的一条：左中右 6 笔，0 胜，-473.19。** 这 6 笔全是“1M 只做到低点抬高/高点降低，但没有破前高/前低”就左侧进场："
             "10-05 11:24、10-08 10:27、10-09 21:10、10-13 19:59、10-16 11:13、10-16 13:35。"
             "左中右本来是“左侧里偏强”的形态，但在这批单里变成了**提前接飞刀**：形态对了，确认没到。")
    L.append("")
    L.append("**右中左 20 笔、55%、+355.08**，是这套样本的主模型；**左中左 12 笔、58%、+606.10**，双底/双顶二推不破也能做；"
             "**无模型（M5 中段）10 笔、70%、+660.58**，是利润池，但它不是可复制的标准模型，更多是 M5 方向 + 5 分钟跟随的顺势单。")
    L.append("")
    L.append("## 四、这 49 笔的状态分布")
    L.append("")
    L.append("| 状态 | 笔数 | 胜率 | 净盈亏 |")
    L.append("|---|---:|---:|---:|")
    for name, r in state_stats.iterrows():
        L.append(f"| {name} | {int(r.n)} | {pct(r.win)} | {money(r.pnl)} |")
    L.append("")
    L.append("**次强趋势 11 笔、73%、+667.69**，是最好做的环境；**弱趋势 14 笔、43%、-286.06**，是最差的环境；"
             "**强趋势 9 笔只有 44%**——强趋势里如果左侧接（10-16 两笔左中右），照样亏；**震荡 15 笔、47%、+438.65**，"
             "说明这批单在震荡里并不是不能赚，关键是别在中间追。")
    L.append("")
    L.append("## 五、该砍什么订单（按模型/状态）")
    L.append("")
    L.append("### A 级：左中右 6 笔，全砍")
    L.append("")
    L.append("| 时间 | 方向 | 状态 | 结果 | 订单 |")
    L.append("|---|---|---|---:|---|")
    for _, r in lmr.iterrows():
        L.append(f"| {r.time:%m-%d %H:%M} | {'多' if r.direction == 'long' else '空'} | {r.state} | {money(r.profit)} | `{r.trade_id}` |")
    L.append("")
    L.append("这 6 笔的共同点：**1M 只做到低点抬高/高点降低，没有破前高/前低**。左中右的“强”只是内部强，不是外部结构确认；"
             "在强趋势回撤里尤其容易变成“提前接”。要砍的不是形态，而是**没破前高/前低就进**这个动作。")
    L.append("")
    L.append("### B 级：弱趋势里降低预期/减仓")
    L.append("")
    L.append("弱趋势 14 笔、43%、-286.06。弱趋势不是不能做，而是只能等防守位/回踩，不能追进攻位；"
             "这 14 笔里亏损集中在 10-05、10-09、10-13、10-20 的连续试单。")
    L.append("")
    L.append("### C 级：强趋势里的左侧单")
    L.append("")
    L.append("强趋势 9 笔只有 44%，其中 10-16 的 `whd6`（左中右）、`whyy`（左中右）都是强趋势回踩 EMA 后左侧接，"
             "都亏；`b3mo`（左中左）也是左侧双底，亏。**强趋势不代表可以左侧接；强趋势里更要等 1M 破位/回抽确认。**")
    L.append("")
    L.append("## 六、逐单标注")
    L.append("")
    L.append("| # | 时间 | 方向 | 状态 | 模型 | 盈亏 | 处理 |")
    L.append("|---:|---|---|---|---|---:|---|")
    for i, r in df.iterrows():
        L.append(f"| {i+1} | {r.time:%m-%d %H:%M} | {'多' if r.direction == 'long' else '空'} | {r.state} | {r.model} | {money(r.profit)} | {r.action} |")
    L.append("")
    L.append("> 每笔的完整备注（含 1M 结构、M5 EMA/斜率/回撤、MFE5/MAE5、结论）已写入应用数据库；"
             "导出表见 `analysis/output/session10_model_annotations.csv`。")
    L.append("")
    L.append("## 七、配图")
    L.append("")
    L.append("![四个进场模型](<E:/workspace/江河知识点图片/图片库/06_进场模型/p0308_左中左、左中右、右中左、右中右/p0308_v038_004915.jpg>)")
    L.append("")
    L.append("![左中左：低点不创新低的三点共振](<E:/workspace/江河知识点图片/图片库/06_进场模型/p1300_左中左：低点不创新低的三点共振/p1300_v010_000957.jpg>)")
    L.append("")
    L.append("![左中右：内部低点先抬高](<E:/workspace/江河知识点图片/图片库/06_进场模型/p1301_左中右：内部低点先抬高/p1301_v010_001412.jpg>)")
    L.append("")
    L.append("![右中左：破最后防守位后等回抽](<E:/workspace/江河知识点图片/图片库/06_进场模型/p1302_右中左：破最后防守位后等回抽/p1302_v010_001617.jpg>)")
    L.append("")
    L.append("![右中右：最理想的顺大顺小](<E:/workspace/江河知识点图片/图片库/06_进场模型/p1304_右中右：最理想的顺大顺小/p1304_v010_002104.jpg>)")
    L.append("")
    L.append("## 八、局限")
    L.append("")
    L.append("- 49 笔、一个品种、一个月份；模型/状态分组后每格样本很小，尤其左中右 6 笔、右中右 1 笔。")
    L.append("- 1M 摆动点用 3 根左右分形识别，边界单（差 0.1–0.3 ATR）是人工复核的；不同画法可能把同一笔归到相邻模型。")
    L.append("- M5 状态用 EMA 间距/斜率/回撤率做代理，并辅以人工复核；它不是唯一的强弱定义。")
    L.append("- 以上是历史复盘，不构成投资建议。")
    L.append("")

    path = os.path.join(REPORTS, "江河模型_2016-10_逐单标注.md")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(L))
    print("wrote", path, len("\n".join(L)))


if __name__ == "__main__":
    main()
