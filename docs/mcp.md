# 本地 MCP 服务

TraderRewind 在应用内跑一个**只读**的 MCP（Model Context Protocol）服务，让外部 AI
客户端直接读取训练库里的回测集、订单，以及行情库里的多周期 K 线，不需要再写 SQL
或导出 CSV。

- 默认端点：`http://127.0.0.1:47821/mcp`
- 传输：JSON-RPC 2.0 over HTTP（MCP Streamable HTTP）
- 监听：仅 `127.0.0.1`
- 权限：只读；没有任何下单、改单、删库工具
- 开关 / 端口：**设置 → MCP**（新版本默认启用；不需要就点「停止服务」）
- 协议：MCP `2025-06-18`，兼容 `2025-03-26` / `2024-11-05`

## 快速接入 DeepSeek Harness

1. 启动 TraderRewind，打开 **设置 → MCP**，确认状态为「运行中」。
2. 在 DSH profile 的 `cordis.patch.yml` 加：

```yaml
- insert:
    - id: traderrewind-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: traderrewind
        transport: streamable-http
        url: http://127.0.0.1:47821/mcp
        toolCallTimeoutMs: 120000
        failOnStartupError: false
```

3. 重启 DSH。工具会以 `mcp__traderrewind__list_sessions` 这类名字出现。

也可以把 `integrations/dsh-mcp/` 作为一个本地 bundle 安装，步骤见该目录的 README。

## 工具

### `list_sessions`

列出全部回测集（会话）及汇总。

```json
{"includeEmpty": true}
```

返回：品种、数据区间、初始资金、净盈亏、胜率、盈亏比、期望、最大回撤、交易笔数。

### `list_trades`

分页拉取平仓订单（交易日志）。

```json
{
  "sessionId": 1,
  "outcome": "loss",
  "limit": 200,
  "offset": 0,
  "order": "asc"
}
```

支持 `sessionId` / `sessionIds` / `outcome`（all / win / loss / breakeven）/
`symbol` / `from` / `to` / `limit` / `offset` / `order`。

每条订单返回：

- `uid`（`sessionId:tradeId`）、`direction`、`openTime` / `closeTime`（epoch 毫秒）
- `openPrice` / `closePrice` / `slAtClose` / `tpAtClose` / `lotSize` / `contractSize`
- `profit`（净盈亏，含手续费）/ `commission` / `closeReason`
- `rMultiple`：应用原始字段（见下方“R 的口径”）
- `rOnRiskTarget`：按会话 `risk_per_trade` 折算的 R，**跨单比较请用这个**
- `initialSlPrice` / `initialRiskUsd` / `riskBasis`：初始止损能否还原
- `plannedRR`：计划盈亏比（只在初始止损可还原时有值）
- `openHour` / `openWeekday` / `sessionTimezone`

### `get_trade`

```json
{"sessionId": 1, "tradeId": "t_1793532857521_uxxo", "includeContext": false}
```

`includeContext=true` 时等价于再调一次 `get_trade_context`。

### `get_trade_context`

单笔订单的多周期上下文，是分析“为什么赚 / 为什么亏”的主工具。

```json
{
  "sessionId": 1,
  "tradeId": "t_1793532857521_uxxo",
  "timeframes": ["M30", "M5", "M1"],
  "beforeBars": 120,
  "afterBars": 60,
  "includeBars": true
}
```

返回：

- `series.<TF>.bars`：进场前 `beforeBars` 根到平仓后 `afterBars` 根的 K 线
  （`time` 是 epoch 秒，附 `timeIso`）
- `series.<TF>.features`：进场那根上的 EMA20/50/200、ATR14、RSI14、20 根区间
  高低点与位置、EMA20 斜率、距 EMA 的 ATR 距离、ATR 分位、15/60 根动量、
  趋势结构（bull / bear / mixed）
- `series.<TF>.directionAligned`：该周期结构是否与订单方向一致
- `excursions`：从开仓到平仓的 MFE / MAE（价格与 R）、发生时间、
  15/30/60 分钟内的早期 MFE / MAE、MFE 捕获率
- `trade` / `session` / `dataset`

指标只使用进场时点及之前的数据；MFE/MAE 使用进场之后的数据，用于复盘归因。

### `get_candles`

任意区间 K 线。行情库基准是 M1，M5/M15/M30/H1/H4/D1 由 M1 聚合。

```json
{
  "symbol": "XAUUSD",
  "timeframe": "M30",
  "from": "2026-10-01T00:00:00Z",
  "to": "2026-10-31T23:59:59Z",
  "limit": 500
}
```

`from` / `to` 支持 ISO 或 epoch 秒 / 毫秒。`limit` 默认 500、最大 5000；
超出时保留最近的一段并返回 `truncated: true`。

### `analyze_trades`

按维度汇总，适合先快速扫一遍共性。

```json
{"sessionIds": [1, 2, 3], "outcome": "all", "maxTrades": 500}
```

返回：整体胜率 / 盈亏比 / 期望 / 最大回撤；按方向、平仓原因、小时、星期、
持仓时长、R 区间、计划 RR、M30 趋势结构、M30 区间位置、早期 MFE 分组；
`drivers` 按与整体平均 R 的偏差排序。

## 资源

`resources/list` 提供三个只读资源：

- `traderrewind://sessions` — 全部回测集汇总
- `traderrewind://trades` — 最多 1000 笔订单
- `traderrewind://guide` — 数据口径与工具说明

## R 的口径（重要）

`closed_trades.r_multiple` 是「盈亏 ÷ **平仓时**止损距离」。对没有移动过止损
的固定单，它等于初始 R；但对 `trail`、部分 `tp/manual`（止损已经移到盈利侧）
的单，分母不再是初始风险，R 会严重失真。

MCP 因此同时返回：

- `rOnRiskTarget = profit / session.risk_per_trade`：按会话风险预算折算，**跨单可比**
- `rMultiple`：应用原始值，仅作参考
- `riskBasis`：
  - `initial_stop`：`sl/tp` 且止损仍在开仓价亏损侧，初始风险可还原
  - `moved_stop`：`trail` 或止损已到盈利侧
  - `unknown`：`manual` 且止损仍在亏损侧（无法确认是否初始）

样本里 379 笔中约 25% 属于 `moved_stop` / `unknown`。做统计时请按 `riskBasis`
过滤，或统一用 `rOnRiskTarget`。

## 时间口径

- 订单时间：epoch **毫秒**，附 `*Iso` 与 `*Local`（会话时区，默认 UTC+8）
- K 线时间：epoch **秒**（TradingView 口径），附 `timeIso`
- 日内周期桶按 UTC 自然日锚点对齐；周/月/季/年按日历边界

## 安全与隐私

- 只 bind `127.0.0.1`，外部机器无法访问
- 拒绝非本机 `Origin`，降低 DNS rebinding / 恶意网页读取风险
- 只读工具；没有写接口
- 不经过系统代理（避免把本地数据转发到代理网关）
- 数据不离开本机；MCP 客户端拿到什么，取决于它调用了哪些工具

## 故障排查

| 现象 | 处理 |
|---|---|
| 设置页显示「启动失败：端口被占用」 | 改端口，或关掉占用该端口的程序 |
| 客户端连不上 | 确认 TraderRewind 正在运行、MCP 已启用；先用 `curl http://127.0.0.1:47821/health` 探活 |
| 工具返回空 | 确认行情库已导入、会话有平仓记录；`list_sessions` 的 `tradeCount` 为 0 时先看数据 |
| 想确认协议细节 | `POST /mcp` 发 `initialize` + `tools/list`，见 `scripts/mcp-client.mjs` |
| 想临时关掉 | 设置 → MCP → 停止服务；或修改 `settings.json` 的 `mcp.enabled` |

## 实现位置

| 文件 | 作用 |
|---|---|
| `src/main/services/mcp-server.ts` | HTTP / JSON-RPC / 会话 / 资源 |
| `src/main/services/mcp-tools.ts` | 工具定义、参数校验、返回结构 |
| `src/main/services/trade-analytics.ts` | 订单归一化、M1 聚合、指标、MFE/MAE |
| `src/main/ipc/mcp-handlers.ts` | 设置页状态 / 启停 / 改端口 |
| `src/shared/types/mcp.ts` | 设置与状态类型 |
| `integrations/dsh-mcp/` | DeepSeek Harness bundle |

## 已知限制

- MCP 只读，不能替代应用内的下单 / 回放控制
- K 线来自本地 M1 数据；没有导入的周期只能由 M1 聚合，不能凭空生成
- MFE/MAE 由 M1 K 线计算；同一分钟内先止损还是先止盈无法还原，按「先止损」保守处理
- 历史订单没有保存初始止损，`moved_stop` 的初始风险不可精确还原
- 不做鉴权（本机回环 + Origin 校验）；如果多人共用一台机器，请用系统账户隔离
