# 复盘分析流水线

这组脚本演示如何**通过 MCP** 而不是直接读 SQLite 做一次完整复盘：

1. `collect_via_mcp.py` — 连 `http://127.0.0.1:47821/mcp`，调
   `list_sessions` / `list_trades` / 逐笔 `get_trade_context`，把 379 笔订单的
   M1/M5/M30 上下文写到 `analysis/data/contexts.jsonl`（约 34 MB，已 gitignore；
   可随时重跑，6 个并发约 6 秒）。
2. `build_dataset.py` — 把上下文摊平成 `analysis/data/features.csv`。
3. `analyze.py` — 总体 / 分样本 / 分组统计，输出 `analysis/output/stats.json`。
4. `feature_compare.py` — 赢家 vs 输家的效应量、Bootstrap 置信区间、跨样本一致性。
5. `whatif_all.py` / `whatif_tp.py` — 规则回放（时间止损、近端固定止盈）。
6. `charts.py` — 用 Pillow 生成 7 张图到 `analysis/output/figures/`。
7. `report_facts.py` — 汇总报告引用到的所有数字到 `analysis/output/report_facts.json`。
8. `make_report.py` — 生成 `reports/TraderRewind_交易复盘_2026-11-09.md` 和 `.html`。

## 运行

```powershell
# 先让 TraderRewind 跑起来，设置 → MCP 为「运行中」
python analysis/collect_via_mcp.py
python analysis/build_dataset.py
python analysis/analyze.py
python analysis/feature_compare.py
python analysis/whatif_all.py
python analysis/whatif_tp.py
python analysis/charts.py
python analysis/report_facts.py
python analysis/make_report.py
```

依赖：Python 3.10+、`numpy`、`pandas`；本仓库运行环境自带这两个包。
不需要 `scipy` / `sklearn` / `matplotlib`。

## 单集诊断（2016-10）

```powershell
python analysis/jianghe_session10.py       # M30 当主周期的旧口径
python analysis/jianghe_session10_m5.py    # 按用户口径：M5 主周期 / M1 执行 / M30 大级别位置
```

`jianghe_session10_m5.py` 只拉 `sessionId=10` 的 49 笔订单，生成
`analysis/data/session10_m5_features.csv`，用于
`reports/江河规则_2016-10_订单诊断_M5主周期.md`。旧口径的
`reports/江河规则_2016-10_订单诊断.md` 保留作对照，但结论以 M5 主周期版为准。

```powershell
python analysis/apply_session10_tags.py   # 写入 49 笔的 notes/tags_json；先备份训练库
```

写入前会备份到 `analysis/output/training.db.bak-before-session10-tags`；
原始备份另存为 `analysis/output/training.db.bak-original`。

## 江河模型/状态标注（2016-10）

```powershell
python analysis/classify_models_all.py       # 1M 左右侧模型 + M5 强/次强/弱/震荡
python analysis/apply_model_state_notes.py   # 把模型/状态写进 49 笔的 notes/tags_json
python analysis/make_model_report.py         # 生成 reports/江河模型_2016-10_逐单标注.md
```

模型/状态判定用进场前 K 线，不使用未来数据；边界单人工复核。写入前备份到
`analysis/output/training.db.bak-before-model-notes`。

标签只保留江河体系 8 个（左中左/左中右/右中左/右中右/强趋势/次强趋势/弱趋势/震荡）：

```powershell
python analysis/apply_jianghe_tags_only.py
```

## 口径

- `r_target = profit / session.risk_per_trade`，跨单可比。
- 移动过止损的订单（`trail`、部分 `tp/manual`）没有可靠的初始止损；
  `get_trade_context` 用风险预算折算 MFE/MAE，并在 `riskBasis` 里标记。
- `contexts.jsonl` 是原始数据，不要提交；`features.csv` 和报告图表可以提交。
