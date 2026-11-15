// ============================================================
// TraderRewind — 交易截图公共逻辑
//
// 手动「添加截图」和「订单结束后自动截图」必须用同一套口径：
//  · 读同一段 K 线（开仓前至少 150 根）；
//  · 画同一条开平仓线和标记；
//  · 合成同样的顶部信息条。
// 这个模块只放纯函数，图表实例由调用方（弹窗 / 离屏截图器）自己管理。
// ============================================================

import { aggregateBars, bufferToBars, timeframeSeconds, timeframeCode, type Bar } from '@shared/utils/timeframe'
import { tzPartsFromSec } from '@shared/types/timezone'
import type { ChartTheme } from '@shared/types/chart-theme'
import type { ClosedTrade } from '../../stores/training-store'
import { formatPrice, formatSigned } from '../../utils/format'

export interface TradeShotImage {
  dataUrl: string
  width: number
  height: number
}

/** 离屏截图的画布尺寸（CSS px）；截图信息条会按设备像素比另加高度 */
export const TRADE_SHOT_CSS_WIDTH = 1120
export const TRADE_SHOT_CSS_HEIGHT = 700

/** 秒级时间按展示时区切成「MM-DD HH:mm」 */
export function stampTime(sec: number, tz: string): string {
  const p = tzPartsFromSec(sec, tz)
  const n = (v: number): string => String(v).padStart(2, '0')
  return `${n(p.month)}-${n(p.day)} ${n(p.hour)}:${n(p.minute)}`
}

/** 主题背景是浅色时，截图顶栏要换成深色字，否则白底白字 */
function isLightBackground(color: string): boolean {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color)
  if (hex) {
    const h = hex[1]
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
    const r = parseInt(full.slice(0, 2), 16)
    const g = parseInt(full.slice(2, 4), 16)
    const b = parseInt(full.slice(4, 6), 16)
    return 0.299 * r + 0.587 * g + 0.114 * b > 160
  }
  const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(color)
  if (rgb) {
    return 0.299 * Number(rgb[1]) + 0.587 * Number(rgb[2]) + 0.114 * Number(rgb[3]) > 160
  }
  return false
}

/** 在已聚合的 K 线里找「不晚于 t」的最近一根（找不到就用第一根） */
export function snapBarTime(bars: Bar[], t: number): number | null {
  if (bars.length === 0) return null
  let lo = 0
  let hi = bars.length - 1
  let best = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (bars[mid].time <= t) {
      best = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return bars[best >= 0 ? best : 0].time
}

/**
 * 读一笔交易前后的 K 线。
 *
 * 开仓前至少 150 根真实 K 线，平仓后 60 根。先按 200 根去要，
 * 遇到周末 / 休市缺口时按缺口继续往前补（最多两轮）。
 *
 * @param baseTf 数据集的原始周期：只有 M1 才能往上聚合，其它周期原样展示
 */
export async function loadTradeBars(
  datasetId: number,
  entryTime: number,
  exitTime: number,
  tf: string,
  baseTf: string
): Promise<Bar[]> {
  const seconds = timeframeSeconds(tf) || 300
  const entry = entryTime
  const exit = Math.max(exitTime, entry + 1)
  const MIN_BEFORE = 150
  const INITIAL_BEFORE = 200
  const AFTER = 60

  const loadFrom = async (from: number): Promise<Bar[]> => {
    const range: any = await window.api.getCandlesRange(
      datasetId,
      Math.floor(from),
      Math.ceil(exit + AFTER * seconds)
    )
    const raw = range?.buffer
      ? bufferToBars(range.buffer as ArrayBuffer, Number(range.count) || 0)
      : []
    return baseTf === 'M1' && tf !== 'M1' ? aggregateBars(raw, tf) : raw
  }

  let from = entry - INITIAL_BEFORE * seconds
  let list = await loadFrom(from)
  let before = list.filter((b) => b.time < entry).length
  for (let round = 0; round < 2 && before < MIN_BEFORE; round++) {
    const missing = MIN_BEFORE - before
    // 1.6 倍余量：缺口里往往还夹着休市时段，按缺失根数等时长补不一定够
    from -= Math.ceil(missing * seconds * 1.6)
    const next = await loadFrom(from)
    const nextBefore = next.filter((b) => b.time < entry).length
    if (nextBefore <= before && next.length <= list.length) break
    list = next
    before = nextBefore
  }
  return list
}

/**
 * 图表画布 + 顶部信息条 → PNG data URL。
 *
 * 信息条不是装饰：单看一张 K 线图，过几天就分不清是哪一单了；
 * 把标的、方向、手数、开平时间、价格和盈亏一起印进图片，导出/分享才有意义。
 */
export function composeTradeShot(
  shot: HTMLCanvasElement,
  opts: {
    trade: ClosedTrade
    timeframe: string
    tz: string
    theme: ChartTheme
    /** 「多 / 空」的本地化文案 */
    sideText: string
    /** 图表容器的 CSS 宽度：用来把设备像素比换算回头部字号 */
    cssWidth: number
  }
): TradeShotImage {
  const { trade, timeframe, tz, theme, sideText, cssWidth } = opts
  const digits = trade.digits
  const pnlColor = trade.pnl >= 0 ? '#ef4444' : '#22c55e'
  const captionCssHeight = 56
  const k = shot.width / Math.max(1, cssWidth)
  const captionH = Math.round(captionCssHeight * k)
  const out = document.createElement('canvas')
  out.width = shot.width
  out.height = shot.height + captionH
  const ctx = out.getContext('2d')
  if (!ctx) return { dataUrl: '', width: out.width, height: out.height }

  const bg = theme.background || '#0b0b0b'
  const lightBg = isLightBackground(bg)
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, out.width, out.height)
  ctx.drawImage(shot, 0, captionH)

  // 顶栏和图表之间的分隔线
  ctx.fillStyle = lightBg ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.10)'
  ctx.fillRect(0, captionH - Math.max(1, k), out.width, Math.max(1, k))

  const padX = Math.round(14 * k)
  ctx.textBaseline = 'middle'

  // 第一行：标的 · 方向/手数 · 周期 · 盈亏
  ctx.font = `600 ${Math.round(14 * k)}px Inter, ui-sans-serif, system-ui, sans-serif`
  ctx.fillStyle = lightBg ? '#111827' : '#e5e5e5'
  const head = `${trade.symbol}  ${sideText} ${trade.lot.toFixed(2)}  ·  ${timeframeCode(timeframe)}`
  ctx.fillText(head, padX, Math.round(captionH * 0.34))

  const pnlText = formatSigned(trade.pnl)
  const headWidth = ctx.measureText(head).width
  ctx.fillStyle = pnlColor
  ctx.fillText(pnlText, padX + headWidth + Math.round(18 * k), Math.round(captionH * 0.34))

  // 第二行：开→平时间 / 价格
  ctx.font = `${Math.round(11.5 * k)}px Inter, ui-sans-serif, system-ui, sans-serif`
  ctx.fillStyle = lightBg ? '#4b5563' : '#9a9a9a'
  const sub = `${stampTime(trade.entryTime, tz)} → ${stampTime(trade.exitTime, tz)}   ·   ${formatPrice(
    trade.entryPrice,
    digits
  )} → ${formatPrice(trade.exitPrice, digits)}`
  ctx.fillText(sub, padX, Math.round(captionH * 0.72))

  // 右上角水印
  ctx.font = `${Math.round(10.5 * k)}px Inter, ui-sans-serif, system-ui, sans-serif`
  ctx.fillStyle = lightBg ? 'rgba(0,0,0,0.30)' : 'rgba(255,255,255,0.28)'
  ctx.textAlign = 'right'
  ctx.fillText('TraderRewind', out.width - padX, Math.round(captionH * 0.55))
  ctx.textAlign = 'left'

  return { dataUrl: out.toDataURL('image/png'), width: out.width, height: out.height }
}
