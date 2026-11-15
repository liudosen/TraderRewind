// ============================================================
// TraderRewind — MCP 工具定义与调用
//
// 工具全部只读：列会话、列订单、取单笔上下文（M1/M5/M30 K 线 +
// 进场指标 + 最大有利/不利偏移）、取任意区间 K 线、按维度做汇总。
// ============================================================

import type { McpToolSummary } from '@shared/types/mcp'
import {
  analyzeTrades,
  getCandles,
  getTradeContext,
  listSessionSummaries,
  listTrades,
  loadDataset,
  loadSessions,
  loadTrade,
  normalizeTrade,
  MCP_TIMEFRAMES,
  type McpTimeframe,
  type TradeContext
} from './trade-analytics'

export interface McpToolDef extends McpToolSummary {
  inputSchema: Record<string, unknown>
  handler: (args: Record<string, unknown>) => unknown
}

const SESSION_SCHEMA = {
  type: 'object',
  properties: {
    sessionId: { type: 'integer', description: '回测集（会话）ID。不传 = 全部回测集' },
    sessionIds: {
      type: 'array',
      items: { type: 'integer' },
      description: '多个回测集 ID；与 sessionId 二选一'
    }
  },
  additionalProperties: false
}

function obj(args: unknown): Record<string, unknown> {
  return args && typeof args === 'object' && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {}
}

function readInt(
  args: Record<string, unknown>,
  key: string,
  opts: { min?: number; max?: number; required?: boolean } = {}
): number | undefined {
  const raw = args[key]
  if (raw == null || raw === '') {
    if (opts.required) throw new Error(`缺少参数 ${key}`)
    return undefined
  }
  const n = Number(raw)
  if (!Number.isFinite(n)) throw new Error(`参数 ${key} 必须是数字`)
  const v = Math.floor(n)
  if (opts.min != null && v < opts.min) throw new Error(`参数 ${key} 不能小于 ${opts.min}`)
  if (opts.max != null && v > opts.max) throw new Error(`参数 ${key} 不能大于 ${opts.max}`)
  return v
}

function readString(
  args: Record<string, unknown>,
  key: string,
  opts: { required?: boolean; values?: readonly string[] } = {}
): string | undefined {
  const raw = args[key]
  if (raw == null || raw === '') {
    if (opts.required) throw new Error(`缺少参数 ${key}`)
    return undefined
  }
  const s = String(raw).trim()
  if (opts.values && !opts.values.includes(s)) {
    throw new Error(`参数 ${key} 只能是：${opts.values.join(' / ')}`)
  }
  return s
}

function readBool(args: Record<string, unknown>, key: string): boolean | undefined {
  const raw = args[key]
  if (raw == null || raw === '') return undefined
  if (typeof raw === 'boolean') return raw
  const s = String(raw).toLowerCase()
  if (s === 'true' || s === '1') return true
  if (s === 'false' || s === '0') return false
  throw new Error(`参数 ${key} 必须是 true/false`)
}

/** 时间参数：ISO 字符串 / 秒级 / 毫秒级时间戳，统一返回秒 */
function readTime(args: Record<string, unknown>, key: string, required = false): number | undefined {
  const raw = args[key]
  if (raw == null || raw === '') {
    if (required) throw new Error(`缺少参数 ${key}`)
    return undefined
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw > 1e12 ? Math.floor(raw / 1000) : Math.floor(raw)
  }
  const s = String(raw).trim()
  const n = Number(s)
  if (Number.isFinite(n) && s !== '') return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n)
  const ms = Date.parse(s)
  if (!Number.isFinite(ms)) throw new Error(`时间参数 ${key} 无法解析：${s}`)
  return Math.floor(ms / 1000)
}

function readTimeframes(args: Record<string, unknown>): McpTimeframe[] | undefined {
  const raw = args.timeframes
  if (raw == null) return undefined
  if (!Array.isArray(raw)) throw new Error('timeframes 必须是数组')
  const out: McpTimeframe[] = []
  for (const item of raw) {
    const tf = String(item).toUpperCase() as McpTimeframe
    if (!MCP_TIMEFRAMES.includes(tf)) {
      throw new Error(`不支持的周期：${item}（可用：${MCP_TIMEFRAMES.join(', ')}）`)
    }
    out.push(tf)
  }
  return out
}

/** 行情库只有 M1 时，用数据集自身的周期作为响应周期 */
function normalizeTimeframe(tf: string | undefined): McpTimeframe {
  const v = (tf ?? 'M1').toUpperCase() as McpTimeframe
  if (!MCP_TIMEFRAMES.includes(v)) {
    throw new Error(`不支持的周期：${tf}（可用：${MCP_TIMEFRAMES.join(', ')}）`)
  }
  return v
}

function sessionScoped(args: Record<string, unknown>): number[] | undefined {
  const ids = args.sessionIds
  if (Array.isArray(ids) && ids.length > 0) {
    return ids.map((v) => {
      const n = Number(v)
      if (!Number.isFinite(n)) throw new Error('sessionIds 必须是数字数组')
      return Math.floor(n)
    })
  }
  const one = readInt(args, 'sessionId', { min: 1 })
  return one != null ? [one] : undefined
}

function requireTradeIds(args: Record<string, unknown>): { sessionId: number; tradeId: string } {
  const sessionId = readInt(args, 'sessionId', { min: 1, required: true }) as number
  const tradeId = readString(args, 'tradeId', { required: true }) as string
  return { sessionId, tradeId }
}

function compactTrade(trade: ReturnType<typeof listTrades>['trades'][number]): unknown {
  return {
    uid: trade.uid,
    sessionId: trade.sessionId,
    sessionName: trade.sessionName,
    id: trade.id,
    symbol: trade.symbol,
    direction: trade.direction,
    type: trade.type,
    action: trade.action,
    openTime: trade.openTime,
    closeTime: trade.closeTime,
    openTimeIso: trade.openTimeIso,
    closeTimeIso: trade.closeTimeIso,
    openTimeLocal: trade.openTimeLocal,
    closeTimeLocal: trade.closeTimeLocal,
    holdingMinutes: trade.holdingMinutes,
    openPrice: trade.openPrice,
    closePrice: trade.closePrice,
    slAtClose: trade.slAtClose,
    tpAtClose: trade.tpAtClose,
    lotSize: trade.lotSize,
    contractSize: trade.contractSize,
    profit: trade.profit,
    commission: trade.commission,
    netProfit: trade.netProfit,
    closeReason: trade.closeReason,
    rMultiple: trade.rMultiple,
    rOnRiskTarget: trade.rOnRiskTarget,
    riskTargetUsd: trade.riskTargetUsd,
    initialSlPrice: trade.initialSlPrice,
    initialRiskUsd: trade.initialRiskUsd,
    riskBasis: trade.riskBasis,
    stopMoved: trade.stopMoved,
    plannedRR: trade.plannedRR,
    tags: trade.tags,
    notes: trade.notes,
    entryReason: trade.entryReason,
    strategyName: trade.strategyName,
    openHour: trade.openHour,
    openWeekday: trade.openWeekday,
    sessionTimezone: trade.sessionTimezone
  }
}

function contextForResponse(ctx: TradeContext, includeBars: boolean): unknown {
  const series: Record<string, unknown> = {}
  for (const [tf, value] of Object.entries(ctx.series)) {
    if (!value) continue
    series[tf] = {
      timeframe: value.timeframe,
      barSeconds: value.barSeconds,
      entryBarTime: value.entryBarTime,
      entryBarIso: value.entryBarIso,
      exitBarTime: value.exitBarTime,
      exitBarIso: value.exitBarIso,
      entryBarIndex: value.entryBarIndex,
      directionAligned: value.directionAligned,
      features: value.features,
      ...(includeBars ? { bars: value.bars } : {})
    }
  }
  return {
    trade: compactTrade(ctx.trade),
    session: ctx.session,
    dataset: ctx.dataset,
    series,
    excursions: ctx.excursions
  }
}

const TOOLS: McpToolDef[] = [
  {
    name: 'list_sessions',
    title: '列出回测集',
    description:
      '列出全部训练/回测集（会话），含品种、区间、初始资金、净盈亏、胜率、盈亏比、最大回撤。' +
      '分析某个月的交易前先用它拿 sessionId。',
    inputSchema: {
      type: 'object',
      properties: {
        includeEmpty: {
          type: 'boolean',
          description: '是否包含没有任何平仓记录的空回测集，默认 true'
        }
      },
      additionalProperties: false
    },
    handler(args) {
      const includeEmpty = readBool(args, 'includeEmpty') !== false
      const sessions = listSessionSummaries(includeEmpty)
      return {
        count: sessions.length,
        totals: {
          sessions: sessions.length,
          trades: sessions.reduce((s, x) => s + x.tradeCount, 0),
          netPnl: sessions.reduce((s, x) => s + x.netPnl, 0),
          wins: sessions.reduce((s, x) => s + x.wins, 0),
          losses: sessions.reduce((s, x) => s + x.losses, 0)
        },
        sessions
      }
    }
  },
  {
    name: 'list_trades',
    title: '列出订单/交易日志',
    description:
      '按回测集、方向结果、品种、时间过滤，分页返回全部平仓订单（交易日志）。' +
      '不传 sessionId 时返回所有回测集；默认每页 500 条（379 笔样本一次拉完）。' +
      'rOnRiskTarget 是按会话单笔风险折算的 R，跨单比较请用它；rMultiple 对移动过止损的单会失真。',
    inputSchema: {
      type: 'object',
      properties: {
        ...SESSION_SCHEMA.properties,
        outcome: {
          type: 'string',
          enum: ['all', 'win', 'loss', 'breakeven'],
          description: '只看盈利 / 亏损 / 打平；默认 all'
        },
        symbol: { type: 'string', description: '品种过滤，例如 XAUUSD' },
        from: { type: 'string', description: '开仓时间下界：ISO 或 epoch 秒/毫秒' },
        to: { type: 'string', description: '开仓时间上界：ISO 或 epoch 秒/毫秒' },
        limit: { type: 'integer', description: '每页条数，1-1000，默认 500' },
        offset: { type: 'integer', description: '跳过条数，默认 0' },
        order: { type: 'string', enum: ['asc', 'desc'], description: '按开仓时间排序，默认 asc' }
      },
      additionalProperties: false
    },
    handler(args) {
      const outcome = readString(args, 'outcome', {
        values: ['all', 'win', 'loss', 'breakeven']
      }) as 'all' | 'win' | 'loss' | 'breakeven' | undefined
      const order = readString(args, 'order', { values: ['asc', 'desc'] }) as
        | 'asc'
        | 'desc'
        | undefined
      const res = listTrades({
        sessionId: readInt(args, 'sessionId', { min: 1 }),
        sessionIds: sessionScoped({ sessionIds: args.sessionIds }),
        outcome: outcome ?? 'all',
        symbol: readString(args, 'symbol'),
        from: readTime(args, 'from'),
        to: readTime(args, 'to'),
        limit: readInt(args, 'limit', { min: 1, max: 1000 }) ?? 500,
        offset: readInt(args, 'offset', { min: 0 }) ?? 0,
        order: order ?? 'asc'
      })
      return { ...res, trades: res.trades.map(compactTrade) }
    }
  },
  {
    name: 'get_trade',
    title: '取单笔订单详情',
    description:
      '按 sessionId + tradeId 取一笔订单的完整字段；includeContext=true 时一并返回多周期上下文' +
      '（等价于再调一次 get_trade_context）。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'integer', description: '回测集 ID' },
        tradeId: {
          type: 'string',
          description: '订单 ID（closed_trades.id，也接受 uid 的冒号后半段）'
        },
        includeContext: { type: 'boolean', description: '是否返回 K 线上下文，默认 false' }
      },
      required: ['sessionId', 'tradeId'],
      additionalProperties: false
    },
    handler(args) {
      const { sessionId, tradeId } = requireTradeIds(args)
      const id = tradeId.includes(':') ? tradeId.split(':').slice(1).join(':') : tradeId
      if (readBool(args, 'includeContext')) {
        const ctx = getTradeContext(sessionId, id, {
          timeframes: ['M30', 'M5', 'M1'],
          beforeBars: 120,
          afterBars: 60,
          includeBars: true
        })
        if (!ctx) throw new Error(`找不到订单 ${sessionId}:${id}`)
        return contextForResponse(ctx, true)
      }
      const row = loadTrade(sessionId, id)
      if (!row) throw new Error(`找不到订单 ${sessionId}:${id}`)
      const session = loadSessions().find((s) => s.id === sessionId)
      if (!session) throw new Error(`找不到回测集 ${sessionId}`)
      const dataset = loadDataset(session.dataset_id)
      return { trade: compactTrade(normalizeTrade(row, session, dataset)) }
    }
  },
  {
    name: 'get_trade_context',
    title: '取订单前后多周期 K 线与结构',
    description:
      '给一笔订单，返回进场前后 M1 / M5 / M30（可自选）K 线、EMA20/50/200、ATR14、RSI14、' +
      '20 根区间位置、动量、趋势结构，以及从开仓到平仓的 MFE/MAE（按会话风险预算折算成 R），' +
      '还给出 15/30/60 分钟内的早期 MFE/MAE。这是分析每笔订单「为什么赚/为什么亏」的主工具。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'integer', description: '回测集 ID' },
        tradeId: { type: 'string', description: '订单 ID' },
        timeframes: {
          type: 'array',
          items: { type: 'string', enum: [...MCP_TIMEFRAMES] },
          description: '要返回的周期，默认 ["M30","M5","M1"]'
        },
        beforeBars: {
          type: 'integer',
          description: '进场前返回多少根该周期 K 线（含进场那根），默认 120，最大 500'
        },
        afterBars: {
          type: 'integer',
          description: '平仓后返回多少根该周期 K 线，默认 60，最大 500'
        },
        includeBars: {
          type: 'boolean',
          description: '是否返回 K 线数组；只想看指标可设 false 减小响应，默认 true'
        }
      },
      required: ['sessionId', 'tradeId'],
      additionalProperties: false
    },
    handler(args) {
      const { sessionId, tradeId } = requireTradeIds(args)
      const id = tradeId.includes(':') ? tradeId.split(':').slice(1).join(':') : tradeId
      const ctx = getTradeContext(sessionId, id, {
        timeframes: readTimeframes(args),
        beforeBars: readInt(args, 'beforeBars', { min: 5, max: 500 }),
        afterBars: readInt(args, 'afterBars', { min: 0, max: 500 }),
        includeBars: readBool(args, 'includeBars') !== false
      })
      if (!ctx) throw new Error(`找不到订单上下文 ${sessionId}:${id}`)
      return contextForResponse(ctx, readBool(args, 'includeBars') !== false)
    }
  },
  {
    name: 'get_candles',
    title: '取任意区间 K 线',
    description:
      '按品种或数据集取任意周期的 K 线（行情库基准是 M1，M5/M15/M30/H1/H4/D1 由 M1 聚合）。' +
      '时间参数支持 ISO 或 epoch 秒/毫秒；返回的 bars[].time 是 epoch 秒并附 timeIso。' +
      'limit 默认 500、最大 5000，超出时保留最近的一段并标记 truncated。',
    inputSchema: {
      type: 'object',
      properties: {
        datasetId: { type: 'integer', description: '数据集 ID；与 symbol 二选一' },
        symbol: { type: 'string', description: '品种，例如 XAUUSD' },
        timeframe: {
          type: 'string',
          enum: [...MCP_TIMEFRAMES],
          description: '周期，默认 M1'
        },
        from: { type: 'string', description: '起始时间（ISO 或 epoch 秒/毫秒），必填' },
        to: { type: 'string', description: '结束时间（ISO 或 epoch 秒/毫秒），必填' },
        limit: { type: 'integer', description: '最多返回多少根，默认 500' }
      },
      required: ['from', 'to'],
      additionalProperties: false
    },
    handler(args) {
      const from = readTime(args, 'from', true) as number
      const to = readTime(args, 'to', true) as number
      if (to <= from) throw new Error('to 必须大于 from')
      const tf = normalizeTimeframe(readString(args, 'timeframe'))
      const res = getCandles({
        datasetId: readInt(args, 'datasetId', { min: 1 }),
        symbol: readString(args, 'symbol'),
        timeframe: tf,
        from,
        to,
        limit: readInt(args, 'limit', { min: 1, max: 5000 })
      })
      if (!res) throw new Error('找不到匹配的数据集；请确认 symbol/datasetId 正确且行情库已导入')
      return res
    }
  },
  {
    name: 'analyze_trades',
    title: '按维度汇总盈亏共性',
    description:
      '对全部或指定回测集的订单做汇总：整体胜率/盈亏比/期望/最大回撤，并按方向、平仓原因、' +
      '小时、星期、持仓时长、R 区间、计划盈亏比、M30 趋势结构、M30 区间位置、早期 MFE 分组。' +
      'drivers 是按平均 R 与整体偏差排序的驱动因素，适合快速找「亏损共性 / 盈利共性」。' +
      '首次调用会逐笔读取行情，379 笔约需数秒。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionIds: {
          type: 'array',
          items: { type: 'integer' },
          description: '限定回测集；不传 = 全部'
        },
        outcome: {
          type: 'string',
          enum: ['all', 'win', 'loss'],
          description: '只分析某类结果，默认 all'
        },
        maxTrades: { type: 'integer', description: '最多分析多少笔，默认 500' }
      },
      additionalProperties: false
    },
    handler(args) {
      const outcome = readString(args, 'outcome', { values: ['all', 'win', 'loss'] }) as
        | 'all'
        | 'win'
        | 'loss'
        | undefined
      return analyzeTrades({
        sessionIds: sessionScoped({ sessionIds: args.sessionIds }),
        outcome: outcome ?? 'all',
        maxTrades: readInt(args, 'maxTrades', { min: 1, max: 1000 })
      })
    }
  }
]

export function mcpToolSummaries(): McpToolSummary[] {
  return TOOLS.map(({ name, title, description }) => ({ name, title, description }))
}

export function mcpToolDefinitions(): Array<{
  name: string
  title: string
  description: string
  inputSchema: Record<string, unknown>
}> {
  return TOOLS.map(({ name, title, description, inputSchema }) => ({
    name,
    title,
    description,
    inputSchema
  }))
}

export async function callMcpTool(
  name: string,
  rawArgs: unknown
): Promise<{ payload: unknown; isError: boolean }> {
  const tool = TOOLS.find((t) => t.name === name)
  if (!tool) return { payload: { error: `未知工具：${name}` }, isError: true }
  try {
    return { payload: tool.handler(obj(rawArgs)), isError: false }
  } catch (e) {
    return {
      payload: { error: e instanceof Error ? e.message : String(e) },
      isError: true
    }
  }
}

export function mcpServerInfo(): {
  name: string
  title: string
  description: string
  instructions: string
} {
  return {
    name: 'traderrewind',
    title: 'TraderRewind 交易复盘',
    description: '本地只读的交易训练数据：回测集、订单日志、多周期 K 线、盈亏归因。',
    instructions:
      'TraderRewind 是一个本地历史行情回放 / 交易训练工具。这里的数据来自用户自己的训练库与行情库，' +
      '全部只读，不会改动任何交易记录。\n\n' +
      '推荐工作流：\n' +
      '1. 先调 list_sessions 找到要分析的回测集；\n' +
      '2. 用 list_trades 拉取订单（可只取 win / loss）；\n' +
      '3. 对每笔订单调 get_trade_context，拿到 M30/M5/M1 进场结构、早期 MFE/MAE；\n' +
      '4. 用 analyze_trades 做分组汇总，再结合逐笔特征解释「亏损共性 / 盈利共性」。\n\n' +
      '口径提醒：\n' +
      '- rOnRiskTarget = 盈亏 / 会话单笔风险预算（默认 $100），跨单可比；\n' +
      '- rMultiple 是应用按「平仓时止损距离」算的 R，移动过止损（trail、部分 tp/manual）的订单会失真；\n' +
      '- initialRiskUsd / initialSlPrice 只在 sl/tp 且止损仍在亏损侧时可靠；\n' +
      '- bars[].time 是 epoch 秒，订单时间是 epoch 毫秒，均附 ISO 字符串。\n\n' +
      '不要根据这些数据给出投资建议；这是历史复盘数据，不是实时行情。'
  }
}
