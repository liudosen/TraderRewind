// ============================================================
// TraderRewind — 技术指标计算（基于已聚合的 K 线）
// 全部只依赖当前及历史 K 线，不存在未来函数
//
// 这里同时是「指标清单 + 参数 schema」的唯一来源：
//  · 菜单里显示什么、参数弹窗里有几项、默认值是多少，全部从 OVERLAYS / SUB_PANES 推导
//  · 主图叠加和副图都支持多选，参数由用户自己调，不再写死
// ============================================================

import type { Bar } from './timeframe'

/** 与 bars 等长的指标值序列，预热期为 null */
export type Series = (number | null)[]

/** 某根 K 线的典型价格 */
function tp(b: Bar): number {
  return (b.high + b.low + b.close) / 3
}

// ------------------------------------------------------------
// 基础算法
// ------------------------------------------------------------

export function sma(bars: Bar[], period: number): Series {
  const out: Series = new Array(bars.length).fill(null)
  if (period <= 0) return out
  let sum = 0
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i].close
    if (i >= period) sum -= bars[i - period].close
    if (i >= period - 1) out[i] = sum / period
  }
  return out
}

export function ema(bars: Bar[], period: number): Series {
  const out: Series = new Array(bars.length).fill(null)
  if (period <= 0 || bars.length === 0) return out
  const k = 2 / (period + 1)
  let prev: number | null = null
  for (let i = 0; i < bars.length; i++) {
    const price = bars[i].close
    prev = prev == null ? price : price * k + prev * (1 - k)
    if (i >= period - 1) out[i] = prev
  }
  return out
}

export function boll(
  bars: Bar[],
  period = 20,
  mult = 2
): { upper: Series; middle: Series; lower: Series } {
  const middle = sma(bars, period)
  const upper: Series = new Array(bars.length).fill(null)
  const lower: Series = new Array(bars.length).fill(null)

  for (let i = 0; i < bars.length; i++) {
    if (middle[i] == null) continue
    let sum = 0
    for (let j = i - period + 1; j <= i; j++) {
      const d = bars[j].close - (middle[i] as number)
      sum += d * d
    }
    const sd = Math.sqrt(sum / period)
    upper[i] = (middle[i] as number) + mult * sd
    lower[i] = (middle[i] as number) - mult * sd
  }
  return { upper, middle, lower }
}

export function macd(
  bars: Bar[],
  fast = 12,
  slow = 26,
  signalPeriod = 9
): { dif: Series; dea: Series; hist: Series } {
  const emaFast = ema(bars, fast)
  const emaSlow = ema(bars, slow)
  const dif: Series = new Array(bars.length).fill(null)

  for (let i = 0; i < bars.length; i++) {
    if (emaFast[i] != null && emaSlow[i] != null) {
      dif[i] = (emaFast[i] as number) - (emaSlow[i] as number)
    }
  }

  // DEA = DIF 的 signalPeriod 日 EMA（从首个有效 DIF 开始）
  const dea: Series = new Array(bars.length).fill(null)
  const hist: Series = new Array(bars.length).fill(null)
  const k = 2 / (signalPeriod + 1)
  let prev: number | null = null
  let seen = 0
  for (let i = 0; i < bars.length; i++) {
    const v = dif[i]
    if (v == null) continue
    seen++
    prev = prev == null ? v : v * k + prev * (1 - k)
    if (seen >= signalPeriod) {
      dea[i] = prev
      hist[i] = (v - prev) * 2
    }
  }
  return { dif, dea, hist }
}

export function rsi(bars: Bar[], period = 14): Series {
  const out: Series = new Array(bars.length).fill(null)
  if (bars.length < period + 1) return out

  let gain = 0
  let loss = 0
  for (let i = 1; i <= period; i++) {
    const diff = bars[i].close - bars[i - 1].close
    if (diff >= 0) gain += diff
    else loss -= diff
  }
  let avgGain = gain / period
  let avgLoss = loss / period
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)

  for (let i = period + 1; i < bars.length; i++) {
    const diff = bars[i].close - bars[i - 1].close
    const g = diff > 0 ? diff : 0
    const l = diff < 0 ? -diff : 0
    avgGain = (avgGain * (period - 1) + g) / period
    avgLoss = (avgLoss * (period - 1) + l) / period
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  }
  return out
}

/** KDJ：先算 RSV，K/D 再做 kPeriod / dPeriod 平滑，J = 3K - 2D */
export function kdj(
  bars: Bar[],
  n = 9,
  kPeriod = 3,
  dPeriod = 3
): { k: Series; d: Series; j: Series } {
  const len = bars.length
  const k: Series = new Array(len).fill(null)
  const d: Series = new Array(len).fill(null)
  const j: Series = new Array(len).fill(null)
  if (n <= 0 || len === 0) return { k, d, j }

  let prevK = 50
  let prevD = 50
  for (let i = 0; i < len; i++) {
    if (i < n - 1) continue
    let hh = -Infinity
    let ll = Infinity
    for (let x = i - n + 1; x <= i; x++) {
      if (bars[x].high > hh) hh = bars[x].high
      if (bars[x].low < ll) ll = bars[x].low
    }
    const rsv = hh === ll ? 50 : ((bars[i].close - ll) / (hh - ll)) * 100
    prevK = ((kPeriod - 1) * prevK + rsv) / kPeriod
    prevD = ((dPeriod - 1) * prevD + prevK) / dPeriod
    k[i] = prevK
    d[i] = prevD
    j[i] = 3 * prevK - 2 * prevD
  }
  return { k, d, j }
}

/** CCI：(TP - MA(TP)) / (0.015 × 平均绝对偏差) */
export function cci(bars: Bar[], period = 14): Series {
  const len = bars.length
  const out: Series = new Array(len).fill(null)
  if (period <= 0) return out

  const tps = bars.map(tp)
  for (let i = 0; i < len; i++) {
    if (i < period - 1) continue
    let sum = 0
    for (let x = i - period + 1; x <= i; x++) sum += tps[x]
    const ma = sum / period
    let dev = 0
    for (let x = i - period + 1; x <= i; x++) dev += Math.abs(tps[x] - ma)
    const md = dev / period
    out[i] = md === 0 ? 0 : (tps[i] - ma) / (0.015 * md)
  }
  return out
}

/** ATR：真实波幅的 Wilder 平滑 */
export function atr(bars: Bar[], period = 14): Series {
  const len = bars.length
  const out: Series = new Array(len).fill(null)
  if (period <= 0 || len === 0) return out

  const tr: number[] = new Array(len).fill(0)
  for (let i = 0; i < len; i++) {
    if (i === 0) {
      tr[i] = bars[i].high - bars[i].low
    } else {
      const pc = bars[i - 1].close
      tr[i] = Math.max(
        bars[i].high - bars[i].low,
        Math.abs(bars[i].high - pc),
        Math.abs(bars[i].low - pc)
      )
    }
  }

  let sum = 0
  for (let i = 0; i < Math.min(period, len); i++) sum += tr[i]
  if (len < period) return out
  let prev = sum / period
  out[period - 1] = prev
  for (let i = period; i < len; i++) {
    prev = (prev * (period - 1) + tr[i]) / period
    out[i] = prev
  }
  return out
}

/** OBV：涨加量、跌减量 */
export function obv(bars: Bar[]): Series {
  const out: Series = new Array(bars.length).fill(null)
  let acc = 0
  for (let i = 0; i < bars.length; i++) {
    if (i > 0) {
      if (bars[i].close > bars[i - 1].close) acc += bars[i].volume
      else if (bars[i].close < bars[i - 1].close) acc -= bars[i].volume
    }
    out[i] = acc
  }
  return out
}

// ------------------------------------------------------------
// 指标清单 + 参数 schema
// ------------------------------------------------------------

export interface ParamField {
  /** 参数键（存盘用，别随便改） */
  key: string
  label: string
  min: number
  max: number
  step: number
  /** 填 0 表示这条线「关掉」（均线这类多条线的指标用） */
  zeroOff?: boolean
}

export interface IndicatorDef<I extends string> {
  id: I
  label: string
  params: ParamField[]
  defaults: Record<string, number>
}

export type OverlayId = 'ema' | 'boll'
export type SubPaneId = 'vol' | 'macd' | 'rsi' | 'kdj' | 'cci' | 'atr' | 'obv'
export type IndicatorId = OverlayId | SubPaneId

/**
 * 一个「已添加的指标」。
 *
 * 同一个指标允许添加多次（比如同时看 RSI(14) 和 RSI(6)、两条不同周期的均线），
 * 所以列表里存的是实例而不是 id：每个实例有自己的 uid 和参数。
 */
export interface IndicatorInstance {
  /** 实例唯一 id（区分同名的两个 RSI） */
  uid: string
  id: IndicatorId
  params: Record<string, number>
  /** 自定义线色，键是 ColorSlot.slot；没设过的槽位用默认色 */
  colors?: Record<string, string>
}

export type IndicatorParams = Partial<Record<IndicatorId, Record<string, number>>>

/** 是否是主图叠加类指标 */
export function isOverlayId(id: IndicatorId): boolean {
  return OVERLAYS.some((o) => o.id === id)
}

/** 指标挂在哪儿：主图叠加 / 副图 */
export type IndicatorKind = 'overlay' | 'sub'

/** 实例 uid：不用 crypto.randomUUID（打包后 file:// 不算安全上下文，可能取不到） */
let instanceSeq = 0
export function createInstanceUid(): string {
  instanceSeq = (instanceSeq + 1) % 1_000_000
  return `${Date.now().toString(36)}${instanceSeq.toString(36)}${Math.random()
    .toString(36)
    .slice(2, 6)}`
}

/** EMA 均线的三条线配色 */
export const EMA_COLORS = ['#f59e0b', '#38bdf8', '#a78bfa']

/**
 * 主图叠加。
 * MA5 / MA20 / MA60 / EMA12 / EMA26 本质都是均线，统一成一个「EMA 均线」入口：
 * 想画几条就填几个周期（0 = 不画），不再在菜单里堆一长串固定周期。
 */
export const OVERLAYS: (IndicatorDef<OverlayId> & { color: string })[] = [
  {
    id: 'ema',
    label: 'EMA 均线',
    color: EMA_COLORS[0],
    params: [
      { key: 'p1', label: '周期1', min: 0, max: 500, step: 1, zeroOff: true },
      { key: 'p2', label: '周期2', min: 0, max: 500, step: 1, zeroOff: true },
      { key: 'p3', label: '周期3', min: 0, max: 500, step: 1, zeroOff: true }
    ],
    defaults: { p1: 12, p2: 26, p3: 0 }
  },
  {
    id: 'boll',
    label: 'BOLL 布林带',
    color: '#94a3b8',
    params: [
      { key: 'period', label: '周期', min: 2, max: 200, step: 1 },
      { key: 'mult', label: '倍数', min: 0.5, max: 5, step: 0.1 }
    ],
    defaults: { period: 20, mult: 2 }
  }
]

export const SUB_PANES: IndicatorDef<SubPaneId>[] = [
  { id: 'vol', label: '成交量', params: [], defaults: {} },
  {
    id: 'macd',
    label: 'MACD',
    params: [
      { key: 'fast', label: '快线', min: 1, max: 200, step: 1 },
      { key: 'slow', label: '慢线', min: 2, max: 400, step: 1 },
      { key: 'signal', label: '信号', min: 1, max: 100, step: 1 }
    ],
    defaults: { fast: 12, slow: 26, signal: 9 }
  },
  {
    id: 'rsi',
    label: 'RSI',
    params: [{ key: 'period', label: '周期', min: 2, max: 100, step: 1 }],
    defaults: { period: 14 }
  },
  {
    id: 'kdj',
    label: 'KDJ',
    params: [
      { key: 'n', label: 'N', min: 2, max: 100, step: 1 },
      { key: 'kPeriod', label: 'K', min: 1, max: 50, step: 1 },
      { key: 'dPeriod', label: 'D', min: 1, max: 50, step: 1 }
    ],
    defaults: { n: 9, kPeriod: 3, dPeriod: 3 }
  },
  {
    id: 'cci',
    label: 'CCI',
    params: [{ key: 'period', label: '周期', min: 2, max: 200, step: 1 }],
    defaults: { period: 14 }
  },
  {
    id: 'atr',
    label: 'ATR',
    params: [{ key: 'period', label: '周期', min: 2, max: 200, step: 1 }],
    defaults: { period: 14 }
  },
  { id: 'obv', label: 'OBV', params: [], defaults: {} }
]

/** 副图最多能同时开几个（再多每块就矮得看不清了） */
export const MAX_SUB_PANES = 4

// ------------------------------------------------------------
// 颜色
// ------------------------------------------------------------

/**
 * 可单独配色的「线槽位」。
 *
 * 多线指标（MA 三条、布林三轨、MACD 两线、KDJ 三线）必须一条一条配，
 * 只给一个颜色的话几条线会同色，等于看不出哪条是哪条。
 * slot 要和参数键 / 线的语义绑定，不能按下标走 —— 否则改个周期颜色就串位了。
 */
export interface ColorSlot {
  /** 稳定键（存盘用，别随便改） */
  slot: string
  label: string
  /** 默认色 */
  color: string
}

const COLOR_SLOTS: Record<IndicatorId, ColorSlot[]> = {
  ema: [
    { slot: 'p1', label: '周期1', color: EMA_COLORS[0] },
    { slot: 'p2', label: '周期2', color: EMA_COLORS[1] },
    { slot: 'p3', label: '周期3', color: EMA_COLORS[2] }
  ],
  boll: [
    { slot: 'up', label: '上轨', color: '#94a3b8' },
    { slot: 'mid', label: '中轨', color: '#64748b' },
    { slot: 'low', label: '下轨', color: '#94a3b8' }
  ],
  // 成交量是逐根按涨跌上色的，颜色归「设置 → 图表主题」管，指标里不给单独改
  vol: [],
  macd: [
    { slot: 'dif', label: 'DIF', color: '#38bdf8' },
    { slot: 'dea', label: 'DEA', color: '#f59e0b' }
  ],
  rsi: [{ slot: 'main', label: '线', color: '#c084fc' }],
  kdj: [
    { slot: 'k', label: 'K', color: '#f59e0b' },
    { slot: 'd', label: 'D', color: '#38bdf8' },
    { slot: 'j', label: 'J', color: '#f472b6' }
  ],
  cci: [{ slot: 'main', label: '线', color: '#22d3ee' }],
  atr: [{ slot: 'main', label: '线', color: '#fb923c' }],
  obv: [{ slot: 'main', label: '线', color: '#a3e635' }]
}

/** 这个指标能单独配几处颜色（空数组 = 颜色由主题控制） */
export function indicatorColorSlots(id: IndicatorId): ColorSlot[] {
  return COLOR_SLOTS[id] ?? []
}

/** 合法颜色：只认 #rgb / #rrggbb，别的（rgba、颜色名）一律当脏数据丢掉 */
export function isHexColor(v: unknown): v is string {
  return typeof v === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)
}

/** 把实例上的自定义色补成一份完整的「槽位 → 颜色」映射 */
export function resolveColors(
  id: IndicatorId,
  custom?: Record<string, string> | null
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const s of indicatorColorSlots(id)) {
    const v = custom?.[s.slot]
    out[s.slot] = isHexColor(v) ? v : s.color
  }
  return out
}

/** 图例色条用的代表色：取第一条线的实际颜色 */
export function instancePrimaryColor(inst: IndicatorInstance): string {
  const slots = indicatorColorSlots(inst.id)
  if (slots.length === 0) return INDICATOR_COLORS[inst.id] ?? '#94a3b8'
  return resolveColors(inst.id, inst.colors)[slots[0].slot]
}

function findDef(id: IndicatorId): IndicatorDef<IndicatorId> {
  const found =
    (OVERLAYS.find((o) => o.id === id) as IndicatorDef<IndicatorId> | undefined) ??
    (SUB_PANES.find((s) => s.id === id) as IndicatorDef<IndicatorId> | undefined)
  return found ?? { id, label: id, params: [], defaults: {} }
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v
}

/** 把存盘里可能残缺 / 越界的参数补成一份完整可用的参数 */
export function resolveParams(
  id: IndicatorId,
  all?: IndicatorParams | null
): Record<string, number> {
  const def = findDef(id)
  const out: Record<string, number> = { ...def.defaults }
  const raw = all?.[id]
  if (raw) {
    for (const f of def.params) {
      const v = raw[f.key]
      if (typeof v === 'number' && Number.isFinite(v)) out[f.key] = clamp(v, f.min, f.max)
    }
  }
  return out
}

/** 新建一个指标实例（参数用该指标的默认值） */
export function makeInstance(id: IndicatorId, params?: Record<string, number> | null): IndicatorInstance {
  return { uid: createInstanceUid(), id, params: params ?? resolveParams(id) }
}

/** 指标在菜单 / 图例里的原始名字（不带参数） */
export function indicatorLabel(id: IndicatorId): string {
  return findDef(id).label
}

/** 该指标支持调哪些参数 */
export function indicatorFields(id: IndicatorId): ParamField[] {
  return findDef(id).params
}

/** 图例色块 / 菜单色条用的代表色 */
export const INDICATOR_COLORS: Record<IndicatorId, string> = {
  ema: EMA_COLORS[0],
  boll: '#94a3b8',
  vol: '#64748b',
  macd: '#38bdf8',
  rsi: '#c084fc',
  kdj: '#f472b6',
  cci: '#22d3ee',
  atr: '#fb923c',
  obv: '#a3e635'
}

/** 图例 / 菜单里显示的名字，带上当前参数：EMA(12,26) / BOLL(20,2) / RSI(14) */export function indicatorTitle(
  id: IndicatorId,
  params?: Record<string, number> | null
): string {
  const def = findDef(id)
  const p = params ?? resolveParams(id)
  const vals = def.params
    .filter((f) => !(f.zeroOff && !p[f.key]))
    .map((f) => String(Number.isInteger(f.step) ? Math.round(p[f.key] ?? 0) : p[f.key] ?? 0))
  const base = def.label.split(' ')[0]
  return vals.length > 0 ? `${base}(${vals.join(',')})` : def.label
}

// ------------------------------------------------------------
// 渲染数据
// ------------------------------------------------------------

export interface OverlayLine {
  key: string
  /** 对应的颜色槽位（十字线读数按它取色/取当前值） */
  slot: string
  color: string
  values: Series
}

/** 主图叠加要画的线 */
export function overlayLines(
  id: OverlayId,
  bars: Bar[],
  params?: Record<string, number> | null,
  colors?: Record<string, string> | null
): OverlayLine[] {
  const p = params ?? resolveParams(id)
  const c = resolveColors(id, colors)
  if (id === 'ema') {
    const out: OverlayLine[] = []
    const periods = [p.p1, p.p2, p.p3]
    periods.forEach((period, i) => {
      if (!period || period < 1) return
      const slot = `p${i + 1}`
      out.push({
        key: `ema_${Math.round(period)}`,
        slot,
        color: c[slot] ?? EMA_COLORS[i % EMA_COLORS.length],
        values: ema(bars, Math.round(period))
      })
    })
    return out
  }
  const { upper, middle, lower } = boll(bars, Math.round(p.period ?? 20), p.mult ?? 2)
  return [
    { key: 'boll_up', slot: 'up', color: c.up, values: upper },
    { key: 'boll_mid', slot: 'mid', color: c.mid, values: middle },
    { key: 'boll_low', slot: 'low', color: c.low, values: lower }
  ]
}

export interface SubPaneSeries {
  key: string
  /** 对应的颜色槽位 / 读数标签（hist 用 hist、单线用 main） */
  slot: string
  type: 'line' | 'hist'
  values: Series
  color?: string
  /** hist 专用：逐根颜色（长度与 values 一致，空串表示跟默认色） */
  colors?: string[]
  lineWidth?: 1 | 2
}

export interface SubPaneGuide {
  value: number
  /** 不填用默认灰 */
  color?: string
}

export interface SubPaneView {
  id: SubPaneId
  title: string
  series: SubPaneSeries[]
  /** 参考线（RSI 70/30、CCI ±100 之类） */
  guides: SubPaneGuide[]
  /** 数值轴格式 */
  format: 'volume' | 'price' | 'plain'
}

function alpha(hex: string, a: number): string {
  const h = hex.replace('#', '')
  const full =
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h
  const r = parseInt(full.slice(0, 2), 16)
  const g = parseInt(full.slice(2, 4), 16)
  const b = parseInt(full.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${a})`
}

/** 副图要画的内容（多选时每个指标各占一个 pane） */
export function subPaneView(
  id: SubPaneId,
  bars: Bar[],
  params: Record<string, number> | null,
  theme: { upColor: string; downColor: string },
  colors?: Record<string, string> | null
): SubPaneView {
  const p = params ?? resolveParams(id)
  const title = indicatorTitle(id, p)
  const c = resolveColors(id, colors)

  if (id === 'vol') {
    return {
      id,
      title,
      guides: [],
      format: 'volume',
      series: [
        {
          key: 'vol',
          slot: 'vol',
          type: 'hist',
          values: bars.map((b) => b.volume),
          colors: bars.map((b) =>
            b.close >= b.open ? alpha(theme.upColor, 0.55) : alpha(theme.downColor, 0.55)
          )
        }
      ]
    }
  }

  if (id === 'macd') {
    const fast = Math.max(1, Math.round(p.fast ?? 12))
    const slow = Math.max(2, Math.round(p.slow ?? 26))
    const sig = Math.max(1, Math.round(p.signal ?? 9))
    const { dif, dea, hist } = macd(bars, fast, slow, sig)
    return {
      id,
      title,
      format: 'plain',
      guides: [{ value: 0, color: 'rgba(255,255,255,0.18)' }],
      series: [
        {
          key: 'macd_hist',
          slot: 'hist',
          type: 'hist',
          values: hist,
          colors: hist.map((v) =>
            v == null ? '' : v >= 0 ? alpha(theme.upColor, 0.65) : alpha(theme.downColor, 0.65)
          )
        },
        { key: 'macd_dif', slot: 'dif', type: 'line', values: dif, color: c.dif },
        { key: 'macd_dea', slot: 'dea', type: 'line', values: dea, color: c.dea }
      ]
    }
  }

  if (id === 'rsi') {
    return {
      id,
      title,
      format: 'plain',
      guides: [
        { value: 70, color: 'rgba(239,68,68,0.35)' },
        { value: 30, color: 'rgba(34,197,94,0.35)' }
      ],
      series: [
        {
          key: 'rsi',
          slot: 'main',
          type: 'line',
          values: rsi(bars, Math.round(p.period ?? 14)),
          color: c.main
        }
      ]
    }
  }

  if (id === 'kdj') {
    const { k, d, j } = kdj(
      bars,
      Math.round(p.n ?? 9),
      Math.round(p.kPeriod ?? 3),
      Math.round(p.dPeriod ?? 3)
    )
    return {
      id,
      title,
      format: 'plain',
      guides: [
        { value: 80, color: 'rgba(239,68,68,0.28)' },
        { value: 20, color: 'rgba(34,197,94,0.28)' }
      ],
      series: [
        { key: 'kdj_k', slot: 'k', type: 'line', values: k, color: c.k },
        { key: 'kdj_d', slot: 'd', type: 'line', values: d, color: c.d },
        { key: 'kdj_j', slot: 'j', type: 'line', values: j, color: c.j }
      ]
    }
  }

  if (id === 'cci') {
    return {
      id,
      title,
      format: 'plain',
      guides: [
        { value: 100, color: 'rgba(239,68,68,0.32)' },
        { value: -100, color: 'rgba(34,197,94,0.32)' },
        { value: 0, color: 'rgba(255,255,255,0.14)' }
      ],
      series: [
        {
          key: 'cci',
          slot: 'main',
          type: 'line',
          values: cci(bars, Math.round(p.period ?? 14)),
          color: c.main
        }
      ]
    }
  }

  if (id === 'atr') {
    return {
      id,
      title,
      format: 'price',
      guides: [],
      series: [
        {
          key: 'atr',
          slot: 'main',
          type: 'line',
          values: atr(bars, Math.round(p.period ?? 14)),
          color: c.main
        }
      ]
    }
  }

  return {
    id: 'obv',
    title,
    format: 'volume',
    guides: [],
    series: [{ key: 'obv', slot: 'main', type: 'line', values: obv(bars), color: c.main }]
  }
}
