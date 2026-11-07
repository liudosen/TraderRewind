// ============================================================
// TraderRewind — 待确认下单票面
//
// 主图和每个副周期窗都可能成为「当前操作窗口」，所以票面不能焊在 ReplayChart 里；
// 抽出来之后两边用同一套 HTML / 文案 / 按钮，视觉和点击行为完全一致。
// ============================================================

import React, { useEffect, useState } from 'react'
import { Check, ChevronsUpDown, X } from 'lucide-react'
import { useT } from '../../i18n'
import { ENTRY_BUY_COLOR, ENTRY_SELL_COLOR } from './position-lines'

const PANEL_BG = '#1a1a1a'

/**
 * 图表需要的待确认单视图。
 *
 * 文案（手数、风险金额）都由上层拼好传进来 —— 手数格式化、佣金、汇率、
 * 交叉盘折算全在上层，图表不该再算一遍。
 */
export interface PendingOrderView {
  side: 'buy' | 'sell'
  entry: number
  sl: number | null
  tp: number | null
  /** 左侧框：方向 + 手数，例如「买 0.10 手」 */
  lotText: string
  /** 右侧框：按当前止损算出来的金额，例如「-$12.40」；没设止损时是提示文案 */
  riskText: string
  /** 风险金额是不是一笔真实亏损（决定字色：亏=绿/青，赚=红，与全局涨跌色一致） */
  riskIsLoss: boolean
  /** 止损/止盈线轴标签上的金额（没设就空串） */
  slLabel?: string
  tpLabel?: string
}

/**
 * 跟着开仓价线走的操作票面。
 *
 * 为什么用 HTML 而不是画在 canvas 上：这四个都是要点的（确认/取消是按钮），
 * 画在 canvas 上就得自己做命中判定、悬停态、键盘可达性 —— 用 DOM 全是白送的。
 * 它跟着价格线走，所以自己跑一个 requestAnimationFrame 取 y；
 * 只在这个组件内部 setState，不牵动整个图表重渲染。
 */
export function PendingTicket({
  order,
  priceToY,
  onConfirm,
  onCancel
}: {
  order: PendingOrderView
  /** 价格 → 容器内 y 坐标（拿不到时返回 null，比如价格被缩放到视野外） */
  priceToY: (price: number) => number | null
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element | null {
  const { t } = useT()
  const [y, setY] = useState<number | null>(() => priceToY(order.entry))

  useEffect(() => {
    let raf = 0
    let last: number | null = null
    const tick = (): void => {
      const next = priceToY(order.entry)
      // 只在真的动了才 setState：缩放/平移时每帧都在变，但静止时一帧都不该重渲染
      if (next == null ? last != null : last == null || Math.abs(next - last) > 0.5) {
        last = next
        setY(next)
      }
      raf = requestAnimationFrame(tick)
    }
    tick()
    return () => cancelAnimationFrame(raf)
  }, [order.entry, priceToY])

  // 价格跑到视野外就不显示，免得贴在顶部/底部当成「就在那儿」
  if (y == null || y < 0) return null

  const sideColor = order.side === 'buy' ? ENTRY_BUY_COLOR : ENTRY_SELL_COLOR

  return (
    <div
      data-pending-ticket="1"
      className="absolute z-30 flex -translate-y-1/2 items-center gap-1.5"
      style={{ left: 8, top: y }}
    >
      {/* 左框：方向 + 手数 + 调手数的提示。
          手数用等宽字体（扫一眼就能分清 0.10 还是 0.01）；右边的 ⇅ 是**可见的**操作暗示 ——
          只写 title 悬停提示等于没提示，没人会去悬停一个看起来只是标签的框。
          底色写死实色：`bg-[var(--surface-1)]/97` 这种写法 Tailwind 加了透明度修饰符
          也生成不出合法声明（CSS 变量没法在编译期算 alpha），结果是透明 —— K 线直接从
          框里穿过去，金额根本看不清。 */}
      <span
        title={t('chart.pendingLotHint')}
        className="inline-flex h-[21px] cursor-default items-center rounded-[3px] border pl-2 pr-1 text-[11px] font-medium leading-none shadow-[0_1px_5px_rgba(0,0,0,0.7)]"
        style={{
          borderColor: sideColor,
          color: sideColor,
          backgroundColor: PANEL_BG
        }}
      >
        {order.lotText}
        <span
          aria-hidden="true"
          className="ml-1.5 flex h-[21px] items-center gap-0 border-l pl-1 opacity-70"
          style={{ borderColor: sideColor }}
        >
          <ChevronsUpDown size={11} strokeWidth={2.5} />
        </span>
      </span>

      {/* 右框：按当前止损算出来的金额（没设止损时是提示文案，用次级色） */}
      <span
        className="inline-flex h-[21px] items-center rounded-[3px] border border-[var(--border-strong)] px-2 font-mono text-[11px] leading-none shadow-[0_1px_5px_rgba(0,0,0,0.7)]"
        style={{
          color: order.riskIsLoss ? 'var(--c-pos)' : 'var(--text-muted)',
          backgroundColor: PANEL_BG
        }}
      >
        {order.riskText}
      </span>

      <button
        onClick={onConfirm}
        title={t('chart.pendingConfirmHint', { key: order.side === 'buy' ? 'B' : 'S' })}
        className="inline-flex h-[21px] items-center gap-1 rounded-[3px] bg-[var(--c-accent)] px-2 text-[11px] font-medium leading-none text-white shadow-[0_1px_5px_rgba(0,0,0,0.7)] transition hover:brightness-110"
      >
        <Check size={11} strokeWidth={3} />
        {t('chart.pendingConfirm')}
        {/* 快捷键直接印在按钮上：只写在 title 里等于没有 —— 悬停提示得先知道「这里能悬停」 */}
        <kbd className="ml-0.5 rounded-[2px] bg-white/25 px-[3px] py-[1px] font-mono text-[10px] font-semibold leading-none">
          {order.side === 'buy' ? 'B' : 'S'}
        </kbd>
      </button>

      <button
        onClick={onCancel}
        title={t('chart.pendingCancelHint')}
        className="inline-flex h-[21px] items-center gap-1 rounded-[3px] border border-[var(--border-strong)] pl-1.5 pr-1 text-[var(--text-muted)] shadow-[0_1px_5px_rgba(0,0,0,0.7)] transition-colors hover:border-[var(--c-neg)] hover:text-[var(--c-neg)]"
        style={{ backgroundColor: PANEL_BG }}
      >
        <X size={12} />
        <kbd className="rounded-[2px] bg-white/15 px-[3px] py-[1px] font-mono text-[10px] font-semibold leading-none">
          Esc
        </kbd>
      </button>
    </div>
  )
}
