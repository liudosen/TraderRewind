// ============================================================
// TraderRewind — 训练（回放 + 下单）状态管理
//
// 数据流：数据库 1 分钟 K 线（rawBars） → 按所选周期聚合 → 逐根回放
// ============================================================

import { create } from 'zustand'
import { getContractSize, getContractSpec, getDigits } from '@shared/constants/catalog'
import { calcPnl, quoteUsdRate } from '@shared/utils/pnl'
import {
  aggregateBars,
  bucketStart,
  indexAtTime,
  isChartTimeframe,
  partialBucketBar,
  timeframeSeconds,
  type Bar
} from '@shared/utils/timeframe'
import type { DatasetRow } from './download-store'
import type { Drawing } from '@shared/types/drawing'
import {
  MAX_SUB_PANES,
  makeInstance,
  resolveParams,
  type IndicatorId,
  type IndicatorInstance,
  type IndicatorKind
} from '@shared/utils/indicators'
import { useTimezoneStore } from './timezone-store'
import {
  DEFAULT_INDICATOR_PREFS,
  normalizeIndicatorPrefs,
  type IndicatorPrefs
} from '@shared/types/indicator-prefs'
import {
  DEFAULT_TAG_LIBRARY,
  MAX_TRADE_TAGS,
  MAX_TRADE_TAG_LEN,
  normalizeTagLibrary,
  normalizeTags
} from '@shared/types/trade-tags'
import {
  fmtTradeWindow,
  inTradeWindow,
  normalizeTradeWindow,
  type TradeWindow
} from '@shared/types/trade-window'
import {
  DEFAULT_EXECUTION_COST,
  commissionPerSide,
  normalizeExecutionCost,
  slippagePrice,
  type ExecutionCost
} from '@shared/types/execution-cost'
import { fmtTzClock } from '@shared/types/timezone'

export { MAX_TRADE_TAGS, MAX_TRADE_TAG_LEN }
export type { TradeWindow }

export type { Bar }

export interface TrainingSession {
  id: number
  dataset_id: number
  name: string
  current_index: number
  speed: number
  initial_balance: number
  balance: number
  lot_size: number
  created_at: number
  updated_at: number
  last_opened_at: number
  start_time: number | null
  end_time: number | null
  display_timeframe: string | null
  current_bar_time: number | null
  /** 回测集完成时间（游标走到区间最后一根时写入） */
  completed_at: number | null
  /** 单笔风险（金额）：每笔盈亏 ÷ 它 = R */
  risk_per_trade: number | null
  /** 建会话时用的时区：从日志跳回来按它展示（旧会话为空） */
  tz: string | null
  /** 交易时段（'HH:mm-HH:mm'）：时段外禁止开仓；null = 全天不限 */
  trade_window: string | null
  drawings_json: string | null
  dataset_symbol?: string | null
  dataset_timeframe?: string | null
  dataset_bar_count?: number | null
}

export type Side = 'buy' | 'sell'
/**
 * 一笔成交是怎么结束的。
 * `partial` 是「减仓」：手上那笔没平干净，只结算掉了一部分手数。
 */
export type CloseReason = 'sl' | 'tp' | 'trail' | 'manual' | 'partial'

export interface Position {
  id: string
  side: Side
  symbol: string
  lot: number
  entryPrice: number
  entryTime: number
  sl: number | null
  tp: number | null
  digits: number
  contractSize: number
  /** 开仓时付的手续费（已从余额扣掉）；平仓算净盈亏时要再减一次平仓佣金 */
  entryCommission?: number
  /** 下单时填写的思路备注 */
  note: string | null
  /** 下单时打的标签（最多 MAX_TRADE_TAGS 个），随订单一起存进该回测集 */
  tags: string[]
}

export interface ClosedTrade {
  id: string
  side: Side
  symbol: string
  lot: number
  entryPrice: number
  exitPrice: number
  entryTime: number
  exitTime: number
  pnl: number
  reason: CloseReason
  sl: number | null
  tp: number | null
  digits: number
  /** 这笔单子的手续费（开仓 + 平仓，已含在 pnl 里）；旧数据没有 */
  commission?: number
  note: string | null
  /** 下单时打的标签（最多 MAX_TRADE_TAGS 个） */
  tags: string[]
  /** 下单时记录的时区（默认 UTC+8），旧数据可能为空 */
  tz?: string | null
  /** 下单时刻按记录时区算好的可读时间，例如 2025-12-03 09:31:00 */
  openLocal?: string | null
  /** 关单时刻按记录时区算好的可读时间 */
  closeLocal?: string | null
}

/** 解析 tags_json：数组或逗号分隔都能认，脏数据一律丢掉 */
export function parseTags(json: string | null | undefined): string[] {
  if (!json) return []
  try {
    const raw = JSON.parse(json)
    return normalizeTags(raw)
  } catch {
    return normalizeTags(String(json))
  }
}

/**
 * 当前允许图表显示到哪一根 K 线（含），全场唯一口径。
 *
 * 回放没走完时，游标之后的 K 线就是「未来」——任何定位（点订单、点报告、
 * 从日志跳回来…）都不许把它们露出来，否则训练就白打了。
 * 走到最后一根 / 已标记完成之后，整段都算已发生，随便看。
 */
export function revealIndexOf(bars: Bar[], cursor: number, completedAt: number | null): number {
  if (bars.length === 0) return -1
  if (completedAt != null) return bars.length - 1
  return Math.max(0, Math.min(cursor, bars.length - 1))
}

/**
 * 交叉盘换算用的汇率序列（报价货币 → 美元）。
 *
 * `direct = true` 表示数据源是正向直盘（GBPUSD），汇率 = 收盘价；
 * `false` 表示是反向直盘（USDJPY），汇率 = 1 / 收盘价。
 */
export interface CrossRateSeries {
  /** 提供数据的直盘品种，例如 GBPUSD / USDJPY */
  symbol: string
  /** 与 closes 一一对应的时间戳（秒） */
  times: number[]
  closes: number[]
  direct: boolean
}

/**
 * 走完一根显示周期的 K 线之后，「精确到分钟」的回放位置该落到哪。
 *
 * 一根 H1 走完 = 这一小时里最后一根 1 分钟 K 线（13:59），而不是桶起点 13:00 ——
 * 只有这样才能把「打到哪一分钟」记准，切回小周期时也不会倒退一整格。
 * 数据不够长（走到最后一段）时贴着最后一根，不越过已有行情。
 */
function bucketEndTime(bucket: number, tf: string, raw: Bar[]): number {
  const lastRaw = raw.length > 0 ? raw[raw.length - 1].time : bucket
  const sec = timeframeSeconds(tf)
  if (sec > 0) return Math.min(bucket + sec - 60, lastRaw)
  // 日历周期（W1/MN1/Q1/Y1）没有固定秒数：往后探到下一个桶的起点
  for (const probe of [86400, 8 * 86400, 32 * 86400, 93 * 86400, 367 * 86400]) {
    const next = bucketStart(bucket + probe, tf)
    if (next > bucket) return Math.min(next - 60, lastRaw)
  }
  return Math.min(bucket, lastRaw)
}

/**
 * 当前这根 K 线在 `cursorTime` 这个时刻是否「只走到一半」。
 *
 * 走到一半 → 返回截断版（只含已揭示的那些分钟），图表/价格/成交价都用它；
 * 已经走完（或没有游标时间）→ 返回 null，调用方直接用 `bars[cursor]`。
 */
function partialAt(
  rawBars: Bar[],
  tf: string,
  bar: Bar | undefined,
  cursorTime: number
): Bar | null {
  if (!bar || !(cursorTime > 0)) return null
  if (cursorTime >= bucketEndTime(bar.time, tf, rawBars)) return null
  return partialBucketBar(rawBars, tf, cursorTime)
}

/**
 * 「现在这个价」= 最后一根已揭示的 K 线的收盘价（大周期上要的是截断版那条）。
 *
 * 拖止损 / 止盈时所有夹取都以它为准：止损得留在现价的亏损侧、
 * 止盈得留在现价的盈利侧，否则拖出来的就是一张立刻会成交的废单。
 */
function currentClose(get: () => {
  bars: Bar[]
  cursor: number
  partialBar: Bar | null
}): number | null {
  const s = get()
  const bar = s.partialBar ?? s.bars[s.cursor]
  return bar && Number.isFinite(bar.close) ? bar.close : null
}

interface TrainingState {
  // 数据
  datasets: DatasetRow[]
  sessions: TrainingSession[]

  /**
   * 交叉盘的「报价货币 → 美元」汇率序列。
   *
   * 只有交易交叉盘（EURGBP/EURJPY/…）时才需要：盈亏长在报价货币上，
   * 折美元得乘汇率。本机如果下载了对应的美元直盘（GBPUSD / USDJPY），
   * 就用它的真实收盘价换算；没下载就退回内置参考汇率。
   * null = 当前品种不需要换算，或者没有可用数据。
   */
  crossRate: CrossRateSeries | null

  /** 当前会话 */
  activeSession: TrainingSession | null
  symbol: string
  timeframe: string
  digits: number
  /** 会话区间内的全部 1 分钟 K 线 */
  rawBars: Bar[]
  /** 聚合后的显示用 K 线 */
  bars: Bar[]
  /**
   * 当前这根「正在走」的 K 线，可能被截断到 `cursorTime` 为止。
   *
   * 显示周期比 1 分钟大时（比如 H1），`bars[cursor]` 是整根、含还没走到的分钟；
   * 图表的最后一根、价格卡、开仓/平仓的成交价都必须用这里 —— 否则等于提前看到了未来。
   * 桶已经走完时为 null，表示直接使用 `bars[cursor]`。
   */
  partialBar: Bar | null
  cursor: number
  /**
   * 精确到**分钟**的回放位置：最后一根已揭示的 1 分钟 K 线的时间。
   *
   * `cursor` 是「当前显示周期数组里的下标」，在 H4 上它只能定位到 4 小时一格的桶；
   * 真正记录「打到哪了」得靠这个时间戳 —— 落库、切周期锚定、截断当前这根 K 线都用它。
   */
  cursorTime: number
  /** 回测起点：新建会话时的初始游标，重置时回到这里 */
  initialCursor: number
  /**
   * 回测起点的时间戳（= 起点那根 K 线的 time）。
   *
   * `initialCursor` 是**当前显示周期**下的数组下标，切周期后数组长度就变了，
   * 旧下标会失效（切到 H1 时它会大于 bars.length，进度被算成 1/1）。
   * 所以另存一份时间：切周期时按时间重新定位下标，进度才不会崩。
   */
  initialTime: number

  // 回放
  playing: boolean
  barsPerSec: number

  // 交易
  initialBalance: number
  balance: number
  /** 单笔风险（金额）：报告里的 R 都以它为分母 */
  riskPerTrade: number
  lot: number
  /**
   * 当前持有的所有持仓（可以同时有多笔，也可以多空对冲）。
   *
   * 真实盘里「一次只让持一单」是训练器的简化，用户要练的是加减仓和对冲，
   * 所以这里从 `position: Position | null` 改成了数组：
   *  - 每笔各自带 lot / entryPrice / SL / TP / 开仓佣金；
   *  - 浮动盈亏 = 所有持仓各自浮动盈亏之和（见 TrainingPane 里的 floatingPnl）；
   *  - 平仓按 id 一笔一笔来，也可以一次全平。
   * 顺序就是开仓顺序（新的追加在末尾）。
   */
  positions: Position[]
  /**
   * 当前「操作焦点」的那笔持仓（图表上可拖动 SL/TP、持仓卡里高亮）。
   * 开新仓时会自动指向新仓；手动平掉后自动落到剩下最后一笔。
   */
  activePositionId: string | null
  closedTrades: ClosedTrade[]

  /** 图表画线 */
  drawings: Drawing[]
  /** 主图叠加指标（实例列表，同一指标可以有多个实例） */
  overlays: IndicatorInstance[]
  /** 副图指标（实例列表，多选；每个实例独占一个 pane） */
  subPanes: IndicatorInstance[]
  /** 指标显示偏好：用户改过之后，所有回测集都用这一套（默认全关） */
  indicatorPrefs: IndicatorPrefs
  /** 偏好是否已从磁盘读过 */
  prefsLoaded: boolean
  /** 标签库：下单浮窗里可一键点亮的常用标签（设置页维护） */
  tagLibrary: string[]
  /** 交易成本模型（手续费 + 滑点）：用户级，所有回测集共用；默认不计成本 */
  executionCost: ExecutionCost
  /** 报告里点选的交易（图表上高亮其开/关仓线） */
  focusedTrade: ClosedTrade | null
  /**
   * 定位序号：每点一次「定位」就 +1。
   * 图表只监听 focusedTrade.id 的话，重复点同一笔单子（或手动拖走视图后再点一次）
   * 不会触发任何 effect，看着像「点了没反应」。用序号强制重跑。
   */
  focusSeq: number
  /**
   * 上一次「定位被拒绝」的原因，null = 没被拒绝过。
   *
   * 两种拒绝：`future`（这笔单在游标之后，属于未来）、`foreign`（时间落不到
   * 当前回测集的 K 线范围里，多半是从别的会话点过来的）。
   * 只在界面上给一句轻提示，然后就地清掉。
   */
  focusNote: 'future' | 'foreign' | null
  /** 回测集完成时间（游标走到区间最后一根后写入） */
  completedAt: number | null
  /**
   * 打开这个会话时，游标是不是已经在最后一根。
   * 已完成的回测集一打开就停在末尾——这种情况不该再自动弹训练报告，
   * 否则每次打开都被报告糊一脸。只有「回放真正走到末尾」才值得自动弹一次。
   */
  openedAtEnd: boolean

  loading: boolean
  error: string | null

  loadDatasets: () => Promise<void>
  loadSessions: () => Promise<void>
  createSession: (params: {
    datasetId: number
    startTime: number
    endTime: number
    name?: string
    displayTimeframe?: string
    /** 单笔风险（金额）；不传按初始资金的 1% */
    riskPerTrade?: number
    /** 交易时段；null / 不传 = 全天不限 */
    tradeWindow?: TradeWindow | null
  }) => Promise<void>
  openSession: (sessionId: number) => Promise<void>
  deleteSession: (sessionId: number) => Promise<void>
  closeActiveSession: () => void
  setTimeframe: (tf: string) => void

  setPlaying: (playing: boolean) => void
  togglePlay: () => void
  setBarsPerSec: (n: number) => void
  advance: () => void
  markCompleted: () => void
  /** 重置：回到回测起点 + 清空全部订单 + 余额复位 */
  resetSession: () => Promise<void>

  setDrawings: (next: Drawing[]) => void
  /** 添加一个指标实例（同一指标可重复添加）；副图超过上限时返回 false */
  addIndicator: (kind: IndicatorKind, id: IndicatorId) => boolean
  /** 删掉某个指标实例 */
  removeIndicator: (kind: IndicatorKind, uid: string) => void
  /** 改某个实例的某个参数 */
  setIndicatorParams: (kind: IndicatorKind, uid: string, key: string, value: number) => void
  /** 改某个实例某条线的颜色（slot 见 indicatorColorSlots） */
  setIndicatorColor: (kind: IndicatorKind, uid: string, slot: string, color: string) => void
  /** 参数 + 颜色一起恢复默认 */
  resetIndicatorParams: (kind: IndicatorKind, uid: string) => void
  /** 一键全关 */
  clearIndicators: () => void
  /** 读用户级指标偏好（应用启动时调一次） */
  loadIndicatorPrefs: () => Promise<void>
  /** 读标签库（应用启动时调一次） */
  loadTagLibrary: () => Promise<void>
  /** 改标签库：设置页维护，下单时一键点亮 */
  setTagLibrary: (tags: string[]) => void
  /** 读交易成本模型（应用启动时调一次） */
  loadExecutionCost: () => Promise<void>
  /** 改交易成本模型（手续费 + 滑点）：写内存 + 节流落盘 */
  setExecutionCost: (cost: ExecutionCost) => void

  setFocusedTrade: (trade: ClosedTrade | null) => void
  focusTrade: (trade: ClosedTrade) => void
  /** 清掉「定位被拒绝」的提示 */
  clearFocusNote: () => void

  setLot: (lot: number) => void
  /** 开仓：不再限制「已有持仓」，同向加仓、反向对冲都允许 */
  openPosition: (side: Side, note?: string, tags?: string[]) => void
  /** 平掉指定的一笔持仓 */
  closePosition: (
    positionId: string,
    reason: CloseReason,
    priceOverride?: number,
    timeOverride?: number
  ) => void
  /**
   * 减仓：把某笔持仓从当前手数**减到** `newLot`，按当前价结算掉差额那部分。
   *
   * 只能减不能加：`newLot` 必须严格小于原手数、且大于 0（想全平走 closePosition / C 键）。
   * 剩余仓位沿用原来的开仓价、SL/TP、备注，只是手数和分摊后的开仓佣金按比例缩小。
   */
  reducePosition: (
    positionId: string,
    newLot: number,
    priceOverride?: number,
    timeOverride?: number
  ) => void
  /** 一次平掉全部持仓（按给定原因与价格；默认按当前 K 线收盘价） */
  closeAllPositions: (reason?: CloseReason) => void
  /**
   * 按「开仓顺序」平掉最早的那一笔（热键 C 单击走这里）。
   *
   * positions 数组本身就按开仓顺序排列（新仓追加在末尾），所以取第一个就是最早的。
   * 焦点（图表可拖 SL/TP 的那笔）不受影响——通常它指着最新一笔，动着它反而乱。
   */
  closeOldestPosition: (reason?: CloseReason) => void
  setSl: (positionId: string, price: number) => void
  setTp: (positionId: string, price: number) => void
  /** 切换「操作焦点」的那笔持仓（图表可拖 SL/TP、持仓卡高亮） */
  selectPosition: (positionId: string | null) => void
  /**
   * 事后编辑一笔已平仓交易的「思路（备注）」和标签（日志页用）。
   *
   * 只改这两样：成交价、盈亏、时间都是回放当场算出来的，事后改等于改成绩。
   * 落库成功后同步内存里的 closedTrades，这样训练页打开报告看到的也是新值。
   */
  patchTradeMeta: (
    sessionId: number,
    tradeId: string,
    meta: { note?: string | null; tags?: string[] }
  ) => Promise<boolean>

  persistState: () => void
  /** 节流版落库（回放每前进一根都会调用，避免写盘过密） */
  persistSoon: () => void
  /** 立即落库，忽略节流 */
  flushPersist: () => void
}

function computeInitialCursor(len: number): number {
  if (len <= 1) return 0
  return Math.min(120, Math.max(0, Math.floor(len * 0.5)))
}

/**
 * 训练开始前额外读多少「历史参考」K 线（秒）。
 *
 * 不让用户从一片空白开始 —— 打开会话第一眼就得能看见趋势、前高前低、均线走向，
 * 否则完全没法判断这笔单子该不该做。默认两周，按 5 分钟图约 4000 根，足够看。
 *
 * 大周期上两周可能只剩几十根（H4 84 根、D1 14 根），所以再按显示周期算一个
 * 「至少这么多根」的下限，取两者里更长的那段。小周期永远是两周。
 */
const WARMUP_DAYS = 14
const WARMUP_MIN_BARS = 120

function warmupSeconds(timeframe: string): number {
  const byDays = WARMUP_DAYS * 86400
  const byBars = WARMUP_MIN_BARS * Math.max(0, timeframeSeconds(timeframe))
  return Math.max(byDays, byBars)
}

/**
 * 第一根 time >= target 的 K 线下标（找不到就退回最后一根）。
 *
 * 和 indexAtTime 的区别：那个取的是「<= target 的最后一根」，用来定位当前进度；
 * 这里要的是「会话真正开始的那一根」，前面塞过预热 K 线，所以起点通常不是 0。
 */
function firstIndexAtOrAfter(bars: Bar[], target: number): number {
  if (bars.length === 0) return 0
  const i = indexAtTime(bars, target)
  if (bars[i].time < target && i + 1 < bars.length) return i + 1
  return i
}

function pointOf(digits: number): number {
  return Math.pow(10, -digits)
}

/** 汇率序列最多缓存多少个点：M1 数据动辄几十万根，抽稀到万级足够 */
const MAX_CROSS_RATE_POINTS = 20000

/**
 * 找「报价货币 → 美元」可用的美元直盘数据集。
 * 优先正向（GBPUSD 直接用收盘价），其次反向（USDJPY 取收盘价的倒数）。
 */
function findUsdDirectDataset(
  datasets: DatasetRow[],
  quote: string
): { row: DatasetRow; direct: boolean } | null {
  const direct = datasets.find((d) => d.symbol === `${quote}USD`)
  if (direct) return { row: direct, direct: true }
  const inverse = datasets.find((d) => d.symbol === `USD${quote}`)
  if (inverse) return { row: inverse, direct: false }
  return null
}

/**
 * 为交叉盘加载「报价货币 → 美元」的汇率序列。
 *
 * 只有交叉盘需要：美元报价（EURUSD）汇率恒为 1，美元基准（USDJPY）用自身价格取倒数，
 * 都不用查外部数据。本机没下载对应美元直盘时返回 null，
 * 调用方会退回内置参考汇率（界面里会标注来源，不假装精确）。
 */
async function loadCrossRate(
  datasets: DatasetRow[],
  symbol: string,
  from: number,
  to: number
): Promise<CrossRateSeries | null> {
  const spec = getContractSpec(symbol)
  if (!spec.quote || spec.quote === 'USD' || spec.base === 'USD') return null
  const picked = findUsdDirectDataset(datasets, spec.quote)
  if (!picked) return null

  const lo = Math.max(from, picked.row.first_time || 0)
  const hi = Math.min(to, picked.row.last_time || to)
  if (!(hi >= lo)) return null

  try {
    const range: any = await window.api.getCandlesRange(picked.row.id, lo, hi)
    const bars = range?.buffer
      ? bufferToBars(range.buffer as ArrayBuffer, Number(range.count) || 0)
      : []
    if (bars.length === 0) return null

    // 抽稀：只取每 step 根的收盘价，末尾那根单独补上（区间尾部最常用）
    const step = Math.max(1, Math.ceil(bars.length / MAX_CROSS_RATE_POINTS))
    const times: number[] = []
    const closes: number[] = []
    for (let i = 0; i < bars.length; i += step) {
      const c = bars[i].close
      if (!(c > 0)) continue
      times.push(bars[i].time)
      closes.push(c)
    }
    const tail = bars[bars.length - 1]
    if (tail.close > 0 && times[times.length - 1] !== tail.time) {
      times.push(tail.time)
      closes.push(tail.close)
    }
    if (times.length === 0) return null
    return { symbol: picked.row.symbol, times, closes, direct: picked.direct }
  } catch {
    return null
  }
}

/**
 * 取某个时刻的「报价货币 → 美元」汇率。
 * 用「最后一根时间 ≤ 目标时间」的收盘价；超出数据范围就取最近的一端，
 * 总比退回一个静态参考汇率准。没有序列时返回 null，让 pnl 层自己兜底。
 */
export function crossRateAt(cross: CrossRateSeries | null, time: number): number | null {
  if (!cross || cross.times.length === 0) return null
  const n = cross.times.length
  let idx: number
  if (time <= cross.times[0]) {
    idx = 0
  } else if (time >= cross.times[n - 1]) {
    idx = n - 1
  } else {
    // 二分：找最后一个 times[i] <= time 的下标
    let lo = 0
    let hi = n - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (cross.times[mid] <= time) lo = mid
      else hi = mid - 1
    }
    idx = lo
  }
  const close = cross.closes[idx]
  if (!(close > 0)) return null
  return cross.direct ? close : 1 / close
}

/**
 * 一笔持仓按平仓价算出来的美元盈亏（不含佣金）。
 *
 * 实现搬到 shared/utils/pnl.ts 了：那里按「报价货币 → 美元」统一换算，
 * 交叉盘（EURGBP/EURJPY/…）和美元基准盘（USDJPY/USDCHF/USDCAD）都算得对。
 * 这里保留同名导出，训练页的浮动盈亏、报表都还在用它。
 */
export { calcPnl, quoteUsdRate } from '@shared/utils/pnl'
/** IPC 传回的 Float64 缓冲 → K 线数组（每根 6 个字段） */
function bufferToBars(buffer: ArrayBuffer, count: number): Bar[] {
  const view = new Float64Array(buffer)
  const bars: Bar[] = new Array(count)
  for (let i = 0; i < count; i++) {
    const o = i * 6
    bars[i] = {
      time: view[o],
      open: view[o + 1],
      high: view[o + 2],
      low: view[o + 3],
      close: view[o + 4],
      volume: view[o + 5]
    }
  }
  return bars
}

export function rowToTrade(row: any): ClosedTrade {
  const symbol = row.symbol ?? ''
  return {
    id: row.id,
    side: row.type === 'sell' ? 'sell' : 'buy',
    symbol,
    lot: row.lot_size,
    entryPrice: row.open_price,
    exitPrice: row.close_price,
    entryTime: row.open_time,
    exitTime: row.close_time,
    pnl: row.profit,
    reason: (row.close_reason as CloseReason) ?? 'manual',
    sl: row.sl_at_close ?? null,
    tp: row.tp_at_close ?? null,
    digits: getDigits(symbol),
    commission: Number(row.commission) || 0,
    note: row.notes ?? null,
    tags: parseTags(row.tags_json),
    tz: row.tz ?? null,
    openLocal: row.open_local ?? null,
    closeLocal: row.close_local ?? null
  }
}

/** 上次写盘时间戳（节流用） */
let lastPersistAt = 0
let persistTimer: ReturnType<typeof setTimeout> | null = null
/** 两次写盘的最小间隔（ms）：太小会频繁写 sqlite，太大会丢进度 */
const PERSIST_INTERVAL = 800

/** 指标偏好的写盘节流 */
let prefsSaveTimer: ReturnType<typeof setTimeout> | null = null
/** 成本模型的写盘节流 */
let costSaveTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 保存用户级指标偏好：先更新内存状态，稍后才落盘。
 * 这样指标菜单点起来是即时的，又不会每点一下就写一次文件。
 */
function saveIndicatorPrefs(next: IndicatorPrefs): void {
  useTrainingStore.setState({ indicatorPrefs: next })
  if (prefsSaveTimer) clearTimeout(prefsSaveTimer)
  prefsSaveTimer = setTimeout(() => {
    prefsSaveTimer = null
    void window.api.setIndicatorPrefs(next)
  }, 300)
}

/**
 * 结算引擎：「从某笔持仓里按手数结算掉一部分」的全部逻辑。
 *
 * closePosition（cut = 全部手数）和 reducePosition（cut < 全部）都从这里走，
 * 保证减仓与全平用的是同一套成交价、滑点、佣金、汇率折算和 R 倍数口径 ——
 * 减仓不是另一套算法，只是「平掉的手数少一点」。
 *
 * 三个容易写错的地方，这里都按真实券商的算法处理：
 *  · 开仓佣金是按**整笔**手数一次性收的，减仓只该按比例带走属于那一份的那部分，
 *    否则减一次仓就把整笔开仓费全打进这次盈亏，剩下的仓位反而「免费」了；
 *  · 两边的佣金都要减，剩下的仓位保留它那份开仓佣金，等下次结算；
 *  · 部分平仓的 R 倍数，分母只算这次结算掉的那点手数的风险，不是整笔的风险。
 */
function settlePosition(
  get: () => TrainingState,
  set: (partial: Partial<TrainingState>) => void,
  position: Position,
  cutLot: number,
  reason: CloseReason,
  priceOverride?: number,
  timeOverride?: number
): void {
  const { bars, cursor, balance, activeSession, executionCost, crossRate, positions } = get()
  if (!activeSession) return

  // 不许多切：cut 永远不超过手上还剩的手数
  const cut = Number(Math.min(Math.max(cutLot, 0), position.lot).toFixed(4))
  if (!(cut > 0)) return
  const remainderLot = Number((position.lot - cut).toFixed(4))

  /**
   * 成交价用「当前这根可能被截断的 K 线」，不能用整根 bars[cursor]。
   *
   * H1 上刚回放到 13:20 时，bars[cursor] 的 close 是 13:59 的价——那是十分钟后的未来。
   * partialBar 只算到 13:20，close 就是 13:20 那分钟的收盘价。
   */
  const bar = get().partialBar ?? bars[cursor]
  const rawExit = priceOverride ?? bar?.close ?? position.entryPrice
  /**
   * 手动平仓 / 减仓：成交时间就是「当前已揭示到的那一分钟」（cursorTime），
   * 因为成交价取的是那个时刻的收盘价，时间得对得上。
   * 止损止盈走 timeOverride（整根 K 线扫描，落在这根的开头）。
   */
  const exitTime =
    timeOverride ?? get().cursorTime ?? bar?.time ?? Math.floor(Date.now() / 1000)

  /**
   * 平仓端也要吃成本：
   *  · 止盈是限价单，成交价就应当是设定的那个价，不给滑点
   *  · 市价平仓（含减仓）、止损触发都要按不利方向再让一点
   */
  const slip = reason === 'tp' ? 0 : slippagePrice(executionCost, position.digits)
  const fill = position.side === 'buy' ? rawExit - slip : rawExit + slip
  const exitPrice = Number(fill.toFixed(position.digits))

  const quoteToUsd = crossRateAt(crossRate, exitTime)
  const exitRate = quoteUsdRate(position.symbol, exitPrice, { quoteToUsd }).rate
  const exitCommission = commissionPerSide(
    executionCost,
    cut,
    position.contractSize,
    exitPrice,
    exitRate
  )

  const wholeEntryCommission = position.entryCommission ?? 0
  const cutRatio = position.lot > 0 ? cut / position.lot : 1
  const entryCommission = wholeEntryCommission * cutRatio

  // 价差盈亏（只按切掉的这点头寸）− 分摊的开仓佣金 − 本端佣金 = 这批真正落袋的钱
  const gross = calcPnl({ ...position, lot: cut }, exitPrice, { quoteToUsd })
  const pnl = gross - entryCommission - exitCommission

  const trade: ClosedTrade = {
    id: `t_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    side: position.side,
    symbol: position.symbol,
    lot: cut,
    entryPrice: position.entryPrice,
    exitPrice,
    entryTime: position.entryTime,
    exitTime,
    pnl,
    reason,
    sl: position.sl,
    tp: position.tp,
    digits: position.digits,
    commission: entryCommission + exitCommission,
    note: position.note,
    tags: position.tags ?? []
  }

  // 单笔风险（1R）也折美元：止损距离 × 本次结算的手数 × 合约量
  const risk =
    position.sl != null
      ? Math.abs(position.entryPrice - position.sl) * cut * position.contractSize * exitRate
      : 0
  const rMultiple = risk > 0 ? pnl / risk : null

  /**
   * 剩余仓位：手数和开仓佣金一起按比例缩，其它（开仓价、SL/TP、备注、开仓时间）原样留住。
   * 还剩手数就是减仓，一点都不剩才是整笔平掉、从列表里摘掉。
   */
  const rest =
    remainderLot > 0
      ? positions.map((p) =>
          p.id === position.id
            ? { ...p, lot: remainderLot, entryCommission: wholeEntryCommission * (1 - cutRatio) }
            : p
        )
      : positions.filter((p) => p.id !== position.id)

  set({
    positions: rest,
    // 焦点只在整笔平掉时才需要换人；减仓后同一笔还在，焦点不动
    activePositionId:
      remainderLot > 0
        ? get().activePositionId
        : get().activePositionId === position.id
          ? (rest[rest.length - 1]?.id ?? null)
          : get().activePositionId,
    balance: balance + pnl,
    closedTrades: [...get().closedTrades, trade]
  })

  void window.api.appendClosedTrade({
    sessionId: activeSession.id,
    id: trade.id,
    positionId: position.id,
    type: position.side,
    // 库里要能分清「整笔平掉」和「减掉一部分」：后续算持仓时长、胜率时口径不同
    action: remainderLot > 0 ? 'partial' : 'close',
    openTime: position.entryTime,
    closeTime: exitTime,
    openPrice: position.entryPrice,
    closePrice: exitPrice,
    lotSize: cut,
    profit: pnl,
    commission: entryCommission + exitCommission,
    symbol: position.symbol,
    slAtClose: position.sl,
    tpAtClose: position.tp,
    rMultiple,
    closeReason: reason,
    notes: position.note,
    // 标签随订单落库，属于该回测集里的这一笔
    tagsJson: JSON.stringify(position.tags ?? []),
    // 单笔风险：报告里按它把盈亏换算成 R
    initialRiskAmount: get().riskPerTrade
  })

  get().persistState()
}

export const useTrainingStore = create<TrainingState>((set, get) => ({
  datasets: [],
  sessions: [],

  crossRate: null,

  activeSession: null,
  symbol: '',
  timeframe: 'M1',
  digits: 5,
  rawBars: [],
  bars: [],
  partialBar: null,
  cursor: 0,
  cursorTime: 0,
  initialCursor: 0,
  initialTime: 0,

  playing: false,
  barsPerSec: 2,

  initialBalance: 10000,
  balance: 10000,
  riskPerTrade: 100,
  lot: 0.1,
  positions: [],
  activePositionId: null,
  closedTrades: [],
  drawings: [],
  overlays: [],
  subPanes: [],
  indicatorPrefs: { ...DEFAULT_INDICATOR_PREFS },
  prefsLoaded: false,
  tagLibrary: [...DEFAULT_TAG_LIBRARY],
  executionCost: { ...DEFAULT_EXECUTION_COST },
  focusedTrade: null,
  focusSeq: 0,
  focusNote: null,
  completedAt: null,
  openedAtEnd: false,

  loading: false,
  error: null,

  loadDatasets: async () => {
    try {
      const rows = (await window.api.listDownloadedDatasets()) as DatasetRow[]
      set({ datasets: rows ?? [] })
    } catch (e: any) {
      set({ error: e?.message ?? String(e) })
    }
  },

  loadSessions: async () => {
    try {
      const rows = (await window.api.listSessions()) as TrainingSession[]
      set({ sessions: rows ?? [] })
    } catch (e: any) {
      set({ error: e?.message ?? String(e) })
    }
  },

  createSession: async ({ datasetId, startTime, endTime, name, displayTimeframe, riskPerTrade, tradeWindow }) => {
    const ds = get().datasets.find((d) => d.id === datasetId)
    if (!ds) {
      set({ error: '找不到该数据集' })
      return
    }
    try {
      const sessionName = name?.trim() || `${ds.symbol} ${fmtDay(startTime)}~${fmtDay(endTime)}`
      // 建会话时把当前时区一起记下来，之后回到这个会话都按它展示
      const tz = useTimezoneStore.getState().timezone
      const id = await window.api.createSession({
        datasetId,
        name: sessionName,
        initialBalance: 10000,
        lotSize: 0.1,
        riskPerTrade: Number(riskPerTrade) > 0 ? Number(riskPerTrade) : 100,
        startTime,
        endTime,
        displayTimeframe: displayTimeframe ?? 'M5',
        timezone: tz,
        tradeWindow: normalizeTradeWindow(tradeWindow)
      })
      await get().loadSessions()
      await get().openSession(Number(id))
    } catch (e: any) {
      set({ error: e?.message ?? String(e) })
    }
  },

  openSession: async (sessionId) => {
    /**
     * 点的就是当前已经打开的这个回测集：直接返回，什么都不做。
     *
     * 以前这里会整段重载——图表被卸载重建、视图弹回默认窗口、回放被暂停、
     * 未平仓的持仓被清空（持仓不落库）。用户点一下左边列表想「看一眼」，
     * 结果进度和画面全乱，「点左边的训练集，K 线图直接展示成最开始的位置」
     * 就是这么来的。同一个会话重开没有任何收益，幂等返回才是对的。
     */
    const opened = get().activeSession
    if (opened?.id === sessionId && get().bars.length > 0) return
    // 指标偏好是用户级配置，还没读就先读，否则会先闪一下空指标
    if (!get().prefsLoaded) await get().loadIndicatorPrefs()
    // 切到另一个会话前，先把当前会话的进度落库
    const prev = get().activeSession
    if (prev && prev.id !== sessionId) get().flushPersist()
    set({ loading: true, playing: false, error: null, positions: [], activePositionId: null })
    try {
      const session = (await window.api.getSession(sessionId)) as TrainingSession | null
      if (!session) {
        set({ loading: false, error: '会话不存在' })
        return
      }
      const dataset = await window.api.getDataset(session.dataset_id)
      if (!dataset) {
        set({ loading: false, error: '会话对应的行情数据集已被删除' })
        return
      }

      const tf =
        session.display_timeframe && isChartTimeframe(session.display_timeframe)
          ? session.display_timeframe
          : 'M5'

      const from = session.start_time ?? dataset.first_time
      const to = session.end_time ?? dataset.last_time
      /**
       * 多读一段起点之前的 K 线当「历史参考」（见 warmupSeconds）。
       *
       * 这些 K 线只是用来给用户看盘用的：回放游标从会话起点开始，
       * 预热段永远不会被推进到，也就永远不可能在预热段里下单。
       * 数据集本身没那么早的数据就少读一点（SQL 按 time 过滤，自然就少了）。
       */
      const warmFrom = Math.max(
        dataset.first_time || from,
        from - warmupSeconds(tf)
      )
      const range: any = await window.api.getCandlesRange(dataset.id, warmFrom, to)
      const rawBars = range?.buffer
        ? bufferToBars(range.buffer as ArrayBuffer, Number(range.count) || 0)
        : []

      const bars = aggregateBars(rawBars, tf)
      /** 会话真正开始的那一根在数组里的下标（前面是预热 K 线，所以通常不是 0） */
      const startIndex = firstIndexAtOrAfter(bars, from)
      /**
       * 全新会话「开打」的那一根。
       *
       *  · 有预热历史（startIndex > 0）：就停在会话开始这一根，前面全是能直接看的 K 线；
       *  · 数据集本身没有更早的数据（startIndex === 0，比如下载的数据刚好从训练起点开始）：
       *    退回老办法先跳过一小段。否则第一眼只有一根 K 线，照样没法判断该不该下单。
       */
      const openingIndex = startIndex > 0 ? startIndex : computeInitialCursor(bars.length)

      // 恢复进度：
      // 1) 已完成（或回放走到头）的会话：直接停在最后一根，图表整段完整展示
      // 2) 有保存的时间就按时间定位 —— 数组前面带了预热 K 线，存的下标会整体前移，时间不会
      // 3) 只有下标（很老的数据）才退回下标，且不允许退到会话起点之前
      // 4) 全新会话：停在 openingIndex
      let cursor: number
      if (session.completed_at != null && bars.length > 0) {
        cursor = bars.length - 1
      } else if (
        session.current_bar_time != null &&
        bars.length > 0 &&
        session.current_bar_time >= bars[0].time
      ) {
        cursor = Math.max(openingIndex, indexAtTime(bars, session.current_bar_time))
      } else if (session.display_timeframe === tf && session.current_index > 0) {
        cursor = Math.max(openingIndex, Math.min(bars.length - 1, session.current_index))
      } else {
        cursor = openingIndex
      }

      /**
       * 精确到分钟的回放位置。
       *
       * 会话里存的 `current_bar_time` 现在就是「最后一根已揭示的 1 分钟 K 线」，
       * 直接用它，别退回 `bars[cursor].time` —— 那是当前显示周期的桶起点，
       * 在 H4 上等于把位置往回吞掉将近 4 小时。
       * 老数据存的是当时周期的桶起点，也是合法时间戳，照样能用（只是粗一点）。
       */
      const lastBarTime = bars.length > 0 ? bars[bars.length - 1].time : 0
      const cursorBar = bars[cursor]
      const cursorTime =
        session.completed_at != null
          ? lastBarTime
          : session.current_bar_time != null &&
              bars.length > 0 &&
              session.current_bar_time >= bars[0].time
            ? Math.min(session.current_bar_time, lastBarTime)
            : // 全新会话：起点那根算「已走完」，否则第一眼会看到一根只有 1 分钟的残线
              cursorBar
              ? bucketEndTime(cursorBar.time, tf, rawBars)
              : 0

      // 先把时区切到该会话打单时记录的时区，再落状态，
      // 这样组件第一帧渲染时用的就是正确的时区（老会话没记就跟随全局设置）
      useTimezoneStore.getState().useSessionTimezone(session.tz ?? null)

      // 指标：用户亲手设过就所有回测集通用；从没动过才沿用该会话里存的（兼容老数据）
      const prefs = get().indicatorPrefs
      const indicators = prefs.customized
        ? { overlays: prefs.overlays, subPanes: prefs.subPanes }
        : parseIndicators((session as any).indicators_json)

      /**
       * 交叉盘的汇率序列：本机若下载了对应美元直盘，就用真实收盘价换算盈亏，
       * 否则退回内置参考汇率。数据集列表可能还没加载（直接打开某个会话），
       * 先补一次再找，避免「明明下载了 GBPUSD 却按参考汇率算」。
       */
      let datasets = get().datasets
      if (datasets.length === 0) {
        try {
          datasets = ((await window.api.listDownloadedDatasets()) as DatasetRow[]) ?? []
          set({ datasets })
        } catch {
          datasets = []
        }
      }
      const crossRate = await loadCrossRate(datasets, dataset.symbol ?? '', warmFrom, to)

      set({
        activeSession: { ...session, dataset_symbol: dataset.symbol },
        crossRate,
        symbol: dataset.symbol ?? '',
        timeframe: tf,
        digits: getDigits(dataset.symbol ?? ''),
        rawBars,
        bars,
        cursor,
        cursorTime,
        // 当前这根可能还没走完（在大周期上只算到 cursorTime），图表和价格都用它
        partialBar: partialAt(rawBars, tf, cursorBar, cursorTime),
        // 换了回测集，上一集选中的那笔单子必须丢掉：
        // 否则它的开/关仓价格线会继续画在新会话的图上，价位完全对不上。
        focusedTrade: null,
        focusSeq: 0,
        focusNote: null,
        // 重置 / 回到起点都指「会话开打的那一根」，不是数组第 0 根（前面是预热历史）
        initialCursor: openingIndex,
        // 同时记住这一根的时间：切周期要靠它把下标换算到新周期上
        initialTime: bars[openingIndex]?.time ?? 0,
        playing: false,
        barsPerSec:
          session.speed && session.speed >= 1 && session.speed <= 20 ? Math.round(session.speed) : 2,
        initialBalance: session.initial_balance,
        balance: session.balance,
        // 老会话没有该字段（或为 0）时按初始资金 1% 兜底
        riskPerTrade:
          session.risk_per_trade && session.risk_per_trade > 0
            ? session.risk_per_trade
            : Math.max(1, session.initial_balance * 0.01),
        lot: session.lot_size || 0.1,
        positions: [],
        activePositionId: null,
        closedTrades: ((await window.api.listClosedTrades(sessionId)) as any[]).map(rowToTrade),
        drawings: parseDrawings(session.drawings_json),
        overlays: indicators.overlays,
        subPanes: indicators.subPanes,
        completedAt: session.completed_at ?? null,
        // 已完成的回测集一打开就停在最后一根，不该再自动弹报告
        openedAtEnd: cursor >= bars.length - 1,
        loading: false
      })
    } catch (e: any) {
      set({ loading: false, error: e?.message ?? String(e) })
    }
  },

  deleteSession: async (sessionId) => {
    try {
      await window.api.deleteSession(sessionId)
      if (get().activeSession?.id === sessionId) get().closeActiveSession()
      await get().loadSessions()
    } catch (e: any) {
      set({ error: e?.message ?? String(e) })
    }
  },

  closeActiveSession: () => {
    // 先把手上的进度写进去，再清空内存态，否则下次打开会回到旧位置
    get().flushPersist()
    // 退出会话后时间显示回到设置页的全局时区
    useTimezoneStore.getState().useSessionTimezone(null)
    set({
      activeSession: null,
      crossRate: null,
      rawBars: [],
      bars: [],
      cursor: 0,
      cursorTime: 0,
      partialBar: null,
      initialCursor: 0,
      initialTime: 0,
      positions: [],
      activePositionId: null,
      closedTrades: [],
      drawings: [],
      focusedTrade: null,
      focusSeq: 0,
      focusNote: null,
      completedAt: null,
      openedAtEnd: false,
      playing: false,
      symbol: ''
    })
  },

  setTimeframe: (tf) => {
    const { rawBars, bars: curBars, cursor, cursorTime, playing, initialTime } = get()
    if (rawBars.length === 0) {
      set({ timeframe: tf })
      return
    }
    const bars = aggregateBars(rawBars, tf)
    // 锚点必须是「精确的回放时间」，不能用当前周期的桶起点。
    // 用桶起点会逐层量化：M1 1081(18:00) → H4 5 → D1 1(当日 00:00) → 再切回 M1 就退回当日第一根，
    // 看起来就是「切周期把进度重置了」。
    const anchor = cursorTime || curBars[cursor]?.time || bars[0]?.time || 0
    const nextCursor = indexAtTime(bars, anchor)
    /**
     * 回测起点下标也要跟着换周期重算 —— 它存的是旧周期数组里的位置。
     * 不重算的话，从 M5 切到 H1 后 initialCursor（≈18000）远大于新数组长度（≈1400），
     * 进度条分母被 `Math.max(1, …)` 兜成 1，顶部会显示成「1/1」。
     */
    const nextInitial =
      initialTime > 0 && bars.length > 0
        ? Math.min(indexAtTime(bars, initialTime), nextCursor)
        : get().initialCursor
    set({
      timeframe: tf,
      bars,
      cursor: nextCursor,
      // 注意：cursorTime 保持原值（更精确），不要写回新周期的桶起点 ——
      // 正因为它留着「13:20」，切到 H1 后这一根才知道该截断到 13:20，
      // 而不是把整根 H1（含 13:59 收盘价）画出来。
      partialBar: partialAt(rawBars, tf, bars[nextCursor], anchor),
      initialCursor: nextInitial,
      playing
    })
    get().persistState()
  },

  setPlaying: (playing) => {
    const { cursor, bars } = get()
    if (playing && cursor >= bars.length - 1) return
    set({ playing })
    // 暂停时立刻把进度落库，避免下次打开倒退
    if (!playing) {
      get().persistState()
      // 顺手刷新一次列表数据：播放过程中列表用的是打开页面时的快照，
      // 停下来了就把真实的余额/进度对回来（播放中刷新太费，交给实时游标顶）
      void get().loadSessions()
    }
  },

  togglePlay: () => {
    get().setPlaying(!get().playing)
  },

  setBarsPerSec: (n) => {
    set({ barsPerSec: Math.max(1, Math.min(20, n)) })
    get().persistState()
  },

  advance: () => {
    const { cursor, bars, rawBars, timeframe } = get()
    if (cursor >= bars.length - 1) {
      set({ playing: false })
      return
    }
    const next = cursor + 1
    const bar = bars[next]
    /**
     * 走完这一根之后，「打到哪一分钟」的答案是这一格的**最后一分钟**（13:59），
     * 不是桶起点 13:00 —— 一根 H1 走完 = 这一小时全看过了。
     * 落库/切周期都靠这个时间戳，用桶起点会让进度在大小周期间来回缩水。
     */
    const nextTime = bucketEndTime(bar.time, timeframe, rawBars)
    set({
      cursor: next,
      cursorTime: nextTime,
      partialBar: partialAt(rawBars, timeframe, bar, nextTime)
    })
    // 走到区间最后一根 = 这个回测集完成
    if (next >= bars.length - 1) get().markCompleted()

    /**
     * 逐笔判止损 / 止盈：同一根 K 线里可能有多笔同时被扫掉（对冲时更是常见——
     * 一根大阳线会让多头止盈、空头止损一起触发），各笔独立结算。
     * 单根 K 线无法还原盘中路径，采用保守规则：每笔都先判止损。
     *
     * 止损落在成本价的盈利侧（多头 SL 已在开仓价上方 / 空头在下方）时，
     * 这一笔其实是**移动止盈**被触发 —— 止损跟上去把利润锁住了，
     * 记账按 trail 记，报告里别和「亏着出场」混在一起看。
     */
    for (const pos of [...get().positions]) {
      const stopIsProfit =
        pos.sl != null &&
        (pos.side === 'buy' ? pos.sl > pos.entryPrice : pos.sl < pos.entryPrice)
      const slReason: CloseReason = stopIsProfit ? 'trail' : 'sl'
      if (pos.side === 'buy') {
        if (pos.sl != null && bar.low <= pos.sl) {
          get().closePosition(pos.id, slReason, pos.sl, bar.time)
        } else if (pos.tp != null && bar.high >= pos.tp) {
          get().closePosition(pos.id, 'tp', pos.tp, bar.time)
        }
      } else {
        if (pos.sl != null && bar.high >= pos.sl) {
          get().closePosition(pos.id, slReason, pos.sl, bar.time)
        } else if (pos.tp != null && bar.low <= pos.tp) {
          get().closePosition(pos.id, 'tp', pos.tp, bar.time)
        }
      }
    }

    get().persistSoon()
  },

  /** 重置：回到回测起点 + 清空全部订单 + 余额复位，然后从头重新打这个回测集 */
  resetSession: async () => {
    const { activeSession, bars, rawBars, timeframe, initialCursor, initialBalance } = get()
    if (!activeSession || bars.length === 0) return
    const start = Math.max(0, Math.min(bars.length - 1, initialCursor))
    const startBar = bars[start]
    // 起点那根算「已走完」：和新建会话一致的基线，否则重开后第一眼是一根残线
    const startTime = startBar ? bucketEndTime(startBar.time, timeframe, rawBars) : 0
    set({
      playing: false,
      positions: [],
      activePositionId: null,
      closedTrades: [],
      balance: initialBalance,
      cursor: start,
      cursorTime: startTime,
      partialBar: null,
      initialCursor: start,
      initialTime: startBar?.time ?? 0,
      focusedTrade: null,
      focusSeq: 0,
      focusNote: null,
      completedAt: null,
      // 重置后从起点重放，走到末尾时应该重新自动弹一次报告
      openedAtEnd: false
    })
    try {
      await window.api.resetSession(activeSession.id, {
        currentIndex: start,
        currentBarTime: startTime || null
      })
    } catch (e: any) {
      set({ error: e?.message ?? String(e) })
    }
    // 会话列表里的余额也要跟着更新
    void get().loadSessions()
    get().persistState()
  },

  /** 回测集完成：游标走到区间最后一根时落库（幂等） */
  markCompleted: () => {
    const { activeSession, completedAt } = get()
    if (!activeSession || completedAt) return
    set({ completedAt: Date.now() })
    void window.api.completeSession(activeSession.id)
  },

  setDrawings: (next) => {
    set({ drawings: next })
    get().persistState()
  },

  /**
   * 指标是「用户级配置」：
   * 用户一旦调过（哪怕是全部关掉），就把这套记到 settings.json，
   * 之后打开任何回测集都用它，而不是每个会话各存一份。
   */
  addIndicator: (kind, id) => {
    const s = get()
    if (kind === 'sub' && s.subPanes.length >= MAX_SUB_PANES) return false
    const inst = makeInstance(id)
    if (kind === 'overlay') set({ overlays: [...s.overlays, inst] })
    else set({ subPanes: [...s.subPanes, inst] })
    saveIndicatorPrefs({
      overlays: get().overlays,
      subPanes: get().subPanes,
      customized: true
    })
    get().persistState()
    return true
  },

  removeIndicator: (kind, uid) => {
    const s = get()
    if (kind === 'overlay') set({ overlays: s.overlays.filter((x) => x.uid !== uid) })
    else set({ subPanes: s.subPanes.filter((x) => x.uid !== uid) })
    saveIndicatorPrefs({
      overlays: get().overlays,
      subPanes: get().subPanes,
      customized: true
    })
    get().persistState()
  },

  setIndicatorParams: (kind, uid, key, value) => {
    const patch = (list: IndicatorInstance[]): IndicatorInstance[] =>
      list.map((x) => (x.uid === uid ? { ...x, params: { ...x.params, [key]: value } } : x))
    if (kind === 'overlay') set({ overlays: patch(get().overlays) })
    else set({ subPanes: patch(get().subPanes) })
    saveIndicatorPrefs({
      overlays: get().overlays,
      subPanes: get().subPanes,
      customized: true
    })
    get().persistState()
  },

  setIndicatorColor: (kind, uid, slot, color) => {
    const patch = (list: IndicatorInstance[]): IndicatorInstance[] =>
      list.map((x) =>
        x.uid === uid ? { ...x, colors: { ...(x.colors ?? {}), [slot]: color } } : x
      )
    if (kind === 'overlay') set({ overlays: patch(get().overlays) })
    else set({ subPanes: patch(get().subPanes) })
    saveIndicatorPrefs({
      overlays: get().overlays,
      subPanes: get().subPanes,
      customized: true
    })
    get().persistState()
  },

  resetIndicatorParams: (kind, uid) => {
    // 颜色也要跟着回默认，否则「恢复默认」之后线还是花的
    const patch = (list: IndicatorInstance[]): IndicatorInstance[] =>
      list.map((x) => (x.uid === uid ? { ...x, params: resolveParams(x.id), colors: undefined } : x))
    if (kind === 'overlay') set({ overlays: patch(get().overlays) })
    else set({ subPanes: patch(get().subPanes) })
    saveIndicatorPrefs({
      overlays: get().overlays,
      subPanes: get().subPanes,
      customized: true
    })
    get().persistState()
  },

  clearIndicators: () => {
    set({ overlays: [], subPanes: [] })
    saveIndicatorPrefs({ overlays: [], subPanes: [], customized: true })
    get().persistState()
  },

  loadTagLibrary: async () => {
    try {
      const remote = await window.api.getTradeTags()
      set({ tagLibrary: normalizeTagLibrary(remote) })
    } catch {
      // 读不到就退回内置默认，至少标签栏不会是一片空白
      set({ tagLibrary: [...DEFAULT_TAG_LIBRARY] })
    }
  },

  setTagLibrary: (tags) => {
    const next = normalizeTagLibrary(tags)
    set({ tagLibrary: next })
    void window.api.setTradeTags(next)
  },

  loadExecutionCost: async () => {
    try {
      const remote = await window.api.getExecutionCost()
      set({ executionCost: normalizeExecutionCost(remote) })
    } catch {
      set({ executionCost: { ...DEFAULT_EXECUTION_COST } })
    }
  },

  /**
   * 成本模型改动要「立刻反映到下一笔单子」：先写内存（算价、算佣金都读它），
   * 再节流落盘 —— 用户在面板里拖数字时不必每改一个字就写一次 settings.json。
   */
  setExecutionCost: (cost) => {
    const next = normalizeExecutionCost(cost)
    set({ executionCost: next })
    if (costSaveTimer) clearTimeout(costSaveTimer)
    costSaveTimer = setTimeout(() => {
      costSaveTimer = null
      void window.api.setExecutionCost(next)
    }, 300)
  },

  loadIndicatorPrefs: async () => {
    try {
      const remote = await window.api.getIndicatorPrefs()
      const prefs = normalizeIndicatorPrefs(remote)
      set({ indicatorPrefs: prefs, prefsLoaded: true })
    } catch {
      set({ indicatorPrefs: { ...DEFAULT_INDICATOR_PREFS }, prefsLoaded: true })
    }
  },

  setFocusedTrade: (trade) =>
    set((s) => ({ focusedTrade: trade, focusSeq: trade ? s.focusSeq + 1 : s.focusSeq })),

  /**
   * 定位到某一笔成交（报告表格 / 平仓记录 / 日志 三处共用）。
   *
   * 注意：这里**不能动 cursor**。之前是把回放游标倒回这笔单子的开仓位置，
   * 结果图表只画到开仓那根，平仓之后的部分全缺；连线还要往右外推，
   * 看起来就是「定位不准 / 图形溢出」。已完成的回测集本来就该整段 K 线都在。
   *
   * 两道闸（所有定位入口都会经过这里，所以闸设在这一层）：
   *  1) **是不是已经发生过**：回放没走完时，游标之后的 K 线是「未来」，
   *     这笔单要是落在游标后面就不许定位——否则等于提前剧透，训练失去意义；
   *  2) **是不是当前回测集**：交易时间落不到已加载 K 线的时间范围里，
   *     说明它属于别的会话（比如从日志页点过来而目标会话没打开成功），同样不定位。
   */
  focusTrade: (trade) => {
    const { bars, cursor, completedAt } = get()
    if (bars.length === 0) return

    const last = revealIndexOf(bars, cursor, completedAt)
    const firstTime = bars[0].time
    const lastTime = bars[bars.length - 1].time
    /**
     * 判「未来」用平仓时间：开平都在游标之后才算越界；跨游标的持仓按已发生处理。
     *
     * 右边界取「已揭示到的分钟」（cursorTime），不是当前那根 K 线的桶起点：
     * 刚在 08:59 手动平掉的单，桶起点是 08:55，用它会把这笔真实的成交判成「未来」。
     */
    const revealTime = Math.max(bars[last]?.time ?? firstTime, get().cursorTime || 0)

    if (completedAt == null && trade.exitTime > revealTime) {
      set({ focusNote: 'future' })
      return
    }
    if (trade.exitTime < firstTime || trade.entryTime > lastTime) {
      set({ focusNote: 'foreign' })
      return
    }

    set((s) => ({ focusedTrade: trade, focusSeq: s.focusSeq + 1, playing: false, focusNote: null }))
  },

  clearFocusNote: () => {
    if (get().focusNote != null) set({ focusNote: null })
  },

  setLot: (lot) => {
    const clamped = Math.max(0.01, Math.min(100, Number(lot) || 0.01))
    set({ lot: Math.round(clamped * 100) / 100 })
  },

  openPosition: (side, note, tags) => {
    const { bars, cursor, lot, symbol, digits, executionCost, crossRate } = get()
    if (!symbol || bars.length === 0) return
    /**
     * 价格取「当前这根可能被截断的 K 线」：在 H1 上刚回放到 13:20 时，
     * bars[cursor].close 是 13:59 的价（未来），partialBar.close 才是 13:20 的价。
     */
    const bar = get().partialBar ?? bars[cursor]
    if (!bar) return
    // 成交时间跟着已揭示的分钟走，成交价才和它自洽
    const entryTime = get().cursorTime || bar.time
    // 交易时段外严禁开仓（平仓走 closePosition，不受限制）
    if (tradeWindowBlockAt(entryTime)) return

    const contractSize = getContractSize(symbol)
    const slip = slippagePrice(executionCost, digits)
    const fill = side === 'buy' ? bar.close + slip : bar.close - slip
    const entry = Number(fill.toFixed(digits))
    /**
     * 开仓佣金先记在持仓上，等平仓时和价差盈亏一起结算。
     * 不在这里扣余额，是因为「未平仓的持仓」不落库：万一中途关掉应用，
     * 持仓会丢，那笔开仓佣金就会变成无主的扣款（余额少了却没有对应订单）。
     *
     * 百分比佣金按「名义价值折美元」收，所以要带上报价货币汇率 ——
     * 否则 USDJPY 的 10 万美元名义价值会被当成 1500 万日元再乘费率。
     * 交叉盘再叠一层「本机美元直盘」的真实汇率（crossRate）。
     */
    const entryRate = quoteUsdRate(symbol, entry, { quoteToUsd: crossRateAt(crossRate, entryTime) }).rate
    const commission = commissionPerSide(executionCost, lot, contractSize, entry, entryRate)

    const next: Position = {
      id: `pos_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      side,
      symbol,
      lot,
      entryPrice: entry,
      entryTime,
      // 开仓时只给一条线，由用户第一次拖动的方向决定它是止损还是止盈
      sl: null,
      tp: null,
      digits,
      contractSize,
      entryCommission: commission,
      note: note?.trim() ? note.trim() : null,
      tags: parseTags(JSON.stringify(tags ?? []))
    }
    // 追加到末尾（= 开仓顺序），并把这个新仓设为操作焦点
    set({ positions: [...get().positions, next], activePositionId: next.id })
  },

  closePosition: (positionId, reason, priceOverride, timeOverride) => {
    const position = get().positions.find((p) => p.id === positionId)
    if (!position) return
    // 整笔平掉 = 把手上的手数全部结算掉
    settlePosition(get, set, position, position.lot, reason, priceOverride, timeOverride)
  },

  reducePosition: (positionId, newLot, priceOverride, timeOverride) => {
    const position = get().positions.find((p) => p.id === positionId)
    if (!position) return

    // 手数按 0.01 取整，避免浮点误差（0.1 - 0.07 = 0.030000000000000002）
    const keep = Number(Number(newLot).toFixed(2))
    /**
     * 只允许减仓：想加仓、改成一样的、或者减到 0 都直接忽略。
     * 减到 0 请走 closePosition（全平）—— 那条路会正确地清掉持仓和焦点。
     */
    if (!Number.isFinite(keep) || keep < 0.01 || keep >= position.lot) return

    const cut = Number((position.lot - keep).toFixed(2))
    if (!(cut > 0)) return
    settlePosition(get, set, position, cut, 'partial', priceOverride, timeOverride)
  },

  closeAllPositions: (reason = 'manual') => {
    // 一张一张按当前价平：closePosition 内部会各自算滑点、佣金和汇率
    for (const p of [...get().positions]) {
      get().closePosition(p.id, reason)
    }
  },

  closeOldestPosition: (reason = 'manual') => {
    // 数组顺序就是开仓顺序（新仓追加在末尾），第一个即最早那笔
    const oldest = get().positions[0]
    if (!oldest) return
    get().closePosition(oldest.id, reason)
  },

  patchTradeMeta: async (sessionId, tradeId, meta) => {
    const note = typeof meta.note === 'string' ? meta.note : null
    const tags = normalizeTags(meta.tags ?? [])
    try {
      const ok = await window.api.updateTradeMeta(sessionId, tradeId, { note, tags })
      if (!ok) return false
      // 内存里那份也一起改：否则从日志跳回训练页看报告还是旧备注
      if (get().activeSession?.id === sessionId) {
        set((s) => ({
          closedTrades: s.closedTrades.map((trade) =>
            trade.id === tradeId ? { ...trade, note, tags } : trade
          )
        }))
      }
      return true
    } catch (e: any) {
      set({ error: e?.message ?? String(e) })
      return false
    }
  },

  /**
   * 拖止损。
   *
   * 唯一的硬约束是「留在当前价的亏损侧」：做多在现价下方、做空在现价上方。
   * 越过现价就成了一张立刻会成交的废单（下一根 K 线必被扫掉），没有意义。
   *
   * 除此之外不再限制跟开仓价的关系 ——
   * 价格走顺以后把止损一路跟上去（越过开仓价也没关系），就是移动止盈；
   * 这种止损被打掉时按「移动止盈」记账（见 advance 里的判因）。
   */
  setSl: (positionId, price) => {
    const pos = get().positions.find((p) => p.id === positionId)
    if (!pos || !Number.isFinite(price)) return
    const cur = currentClose(get)
    if (cur == null) return
    const min = pointOf(pos.digits)
    const sl = pos.side === 'buy' ? Math.min(price, cur - min) : Math.max(price, cur + min)
    set({
      positions: get().positions.map((p) =>
        p.id === positionId ? { ...p, sl: Math.round(sl / min) * min } : p
      )
    })
  },

  /**
   * 拖止盈。
   *
   * 两条约束：
   *  1. 必须在当前价的盈利侧（做多在上方）—— 否则等于市价平仓，不是止盈；
   *  2. 不能比成本价更差（做多不低于开仓价）—— 价格反向运行脱离成本后，
   *     可以把止盈一路降下来放到**成本价**，做平价保护（回到成本就走，不亏不赚）。
   *
   * 注意下限用的是「成本价」而不是「成本价 + 一个点」：
   * 正好放在成本价上才是平价保护，差一个点就永远是笔小亏。
   */
  setTp: (positionId, price) => {
    const pos = get().positions.find((p) => p.id === positionId)
    if (!pos || !Number.isFinite(price)) return
    const cur = currentClose(get)
    if (cur == null) return
    const min = pointOf(pos.digits)
    const tp =
      pos.side === 'buy'
        ? Math.max(price, pos.entryPrice, cur + min)
        : Math.min(price, pos.entryPrice, cur - min)
    set({
      positions: get().positions.map((p) =>
        p.id === positionId ? { ...p, tp: Math.round(tp / min) * min } : p
      )
    })
  },

  selectPosition: (positionId) => {
    if (positionId == null) {
      set({ activePositionId: null })
      return
    }
    if (!get().positions.some((p) => p.id === positionId)) return
    set({ activePositionId: positionId })
  },

  persistState: () => {
    const {
      activeSession,
      cursor,
      bars,
      cursorTime,
      balance,
      barsPerSec,
      timeframe,
      drawings,
      overlays,
      subPanes
    } = get()
    if (!activeSession) return
    lastPersistAt = Date.now()
    void window.api.saveSessionState(activeSession.id, {
      currentIndex: cursor,
      speed: barsPerSec,
      balance,
      // 存「精确到分钟」的位置，不是当前周期的桶起点：
      // 下次打开 / 切周期都靠它把游标放回原处，桶起点会把位置往回吞一整格
      currentBarTime: cursorTime || bars[cursor]?.time || null,
      displayTimeframe: timeframe,
      // 必须每次带上，否则会被置空
      drawingsJson: JSON.stringify(drawings),
      indicatorsJson: JSON.stringify({ overlays, subPanes })
    })
  },

  /**
   * 节流落库：回放时每前进一根都会调这里。
   * 保证「关窗口 / 切回会话列表 / 暂停」时进度最多丢 0.8 秒的行情，
   * 同时不会每根 K 线都写一次 sqlite。
   */
  persistSoon: () => {
    if (persistTimer != null) return
    const wait = Math.max(0, PERSIST_INTERVAL - (Date.now() - lastPersistAt))
    persistTimer = setTimeout(() => {
      persistTimer = null
      useTrainingStore.getState().persistState()
    }, wait)
  },

  /** 立即落库（忽略节流），用于暂停 / 关闭会话 / 窗口关闭前 */
  flushPersist: () => {
    if (persistTimer != null) {
      clearTimeout(persistTimer)
      persistTimer = null
    }
    get().persistState()
  }
}))

/**
 * 解析会话里存的指标配置。
 * 新格式是 `{ overlays: [实例], subPanes: [实例] }`；
 * 老格式是 `{ overlays: ['ma5', ...], subPane: 'macd' }`，交给同一个 normalize 兜住。
 */
function parseIndicators(json: string | null | undefined): {
  overlays: IndicatorInstance[]
  subPanes: IndicatorInstance[]
} {
  if (!json) return { overlays: [], subPanes: [] }
  try {
    const prefs = normalizeIndicatorPrefs(JSON.parse(json))
    return { overlays: prefs.overlays, subPanes: prefs.subPanes }
  } catch {
    return { overlays: [], subPanes: [] }
  }
}

function parseDrawings(json: string | null | undefined): Drawing[] {
  if (!json) return []
  try {
    const arr = JSON.parse(json)
    if (!Array.isArray(arr)) return []
    return arr.filter(
      (d: any) => d && typeof d.id === 'string' && typeof d.type === 'string' && d.p1
    ) as Drawing[]
  } catch {
    return []
  }
}

function fmtDay(ts: number): string {
  const d = new Date(ts * 1000)
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${d.getUTCFullYear()}-${m}-${day}`
}

// ---------- 交易时段 ----------

/** 当前回测集的交易时段；null = 全天不限 */
export function activeTradeWindow(): TradeWindow | null {
  const s = useTrainingStore.getState()
  return normalizeTradeWindow(s.activeSession?.trade_window)
}

/**
 * 某个时刻能否开仓；不能则返回给用户看的理由，能则返回 null。
 * 判定用的是「该会话自己的时区」，与订单时间显示保持一致。
 */
export function tradeWindowBlockAt(sec: number): string | null {
  const w = activeTradeWindow()
  if (!w) return null
  const tz = useTimezoneStore.getState().effective
  if (inTradeWindow(sec, tz, w)) return null
  return `当前 ${fmtTzClock(sec, tz)} 不在交易时段 ${fmtTradeWindow(w)} 内，无法开仓`
}

/** 当前 K 线那根能否开仓（下单入口用这个） */
export function tradeWindowBlock(): string | null {
  const s = useTrainingStore.getState()
  const bar = s.partialBar ?? s.bars[s.cursor]
  if (!bar) return null
  return tradeWindowBlockAt(s.cursorTime || bar.time)
}

// 开发期调试钩子：便于自动化验证直接读实时状态（生产构建不会打包进来）
if (import.meta.env.DEV) {
  ;(window as any).__rw_store = useTrainingStore
}
