// ============================================================
// TraderRewind — 交易分析数据层
//
// 只读：从 training.db 取会话 / 订单，从 market.db 取 M1 行情，
// 在内存里聚合 M5 / M30 / H1…，再算出每笔订单进场前后的结构特征。
// MCP 工具与设置页都走这里，保证「AI 看到的数」和「界面里的数」同源。
// ============================================================

import { getMarketDb, getTrainingDb } from '../db/connection'
import { loadSettings } from '../settings'
import { getContractSize } from '@shared/constants/catalog'
import {
  aggregateBars,
  bucketStart,
  indexAtTime,
  timeframeSeconds,
  type Bar
} from '@shared/utils/timeframe'
import {
  fmtTzDateTime,
  normalizeTimezone,
  tzPartsFromSec
} from '@shared/types/timezone'

export const MCP_TIMEFRAMES = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'] as const
export type McpTimeframe = (typeof MCP_TIMEFRAMES)[number]

export interface SessionRow {
  id: number
  dataset_id: number
  name: string
  initial_balance: number
  balance: number
  created_at: number
  updated_at: number
  last_opened_at: number
  completed_at: number | null
  start_time: number | null
  end_time: number | null
  tz: string | null
  risk_per_trade: number | null
  trade_window: string | null
  source: string
  contract_size?: number | null
}

export interface TradeRow {
  session_id: number
  id: string
  position_id: string
  type: string
  action: string
  open_time: number
  close_time: number
  open_price: number
  close_price: number
  lot_size: number
  profit: number
  commission: number
  notes: string | null
  tags_json: string | null
  symbol: string | null
  swap_total: number
  close_reason: string | null
  sl_at_close: number | null
  tp_at_close: number | null
  r_multiple: number | null
  initial_risk_amount: number | null
  ticket_number: number | null
  strategy_name: string | null
  entry_reason: string | null
  open_local: string | null
  close_local: string | null
  tz: string | null
}

export interface DatasetRow {
  id: number
  symbol: string
  timeframe: string
  timezone: string
  first_time: number
  last_time: number
  candle_count: number
  kind: string
  market: string
  source: string
}

export interface TradeRecord {
  uid: string
  sessionId: number
  sessionName: string
  id: string
  symbol: string
  direction: 'long' | 'short'
  type: string
  action: string
  openTime: number
  closeTime: number
  openTimeIso: string
  closeTimeIso: string
  openTimeLocal: string
  closeTimeLocal: string
  holdingMinutes: number
  openPrice: number
  closePrice: number
  /** 平仓那一刻的止损 / 止盈价；移动过止损时不是初始价 */
  slAtClose: number | null
  tpAtClose: number | null
  lotSize: number
  contractSize: number
  profit: number
  commission: number
  swapTotal: number
  netProfit: number
  /** 应用里存下来的 R；注意：移动过止损的单，它是按「平仓时的止损」算的，不是初始风险 */
  rMultiple: number | null
  /** 按会话设定的单笔风险（默认 $100）折算的 R，跨单可比 */
  rOnRiskTarget: number
  riskTargetUsd: number
  /** 初始止损价；只有「止损没有被移动」的 sl/tp 单才能可靠还原 */
  initialSlPrice: number | null
  /** 初始风险美元；同上，未知时为 null */
  initialRiskUsd: number | null
  /** initial_stop = 止损在开仓价亏损侧且以 sl/tp 结束，可当初始止损；moved_stop = 已被移动 */
  riskBasis: 'initial_stop' | 'moved_stop' | 'unknown'
  stopMoved: boolean
  plannedRR: number | null
  closeReason: string
  tags: string[]
  notes: string | null
  entryReason: string | null
  strategyName: string | null
  ticketNumber: number | null
  sessionTimezone: string
  openHour: number
  openWeekday: number
  openDay: string
}

export interface SessionSummary {
  id: number
  name: string
  datasetId: number
  symbol: string | null
  datasetTimeframe: string | null
  timezone: string
  startTime: number | null
  endTime: number | null
  startIso: string | null
  endIso: string | null
  createdAt: number
  completedAt: number | null
  initialBalance: number
  balance: number
  netPnl: number
  returnPct: number
  tradeCount: number
  wins: number
  losses: number
  breakeven: number
  winRate: number
  grossProfit: number
  grossLoss: number
  profitFactor: number | null
  expectancyUsd: number
  avgWin: number
  avgLoss: number
  payoff: number | null
  avgR: number
  maxDrawdown: number
  bestTrade: number | null
  worstTrade: number | null
  riskPerTrade: number
  tradeWindow: string | null
  source: string
}

export interface FeatureSnapshot {
  index: number
  time: number
  timeIso: string
  close: number
  ema20: number | null
  ema50: number | null
  ema200: number | null
  atr14: number | null
  rsi14: number | null
  hi20: number | null
  lo20: number | null
  rangePos20: number | null
  ema20Slope10Atr: number | null
  distEma20Atr: number | null
  distEma50Atr: number | null
  atrPct: number | null
  atrPercentile: number | null
  momentum15: number | null
  momentum60: number | null
  trendStack: 'bull' | 'bear' | 'mixed'
}

export interface ContextSeries {
  timeframe: McpTimeframe
  barSeconds: number
  entryBarTime: number
  entryBarIso: string
  exitBarTime: number
  exitBarIso: string
  entryBarIndex: number
  bars: Array<Bar & { timeIso: string }>
  features: FeatureSnapshot | null
  directionAligned: boolean | null
}

export interface ExcursionStats {
  mfePrice: number
  maePrice: number
  mfeR: number
  maeR: number
  mfeAt: number | null
  maeAt: number | null
  mfeAtIso: string | null
  maeAtIso: string | null
  timeToMfeMinutes: number | null
  timeToMaeMinutes: number | null
  mfe15R: number | null
  mfe30R: number | null
  mfe60R: number | null
  mae15R: number | null
  mae30R: number | null
  mae60R: number | null
  captureRatio: number | null
}

export interface TradeContext {
  trade: TradeRecord
  session: {
    id: number
    name: string
    timezone: string
    riskPerTrade: number
    startTime: number | null
    endTime: number | null
  }
  dataset: {
    id: number
    symbol: string
    timeframe: string
    firstTime: number
    lastTime: number
    candleCount: number
  }
  series: Partial<Record<McpTimeframe, ContextSeries>>
  excursions: ExcursionStats | null
  featuresAtEntry: Partial<Record<McpTimeframe, FeatureSnapshot | null>>
}

// ---------- 基础读取 ----------

function trainingDb(): ReturnType<typeof getTrainingDb> {
  return getTrainingDb()
}

function marketDb(): ReturnType<typeof getMarketDb> {
  return getMarketDb()
}

export function loadSessions(): SessionRow[] {
  return trainingDb()
    .prepare('SELECT * FROM sessions ORDER BY last_opened_at DESC')
    .all() as SessionRow[]
}

export function loadDatasets(): Map<number, DatasetRow> {
  const rows = marketDb()
    .prepare('SELECT * FROM datasets ORDER BY id')
    .all() as DatasetRow[]
  return new Map(rows.map((r) => [r.id, r]))
}

export function loadDataset(datasetId: number): DatasetRow | null {
  return (
    (marketDb().prepare('SELECT * FROM datasets WHERE id = ?').get(datasetId) as
      | DatasetRow
      | undefined) ?? null
  )
}

export function loadTradeRows(sessionId?: number): TradeRow[] {
  if (sessionId != null) {
    return trainingDb()
      .prepare('SELECT * FROM closed_trades WHERE session_id = ? ORDER BY open_time ASC')
      .all(sessionId) as TradeRow[]
  }
  return trainingDb()
    .prepare('SELECT * FROM closed_trades ORDER BY session_id, open_time ASC')
    .all() as TradeRow[]
}

export function loadTrade(sessionId: number, tradeId: string): TradeRow | null {
  return (
    (trainingDb()
      .prepare('SELECT * FROM closed_trades WHERE session_id = ? AND id = ?')
      .get(sessionId, tradeId) as TradeRow | undefined) ?? null
  )
}

// ---------- 订单归一化 ----------

function parseTags(json: string | null): string[] {
  if (!json) return []
  try {
    const arr = JSON.parse(json)
    return Array.isArray(arr) ? arr.map(String).filter(Boolean) : []
  } catch {
    return []
  }
}

/** 止损是否已经被移到开仓价的盈利侧（移动止盈） */
function isStopOnProfitSide(type: string, open: number, sl: number | null): boolean {
  if (sl == null || !Number.isFinite(sl)) return false
  return type === 'buy' ? sl > open : sl < open
}

/**
 * 把数据库行变成给 AI 看的统一订单对象。
 *
 * 关键坑：closed_trades.r_multiple 是「盈亏 / 平仓时止损距离」。
 * 对于移动过止损的单（trail / 部分 tp/manual），分母早就不是初始风险，
 * 这个 R 会严重失真。这里同时给出 rOnRiskTarget（按会话风险预算），
 * 并且只在「止损仍在亏损侧、且以 sl/tp 结束」时还原 initialRiskUsd。
 */
export function normalizeTrade(
  row: TradeRow,
  session: SessionRow,
  dataset: DatasetRow | null
): TradeRecord {
  const tz = normalizeTimezone(session.tz ?? row.tz ?? loadSettings().timezone)
  const parts = tzPartsFromSec(row.open_time, tz)
  const contractSize = getContractSize(row.symbol ?? dataset?.symbol ?? 'XAUUSD')
  const riskTarget = Number(session.risk_per_trade) > 0 ? Number(session.risk_per_trade) : 100
  const stopMoved =
    row.close_reason === 'trail' || isStopOnProfitSide(row.type, row.open_price, row.sl_at_close)
  const canTrustStop =
    !stopMoved &&
    (row.close_reason === 'sl' || row.close_reason === 'tp') &&
    row.sl_at_close != null &&
    Number.isFinite(row.sl_at_close)
  const initialRiskUsd = canTrustStop
    ? Math.abs(row.open_price - (row.sl_at_close as number)) * row.lot_size * contractSize
    : null
  const riskBasis: TradeRecord['riskBasis'] = canTrustStop
    ? 'initial_stop'
    : stopMoved
      ? 'moved_stop'
      : 'unknown'
  const plannedRR =
    canTrustStop && row.tp_at_close != null && initialRiskUsd != null && initialRiskUsd > 0
      ? (Math.abs(row.tp_at_close - row.open_price) * row.lot_size * contractSize) / initialRiskUsd
      : null

  return {
    uid: `${row.session_id}:${row.id}`,
    sessionId: row.session_id,
    sessionName: session.name,
    id: row.id,
    symbol: row.symbol ?? dataset?.symbol ?? '',
    direction: row.type === 'buy' ? 'long' : 'short',
    type: row.type,
    action: row.action,
    openTime: row.open_time * 1000,
    closeTime: row.close_time * 1000,
    openTimeIso: new Date(row.open_time * 1000).toISOString(),
    closeTimeIso: new Date(row.close_time * 1000).toISOString(),
    openTimeLocal: row.open_local ?? fmtTzDateTime(row.open_time, tz),
    closeTimeLocal: row.close_local ?? fmtTzDateTime(row.close_time, tz),
    holdingMinutes: Math.max(0, (row.close_time - row.open_time) / 60),
    openPrice: row.open_price,
    closePrice: row.close_price,
    slAtClose: row.sl_at_close,
    tpAtClose: row.tp_at_close,
    lotSize: row.lot_size,
    contractSize,
    profit: row.profit,
    commission: row.commission,
    swapTotal: row.swap_total ?? 0,
    netProfit: row.profit,
    rMultiple: row.r_multiple,
    rOnRiskTarget: row.profit / riskTarget,
    riskTargetUsd: riskTarget,
    initialSlPrice: canTrustStop ? row.sl_at_close : null,
    initialRiskUsd,
    riskBasis,
    stopMoved,
    plannedRR,
    closeReason: row.close_reason ?? 'unknown',
    tags: parseTags(row.tags_json),
    notes: row.notes,
    entryReason: row.entry_reason,
    strategyName: row.strategy_name,
    ticketNumber: row.ticket_number,
    sessionTimezone: tz,
    openHour: parts.hour,
    openWeekday: parts.weekday,
    openDay: `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
  }
}

// ---------- 汇总 ----------

function finiteOrNull(v: number | null | undefined): number | null {
  return v != null && Number.isFinite(v) ? v : null
}

export function summarizeTrades(trades: TradeRecord[]): {
  tradeCount: number
  wins: number
  losses: number
  breakeven: number
  winRate: number
  netPnl: number
  grossProfit: number
  grossLoss: number
  profitFactor: number | null
  expectancyUsd: number
  avgWin: number
  avgLoss: number
  payoff: number | null
  avgR: number
  maxDrawdown: number
  bestTrade: number | null
  worstTrade: number | null
} {
  const wins = trades.filter((t) => t.profit > 0)
  const losses = trades.filter((t) => t.profit < 0)
  const grossProfit = wins.reduce((s, t) => s + t.profit, 0)
  const grossLoss = losses.reduce((s, t) => s + t.profit, 0)
  const netPnl = trades.reduce((s, t) => s + t.profit, 0)
  const avgWin = wins.length > 0 ? grossProfit / wins.length : 0
  const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0
  const payoff = avgLoss !== 0 ? avgWin / Math.abs(avgLoss) : null

  // 最大回撤：按平仓时间累加已实现盈亏，只看权益曲线
  const ordered = [...trades].sort((a, b) => a.closeTime - b.closeTime)
  let cum = 0
  let peak = 0
  let maxDd = 0
  for (const t of ordered) {
    cum += t.profit
    if (cum > peak) peak = cum
    if (peak - cum > maxDd) maxDd = peak - cum
  }

  return {
    tradeCount: trades.length,
    wins: wins.length,
    losses: losses.length,
    breakeven: trades.length - wins.length - losses.length,
    winRate: trades.length > 0 ? wins.length / trades.length : 0,
    netPnl,
    grossProfit,
    grossLoss,
    profitFactor: grossLoss !== 0 ? grossProfit / Math.abs(grossLoss) : null,
    expectancyUsd: trades.length > 0 ? netPnl / trades.length : 0,
    avgWin,
    avgLoss,
    payoff,
    avgR:
      trades.length > 0 ? trades.reduce((s, t) => s + t.rOnRiskTarget, 0) / trades.length : 0,
    maxDrawdown: maxDd,
    bestTrade: trades.length > 0 ? Math.max(...trades.map((t) => t.profit)) : null,
    worstTrade: trades.length > 0 ? Math.min(...trades.map((t) => t.profit)) : null
  }
}

export function listSessionSummaries(includeEmpty = true): SessionSummary[] {
  const sessions = loadSessions()
  const datasets = loadDatasets()
  const allTrades = loadTradeRows()
  const bySession = new Map<number, TradeRecord[]>()
  for (const row of allTrades) {
    const session = sessions.find((s) => s.id === row.session_id)
    if (!session) continue
    const out = bySession.get(row.session_id) ?? []
    out.push(normalizeTrade(row, session, datasets.get(session.dataset_id) ?? null))
    bySession.set(row.session_id, out)
  }

  return sessions
    .filter((s) => includeEmpty || (bySession.get(s.id)?.length ?? 0) > 0)
    .map((s) => {
      const ds = datasets.get(s.dataset_id) ?? null
      const trades = bySession.get(s.id) ?? []
      const sum = summarizeTrades(trades)
      return {
        id: s.id,
        name: s.name,
        datasetId: s.dataset_id,
        symbol: ds?.symbol ?? trades[0]?.symbol ?? null,
        datasetTimeframe: ds?.timeframe ?? null,
        timezone: normalizeTimezone(s.tz ?? loadSettings().timezone),
        startTime: s.start_time,
        endTime: s.end_time,
        startIso: s.start_time != null ? new Date(s.start_time * 1000).toISOString() : null,
        endIso: s.end_time != null ? new Date(s.end_time * 1000).toISOString() : null,
        createdAt: s.created_at,
        completedAt: s.completed_at,
        initialBalance: s.initial_balance,
        balance: s.balance,
        netPnl: sum.netPnl,
        returnPct: s.initial_balance > 0 ? (sum.netPnl / s.initial_balance) * 100 : 0,
        tradeCount: sum.tradeCount,
        wins: sum.wins,
        losses: sum.losses,
        breakeven: sum.breakeven,
        winRate: sum.winRate,
        grossProfit: sum.grossProfit,
        grossLoss: sum.grossLoss,
        profitFactor: sum.profitFactor,
        expectancyUsd: sum.expectancyUsd,
        avgWin: sum.avgWin,
        avgLoss: sum.avgLoss,
        payoff: sum.payoff,
        avgR: sum.avgR,
        maxDrawdown: sum.maxDrawdown,
        bestTrade: sum.bestTrade,
        worstTrade: sum.worstTrade,
        riskPerTrade: Number(s.risk_per_trade) > 0 ? Number(s.risk_per_trade) : 100,
        tradeWindow: s.trade_window,
        source: s.source
      }
    })
}

export interface ListTradesOptions {
  sessionId?: number
  sessionIds?: number[]
  outcome?: 'all' | 'win' | 'loss' | 'breakeven'
  symbol?: string
  from?: number
  to?: number
  limit?: number
  offset?: number
  order?: 'asc' | 'desc'
}

export function listTrades(opts: ListTradesOptions = {}): {
  total: number
  offset: number
  limit: number
  trades: TradeRecord[]
} {
  const sessions = loadSessions()
  const sessionMap = new Map(sessions.map((s) => [s.id, s]))
  const datasets = loadDatasets()
  const ids =
    opts.sessionIds && opts.sessionIds.length > 0
      ? new Set(opts.sessionIds)
      : opts.sessionId != null
        ? new Set([opts.sessionId])
        : null

  let trades: TradeRecord[] = []
  for (const row of loadTradeRows()) {
    if (ids && !ids.has(row.session_id)) continue
    const session = sessionMap.get(row.session_id)
    if (!session) continue
    trades.push(normalizeTrade(row, session, datasets.get(session.dataset_id) ?? null))
  }

  if (opts.outcome && opts.outcome !== 'all') {
    trades = trades.filter((t) =>
      opts.outcome === 'win'
        ? t.profit > 0
        : opts.outcome === 'loss'
          ? t.profit < 0
          : t.profit === 0
    )
  }
  if (opts.symbol) {
    const s = opts.symbol.toUpperCase()
    trades = trades.filter((t) => t.symbol.toUpperCase() === s)
  }
  if (opts.from != null) trades = trades.filter((t) => t.openTime >= opts.from! * 1000)
  if (opts.to != null) trades = trades.filter((t) => t.openTime <= opts.to! * 1000)

  trades.sort((a, b) =>
    opts.order === 'desc' ? b.openTime - a.openTime : a.openTime - b.openTime
  )
  const total = trades.length
  const offset = Math.max(0, Math.floor(opts.offset ?? 0))
  const limit = Math.max(1, Math.min(1000, Math.floor(opts.limit ?? 200)))
  return { total, offset, limit, trades: trades.slice(offset, offset + limit) }
}

// ---------- K 线与指标 ----------

function loadM1(datasetId: number, fromSec: number, toSec: number): Bar[] {
  const rows = marketDb()
    .prepare(
      `SELECT time, open, high, low, close, volume
         FROM candles
        WHERE dataset_id = ? AND time >= ? AND time <= ?
        ORDER BY time`
    )
    .all(datasetId, Math.floor(fromSec), Math.floor(toSec)) as Bar[]
  return rows
}

function ema(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN)
  if (values.length === 0) return out
  const a = 2 / (period + 1)
  out[0] = values[0]
  for (let i = 1; i < values.length; i++) out[i] = a * values[i] + (1 - a) * out[i - 1]
  return out
}

function wilder(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN)
  if (values.length < period) return out
  let seed = 0
  for (let i = 0; i < period; i++) seed += values[i]
  out[period - 1] = seed / period
  for (let i = period; i < values.length; i++) {
    out[i] = (out[i - 1] * (period - 1) + values[i]) / period
  }
  return out
}

function atr(bars: Bar[], period = 14): number[] {
  const tr = new Array<number>(bars.length).fill(NaN)
  for (let i = 0; i < bars.length; i++) {
    const prev = i > 0 ? bars[i - 1].close : bars[i].open
    tr[i] = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - prev),
      Math.abs(bars[i].low - prev)
    )
  }
  return wilder(tr, period)
}

function rsi(values: number[], period = 14): number[] {
  const up = new Array<number>(values.length).fill(0)
  const down = new Array<number>(values.length).fill(0)
  for (let i = 1; i < values.length; i++) {
    const d = values[i] - values[i - 1]
    if (d > 0) up[i] = d
    else down[i] = -d
  }
  const au = wilder(up, period)
  const ad = wilder(down, period)
  return values.map((_, i) => {
    if (!Number.isFinite(au[i]) || !Number.isFinite(ad[i])) return NaN
    if (ad[i] === 0) return 100
    return 100 - 100 / (1 + au[i] / ad[i])
  })
}

function percentileRank(values: number[], value: number): number | null {
  const finite = values.filter((v) => Number.isFinite(v))
  if (finite.length === 0 || !Number.isFinite(value)) return null
  return finite.filter((v) => v <= value).length / finite.length
}

function snapshotAt(bars: Bar[], idx: number): FeatureSnapshot | null {
  if (idx < 0 || idx >= bars.length || bars.length < 20) return null
  const close = bars.map((b) => b.close)
  const e20 = ema(close, 20)
  const e50 = ema(close, 50)
  const e200 = ema(close, 200)
  const a14 = atr(bars, 14)
  const r14 = rsi(close, 14)
  const n = 20
  const start = Math.max(0, idx - n + 1)
  let hi = -Infinity
  let lo = Infinity
  for (let i = start; i <= idx; i++) {
    if (bars[i].high > hi) hi = bars[i].high
    if (bars[i].low < lo) lo = bars[i].low
  }
  const range = hi - lo
  const a = a14[idx]
  const num = (v: number): number | null => (Number.isFinite(v) ? v : null)
  const stack: FeatureSnapshot['trendStack'] =
    Number.isFinite(e20[idx]) && Number.isFinite(e50[idx])
      ? close[idx] > e20[idx] && e20[idx] > e50[idx]
        ? 'bull'
        : close[idx] < e20[idx] && e20[idx] < e50[idx]
          ? 'bear'
          : 'mixed'
      : 'mixed'

  return {
    index: idx,
    time: bars[idx].time,
    timeIso: new Date(bars[idx].time * 1000).toISOString(),
    close: close[idx],
    ema20: num(e20[idx]),
    ema50: num(e50[idx]),
    ema200: num(e200[idx]),
    atr14: num(a),
    rsi14: num(r14[idx]),
    hi20: hi,
    lo20: lo,
    rangePos20: range > 0 ? (close[idx] - lo) / range : null,
    ema20Slope10Atr:
      idx >= 10 && Number.isFinite(a) && a > 0 ? (e20[idx] - e20[idx - 10]) / a : null,
    distEma20Atr: Number.isFinite(a) && a > 0 ? (close[idx] - e20[idx]) / a : null,
    distEma50Atr: Number.isFinite(a) && a > 0 ? (close[idx] - e50[idx]) / a : null,
    atrPct: Number.isFinite(a) && close[idx] > 0 ? a / close[idx] : null,
    atrPercentile: percentileRank(a14.slice(Math.max(0, idx - 200), idx + 1), a),
    momentum15: idx >= 15 ? close[idx] / close[idx - 15] - 1 : null,
    momentum60: idx >= 60 ? close[idx] / close[idx - 60] - 1 : null,
    trendStack: stack
  }
}

function mapBars(bars: Bar[]): Array<Bar & { timeIso: string }> {
  return bars.map((b) => ({ ...b, timeIso: new Date(b.time * 1000).toISOString() }))
}

function directionAligned(trade: TradeRecord, snap: FeatureSnapshot | null): boolean | null {
  if (!snap) return null
  if (trade.direction === 'long') return snap.trendStack === 'bull'
  return snap.trendStack === 'bear'
}

export interface GetContextOptions {
  timeframes?: McpTimeframe[]
  beforeBars?: number
  afterBars?: number
  includeBars?: boolean
  /** 指标预热根数，默认 260；想省内存可以调小，但 EMA200 会变 null */
  indicatorLookback?: number
}

function computeExcursions(
  trade: TradeRecord,
  datasetId: number,
  lastDataTime: number
): ExcursionStats | null {
  const entrySec = Math.floor(trade.openTime / 1000)
  const closeSec = Math.min(Math.floor(trade.closeTime / 1000), lastDataTime)
  if (closeSec < entrySec) return null
  const path = loadM1(datasetId, entrySec, closeSec)
  if (path.length === 0) return null

  const long = trade.direction === 'long'
  let mfe = -Infinity
  let mae = -Infinity
  let mfeAt: number | null = null
  let maeAt: number | null = null
  const notional = trade.lotSize * trade.contractSize
  const risk = trade.riskTargetUsd
  const rOf = (priceMove: number): number => (priceMove * notional) / risk

  const mfeAtTime = new Map<number, number>()
  const maeAtTime = new Map<number, number>()
  for (const b of path) {
    const fav = long ? b.high - trade.openPrice : trade.openPrice - b.low
    const adv = long ? trade.openPrice - b.low : b.high - trade.openPrice
    if (fav > mfe) {
      mfe = fav
      mfeAt = b.time
    }
    if (adv > mae) {
      mae = adv
      maeAt = b.time
    }
    mfeAtTime.set(b.time, Math.max(0, fav))
    maeAtTime.set(b.time, Math.max(0, adv))
  }

  const windowMax = (mins: number, map: Map<number, number>): number | null => {
    const cutoff = entrySec + mins * 60
    let best = -Infinity
    for (const [t, v] of map) {
      if (t <= cutoff && v > best) best = v
    }
    return Number.isFinite(best) ? rOf(best) : null
  }

  const iso = (sec: number | null): string | null =>
    sec == null ? null : new Date(sec * 1000).toISOString()

  return {
    mfePrice: mfe,
    maePrice: mae,
    mfeR: rOf(mfe),
    maeR: rOf(mae),
    mfeAt,
    maeAt,
    mfeAtIso: iso(mfeAt),
    maeAtIso: iso(maeAt),
    timeToMfeMinutes: mfeAt != null ? (mfeAt - entrySec) / 60 : null,
    timeToMaeMinutes: maeAt != null ? (maeAt - entrySec) / 60 : null,
    mfe15R: windowMax(15, mfeAtTime),
    mfe30R: windowMax(30, mfeAtTime),
    mfe60R: windowMax(60, mfeAtTime),
    mae15R: windowMax(15, maeAtTime),
    mae30R: windowMax(30, maeAtTime),
    mae60R: windowMax(60, maeAtTime),
    captureRatio:
      trade.rOnRiskTarget != null && rOf(mfe) > 0 ? trade.rOnRiskTarget / rOf(mfe) : null
  }
}

export function getTradeContext(
  sessionId: number,
  tradeId: string,
  opts: GetContextOptions = {}
): TradeContext | null {
  const session = loadSessions().find((s) => s.id === sessionId)
  if (!session) return null
  const row = loadTrade(sessionId, tradeId)
  if (!row) return null
  const dataset = loadDataset(session.dataset_id)
  if (!dataset) return null
  const trade = normalizeTrade(row, session, dataset)
  const timeframes = opts.timeframes?.length ? opts.timeframes : (['M30', 'M5', 'M1'] as McpTimeframe[])
  const beforeBars = Math.max(5, Math.min(500, Math.floor(opts.beforeBars ?? 120)))
  const afterBars = Math.max(0, Math.min(500, Math.floor(opts.afterBars ?? 60)))
  const includeBars = opts.includeBars !== false
  const lookback = Math.max(60, Math.min(400, Math.floor(opts.indicatorLookback ?? 260)))
  const entrySec = Math.floor(trade.openTime / 1000)
  const closeSec = Math.floor(trade.closeTime / 1000)

  const series: Partial<Record<McpTimeframe, ContextSeries>> = {}
  const featuresAtEntry: Partial<Record<McpTimeframe, FeatureSnapshot | null>> = {}

  for (const tf of timeframes) {
    if (!MCP_TIMEFRAMES.includes(tf)) continue
    const barSec = timeframeSeconds(tf)
    if (!(barSec > 0)) continue
    const fromSec = entrySec - (lookback + beforeBars) * barSec
    const toSec = closeSec + afterBars * barSec
    const raw = loadM1(dataset.id, bucketStart(fromSec, tf), toSec)
    if (raw.length === 0) continue
    const bars = tf === 'M1' ? raw : aggregateBars(raw, tf)
    const entryIdx = indexAtTime(bars, entrySec)
    if (entryIdx < 0) continue
    const snap = snapshotAt(bars, entryIdx)
    featuresAtEntry[tf] = snap
    const startIdx = Math.max(0, entryIdx - beforeBars + 1)
    const outBars = includeBars ? bars.slice(startIdx) : []
    series[tf] = {
      timeframe: tf,
      barSeconds: barSec,
      entryBarTime: bars[entryIdx].time,
      entryBarIso: new Date(bars[entryIdx].time * 1000).toISOString(),
      exitBarTime: bucketStart(closeSec, tf),
      exitBarIso: new Date(bucketStart(closeSec, tf) * 1000).toISOString(),
      entryBarIndex: entryIdx - startIdx,
      bars: mapBars(outBars),
      features: snap,
      directionAligned: directionAligned(trade, snap)
    }
  }

  const excursions = computeExcursions(trade, dataset.id, dataset.last_time)

  return {
    trade,
    session: {
      id: session.id,
      name: session.name,
      timezone: normalizeTimezone(session.tz ?? loadSettings().timezone),
      riskPerTrade: Number(session.risk_per_trade) > 0 ? Number(session.risk_per_trade) : 100,
      startTime: session.start_time,
      endTime: session.end_time
    },
    dataset: {
      id: dataset.id,
      symbol: dataset.symbol,
      timeframe: dataset.timeframe,
      firstTime: dataset.first_time,
      lastTime: dataset.last_time,
      candleCount: dataset.candle_count
    },
    series,
    excursions,
    featuresAtEntry
  }
}

export interface GetCandlesOptions {
  datasetId?: number
  symbol?: string
  timeframe: McpTimeframe
  from: number
  to: number
  limit?: number
}

export function getCandles(opts: GetCandlesOptions): {
  datasetId: number
  symbol: string
  timeframe: McpTimeframe
  from: number
  to: number
  count: number
  truncated: boolean
  bars: Array<Bar & { timeIso: string }>
} | null {
  const datasets = [...loadDatasets().values()]
  let dataset: DatasetRow | undefined
  if (opts.datasetId != null) dataset = datasets.find((d) => d.id === opts.datasetId)
  else if (opts.symbol) {
    const s = opts.symbol.toUpperCase()
    dataset = datasets
      .filter((d) => d.symbol.toUpperCase() === s && d.kind === 'bar')
      .sort((a, b) => b.candle_count - a.candle_count)[0]
  }
  if (!dataset) return null

  const tf = opts.timeframe
  const barSec = timeframeSeconds(tf)
  if (!(barSec > 0)) return null
  const limit = Math.max(1, Math.min(5000, Math.floor(opts.limit ?? 500)))
  const fromSec = Math.floor(opts.from)
  const toSec = Math.floor(opts.to)

  let bars: Bar[]
  if (dataset.timeframe === tf) {
    bars = loadM1(dataset.id, fromSec, toSec)
  } else {
    const raw = loadM1(dataset.id, bucketStart(fromSec, tf), toSec)
    bars = tf === 'M1' ? raw : aggregateBars(raw, tf)
  }
  const filtered = bars.filter((b) => b.time >= fromSec - barSec && b.time <= toSec)
  const truncated = filtered.length > limit
  const out = truncated ? filtered.slice(-limit) : filtered
  return {
    datasetId: dataset.id,
    symbol: dataset.symbol,
    timeframe: tf,
    from: fromSec,
    to: toSec,
    count: out.length,
    truncated,
    bars: mapBars(out)
  }
}

// ---------- 分组统计 ----------

export interface GroupStat {
  key: string
  label: string
  tradeCount: number
  wins: number
  winRate: number
  netPnl: number
  avgPnl: number
  avgR: number
  profitFactor: number | null
  medianHoldingMinutes: number
}

function holdingBucket(min: number): string {
  if (min <= 15) return '<=15m'
  if (min <= 30) return '15-30m'
  if (min <= 60) return '30-60m'
  if (min <= 120) return '1-2h'
  if (min <= 240) return '2-4h'
  if (min <= 480) return '4-8h'
  return '>8h'
}

function rBucket(r: number): string {
  if (r <= -1.5) return '<-1.5R'
  if (r < -0.5) return '-1.5~-0.5R'
  if (r < 0.5) return '-0.5~0.5R'
  if (r < 1.5) return '0.5~1.5R'
  if (r < 3) return '1.5~3R'
  if (r < 5) return '3~5R'
  return '>5R'
}

function rrBucket(rr: number | null): string {
  if (rr == null) return 'unknown'
  if (rr < 1.5) return '<1.5R'
  if (rr < 2) return '1.5-2R'
  if (rr < 3) return '2-3R'
  if (rr < 5) return '3-5R'
  return '>=5R'
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export interface AnalyzeResult {
  generatedAt: string
  scope: {
    sessionIds: number[] | null
    outcome: string
    tradeCount: number
  }
  overall: ReturnType<typeof summarizeTrades>
  groups: {
    bySession: GroupStat[]
    byDirection: GroupStat[]
    byCloseReason: GroupStat[]
    byHour: GroupStat[]
    byWeekday: GroupStat[]
    byHolding: GroupStat[]
    byRiskTargetR: GroupStat[]
    byPlannedRR: GroupStat[]
    byM30Trend: GroupStat[]
    byM30RangePosition: GroupStat[]
    byEarlyMFE: GroupStat[]
  }
  drivers: Array<{
    dimension: string
    key: string
    tradeCount: number
    winRate: number
    avgR: number
    netPnl: number
    edgeVsOverallR: number
  }>
  excursions: {
    medianMfeR: number | null
    medianMaeR: number | null
    medianTimeToMfeMinutes: number | null
    medianMfe30R: number | null
  }
  dataQuality: {
    reliableInitialRiskTrades: number
    movedStopTrades: number
    unknownRiskTrades: number
    note: string
  }
}

export function analyzeTrades(opts: {
  sessionIds?: number[]
  outcome?: 'all' | 'win' | 'loss'
  maxTrades?: number
} = {}): AnalyzeResult {
  const { total, trades } = listTrades({
    sessionIds: opts.sessionIds,
    outcome: opts.outcome ?? 'all',
    limit: Math.min(1000, opts.maxTrades ?? 500),
    order: 'asc'
  })
  const withContext = trades.map((t) => {
    const ctx = getTradeContext(t.sessionId, t.id, {
      timeframes: ['M30', 'M1'],
      beforeBars: 60,
      afterBars: 2,
      includeBars: false
    })
    return {
      t,
      m30: ctx?.featuresAtEntry.M30 ?? null,
      exc: ctx?.excursions ?? null
    }
  })

  const trendKey = (t: TradeRecord, m30: FeatureSnapshot | null): string => {
    if (!m30) return 'unknown'
    const aligned = t.direction === 'long' ? m30.trendStack === 'bull' : m30.trendStack === 'bear'
    const opposed = t.direction === 'long' ? m30.trendStack === 'bear' : m30.trendStack === 'bull'
    return aligned ? 'with-trend' : opposed ? 'counter-trend' : 'mixed'
  }
  const rangeKey = (t: TradeRecord, m30: FeatureSnapshot | null): string => {
    if (!m30 || m30.rangePos20 == null) return 'unknown'
    // 必须按方向调整：1 = 多头在区间上沿 / 空头在区间下沿，和报告里的 dir_pos 同口径
    const r = t.direction === 'long' ? m30.rangePos20 : 1 - m30.rangePos20
    return r < 0.2 ? '0-20%' : r < 0.4 ? '20-40%' : r < 0.6 ? '40-60%' : r < 0.8 ? '60-80%' : '80-100%'
  }
  const mfeKey = (exc: ExcursionStats | null): string => {
    if (!exc || exc.mfe30R == null) return 'unknown'
    const m = exc.mfe30R
    return m < 0.25 ? '<0.25R' : m < 0.5 ? '0.25-0.5R' : m < 0.75 ? '0.5-0.75R' : m < 1.25 ? '0.75-1.25R' : '>=1.25R'
  }

  // 带 M30 / 早段 MFE 的分组用这套手写聚合，避免把上下文塞进 TradeRecord
  const groupWith = (
    keyFn: (t: TradeRecord, m30: FeatureSnapshot | null, exc: ExcursionStats | null) => string
  ): GroupStat[] => {
    const map = new Map<string, TradeRecord[]>()
    for (const x of withContext) {
      const k = keyFn(x.t, x.m30, x.exc)
      const arr = map.get(k) ?? []
      arr.push(x.t)
      map.set(k, arr)
    }
    return [...map.entries()]
      .map(([key, arr]) => {
        const sum = summarizeTrades(arr)
        const durations = arr.map((t) => t.holdingMinutes).sort((a, b) => a - b)
        return {
          key,
          label: key,
          tradeCount: sum.tradeCount,
          wins: sum.wins,
          winRate: sum.winRate,
          netPnl: sum.netPnl,
          avgPnl: sum.expectancyUsd,
          avgR: sum.avgR,
          profitFactor: sum.profitFactor,
          medianHoldingMinutes:
            durations.length > 0 ? durations[Math.floor(durations.length / 2)] : 0
        }
      })
      .sort((a, b) => b.netPnl - a.netPnl)
  }
  const grouped = (keyFn: (t: TradeRecord) => string): GroupStat[] =>
    groupWith((t) => keyFn(t))

  const overall = summarizeTrades(trades)
  const groups = {
    bySession: grouped((t) => String(t.sessionId)),
    byDirection: grouped((t) => t.direction),
    byCloseReason: grouped((t) => t.closeReason),
    byHour: grouped((t) => String(t.openHour).padStart(2, '0') + ':00'),
    byWeekday: grouped((t) => WEEKDAYS[t.openWeekday] ?? String(t.openWeekday)),
    byHolding: grouped((t) => holdingBucket(t.holdingMinutes)),
    byRiskTargetR: grouped((t) => rBucket(t.rOnRiskTarget)),
    byPlannedRR: grouped((t) => rrBucket(t.plannedRR)),
    byM30Trend: groupWith((t, m30) => trendKey(t, m30)),
    byM30RangePosition: groupWith((t, m30) => rangeKey(t, m30)),
    byEarlyMFE: groupWith((_t, _m30, exc) => mfeKey(exc))
  }

  // 驱动因素：各分组里样本 >= 10 且与整体平均 R 偏差最大的项
  const drivers: AnalyzeResult['drivers'] = []
  const dims: Array<[string, GroupStat[]]> = [
    ['direction', groups.byDirection],
    ['closeReason', groups.byCloseReason],
    ['hour', groups.byHour],
    ['weekday', groups.byWeekday],
    ['holding', groups.byHolding],
    ['plannedRR', groups.byPlannedRR],
    ['m30Trend', groups.byM30Trend],
    ['m30RangePosition', groups.byM30RangePosition],
    ['earlyMFE', groups.byEarlyMFE]
  ]
  for (const [dimension, stats] of dims) {
    for (const g of stats) {
      if (g.tradeCount < 10) continue
      drivers.push({
        dimension,
        key: g.key,
        tradeCount: g.tradeCount,
        winRate: g.winRate,
        avgR: g.avgR,
        netPnl: g.netPnl,
        edgeVsOverallR: g.avgR - overall.avgR
      })
    }
  }
  drivers.sort((a, b) => b.edgeVsOverallR - a.edgeVsOverallR)

  const mfeVals = withContext
    .map((x) => x.exc?.mfeR)
    .filter((v): v is number => v != null && Number.isFinite(v))
  const maeVals = withContext
    .map((x) => x.exc?.maeR)
    .filter((v): v is number => v != null && Number.isFinite(v))
  const tMfeVals = withContext
    .map((x) => x.exc?.timeToMfeMinutes)
    .filter((v): v is number => v != null && Number.isFinite(v))
  const mfe30Vals = withContext
    .map((x) => x.exc?.mfe30R)
    .filter((v): v is number => v != null && Number.isFinite(v))
  const median = (arr: number[]): number | null => {
    if (arr.length === 0) return null
    const s = [...arr].sort((a, b) => a - b)
    return s[Math.floor(s.length / 2)]
  }

  return {
    generatedAt: new Date().toISOString(),
    scope: {
      sessionIds: opts.sessionIds ?? null,
      outcome: opts.outcome ?? 'all',
      tradeCount: total
    },
    overall,
    groups,
    drivers,
    excursions: {
      medianMfeR: median(mfeVals),
      medianMaeR: median(maeVals),
      medianTimeToMfeMinutes: median(tMfeVals),
      medianMfe30R: median(mfe30Vals)
    },
    dataQuality: {
      reliableInitialRiskTrades: trades.filter((t) => t.riskBasis === 'initial_stop').length,
      movedStopTrades: trades.filter((t) => t.riskBasis === 'moved_stop').length,
      unknownRiskTrades: trades.filter((t) => t.riskBasis === 'unknown').length,
      note:
        'rMultiple 来自「盈亏 / 平仓时止损距离」。移动过止损（trail、部分 tp/manual）的订单，' +
        '这个分母不是初始风险，R 会失真；跨单比较请用 rOnRiskTarget（按会话 risk_per_trade 折算）。'
    }
  }
}
