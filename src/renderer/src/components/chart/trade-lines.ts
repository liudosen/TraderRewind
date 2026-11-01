// ============================================================
// TraderRewind — 历史成交连线（两个 K 线窗口共用）
//
// 为什么单独一个模块：双周期分屏之后，主图和副周期窗都得画同一批成交连线，
// 而且必须长得一模一样 —— 一边实线一边虚线、一边红一边绿，对照就失去意义了。
// 顺带把「点一笔订单要定位到哪里」也算在这里，两个窗口的定位口径也统一。
// ============================================================

import type { ClosedTrade } from '../../stores/training-store'
import type { ChartMapping, Viewport } from './drawings'

/** 盈利 = 红、亏损 = 绿（跟随全局的国内配色约定） */
export const TRADE_WIN_COLOR = '#ef4444'
export const TRADE_LOSS_COLOR = '#22c55e'
/** 成交端点三角形：半宽 / 高 */
const TRI_HALF = 5
const TRI_H = 7.5

/**
 * 点击订单定位时固定显示的 K 线根数。
 *
 * 固定「相对根数」而不是「整段铺满」，好处是每次定位屏幕上的柱宽都一样：
 * 150 根按图表宽度均分，窗口一屏正好铺满，既不挤成一团也不会只占半屏。
 */
export const FOCUS_VISIBLE_BARS = 150

/**
 * 在 (x, y) 画一个小实心三角形，dir = -1 朝上、1 朝下。
 * 底边压在价格点上，尖角朝外——这样连线的一端正好落在底边中点。
 * 描一圈深色边，压在 K 线上也能看清。
 */
function drawTriangle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  dir: -1 | 1,
  big = false
): void {
  const half = big ? TRI_HALF + 1.5 : TRI_HALF
  const height = big ? TRI_H + 2 : TRI_H
  const apexY = y + dir * height
  ctx.beginPath()
  ctx.moveTo(x, apexY)
  ctx.lineTo(x - half, y)
  ctx.lineTo(x + half, y)
  ctx.closePath()
  ctx.fill()
  ctx.strokeStyle = 'rgba(0,0,0,0.8)'
  ctx.lineWidth = 1
  ctx.stroke()
}

/**
 * 历史成交连线：把每一笔已平仓订单的「开仓价 @ 开仓时间」和「平仓价 @ 平仓时间」
 * 用一条细虚线连起来，一眼就能看出这单走了多远、是赚是亏。
 * 端点用小三角形表示方向：做多开仓朝上、平仓朝下；做空正好相反。
 * 整段超出可视区时由 canvas 自动裁掉。
 */
export function drawTrades(
  ctx: CanvasRenderingContext2D,
  trades: ClosedTrade[],
  map: ChartMapping,
  view: Viewport,
  focusId?: string | null
): void {
  if (trades.length === 0) return

  ctx.save()
  ctx.beginPath()
  ctx.rect(0, 0, view.width, view.height)
  ctx.clip()

  const paint = (t: ClosedTrade, focused: boolean): void => {
    const x1 = map.timeToX(t.entryTime)
    const y1 = map.priceToY(t.entryPrice)
    const x2 = map.timeToX(t.exitTime)
    const y2 = map.priceToY(t.exitPrice)
    if (x1 == null || y1 == null || x2 == null || y2 == null) return
    if (x1 < -40 && x2 < -40) return
    if (x1 > view.width + 40 && x2 > view.width + 40) return

    const color = t.pnl >= 0 ? TRADE_WIN_COLOR : TRADE_LOSS_COLOR
    ctx.strokeStyle = color
    ctx.fillStyle = color

    // 开仓价 → 平仓价 的连线（被定位的那笔加粗 + 加一层柔光，一眼能挑出来）
    ctx.globalAlpha = focused ? 1 : 0.9
    ctx.lineWidth = focused ? 2 : 1
    ctx.setLineDash(focused ? [6, 3] : [4, 3])
    if (focused) {
      ctx.shadowColor = color
      ctx.shadowBlur = 6
    }
    ctx.beginPath()
    ctx.moveTo(x1, y1)
    ctx.lineTo(x2, y2)
    ctx.stroke()
    ctx.shadowBlur = 0
    ctx.setLineDash([])

    // 端点：开仓三角指向持仓方向，平仓三角反向（尖角朝下 = 这一单结束了）
    ctx.globalAlpha = 1
    const entryUp = t.side === 'buy'
    drawTriangle(ctx, x1, y1, entryUp ? -1 : 1, focused)
    drawTriangle(ctx, x2, y2, entryUp ? 1 : -1, focused)
  }

  // 先画普通成交，最后画被定位的那一笔，保证它在最上层
  for (const t of trades) if (t.id !== focusId) paint(t, false)
  const focusedTrade = focusId ? trades.find((t) => t.id === focusId) : undefined
  if (focusedTrade) paint(focusedTrade, true)

  ctx.restore()
}

export interface FocusRangeInput {
  /** 这个窗口一共有多少根 K 线 */
  total: number
  /** 最后一根允许显示的序号（回放没走完时就是游标那根，不许看见未来） */
  lastRevealed: number
  /** 开仓 / 平仓落在第几根 */
  idxIn: number | null
  idxOut: number | null
}

/**
 * 点一笔订单要定位到哪一段。
 *
 * 固定窗口而不是「整段铺满」：150 根按图表宽度均分，每次定位屏幕上柱宽都一样。
 * 两个窗口都要用同一套口径 —— 各算各的，主图跳 M15 的 150 根、副窗跳 H1 的 150 根，
 * 结果就是两边停在完全不同的时间段上。
 *
 * 返回 null 表示「这笔单不该定位」（在游标之后，压根还没发生）。
 */
export function focusLogicalRange({
  total,
  lastRevealed,
  idxIn,
  idxOut
}: FocusRangeInput): { from: number; to: number } | null {
  const n = total
  if (n <= 1 || idxIn == null) return null

  const last = Math.max(0, Math.min(lastRevealed, n - 1))
  // 这笔单在游标之后（或压根不属于这一段），宁可不定位也不许把未来露出来
  if (Math.round(idxIn) > last) return null

  // 以开仓那根为锚点；但这笔单子本身不到一屏时，改用「开→平」的中点，
  // 不然持仓很久的单子只能看到开仓、平仓被挤出屏幕外。
  let anchor = idxIn
  if (idxOut != null && idxOut > idxIn && idxOut - idxIn <= FOCUS_VISIBLE_BARS - 20) {
    anchor = (idxIn + idxOut) / 2
  }

  const half = Math.floor(FOCUS_VISIBLE_BARS / 2)
  const span = FOCUS_VISIBLE_BARS - 1
  // 锚点本身也不许越过上限（跨游标持仓取中点时可能出现）
  const a = Math.min(anchor, last)
  let from = Math.round(a) - half
  let to = from + span
  // 贴着开头：整体右移，跨度不变（否则前几笔只能看到半屏）
  if (from < 0) {
    to -= from
    from = 0
  }
  // 贴着「当前可见上限」：整体左移，跨度不变
  if (to > last) {
    from = Math.max(0, from - (to - last))
    to = last
  }
  return { from, to }
}
