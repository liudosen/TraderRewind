// ============================================================
// TraderRewind — 交易时段（盘口时限）
//
// 目的：训练纪律。用户只想在「早上 7 点到晚上 23 点」这类时段内做单，
// 时段之外按买入/卖出会被拦住。
//
// 约定：
// - 时段按「该回测集自己的时区」解释（与订单时间显示同一套时区），
//   不是 UTC，也不是浏览器本地时区。
// - 支持跨零点：from > to 表示「22:00 → 次日 06:00」。
// - from === to 视为「全天不限」（零长度区间没有意义，直接当没设）。
// - 只限制「开仓」，平仓永远放行 —— 不能把用户锁在仓位里出不来。
// ============================================================

import { tzPartsFromSec } from './timezone'

/** 交易时段，HH:mm（24 小时制） */
export interface TradeWindow {
  /** 起始时刻，含 */
  from: string
  /** 结束时刻，不含 */
  to: string
}

const HM_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/

/** 任意输入 → 'HH:mm'，非法返回 null */
export function normalizeHm(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const m = HM_RE.exec(value.trim())
  if (!m) return null
  return `${m[1].padStart(2, '0')}:${m[2]}`
}

/**
 * 任意输入 → 合法交易时段；无效 / 全天 / 不限制都返回 null。
 * 兼容三种存法：null、'07:00-23:00' 字符串（数据库里就存这个）、{from,to} 对象。
 */
export function normalizeTradeWindow(value: unknown): TradeWindow | null {
  if (value == null) return null

  let from: string | null = null
  let to: string | null = null

  if (typeof value === 'string') {
    const m = /^\s*(\d{1,2}:\d{2})\s*[-~]\s*(\d{1,2}:\d{2})\s*$/.exec(value)
    if (!m) return null
    from = normalizeHm(m[1])
    to = normalizeHm(m[2])
  } else if (typeof value === 'object') {
    const o = value as Record<string, unknown>
    from = normalizeHm(o.from)
    to = normalizeHm(o.to)
  }

  if (!from || !to) return null
  // 首尾相同 = 零长度，当「不限」处理
  if (from === to) return null
  return { from, to }
}

/** 落库用：'07:00-23:00' | null */
export function serializeTradeWindow(w: TradeWindow | null): string | null {
  const n = normalizeTradeWindow(w)
  return n ? `${n.from}-${n.to}` : null
}

/** 'HH:mm' → 一天中的第几分钟 */
export function hmToMinutes(hm: string): number {
  const [h, m] = hm.split(':').map(Number)
  return h * 60 + m
}

/** 是否跨零点 */
export function isOvernight(w: TradeWindow): boolean {
  return hmToMinutes(w.from) > hmToMinutes(w.to)
}

/** 给界面看的文案：'07:00–23:00'（跨零点时加「次日」） */
export function fmtTradeWindow(w: TradeWindow | null): string {
  const n = normalizeTradeWindow(w)
  if (!n) return '全天'
  return isOvernight(n) ? `${n.from}–次日 ${n.to}` : `${n.from}–${n.to}`
}

/**
 * 某个时刻（UTC 秒，与 bar.time 同轴）是否落在时段内。
 * tz 传该会话的生效时区；w 为 null 表示不限，永远放行。
 */
export function inTradeWindow(sec: number, tz: unknown, w: TradeWindow | null): boolean {
  const n = normalizeTradeWindow(w)
  if (!n) return true
  if (!Number.isFinite(sec)) return true
  const t = tzPartsFromSec(sec, tz)
  const mins = t.hour * 60 + t.minute
  const a = hmToMinutes(n.from)
  const b = hmToMinutes(n.to)
  return a < b ? mins >= a && mins < b : mins >= a || mins < b
}

/** 时段长度（分钟），跨零点按 24h 折算 */
export function tradeWindowMinutes(w: TradeWindow): number {
  const a = hmToMinutes(w.from)
  const b = hmToMinutes(w.to)
  return b > a ? b - a : 24 * 60 - a + b
}

/**
 * 下一个交易时段的**开门时刻**（UTC 秒，与 bar.time 同轴）。
 *
 * 只在「当前不在时段内」时有意义 —— 已经开着盘就没什么可跳的，返回 null。
 * 同样返回 null 的还有：没设时段、输入不合法。
 *
 * 算法是先按时钟直接算，再用 inTradeWindow 复核：夏令时切换那天「今天 + N 分钟」
 * 未必还落在预期的钟点上，复核不过就退化成逐分钟探测（最多两天，足够跨过一个
 * 周末）。这样既不用每次都扫几千次，也不会在时区边界上给出错误答案。
 */
export function nextTradeWindowStart(
  sec: number,
  tz: unknown,
  w: TradeWindow | null
): number | null {
  const n = normalizeTradeWindow(w)
  if (!n || !Number.isFinite(sec)) return null
  if (inTradeWindow(sec, tz, n)) return null

  const t = tzPartsFromSec(sec, tz)
  const mins = t.hour * 60 + t.minute
  const a = hmToMinutes(n.from)

  /**
   * 落在关盘区间里，离下一次开门还有几分钟。
   * 三种情形刚好覆盖完：跨零点时段永远在「今天开门之前」；
   * 同日时段则要分清是「今天还没开」还是「今天已经收了」。
   */
  const waitMin = isOvernight(n) ? a - mins : mins < a ? a - mins : 24 * 60 - mins + a

  const base = Math.floor(sec / 60) * 60
  const guess = base + waitMin * 60
  if (inTradeWindow(guess, tz, n)) return guess

  for (let i = 1; i <= 2 * 24 * 60; i++) {
    const probe = base + i * 60
    if (inTradeWindow(probe, tz, n)) return probe
  }
  return null
}
