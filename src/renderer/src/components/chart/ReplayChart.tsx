import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  HistogramSeries,
  LineStyle,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type LineData,
  type Logical,
  type Time,
  TickMarkType,
  type UTCTimestamp,
  type WhitespaceData
} from 'lightweight-charts'
import type { Bar, ClosedTrade, Position } from '../../stores/training-store'
import {
  overlayLines as calcOverlayLines,
  subPaneView as calcSubPaneView,
  indicatorTitle,
  type IndicatorInstance,
  type IndicatorKind,
  type OverlayId,
  type Series,
  type SubPaneId
} from '@shared/utils/indicators'
import { IndicatorLegend, type IndicatorRow } from './IndicatorLegend'
import {
  DRAWING_COLORS,
  DRAWING_TOOLS,
  type Drawing,
  type DrawingPoint,
  type DrawingType
} from '@shared/types/drawing'
import {
  drawShape,
  drawPreview,
  estimateTextWidth,
  hitTest,
  inTimeWindow,
  polyPoints,
  shapePoints,
  type ChartMapping,
  type DrawingHit
} from './drawings'
import { drawTrades, focusLogicalRange } from './trade-lines'
import {
  ENTRY_BUY_COLOR,
  ENTRY_SELL_COLOR,
  SL_COLOR,
  TP_COLOR,
  TRAIL_COLOR,
  isTrailingStop,
  riskTitle
} from './position-lines'
import { PendingTicket, type PendingOrderView } from './pending-ticket'
export type { PendingOrderView }
import { useChartThemeStore } from '../../stores/chart-theme-store'
import { useTimezoneStore, currentTimezone } from '../../stores/timezone-store'
import { tzPartsFromSec } from '@shared/types/timezone'
import { DEFAULT_CHART_THEME } from '@shared/types/chart-theme'
import { Trash2 } from 'lucide-react'
import clsx from 'clsx'
import { useT, translateLabel, type MessageKey, type Translator } from '../../i18n'

/** 右键菜单可选颜色 */
const DRAWING_PALETTE = [
  '#eab308',
  '#38bdf8',
  '#22d3ee',
  '#a78bfa',
  '#f472b6',
  '#ef4444',
  '#22c55e',
  '#e5e7eb'
]

/**
 * 右键菜单标题里的画线工具名。
 * DRAWING_TOOLS 里的 label 是共享层的中文常量（还被别的组件引用，不能改形状），
 * 这里按画线类型单独查词典。
 */
const DRAWING_LABEL_KEYS: Record<DrawingType, MessageKey> = {
  trend: 'chart.drawingTrend',
  ray: 'chart.drawingRay',
  extline: 'chart.drawingExtline',
  hline: 'chart.drawingHline',
  vline: 'chart.drawingVline',
  polyline: 'chart.drawingPolyline',
  fib: 'chart.drawingFib',
  rect: 'chart.drawingRect',
  ellipse: 'chart.drawingEllipse',
  arrow: 'chart.drawingArrow',
  text: 'chart.drawingText'
}

interface ReplayChartProps {
  bars: Bar[]
  cursor: number
  /** 主图当前是不是「选中窗口」；从副窗切回来时强制整段重画一次，清掉增量 update 留下的空洞 */
  active?: boolean
  /**
   * 当前这根「只走到一半」的 K 线（截断到已揭示的分钟）；走完了就是 null。
   *
   * 显示周期比 1 分钟大时（H1/H4…），`bars[cursor]` 是整根、含还没走到的分钟，
   * 直接画出来等于把未来的收盘价提前告诉用户 —— 由 store 算好传进来。
   */
  partialBar?: Bar | null
  /** 当前所有持仓（可多笔、可多空并存），每笔都会在图上画出自己的开仓 / 止损 / 止盈线 */
  positions: Position[]
  /** 当前操作焦点的那笔持仓（价格卡、持仓卡高亮的那笔） */
  activePositionId: string | null
  /** 点中某条线时把它对应持仓设为焦点 */
  onSelectPosition?: (positionId: string) => void
  digits: number
  onSlChange: (positionId: string, price: number) => void
  onTpChange: (positionId: string, price: number) => void
  /**
   * 「打到这条止盈/止损线，这笔单子净赚/净亏多少」的文案，挂在线的轴标签上。
   *
   * 金额只能由上层算：手数、合约量、佣金、报价货币兑换、交叉盘汇率都在
   * TrainingPane / store 那边，图表这边只负责显示。
   * 返回空串表示不显示（例如还没设止损）。
   */
  riskPnlLabel?: (position: Position, kind: 'sl' | 'tp') => string
  /**
   * 减仓：把某笔持仓从当前手数减到 `newLot`（右键点开仓线弹出的面板里确认）。
   * 只能减不能加，非法值由 store 再兜一层。
   */
  onReducePosition?: (positionId: string, newLot: number) => void
  /**
   * 减仓面板里的实时预览：「按现价把 `lot` 手平掉，大约落袋多少」。
   *
   * 和 `riskPnlLabel` 同一套口径（滑点、佣金分摊、交叉盘汇率都在上层算），
   * 图表只负责显示。没传就退化成只显示手数。
   */
  lotPnlLabel?: (position: Position, lot: number) => string
  overlays: IndicatorInstance[]
  subPanes: IndicatorInstance[]
  /** 改某个指标实例的参数（图例里点的） */
  onIndicatorParams?: (kind: IndicatorKind, uid: string, key: string, value: number) => void
  /** 改某个指标实例某条线的颜色 */
  onIndicatorColor?: (kind: IndicatorKind, uid: string, slot: string, color: string) => void
  /** 参数 + 颜色恢复默认 */
  onIndicatorReset?: (kind: IndicatorKind, uid: string) => void
  /** 从图例里移除某个指标实例 */
  onIndicatorRemove?: (kind: IndicatorKind, uid: string) => void
  /** 图例小眼睛：隐藏 / 重新显示某个指标实例 */
  onIndicatorHidden?: (kind: IndicatorKind, uid: string, hidden: boolean) => void
  drawings: Drawing[]
  onDrawingsChange: (next: Drawing[]) => void
  activeTool: DrawingType | null
  /** 画线完成或取消后通知父级退出画线模式 */
  onToolChange?: (tool: DrawingType | null) => void
  /** 图表中央水印文字（标的 · 周期） */
  watermark?: string
  /** 当前显示周期（切周期时用来保留缩放比例，避免视野跳到默认位置） */
  timeframe?: string
  /** 已平仓的历史交易：在图上用虚线连接开仓点与平仓点 */
  trades?: ClosedTrade[]
  /** 报告里点选的交易：在图上画出开/关仓价格线并定位 */
  focusedTrade?: ClosedTrade | null
  /** 定位序号：同一笔交易被反复点选时用它强制重新定位 */
  focusSeq?: number
  /**
   * 这笔交易该不该由本图去定位（默认 true）。
   *
   * 双周期分屏时只有一个窗口能「跳过去」：两边的 150 根跨度完全不同，
   * 都设一遍只会互相覆盖。谁被选中谁定位，另一个靠时间范围同步跟过去。
   */
  focusTarget?: boolean
  /**
   * 当前允许显示到哪一根 K 线（含）—— 回放没走完时就是游标那一根。
   *
   * 由上层用 `revealIndexOf(bars, cursor, completedAt)` 算好传进来：
   * 之后所有「把视野挪到某处」的逻辑都拿它当右边界，谁也别想越过游标
   * 去展示还没走到的 K 线。不传就按整段都可见处理（老行为）。
   */
  revealIndex?: number
  /** 点击图表 / 按 Esc 时通知外部清掉聚焦交易 */
  onClearFocus?: () => void
  /**
   * 待确认的下单（按 B/S 之后先摆在图上、点「确认」才算真正持仓）。
   *
   * 它不是持仓：不参与浮动盈亏、不进持仓卡、平仓统计也看不到它。
   * 图表这边只负责三件事 —— 画三条线（开仓 / 止损 / 止盈）、让用户拖着调、
   * 在开仓线那一行摆出「方向+手数」「风险金额」「确认」「取消」。
   */
  pendingOrder?: PendingOrderView | null
  /** 拖待确认单的止损（夹取由上层负责，图表只报原始价） */
  onPendingSlChange?: (price: number) => void
  /** 拖待确认单的止盈 */
  onPendingTpChange?: (price: number) => void
  /** 点「确认」：上层会弹出备注浮窗，填完才真正开仓 */
  onPendingConfirm?: () => void
  /** 点「取消」或按 Esc：这张单子作废 */
  onPendingCancel?: () => void
  /**
   * 图表实例就绪 / 销毁时回调。
   *
   * 双周期窗要跟主图同步两样东西，所以两样都得给出去：
   *  - 时间轴（chart）→ 同步可视范围；
   *  - K 线 series → 跨图十字线要用它做「价格 ↔ 像素」换算
   *    （`setCrosshairPosition(price, time, series)` 的第三个参数就是它）。
   */
  onChartReady?: (
    chart: IChartApi | null,
    series: ISeriesApi<'Candlestick'> | null
  ) => void
}

/** 待确认单在命中判定里用的伪 id：和真实持仓 id（`pos_…`）不会撞 */
const PENDING_ID = '__pending_order__'

// 细线更好看，但抓取判定要放宽一点，否则很难「抓住」
const HIT_TOLERANCE = 10

/**
 * 给「双击改字」的输入框定宽度。
 *
 * 宽度估算和命中盒共用 drawings.ts 里那一套（全角 12px / 空格 4px / 其余 7px），
 * 只在这里补左右内边距，再夹到 160~460 之间：太窄盖不住底下那条老文字，
 * 太宽又会压到旁边的 K 线。
 */
function textBoxWidth(text: string): number {
  return Math.max(160, Math.min(460, estimateTextWidth(text) + 28))
}

/**
 * 左上角提示条要说的话。
 * kind 对应「焦点这笔持仓还差哪条线」：两条都没设 / 只缺止损 / 只缺止盈 / 都设好了。
 */
type RiskHint =
  | { kind: 'both'; lossSide: string; profitSide: string }
  | { kind: 'sl'; lossSide: string }
  | { kind: 'tp'; profitSide: string }
  | { kind: 'adjust' }

type AnySeries = ISeriesApi<'Line'> | ISeriesApi<'Histogram'>

/** 减仓手数的步进（和下单面板一样按 0.01 手） */
const LOT_STEP = 0.01

/** 手数统一按 0.01 取整，避开 0.1 - 0.07 = 0.030000000000000002 这类浮点尾巴 */
function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * 右键点持仓开仓线弹出的「调整仓位」面板。
 *
 * 只能减仓，这一点在三个入口上都是硬约束：
 *  · 滑杆的范围是 [0.01, 当前手数 - 0.01]；
 *  · 步进的 +/- 到边界就禁用；
 *  · 快捷比例只会把目标手数往小里调。
 * 想加仓是重新下单的事，不在这里做 —— 那会涉及开仓价、佣金、开仓时间的重算。
 *
 * 目标手数存在自己的 state 里，面板关掉即丢，不会带到下一笔。
 */
function LotMenu({
  position,
  x,
  y,
  bounds,
  lotPnlLabel,
  onConfirm,
  onClose
}: {
  position: Position
  x: number
  y: number
  /** 图表容器尺寸，用来把面板夹在可见区域内 */
  bounds: { width: number; height: number }
  lotPnlLabel?: (position: Position, lot: number) => string
  onConfirm: (newLot: number) => void
  onClose: () => void
}): React.JSX.Element {
  const { t } = useT()
  const max = round2(position.lot - LOT_STEP)
  /** 这笔已经是最小手数了：没有减的余地，面板只做说明 */
  const canReduce = max >= LOT_STEP

  // 默认落在「平掉一半」：右键想减仓时，半仓是最常见的一步
  const [target, setTarget] = useState(() => Math.max(LOT_STEP, round2(position.lot / 2)))

  const keep = Math.min(Math.max(round2(target), LOT_STEP), Math.max(max, LOT_STEP))
  const cut = round2(position.lot - keep)
  const money = cut > 0 && lotPnlLabel ? lotPnlLabel(position, cut) : ''
  const sideColor = position.side === 'buy' ? ENTRY_BUY_COLOR : ENTRY_SELL_COLOR
  const sideText = position.side === 'buy' ? t('chart.sideBuy') : t('chart.sideSell')

  const setKeep = (v: number): void => {
    setTarget(Math.min(Math.max(round2(v), LOT_STEP), max))
  }

  const width = 236
  const height = 208
  const left = Math.min(Math.max(x, 0), Math.max(0, bounds.width - width - 4))
  const top = Math.min(Math.max(y, 0), Math.max(0, bounds.height - height - 4))

  return (
    <div
      data-lot-menu="1"
      className="absolute z-30 w-[236px] overflow-hidden rounded-lg border border-[var(--border-strong)] bg-[var(--surface-1)] shadow-2xl"
      style={{ left, top }}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        // 面板自己有焦点（输入框 / 按钮）时也要能 Esc 关、Enter 确认
        if (e.key === 'Escape') {
          e.stopPropagation()
          onClose()
        } else if (e.key === 'Enter' && canReduce) {
          e.preventDefault()
          onConfirm(keep)
        } else if (e.key === 'ArrowUp') {
          e.preventDefault()
          setKeep(keep + LOT_STEP)
        } else if (e.key === 'ArrowDown') {
          e.preventDefault()
          setKeep(keep - LOT_STEP)
        }
      }}
    >
      <div className="flex items-center justify-between px-2.5 pb-1 pt-1.5">
        <span className="text-[10.5px] text-[var(--text-faint)]">{t('chart.adjustPosition')}</span>
        <span className="font-mono text-[11px] font-medium" style={{ color: sideColor }}>
          {t('chart.sideLotUnit', { side: sideText, lot: position.lot.toFixed(2) })}
        </span>
      </div>

      {!canReduce ? (
        <div className="px-2.5 pb-2.5 pt-1 text-[10.5px] leading-relaxed text-[var(--text-muted)]">
          {t('chart.lotAtMinimum', { lot: position.lot.toFixed(2) })}
        </div>
      ) : (
        <>
          <div className="flex items-center gap-1 px-2.5 pt-1">
            <button
              onClick={() => setKeep(keep - LOT_STEP)}
              disabled={keep <= LOT_STEP}
              title={t('chart.reduceOneStep')}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-[var(--border-subtle)] text-[12px] leading-none text-[var(--text-secondary)] transition-colors hover:border-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-30"
            >
              −
            </button>
            <input
              type="number"
              value={keep}
              step={LOT_STEP}
              min={LOT_STEP}
              max={max}
              // 重新输入时先全选，省得手删
              onFocus={(e) => e.target.select()}
              onChange={(e) => {
                const n = Number(e.target.value)
                if (Number.isFinite(n)) setKeep(n)
              }}
              className="h-5 w-full min-w-0 rounded border border-[var(--border-subtle)] bg-[var(--surface-2)] px-1.5 text-center font-mono text-[11.5px] tabular-nums text-[var(--text-primary)] outline-none focus:border-[var(--c-accent)]"
            />
            <button
              onClick={() => setKeep(keep + LOT_STEP)}
              disabled={keep >= max}
              title={t('chart.increaseOneStep')}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-[var(--border-subtle)] text-[12px] leading-none text-[var(--text-secondary)] transition-colors hover:border-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-30"
            >
              +
            </button>
            <span className="shrink-0 text-[10px] text-[var(--text-faint)]">
              {t('chart.lotShort')}
            </span>
          </div>

          <div className="px-2.5 pt-1.5">
            <input
              type="range"
              min={LOT_STEP}
              max={max}
              step={LOT_STEP}
              value={keep}
              onChange={(e) => setKeep(Number(e.target.value))}
              className="h-1 w-full cursor-pointer appearance-none rounded bg-[var(--surface-4)] accent-[var(--c-accent)]"
            />
          </div>

          <div className="flex gap-1 px-2.5 pt-2">
            {(
              [
                { labelKey: 'chart.closeQuarter', remain: 0.75 },
                { labelKey: 'chart.closeHalf', remain: 0.5 },
                { labelKey: 'chart.closeThreeQuarters', remain: 0.25 }
              ] as { labelKey: MessageKey; remain: number }[]
            ).map((q) => {
              const v = Math.max(LOT_STEP, round2(position.lot * q.remain))
              const active = Math.abs(v - keep) < 0.0001
              return (
                <button
                  key={q.labelKey}
                  onClick={() => setKeep(v)}
                  className={clsx(
                    'flex-1 rounded border px-1 py-0.5 text-[10px] transition-colors',
                    active
                      ? 'border-[var(--c-accent-border)] bg-[var(--c-accent-tint)] text-[var(--c-accent)]'
                      : 'border-[var(--border-subtle)] text-[var(--text-muted)] hover:border-[var(--text-muted)] hover:text-[var(--text-secondary)]'
                  )}
                >
                  {t(q.labelKey)}
                </button>
              )
            })}
          </div>

          {/* 实时预览：这次减掉多少手、大约落袋多少、还剩多少在场 */}
          <div className="mt-2 border-t border-[var(--border-subtle)] px-2.5 py-1.5 text-[10.5px] leading-relaxed">
            <div className="flex items-center justify-between">
              <span className="text-[var(--text-faint)]">
                {t('chart.closeLots', { lot: cut.toFixed(2) })}
              </span>
              <span
                className="font-mono tabular-nums"
                style={{ color: money.startsWith('-') ? 'var(--c-pos)' : 'var(--c-neg)' }}
              >
                {money || '—'}
              </span>
            </div>
            <div className="text-[var(--text-faint)]">
              {t('chart.keepLots', { lot: keep.toFixed(2) })}
            </div>
          </div>

          <div className="flex gap-1.5 border-t border-[var(--border-subtle)] px-2.5 py-1.5">
            <button
              onClick={onClose}
              className="flex-1 rounded border border-[var(--border-subtle)] py-1 text-[11px] text-[var(--text-secondary)] transition-colors hover:border-[var(--text-muted)] hover:text-[var(--text-primary)]"
            >
              {t('chart.cancel')}
            </button>
            <button
              onClick={() => onConfirm(keep)}
              className="flex-1 rounded border border-[var(--c-accent-border)] bg-[var(--c-accent-tint)] py-1 text-[11px] font-medium text-[var(--c-accent)] transition-colors hover:bg-[var(--c-accent)] hover:text-white"
            >
              {t('chart.confirmReduce')}
            </button>
          </div>
        </>
      )}
    </div>
  )
}


/**
 * 在已加载的 K 线里找离 t 最近的一根的时间。
 * 画线的时间点必须落在真实存在的 K 线上，否则 timeToCoordinate 取不到坐标。
 */
function nearestBarTime(list: Bar[], t: number): number | null {
  if (list.length === 0) return null
  const len = list.length
  if (t <= list[0].time) return list[0].time
  if (t >= list[len - 1].time) return list[len - 1].time
  let lo = 0
  let hi = len - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (list[mid].time <= t) lo = mid
    else hi = mid
  }
  return t - list[lo].time <= list[hi].time - t ? list[lo].time : list[hi].time
}

/** 成交连线与「点订单定位 150 根」都搬去了 ./trade-lines，副周期窗要用同一套 */

/**
 * 价格轴的「指纹」。
 *
 * 屏幕 y=0 / y=1000 两点各对应一个价格，两点就能唯一确定价格轴的仿射映射。
 * 用它判断「价格轴这一帧有没有变过」——lightweight-charts 没有「价格轴重算完成」
 * 这类事件可订阅，只能自己盯着。
 *
 * 取 1000 这种超出面板高度的 y 也没问题：这个映射本身是线性的，会自动外推，
 * 两点拉得越开，指纹对微小变化的敏感度越高。
 *
 * 空数据时价格轴没有区间，coordinateToPrice 会返回 null，此时返回 '' 占位。
 */
function priceScaleSignature(series: ISeriesApi<any>): string {
  const top = series.coordinateToPrice(0)
  const bottom = series.coordinateToPrice(1000)
  if (top == null || bottom == null) return ''
  return `${top}|${bottom}`
}

/** 读出当前可见的时间窗口（切周期时用来「保持同一段时间」） */
function readVisibleWindow(chart: IChartApi): { from: number; to: number } | null {
  const r = chart.timeScale().getVisibleRange()
  if (!r) return null
  const from = Number(r.from)
  const to = Number(r.to)
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null
  return { from, to }
}

/**
 * 某个时间戳在 K 线序列上的「小数下标」（相邻两根之间线性插值）。
 * 和 timeToLogical 一个思路，但这里要用传进来的新数组算，不能读 ref。
 */
function logicalOfTime(bars: Bar[], count: number, t: number): number {
  const n = Math.min(count, bars.length)
  if (n <= 0) return 0
  if (t <= bars[0].time) return 0
  if (t >= bars[n - 1].time) return n - 1
  let lo = 0
  let hi = n - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (bars[mid].time <= t) lo = mid
    else hi = mid
  }
  const span = bars[hi].time - bars[lo].time
  return lo + (span > 0 ? (t - bars[lo].time) / span : 0)
}

/** 刻度 / 十字线后面的星期文案，下标与 tzPartsFromSec().weekday 一致（0 = 周日） */
const WEEKDAY_KEYS = [
  'chart.weekdaySun',
  'chart.weekdayMon',
  'chart.weekdayTue',
  'chart.weekdayWed',
  'chart.weekdayThu',
  'chart.weekdayFri',
  'chart.weekdaySat'
] as const

/**
 * 订单时间 MM-DD HH:MM（默认 UTC+8，跟成交列表一致）；withDate=false 只留 HH:MM。
 *
 * `withWeekday` 打开时在日期后面缀上星期 —— 十字线横着拉的时候，
 * 「今天周几」比「几号」更影响对行情的判断（周末 / 周一跳空）。
 */
function fmtClock(ts: number, withDate = true, t?: Translator, withWeekday = false): string {
  const parts = tzPartsFromSec(ts, currentTimezone())
  const p = (n: number): string => String(n).padStart(2, '0')
  const hm = `${p(parts.hour)}:${p(parts.minute)}`
  if (!withDate) return hm
  const wd =
    withWeekday && t ? ` ${t(WEEKDAY_KEYS[parts.weekday] ?? 'chart.weekdaySun')}` : ''
  return `${p(parts.month)}-${p(parts.day)}${wd} ${hm}`
}

/**
 * 坐标轴刻度：按设置里的时区渲染（lightweight-charts 默认走 UTC，会跟成交列表差 8 小时）。
 *
 * `withWeekday` 打开时，日期刻度后面缀上星期（「2日 周一」）；
 * 日内周期下只有「日界刻度」（00:00 那个）带星期 —— 每小时都挂一个「周一」会把轴挤满。
 */
function fmtTickMark(ts: number, type: TickMarkType, t: Translator, withWeekday: boolean): string {
  const parts = tzPartsFromSec(ts, currentTimezone())
  const p = (n: number): string => String(n).padStart(2, '0')
  const wd = withWeekday ? ` ${t(WEEKDAY_KEYS[parts.weekday] ?? 'chart.weekdaySun')}` : ''
  switch (type) {
    case TickMarkType.Year:
      return String(parts.year)
    case TickMarkType.Month:
      return t('chart.axisMonth', { m: parts.month })
    case TickMarkType.DayOfMonth:
      return `${t('chart.axisDay', { d: parts.day })}${wd}`
    case TickMarkType.Time: {
      const hm = `${p(parts.hour)}:${p(parts.minute)}`
      // 日内图上 00:00 就是换日那根，标出星期用户才知道跳到哪一天了
      return parts.hour === 0 && parts.minute === 0 ? `${hm}${wd}` : hm
    }
    case TickMarkType.TimeWithSeconds:
      return `${p(parts.hour)}:${p(parts.minute)}:${p(parts.second)}`
    default:
      return ''
  }
}

/**
 * 主图（pane 0）在画布坐标系里的纵向范围。
 *
 * 画线绑的是**价格轴**，任何价格都能换算出一个 y —— 而副图（CCI/成交量那些）
 * 和主图共用同一块 overlay 画布，于是主图里的线段会顺着延伸进副图，
 * 看起来就是「主图的图形跑到副图上去了」。所以凡是跟价格绑定的绘制都要裁进主图。
 *
 * 优先问 pane 自己的 DOM 元素（最准：副图个数、拉伸比例、窗口尺寸一变它自己就跟着走）；
 * 拿不到就退回整块画布，宁可回到旧行为也别整片画不出来。
 */
function mainPaneRange(chart: IChartApi, hostRect: DOMRect): { top: number; bottom: number } {
  const el = chart.panes()[0]?.getHTMLElement()
  if (el) {
    const r = el.getBoundingClientRect()
    if (r.height > 0) return { top: r.top - hostRect.top, bottom: r.bottom - hostRect.top }
  }
  return { top: 0, bottom: hostRect.height }
}


/**
 * 右侧未来占位「一次续多长」的起步根数。
 *
 * 横向时间要能无限往右滑：设置里的「未来空白」只是起步值，用户拖到占位尽头
 * 就再续一段。续长量按现有长度的一半递增（见 growFuture），所以越往后每次续得越多，
 * 避免几十万点还要每 200 根重建一次数组。
 */
const FUTURE_GROW_STEP = 2000

/**
 * 未来占位的天花板。
 *
 * 不设上限就等于把「无限」交给用户的手指 —— M1 上一分钟一根，拖久了数组会把内存吃干。
 * 50000 根在 M1 上是约 35 天的连续分钟，实际操作中撞不到。
 */
const FUTURE_AHEAD_MAX = 50000

export function ReplayChart({
  bars,
  cursor,
  active = true,
  partialBar,
  positions,
  activePositionId,
  digits,
  onSelectPosition,
  onSlChange,
  onTpChange,
  riskPnlLabel,
  onReducePosition,
  lotPnlLabel,
  overlays,
  subPanes,
  onIndicatorParams,
  onIndicatorColor,
  onIndicatorReset,
  onIndicatorRemove,
  onIndicatorHidden,
  drawings,
  onDrawingsChange,
  activeTool,
  onToolChange,
  watermark,
  timeframe,
  trades,
  focusedTrade,
  focusSeq,
  focusTarget = true,
  revealIndex,
  onClearFocus,
  pendingOrder,
  onPendingSlChange,
  onPendingTpChange,
  onPendingConfirm,
  onPendingCancel,
  onChartReady
}: ReplayChartProps): React.JSX.Element {
  const { t, locale } = useT()
  const theme = useChartThemeStore((s) => s.theme)
  // 当前生效时区：历史会话用它自己打单时记录的时区
  const timezone = useTimezoneStore((s) => s.effective)

  /**
   * 右侧「未来空白」的根数。
   *
   * 建图 effect 和鼠标事件 effect 的依赖都是挑着写的（加依赖会重建整张图 / 重绑事件），
   * 所以这里留一份 ref 给闭包读，就不会读到过期的主题。
   */
  const futureBarsRef = useRef(theme.futureBars)
  futureBarsRef.current = theme.futureBars
  /**
   * 右侧未来占位当前铺了多少根。
   *
   * 设置里的「未来空白」只是起步值；用户往右拖到尽头时会一段段续上
   * （见 FUTURE_GROW_STEP），所以横向时间实际上是滑不到头的。
   */
  const futureAheadRef = useRef(0)
  /**
   * 上次续长的时刻。
   *
   * 续长是**改数据长度**，而 lightweight-charts 在数据变长时会保持「视野右端与末根的距离」，
   * 于是视野跟着往右跳一段 —— 这一跳以「用户平移」的名义回调进 onRange，
   * 又满足续长条件，就自己续自己一路顶到上限（实测一帧内从 60 跳到 50000）。
   * 用时间戳挡住这段自激：一次续长之后 250ms 内不再续。
   */
  const futureGrowAtRef = useRef(0)
  /**
   * 鼠标 / 手指是不是正按在图上。
   *
   * 播放推进时会重铺数据并（为了抵消 lightweight-charts 的右偏移漂移）把视野钉回原位；
   * 但用户正在拖动时，这一钉会把他刚拖出来的位置抢回去。拖动期间先放过，
   * 松手后的下一格再按新位置钉住。
   */
  const pointerDownRef = useRef(false)
  /** 按下时刻：拖拽事件丢失时（比如松手在窗口外）用超时兜底，别把视野永久冻住 */
  const pointerDownAtRef = useRef(0)
  /** 上一次主图是不是选中窗口；从副窗切回主图时要做一次全量 setData */
  const activeRef = useRef(true)

  const containerRef = useRef<HTMLDivElement>(null)
  /** 最外层容器：用来量「主图指标图例占了多高」（提示条要排在它下面） */
  const rootRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  /** 右侧「未来」占位序列：只有时间、不画线，负责把时间轴撑到未来（见建图处的说明） */
  const futureSeriesRef = useRef<ISeriesApi<'Line'> | null>(null)
  /** 同一个 chart 实例的 state 版：图例要订阅十字线，必须能拿到实例并在挂载后重渲染 */
  const [chartApi, setChartApi] = useState<IChartApi | null>(null)
  /**
   * 往外递图表实例走 ref。
   * 建图那个 effect 的依赖是 `[]`，把回调写进依赖会让整张图重建（丢视野、丢画线），
   * 所以回调变了也只用最新的那个，不重跑 effect。
   */
  const onChartReadyRef = useRef(onChartReady)
  onChartReadyRef.current = onChartReady

  // 文本工具输入态
  const [textDraft, setTextDraft] = useState<{
    x: number
    y: number
    time: number
    price: number
  } | null>(null)

  /**
   * 双击改字：编辑一条**已有**的文本画线。
   *
   * 记 id + 输入框该摆哪儿（锚点坐标）+ 进来时的原文 —— 原文用来判断「改没改」，
   * 一个字没动就不必触发一次落库。
   */
  const [textEdit, setTextEdit] = useState<{
    id: string
    x: number
    y: number
    initial: string
  } | null>(null)

  /**
   * Esc 取消的标记。
   *
   * Esc 之后输入框会卸载，某些情况下浏览器仍会补一个 blur，而 blur 的处理是
   * 「提交」—— 不加这个标记的话按 Esc 反而把改到一半的字写进去了。
   * 每次打开编辑前都清掉，免得吞掉下一次正常提交。
   */
  const textEditCancelRef = useRef(false)

  // 右键菜单（命中已有画线时出现）
  const [menu, setMenu] = useState<{ x: number; y: number; id: string; type: DrawingType } | null>(
    null
  )

  /**
   * 右键点开仓线弹出的「调整仓位」面板。
   *
   * 只记位置和点到哪一笔，目标手数放在面板组件自己的 state 里 ——
   * 面板关掉就一起丢掉，不会污染下一笔。
   */
  const [lotMenu, setLotMenu] = useState<{ x: number; y: number; id: string } | null>(null)

  /**
   * 每笔持仓在图上的一组价格线。
   * 多持仓（甚至多空对冲）时每笔各画各的：开仓 / 止损 / 止盈 / 待定。
   */
  const posLinesRef = useRef<
    Map<string, { entry?: IPriceLine; sl?: IPriceLine; tp?: IPriceLine; pending?: IPriceLine }>
  >(new Map())
  /**
   * 本次「拖开仓线设止损止盈」允许设哪一个：
   *  · 'free' —— 两个都还没设，拖到哪边就设哪个（实时跟着方向切换）
   *  · 'sl'   —— 已有止盈，这次只能拖止损
   *  · 'tp'   —— 已有止损，这次只能拖止盈
   *
   * 在 mousedown 那一刻按当时的持仓快照定下来，拖完清空。
   * 不在移动过程中反复重算：否则同一拖里先往上（设了止盈）再往下，
   * 后半段会突然被「已有止盈」的规则锁住，手感像是拖不动了。
   */
  const riskModeRef = useRef<'free' | 'sl' | 'tp' | null>(null)
  /** 正在拖的是哪一笔持仓 */
  const dragPosRef = useRef<string | null>(null)
  /** 按下价格线时的 y / 是否已经真的拖动过（防止点一下票面就多出一条极窄止盈） */
  const dragStartYRef = useRef(0)
  const dragMovedRef = useRef(false)

  /**
   * 待确认单的几条价格线 + 最新快照。
   *
   * 鼠标事件是绑在图表容器上的（effect 只挂一次），闭包里永远是挂载那一刻的 props，
   * 所以待确认单必须走 ref 才读得到最新值 —— 和 positions 用 positionsRef 是同一回事。
   */
  const pendingRef = useRef<PendingOrderView | null>(null)
  pendingRef.current = pendingOrder ?? null
  const pendingLinesRef = useRef<{ entry?: IPriceLine; sl?: IPriceLine; tp?: IPriceLine }>({})
  /** 待确认单的回调也走 ref：鼠标事件闭包是挂载那一刻的，直接用 prop 会调到旧函数 */
  const pendingCbRef = useRef({
    sl: onPendingSlChange,
    tp: onPendingTpChange,
    confirm: onPendingConfirm,
    cancel: onPendingCancel
  })
  pendingCbRef.current = {
    sl: onPendingSlChange,
    tp: onPendingTpChange,
    confirm: onPendingConfirm,
    cancel: onPendingCancel
  }

  const prevLenRef = useRef(0)
  const prevBarsRef = useRef<Bar[] | null>(null)
  const dragRef = useRef<'sl' | 'tp' | 'risk' | null>(null)

  /** 当前可视窗口里有多少根 K 线（只在读不到 userWindowRef 时兜底用） */
  const viewSpanRef = useRef(110)
  /**
   * 用户当前「在看」的那段时间（真实时间戳）。切周期时按它还原视野。
   *
   * 为什么不直接读 chart 的当前可视范围：切完周期后画面上的窗口可能被撑过（比如
   * 1 小时在 H1 上只剩 1 根，会被抬高到几根），如果把撑过的窗口当成下一次切换的基准，
   * M1→H1→M1 来回切几次，时间跨度就会一层层放大，再也回不去。
   * 这里只记「用户自己缩放/平移之后」的窗口，代码主动设的那一次不算。
   */
  const userWindowRef = useRef<{ from: number; to: number } | null>(null)
  /** 上一次由代码主动设视野的时刻，用来把那次区间变化和用户操作区分开 */
  const autoRangeAtRef = useRef(0)
  const tfRef = useRef(timeframe)

  const indicatorRefs = useRef<Map<string, AnySeries>>(new Map())
  const focusLinesRef = useRef<IPriceLine[]>([])

  // 画线状态
  const drawingsRef = useRef<Drawing[]>(drawings)
  const selectedRef = useRef<string | null>(null)
  const toolRef = useRef<DrawingType | null>(activeTool)
  const drawingDragRef = useRef<{
    id: string
    handle: DrawingHit
    startTime: number
    startPrice: number
    origin: Drawing
  } | null>(null)
  const previewRef = useRef<{
    type: DrawingType
    p1: { x: number; y: number }
    p2: { x: number; y: number }
    t1: number
    v1: number
    t2: number
    v2: number
    /**
     * 折线专用：已经用左键落下的锚点（存时间/价格而不是屏幕坐标）。
     *
     * 画折线的过程中用户可能滚一下图再继续点，存屏幕坐标那一瞬间就错位了；
     * 存时间/价格每次重绘时重新映射才稳。
     * 最后那段「跟着鼠标走的」不在这里面，它是 p2 / t2 / v2。
     */
    anchors?: DrawingPoint[]
  } | null>(null)

  const positionsRef = useRef<Position[]>(positions)
  useEffect(() => {
    positionsRef.current = positions
  }, [positions])

  /** 历史成交（虚线连接开仓点与平仓点，画在 overlay canvas 上） */
  const tradesRef = useRef<ClosedTrade[]>(trades ?? [])
  useEffect(() => {
    tradesRef.current = trades ?? []
    redrawRef.current()
  }, [trades])

  /** 日志/报告里正在定位的那一笔（画竖线标记用） */
  const focusedRef = useRef<ClosedTrade | null>(focusedTrade ?? null)

  /**
   * 价格线的「结构指纹」：只在这几项变化时才重建线条。
   *
   * 拖 SL/TP 时每帧都会改价格，如果把它算进指纹里就会每帧销毁重建一遍；
   * 价格的更新走另一个 effect 的 applyOptions（见下）。
   * 这里关心的是「有几笔、各自是哪一边、开仓价在哪、有没有设过 SL/TP」。
   */
  const posLineSig = positions
    .map((p) => `${p.id}:${p.side}:${p.entryPrice}:${p.sl != null ? 1 : 0}${p.tp != null ? 1 : 0}`)
    .join('|')

  // 已加载 K 线的时间范围（画线锚点夹取 / 越界坐标外推用）
  const rangeRef = useRef<{ first: number; last: number; step: number; lastIndex: number }>({
    first: 0,
    last: 0,
    step: 0,
    lastIndex: 0
  })
  const barsRef = useRef<Bar[]>(bars)
  useEffect(() => {
    barsRef.current = bars
    if (bars.length === 0) {
      rangeRef.current = { first: 0, last: 0, step: 0, lastIndex: 0 }
      return
    }
    const lastIndex = Math.min(cursor, bars.length - 1)
    /**
     * 「一根 K 线多长」按最近两根算。
     *
     * 未来空白区的时间刻度、画到未来的锚点都靠它外推；用 bars[1]-bars[0]
     * 会被开头的午休 / 隔夜缺口带偏，越往右画偏得越多。
     */
    const prevIndex = Math.max(0, lastIndex - 1)
    const recentStep = bars[lastIndex].time - bars[prevIndex].time
    rangeRef.current = {
      first: bars[0].time,
      last: bars[lastIndex].time,
      step: recentStep > 0 ? recentStep : bars.length > 1 ? bars[1].time - bars[0].time : 0,
      lastIndex
    }
  }, [bars, cursor])

  // 重绘函数存 ref，供各处调用而不引起依赖变化
  const redrawRef = useRef<() => void>(() => undefined)
  /** 上一次重绘时价格轴的样子（见 priceScaleSignature） */
  const scaleSigRef = useRef('')

  /**
   * 按当前 K 线尾巴铺 `count` 个未来占位点（不碰 futureAheadRef，纯渲染）。
   *
   * 时间按「最近两根 K 线的间隔」往后排，跟坐标轴上外推的口径对齐；
   * 数值沿用最后一根收盘价 —— 它既不绘制也不参与自动缩放，只是把时间点带上去。
   */
  const applyFuture = useCallback((count: number) => {
    const fs = futureSeriesRef.current
    if (!fs) return
    const { last, step, lastIndex } = rangeRef.current
    const list = barsRef.current
    if (count <= 0 || !last || step <= 0 || list.length === 0) {
      fs.setData([])
      return
    }
    const value = list[Math.min(lastIndex, list.length - 1)]?.close ?? 0
    const points: { time: UTCTimestamp; value: number }[] = []
    for (let k = 1; k <= count; k++) {
      points.push({ time: (last + k * step) as UTCTimestamp, value })
    }
    fs.setData(points)
  }, [])

  /**
   * 重铺右侧「未来」占位点。
   *
   * @param reset true = 回到设置里的根数（换数据 / 换周期 / 改设置时用）；
   *              false = 只补不吞，用户拖出去的未来得留着。
   */
  const refreshFuture = useCallback(
    (reset = false) => {
      const base = Math.max(0, Math.floor(futureBarsRef.current))
      futureAheadRef.current = reset ? base : Math.max(futureAheadRef.current, base)
      applyFuture(futureAheadRef.current)
    },
    [applyFuture]
  )

  /**
   * 用户往右拖到占位尽头时再续一段 —— 这就是「横向时间无限」。
   *
   * 只加长度、不挪视野：续长发生在右端之外，用户正在看的那一段一根都不该动。
   * 关掉「未来空白」（设置为 0）就不续 —— 那是用户明确不要未来区。
   */
  const growFuture = useCallback((): boolean => {
    if (futureBarsRef.current <= 0) return false
    const cur = futureAheadRef.current
    if (cur >= FUTURE_AHEAD_MAX) return false
    const step = Math.max(FUTURE_GROW_STEP, Math.round(cur * 0.5))
    futureAheadRef.current = Math.min(FUTURE_AHEAD_MAX, cur + step)
    applyFuture(futureAheadRef.current)
    return true
  }, [applyFuture])

  useEffect(() => {
    drawingsRef.current = drawings
    redrawRef.current()
  }, [drawings])

  useEffect(() => {
    toolRef.current = activeTool
    if (activeTool) selectedRef.current = null
    const el = containerRef.current
    if (el) el.style.cursor = activeTool ? 'crosshair' : ''
    redrawRef.current()
  }, [activeTool])

  // ---------- 指标计算（只依赖 bars / 实例配置，回放推进时不重算） ----------
  /**
   * 指标计算用的 K 线：把游标那一根换成「已揭示部分」。
   *
   * 否则在 H1 上刚打到 13:20 时，MA/MACD 的最后一点会用到 13:59 的收盘价，
   * 均线跟着往一根还没发生过的方向拐 —— 和 K 线本身被截断的口径就对不上了。
   */
  const calcBars = useMemo(() => {
    if (!partialBar || bars.length === 0 || cursor < 0 || cursor >= bars.length) return bars
    const out = bars.slice()
    out[cursor] = partialBar
    return out
  }, [bars, cursor, partialBar])

  const overlayData = useMemo(() => {
    const out: { key: string; uid: string; slot: string; color: string; values: Series }[] = []
    for (const inst of overlays) {
      // 点了小眼睛就不画线（也不建 series），参数还留着
      if (inst.hidden) continue
      for (const line of calcOverlayLines(inst.id as OverlayId, calcBars, inst.params, inst.colors)) {
        // series key 带上实例 uid：同一个指标添加两次也不会互相覆盖
        out.push({
          key: `${inst.uid}:${line.key}`,
          uid: inst.uid,
          slot: line.slot,
          color: line.color,
          values: line.values
        })
      }
    }
    return out
  }, [calcBars, overlays])

  const subPaneData = useMemo(
    () =>
      // 隐藏的副图不建 pane：整块图直接让位给别的副图，而不是留一片空白的坐标轴
      subPanes
        .filter((inst) => !inst.hidden)
        .map((inst) => ({
          uid: inst.uid,
          view: calcSubPaneView(
            inst.id as SubPaneId,
            calcBars,
            inst.params,
            {
              upColor: theme.upColor,
              downColor: theme.downColor
            },
            inst.colors
          )
        })),
    [calcBars, subPanes, theme.upColor, theme.downColor]
  )

  /**
   * 结构签名：只要它变了，就必须把 series / pane 全部拆了重建。
   * （线增删、pane 增删、参数变化、改颜色都会改变要画的 series 数量或颜色）
   */
  const indicatorStructure = useMemo(
    () =>
      JSON.stringify({
        // 主图也要带上颜色，否则只改颜色不会触发重建，线色不生效
        o: overlayData.map((l) => ({ k: l.key, c: l.color })),
        s: subPaneData.map((p) => ({
          u: p.uid,
          k: p.view.series.map((s) => s.key),
          t: p.view.series.map((s) => s.type),
          c: p.view.series.map((s) => s.color),
          g: p.view.guides
        }))
      }),
    [overlayData, subPaneData]
  )

  /**
   * 图例 / 十字线读数用的行描述：每个指标实例一行，自带 pane 序号和每段线的颜色。
   * 主图实例 pane=0（读数接在图例 chip 后面），副图实例按顺序占 pane 1..n。
   *
   * 隐藏的实例也留一行：pane 记 0、带 hidden 标记，图例把它们排在主图那一行变暗显示，
   * 用户随时能点小眼睛把它放回来（副图被隐藏时已经没有它自己的 pane 了）。
   */
  const indicatorRows = useMemo<IndicatorRow[]>(() => {
    const rows: IndicatorRow[] = []
    for (const inst of overlays) {
      rows.push({
        kind: 'overlay',
        inst,
        pane: 0,
        title: translateLabel(locale, indicatorTitle(inst.id, inst.params)),
        format: 'price',
        hidden: inst.hidden === true,
        segs: inst.hidden
          ? []
          : overlayData
              .filter((l) => l.uid === inst.uid)
              .map((l) => ({ key: l.key, color: l.color }))
      })
    }
    subPaneData.forEach((entry, i) => {
      const inst = subPanes.find((p) => p.uid === entry.uid)
      if (!inst) return
      rows.push({
        kind: 'sub',
        inst,
        pane: i + 1,
        title: translateLabel(locale, entry.view.title),
        format: entry.view.format,
        // hist 没有固定单色（逐根按涨跌上色），读数用中性灰
        segs: entry.view.series.map((s) => ({
          key: `${entry.uid}:${s.key}`,
          color: s.color ?? '#94a3b8'
        }))
      })
    })
    for (const inst of subPanes) {
      if (!inst.hidden) continue
      rows.push({
        kind: 'sub',
        inst,
        pane: 0,
        title: translateLabel(locale, indicatorTitle(inst.id, inst.params)),
        format: 'plain',
        hidden: true,
        segs: []
      })
    }
    return rows
  }, [overlays, subPanes, overlayData, subPaneData, locale])

  /** 读数用：series key → series 实例（十字线数据要从这个映射里取） */
  const getIndicatorSeries = useCallback(
    (key: string): ISeriesApi<any> | undefined => indicatorRefs.current.get(key),
    []
  )

  /**
   * 统一坐标映射。
   *
   * lightweight-charts 的 timeToCoordinate 只认「数据里真实存在的那个时间」，
   * 别的时刻一律返回 null。画线的锚点是绝对时间戳 + 价格，切到别的周期后
   * 这些时间点基本都不在新周期的 K 线上，所以这里必须自己算坐标。
   *
   * 做法：按「分数逻辑索引」在相邻两根 K 线之间线性插值。
   * 不能用「吸附到最近一根」——两端各吸一次，图形会被拉长一格，
   * 甚至整体糊到最后一根 K 线上（看起来就是「溢出」到不该去的地方）。
   */
  const timeToLogical = useCallback((time: number): number | null => {
    const list = barsRef.current
    const n = list.length
    if (n === 0) return null
    if (n === 1) return 0

    let i: number
    if (time <= list[0].time) {
      i = 0
    } else if (time >= list[n - 1].time) {
      i = n - 2
    } else {
      let lo = 0
      let hi = n - 1
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1
        if (list[mid].time <= time) lo = mid
        else hi = mid
      }
      i = lo
    }

    const a = list[i]
    const b = list[i + 1]
    const span = b.time - a.time
    const frac = span > 0 ? (time - a.time) / span : 0
    return i + frac
  }, [])

  const buildMapping = useCallback((): ChartMapping | null => {
    const chart = chartRef.current
    const series = seriesRef.current
    if (!chart || !series) return null
    const ts = chart.timeScale()

    return {
      timeToX: (time) => {
        const c = ts.timeToCoordinate(time as UTCTimestamp)
        if (c != null) return c as number

        const logical = timeToLogical(time)
        if (logical == null || !Number.isFinite(logical)) return null

        // 注意：logicalToCoordinate 只接受整数（传小数会被算成 0），
        // 所以这里取相邻两根 K 线的整数坐标，再用小数部分线性插值。
        const list = barsRef.current
        const n = list.length
        if (n === 0) return null
        const i = Math.min(Math.max(Math.floor(logical), 0), n - 1)
        const frac = logical - i

        const xa = ts.timeToCoordinate(list[i].time as UTCTimestamp)
        if (xa == null) return null
        const xb = i + 1 < n ? ts.timeToCoordinate(list[i + 1].time as UTCTimestamp) : null
        if (xb != null) return (xa as number) + ((xb as number) - (xa as number)) * frac

        // 落在最后一根之后（或只有一根）：按平均柱宽外推
        const bs = ts.options().barSpacing
        return (xa as number) + frac * bs
      },
      xToTime: (x) => {
        const time = ts.coordinateToTime(x)
        if (time != null) return Number(time)
        // 落在最后一根右侧的「未来空白」/ 第一根左侧：按柱宽把屏幕距离换算成时间。
        //
        // 以前这里是「贴到最后一根」，于是拖到未来区画线时锚点全被吸回最后一根，
        // 画出来的线永远到不了未来。现在换算成真正的时间戳，画线才能落在未来。
        const { first, last, step } = rangeRef.current
        if (!first || !last) return null
        const lastX = ts.timeToCoordinate(last as UTCTimestamp)
        if (lastX != null && x > (lastX as number)) {
          const bs = ts.options().barSpacing || 6
          const aheadBars = (x - (lastX as number)) / bs
          return Math.round(last + aheadBars * (step || 60))
        }
        const firstX = ts.timeToCoordinate(first as UTCTimestamp)
        if (firstX != null && x < (firstX as number)) return first
        return null
      },
      priceToY: (p) => {
        const c = series.priceToCoordinate(p)
        return c == null || !Number.isFinite(c as number) ? null : (c as number)
      },
      yToPrice: (y) => {
        const p = series.coordinateToPrice(y)
        return p == null || !Number.isFinite(p as number) ? null : (p as number)
      }
    }
  }, [])

  /**
   * 待确认单票面用的价格 → y 换算。
   *
   * 单独包一层是因为 `PendingTicket` 里在 rAF 循环里每帧都要调它：
   * 必须是稳定引用，否则每次父级重渲染都会重启动画循环。
   * 这里直接问 series，不走 buildMapping —— 后者每次都新建四个闭包，
   * 一帧一次的空转没必要付这份钱（待确认单挂着的时候是每帧都跑）。
   */
  const pendingPriceToY = useCallback((price: number): number | null => {
    const s = seriesRef.current
    if (!s) return null
    const c = s.priceToCoordinate(price)
    return c == null || !Number.isFinite(c as number) ? null : (c as number)
  }, [])

  /**
   * 当前可见的时间窗口（两端各放宽 2 根）。
   *
   * 用途只有一个：把「这一帧根本看不见」的画线和成交先筛掉再算坐标。
   * 一场回放里画线会攒到几百条，全都在视野里的可能只有几条 —— 每条都要跑
   * 二分 + timeToCoordinate 才能知道画在哪，纯属白算。这里用可视**逻辑**下标
   * 换算成时间（未来占位区也能正确外推），全程只有常数次运算。
   */
  const visibleTimeWindow = useCallback((): { lo: number; hi: number } | null => {
    const chart = chartRef.current
    if (!chart) return null
    const list = barsRef.current
    const n = list.length
    if (n < 1) return null
    const lr = chart.timeScale().getVisibleLogicalRange()
    if (!lr) return null

    const step = rangeRef.current.step || 60
    const at = (L: number): number => {
      // 两头落在数据之外（左侧历史尽头 / 右侧未来空白）时按柱宽外推
      if (L <= 0) return list[0].time + L * step
      if (L >= n - 1) return list[n - 1].time + (L - (n - 1)) * step
      const i = Math.floor(L)
      return list[i].time + (list[i + 1].time - list[i].time) * (L - i)
    }
    const pad = 2
    return { lo: at(lr.from - pad), hi: at(lr.to + pad) }
  }, [])

  /** 上一帧量出来的图表几何（见 paintNow 里的说明） */
  const metricsRef = useRef<{
    w: number
    h: number
    paneTop: number
    paneBottom: number
    paneCount: number
    at: number
  } | null>(null)
  /** 尺寸/布局可能变过 —— 下一帧重新量一次 */
  const metricsDirtyRef = useRef(true)
  /** 待执行的重绘帧 */
  const paintRafRef = useRef(0)

  const paintNow = useCallback(() => {
    const canvas = canvasRef.current
    const chart = chartRef.current
    const series = seriesRef.current
    if (!canvas || !chart || !series) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // 用父容器尺寸作为基准：若测量画布自身，设置 width 会反向影响下一次测量，
    // 形成「越画越大」的反馈循环
    const host = canvas.parentElement
    if (!host) return

    /**
     * 几何量只在「可能变过」的时候读。
     *
     * getBoundingClientRect 会强制同步排版；一帧里读两次（容器一次、主图 pane 一次）
     * 再夹着 canvas 的样式写入，就是最典型的 layout thrash。以前每次重绘都读一遍，
     * 而一次鼠标移动会触发好几次重绘 —— 滚动/拖拽时这些读数叠起来就是卡顿。
     */
    let m = metricsRef.current
    const paneCount = chart.panes().length
    /**
     * 除了「脏了就重量」，还加一条时间兜底：250ms 内至少重量一次。
     * 有些几何变化没有事件可订阅（比如拖动副图之间的分隔条，容器尺寸不变），
     * 全靠事件失效会一直用错的分界线。8 次/秒的两下 DOM 读取，代价可以忽略。
     */
    if (!m || metricsDirtyRef.current || m.paneCount !== paneCount || performance.now() - m.at > 250) {
      const hostRect = host.getBoundingClientRect()
      const pane = mainPaneRange(chart, hostRect)
      const top = Math.max(0, pane.top)
      m = {
        w: Math.max(1, Math.round(hostRect.width)),
        h: Math.max(1, Math.round(hostRect.height)),
        paneTop: top,
        paneBottom: Math.max(top + 1, pane.bottom),
        paneCount,
        at: performance.now()
      }
      metricsRef.current = m
      metricsDirtyRef.current = false
    }

    if (canvas.style.width !== `${m.w}px`) canvas.style.width = `${m.w}px`
    if (canvas.style.height !== `${m.h}px`) canvas.style.height = `${m.h}px`
    const dpr = window.devicePixelRatio || 1
    const bmpW = Math.round(m.w * dpr)
    const bmpH = Math.round(m.h * dpr)
    if (canvas.width !== bmpW) canvas.width = bmpW
    if (canvas.height !== bmpH) canvas.height = bmpH

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, m.w, m.h)

    const map = buildMapping()
    if (!map) return

    /**
     * 只画主图那一块。
     *
     * 价格轴是「无界」的：价格跑到哪，y 就跟着算到哪，所以主图的线段、射线、
     * 成交连线本来会一路画进下面的副图（截图里那种溢出）。
     * 这里按 pane 0 的真实高度裁一刀，`view.height` 也一并换掉 ——
     * 竖线、射线的延伸长度同样按主图算，不然它们还是会长到副图外面去。
     */
    const view = { width: m.w, height: m.paneBottom }

    ctx.save()
    ctx.beginPath()
    ctx.rect(0, m.paneTop, m.w, m.paneBottom - m.paneTop)
    ctx.clip()

    /**
     * 先按时间窗筛一遍再画：看不见的画线一条都不用算坐标。
     * 画线一多，「算完再交给 canvas 裁掉」的成本就成了拖拽时不跟手的主因。
     */
    const win = visibleTimeWindow()
    for (const d of drawingsRef.current) {
      if (win && !inTimeWindow(d, win.lo, win.hi)) continue
      drawShape(ctx, d, map, view, d.id === selectedRef.current)
    }

    drawTrades(ctx, tradesRef.current, map, view, focusedRef.current?.id ?? null, win)

    const preview = previewRef.current
    if (preview) {
      // 折线：已落下的锚点按「时间/价格 → 当前屏幕坐标」重新映射（中途滚图也不会错位）
      const via =
        preview.anchors && preview.anchors.length > 0
          ? preview.anchors
              .map((a) => {
                const ax = map.timeToX(a.time)
                const ay = map.priceToY(a.price)
                return ax != null && ay != null ? { x: ax, y: ay } : null
              })
              .filter((a): a is { x: number; y: number } => a != null)
          : undefined
      drawPreview(ctx, preview.type, preview.p1, preview.p2, via)
    }

    ctx.restore()

    // 记下这次用的是哪一版价格轴。如果价格轴其实还没算到最终值，
    // 看门狗会在下一帧发现指纹变了，再补一帧（见下面的 watchPriceScale）。
    scaleSigRef.current = priceScaleSignature(series)
  }, [buildMapping, visibleTimeWindow])

  /**
   * 请求重绘 —— 合并到下一帧只画一次。
   *
   * 一次鼠标移动会同时踩响好几条重绘路径：十字线回调、可视范围回调、价格轴看门狗、
   * 拖拽/画线逻辑。以前每条路径都立刻整幅重画一遍，画线一多，一帧之内画三四遍
   * 就是肉眼可见的卡顿；而且同一个事件里连做几次「读 DOM → 写 canvas」最伤排版。
   * 现在只记一个「要重画」的标记，真正画的时候一帧一次。
   */
  const redraw = useCallback(() => {
    if (paintRafRef.current) return
    paintRafRef.current = requestAnimationFrame(() => {
      paintRafRef.current = 0
      paintNow()
    })
  }, [paintNow])

  redrawRef.current = redraw

  // 卸载时把没跑完的那一帧撤掉，别在已销毁的 canvas 上画
  useEffect(
    () => () => {
      if (paintRafRef.current) {
        cancelAnimationFrame(paintRafRef.current)
        paintRafRef.current = 0
      }
    },
    []
  )

  // ---------- 初始化图表 ----------
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const t0 = useChartThemeStore.getState().theme ?? DEFAULT_CHART_THEME
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { color: t0.background },
        textColor: t0.textColor,
        fontSize: 11,
        fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif'
      },
      grid: {
        vertLines: { color: t0.gridColor, visible: t0.gridVisible },
        horzLines: { color: t0.gridColor, visible: t0.gridVisible }
      },
      rightPriceScale: {
        borderColor: '#2a2a2a',
        scaleMargins: { top: 0.12, bottom: 0.12 }
      },
      timeScale: {
        borderColor: '#2a2a2a',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 6,
        barSpacing: 6,
        // 默认是按 UTC 渲染刻度，而成交列表用的是本地时间，两者差 8 小时
        // 看起来就像「订单定位偏了」，这里统一按本地时间画
        tickMarkFormatter: (time: Time, type: TickMarkType): string =>
          fmtTickMark(Number(time), type, t, t0.axisWeekday)
      },
      crosshair: {
        // 0 = 跟随鼠标自由移动；1 = 磁吸到最近 K 线
        mode: t0.crosshairMagnet ? 1 : 0,
        vertLine: {
          color: t0.crosshairColor,
          width: t0.crosshairWidth,
          style: t0.crosshairStyle,
          labelVisible: t0.crosshairLabels,
          labelBackgroundColor: '#2a2a2a'
        },
        horzLine: {
          color: t0.crosshairColor,
          width: t0.crosshairWidth,
          style: t0.crosshairStyle,
          labelVisible: t0.crosshairLabels,
          labelBackgroundColor: '#2a2a2a'
        }
      },
      localization: {
        locale: 'zh-CN',
        // 十字线标签同样按本地时间，跟成交列表对齐
        timeFormatter: (time: Time): string =>
          fmtClock(Number(time), true, t, t0.axisWeekday)
      }
    })

    const series = chart.addSeries(CandlestickSeries, {
      upColor: t0.upColor,
      downColor: t0.downColor,
      borderUpColor: t0.upColor,
      borderDownColor: t0.downColor,
      wickUpColor: t0.upColor,
      wickDownColor: t0.downColor,
      borderVisible: t0.showBorder,
      wickVisible: t0.showWick,
      priceFormat: { type: 'price', precision: 5, minMove: 0.00001 }
    })

    /**
     * 「未来」占位序列：只为了让时间轴往右延伸出未来刻度。
     *
     * lightweight-charts 的空白（rightOffset）区**不会画任何刻度标签**，所以光把
     * rightOffset 调大，右边只会是一片没有任何时间的黑，画线时根本不知道该对齐到哪天。
     * 这里铺一条不画的线（每个点都是真实时间戳），时间轴就会把这些时间当作刻度画出来，
     * 而 K 线序列本身一根都不多 —— 正好是「看得到未来时间、看不到未来 K 线」。
     *
     * 三条关键设置：
     *  · lineVisible:false + 透明色 —— 一个像素都不画；
     *  · autoscaleInfoProvider 返回 null —— 不许这段占位把价格轴撑变形；
     *  · lastValueVisible / priceLineVisible / crosshairMarkerVisible 全关 ——
     *    不显示最新价线、不留标记。
     */
    const futureSeries = chart.addSeries(
      LineSeries,
      {
        color: 'rgba(0,0,0,0)',
        lineVisible: false,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        autoscaleInfoProvider: () => null
      },
      0
    )

    chartRef.current = chart
    seriesRef.current = series
    futureSeriesRef.current = futureSeries
    // 新图 = 新几何，下一帧重新量
    metricsDirtyRef.current = true
    setChartApi(chart)
    onChartReadyRef.current?.(chart, series)

    if (import.meta.env.DEV) {
      ;(window as any).__rw_chart = { chart, series }
    }

    /**
     * 续长一段未来占位点，并把视野按原样设回去。
     *
     * 为什么必须还原：setData 让数据变长时，图表会保持「视野右端与末根的距离」，
     * 于是视野整体往右跳掉整整一段（实测一跳 345 根 ≈ 2.7 屏）。
     *
     * 为什么只在「没按住鼠标」时做：真实拖动期间这段代码是在图表的 mousemove 处理里
     * 跑起来的，同步设回去会被它后面的增量平移覆盖，微任务里设回去又会让它的
     * 内部锚点错位（实测拖到一半直接卡住不动）。所以拖动中只记账（growPendingRef），
     * 松手后再补 —— 那时没有谁跟这次还原抢视野。
     */
    const growAndRestore = () => {
      const r = chart.timeScale().getVisibleLogicalRange()
      if (!r) return
      futureGrowAtRef.current = performance.now()
      if (!growFuture()) return
      autoRangeAtRef.current = performance.now()
      chart.timeScale().setVisibleLogicalRange(r)
    }
    /** 拖动中撞到未来尽头：先记下来，等松手再续 */
    let growPending = false
    /**
     * 鼠标/手指按着没。
     *
     * 图表自己处理平移，没有对外说「我正在拖」的接口，所以自己盯一下全局的按下/松开。
     * 捕获阶段挂监听：图里的画线/拖单子会 stopPropagation，但拦不住捕获阶段。
     */
    let pointerDown = false
    const markDown = () => {
      pointerDown = true
      pointerDownRef.current = true
      pointerDownAtRef.current = performance.now()
    }
    /**
     * 松手：把拖动期间搁置的续长补上。
     *
     * 此刻没有谁在跟这次「设回视野」抢 —— 拖动中做会被图表的增量平移覆盖，实测会卡死。
     */
    const markUp = () => {
      pointerDown = false
      pointerDownRef.current = false
      pointerDownAtRef.current = 0
      if (!growPending) return
      growPending = false
      growAndRestore()
    }
    window.addEventListener('pointerdown', markDown, true)
    window.addEventListener('pointerup', markUp, true)
    window.addEventListener('pointercancel', markUp, true)
    // 拖到窗口外/切走时收不到 pointerup，blur 也收一下，避免 pointerDown 永久为真
    window.addEventListener('blur', markUp)
    const isDragging = () => pointerDown

    /**
     * @param byUser true = 由用户缩放/平移触发；false = 只是十字线在动。
     * 只有用户自己动了视野才更新 userWindowRef，否则切周期时按「代码设出来的窗口」
     * 当基准，来回切会把时间跨度越撑越大。
     */
    const onRange = (byUser: boolean) => {
      // 记一下当前窗口有多宽（根数），切周期时按它还原缩放
      const r = chart.timeScale().getVisibleLogicalRange()
      if (r && Number.isFinite(r.from) && Number.isFinite(r.to)) {
        const span = Math.round(r.to - r.from)
        if (span > 5 && span < 20000) viewSpanRef.current = span
      }
      /**
       * 十字线移动（byUser = false）**不用重画叠加层**。
       *
       * 它既不改时间轴也不改价格轴，画线和成交连线一根都不会动；价格轴万一真的
       * 变了（autoscale 重算），下面的看门狗会在同一帧补一次。以前这里也整幅重画，
       * 于是鼠标在图上一动，就要把全部画线重绘一遍 —— 画线攒多之后，光「移动鼠标」
       * 就足以让画面发涩，按住右键拖着画的时候更是雪上加霜。
       */
      if (!byUser) return
      // 刚由代码设过视野（120ms 内）就不算用户操作
      if (performance.now() - autoRangeAtRef.current > 120) {
        /**
         * 刚续过长（250ms 内）：这段视野变化是自己引起的，不是用户又拖了一下，
         * 整段跳过 —— 否则会拿一个被推歪的窗口去覆盖 userWindowRef，
         * 判断续长的那个条件也会被自激一遍（见 futureGrowAtRef）。
         */
        if (performance.now() - futureGrowAtRef.current <= 250) {
          redrawRef.current()
          return
        }
        userWindowRef.current = readVisibleWindow(chart)
        /**
         * 滑到未来占位的尽头了就再续一段 —— 横向时间因此滑不到头。
         * 拖动中只记账，松手时补（见 growAndRestore 的注释）。
         */
        if (r && r.to > rangeRef.current.lastIndex + 1 + futureAheadRef.current - 2) {
          if (isDragging()) growPending = true
          else growAndRestore()
        }
      }
      redrawRef.current()
    }
    const onRangeByUser = () => onRange(true)
    const onCrosshair = () => onRange(false)
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRangeByUser)
    chart.subscribeCrosshairMove(onCrosshair)
    const ro = new ResizeObserver(() => {
      // 尺寸变了才重新量几何（paintNow 里的 metricsRef 缓存）
      metricsDirtyRef.current = true
      redrawRef.current()
    })
    ro.observe(el)

    /**
     * 价格轴看门狗：让叠加层（成交连线 / 画线）真正实时跟着 K 线走。
     *
     * 时间轴和价格轴的更新时机不一样：
     *  - 时间轴（timeToCoordinate）在设完可视区间的那一刻就是新值；
     *  - 价格轴（autoscale）要等图表下一次 paint 才重算，而 lightweight-charts
     *    没有「价格轴变了」这类事件可以订阅。
     *
     * 于是我们这层 canvas 在「点订单定位 / 滚轮缩放 / 拖右侧价格轴 / 数据推进撑开
     * 价格区间」这些时刻拿到的还是上一帧的换算式：x 已经对准了，y 还是旧的。
     * 更糟的是事后没有任何事件再触发重绘，错位就一直留在屏幕上——用户看到的就是
     * 「历史交易线不跟着 K 线图变化、越缩放越歪」。
     *
     * 这里每帧读一次价格轴指纹（两次 coordinateToPrice，开销可忽略），
     * 变了就在当帧补画一次。不依赖任何事件的触发时机，自然也不会白画。
     */
    let watchRaf = 0
    const watchPriceScale = () => {
      watchRaf = requestAnimationFrame(watchPriceScale)
      const s = seriesRef.current
      if (!s) return
      const sig = priceScaleSignature(s)
      // 和「上一次真正画出去时用的价格轴」比，一样就没什么可补的
      if (sig === scaleSigRef.current) return
      // 先把基线推上去：万一 redraw 因为尺寸测量不到等原因提前返回，
      // 也不会每帧都重试成空转
      scaleSigRef.current = sig
      redrawRef.current()
    }
    watchRaf = requestAnimationFrame(watchPriceScale)

    return () => {
      cancelAnimationFrame(watchRaf)
      ro.disconnect()
      window.removeEventListener('pointerdown', markDown, true)
      window.removeEventListener('pointerup', markUp, true)
      window.removeEventListener('pointercancel', markUp, true)
      window.removeEventListener('blur', markUp)
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRangeByUser)
      chart.unsubscribeCrosshairMove(onCrosshair)
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
      futureSeriesRef.current = null
      setChartApi(null)
      onChartReadyRef.current?.(null, null)
      indicatorRefs.current.clear()
      posLinesRef.current.clear()
      // 图没了，缓存的几何量也失效
      metricsRef.current = null
      metricsDirtyRef.current = true
      riskModeRef.current = null
      dragPosRef.current = null
      dragMovedRef.current = false
      prevLenRef.current = 0
      prevBarsRef.current = null
      // 图重建了，未来占位要从设置值重新铺
      futureAheadRef.current = 0
      futureGrowAtRef.current = 0
      pointerDownRef.current = false
    }
    // growFuture 是稳定引用（内部只读 ref），放进依赖不会导致整张图重建
  }, [growFuture])

  // ---------- 精度 ----------
  useEffect(() => {
    seriesRef.current?.applyOptions({
      priceFormat: { type: 'price', precision: digits, minMove: Math.pow(10, -digits) }
    })
  }, [digits])

  // ---------- 主题 / 时区实时应用 ----------
  useEffect(() => {
    const chart = chartRef.current
    const series = seriesRef.current
    if (!chart || !series) return

    chart.applyOptions({
      layout: { background: { color: theme.background }, textColor: theme.textColor },
      // 切时区后要让坐标轴和十字线立刻按新时区重画
      timeScale: {
        tickMarkFormatter: (time: Time, type: TickMarkType): string =>
          fmtTickMark(Number(time), type, t, theme.axisWeekday)
      },
      localization: {
        locale: 'zh-CN',
        timeFormatter: (time: Time): string =>
          fmtClock(Number(time), true, t, theme.axisWeekday)
      },
      grid: {
        vertLines: { color: theme.gridColor, visible: theme.gridVisible },
        horzLines: { color: theme.gridColor, visible: theme.gridVisible }
      },
      crosshair: {
        mode: theme.crosshairMagnet ? 1 : 0,
        vertLine: {
          color: theme.crosshairColor,
          width: theme.crosshairWidth,
          style: theme.crosshairStyle,
          labelVisible: theme.crosshairLabels
        },
        horzLine: {
          color: theme.crosshairColor,
          width: theme.crosshairWidth,
          style: theme.crosshairStyle,
          labelVisible: theme.crosshairLabels
        }
      }
    })

    series.applyOptions({
      upColor: theme.upColor,
      downColor: theme.downColor,
      borderUpColor: theme.upColor,
      borderDownColor: theme.downColor,
      wickUpColor: theme.upColor,
      wickDownColor: theme.downColor,
      borderVisible: theme.showBorder,
      wickVisible: theme.showWick
    })

    redrawRef.current()
  }, [theme, timezone, t])

  // ---------- 主图数据推进 ----------
  useEffect(() => {
    const series = seriesRef.current
    const chart = chartRef.current
    if (!series || !chart) return

    const visibleCount = Math.min(bars.length, cursor + 1)
    if (visibleCount <= 0) {
      series.setData([])
      futureSeriesRef.current?.setData([])
      prevLenRef.current = 0
      prevBarsRef.current = bars
      return
    }

    const sameDataset = prevBarsRef.current === bars
    // 从副窗切回主图：增量 update 可能留下一段没重画的空洞，强制做一次全量 setData
    const becameActive = active && !activeRef.current
    activeRef.current = active
    const appendedOne =
      !becameActive && sameDataset && visibleCount === prevLenRef.current + 1

    /**
     * 默认视图右侧留多少根空白。
     *
     * 至少 3 根（最后一根不贴边框，还能看出下一根要来的位置）；
     * 开了「未来空白」就多留一点，一上来就能看到未来的时间刻度、也有地方落笔。
     * 但最多 20 根 —— 再多一开屏就有半屏是空的，反而不知道看哪儿。
     */
    const rightPad = (count: number): number =>
      Math.max(count <= 10 ? 3 : 7, Math.min(Math.max(0, futureBarsRef.current), 20))

    /**
     * 换成另一个回测集（不是切周期）时，记着的窗口属于上一份数据，先丢掉，
     * 免得下一次切周期按一个跟当前数据无关的时间段去定位。
     */
    if (!sameDataset && tfRef.current === timeframe) userWindowRef.current = null

    /**
     * 切周期前先确定「要还原成哪段时间」。
     * 优先用 userWindowRef（用户上一次自己缩放/平移出来的窗口，不会被切周期后的
     * 画面撑大而污染）；没有就用 chart 当前的可视范围兜底。
     * 必须抢在 setData 之前——chart 里装的还是旧周期的数据，这一帧之后就换掉了。
     */
    const tfChanged = tfRef.current !== timeframe
    const prevWindow = tfChanged ? (userWindowRef.current ?? readVisibleWindow(chart)) : null
    /**
     * 这一格推进之前用户在看哪几根。
     *
     * 播放推进时：贴边就跟着新 K 线平移同样根数，历史区就一根不动。
     * setData / update 之后 lightweight-charts 会拿“新的最后一根”重算右偏移，
     * 所以先把逻辑范围和当时是否贴边记下来，数据灌完再按规则设回去。
     *
     * 换回测集 / 切周期不走这条还原：那两个分支本来就要重新定位到一段有意义的窗口。
     */
    const prevLogical = chart.timeScale().getVisibleLogicalRange()
    const prevLen = prevLenRef.current
    /**
     * 这一格推进前，视窗是不是已经贴着最新。
     *
     * 贴着最新时允许跟着新 K 线往右平移同样的根数（否则最新一根会从右边溢出去）；
     * 用户已经往回翻到历史区时，逻辑范围必须原样钉死，一步都不许动。
     * 两种需求不矛盾：区别只在“推之前右端在不在最新附近”。
     */
    const wasAtLiveEdge =
      prevLogical != null && prevLen > 0 && prevLogical.to >= prevLen - 3

    if (appendedOne) {
      const bar = partialBar ?? bars[cursor]
      series.update({
        time: bar.time as UTCTimestamp,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close
      })
    } else {
      const data: CandlestickData[] = []
      for (let i = 0; i < visibleCount; i++) {
        // 最后一根可能只走到一半（大周期上切过来时）：画截断版，别把未来的收盘价露出来
        const b = i === visibleCount - 1 && partialBar ? partialBar : bars[i]
        data.push({
          time: b.time as UTCTimestamp,
          open: b.open,
          high: b.high,
          low: b.low,
          close: b.close
        })
      }
      /**
       * setData 换数据本身就会触发一次可视区间变化（右端贴到新数据的末尾），
       * 那一下必须算成「代码改的」，否则会被当成用户正在看的窗口，
       * 下一次切周期就按一个跟用户无关的狭窄窗口去定位。
       * 时间戳打在 setData 之前，因为那次变化是在 setData 里同步发出的。
       */
      autoRangeAtRef.current = performance.now()
      series.setData(data)

      tfRef.current = timeframe

      // 切周期：按「同一段时间」还原视野，而不是同一根数。
      // 保持根数会让时间跨度随周期成倍缩放（M1 的 346 根是 6 小时，M15 的 346 根是 3.6 天），
      // 切过去等于换了一个时间段看。这里把切换前的时间窗口映射回新周期的下标。
      if (tfChanged) {
        const pad = rightPad(visibleCount)
        const maxTo = visibleCount + pad
        // 下限只防「一段窗口在更大周期上只剩一根」这种退化画面；
        // 撑大之后不会回头污染下一轮切换（基准始终是 userWindowRef）。
        const minSpan = 4
        let from: number
        let to: number

        if (prevWindow) {
          from = logicalOfTime(bars, visibleCount, prevWindow.from)
          to = logicalOfTime(bars, visibleCount, prevWindow.to)
          // 这段窗口在新周期上超出了已有数据（比如往右拖过一点）就贴住末尾，整体左移
          if (to > maxTo) {
            const shift = to - maxTo
            to = maxTo
            from -= shift
          }
          // 太窄（更大周期上只剩一两根）就往前多给几根，别让一根 K 线占满整屏。
          // 注意从右端往前补：用户看的是那段行情的末尾，补前面比补后面合理。
          if (to - from < minSpan) from = to - minSpan
          if (from < 0) {
            to -= from
            from = 0
          }
          if (to > maxTo) to = maxTo
        } else {
          // 读不到旧窗口（首次挂载之类）就退回默认根数
          const span = Math.min(Math.max(20, Math.round(viewSpanRef.current)), maxTo)
          from = visibleCount - span
          to = maxTo
          if (to - from < minSpan) from = to - minSpan
          if (from < 0) from = 0
        }

        autoRangeAtRef.current = performance.now()
        chart.timeScale().setVisibleLogicalRange({ from, to })
      } else if (!sameDataset) {
        const pad = rightPad(visibleCount)
        autoRangeAtRef.current = performance.now()
        chart.timeScale().setVisibleLogicalRange({
          from: Math.max(0, visibleCount - 110),
          to: visibleCount + pad
        })
      }
    }

    prevLenRef.current = visibleCount
    prevBarsRef.current = bars
    /**
     * 主图推进后重铺未来时间点：占位的时间要接着最后一根往后排。
     *
     * 注意：重铺会让时间轴末端跟着最后一根后移，即使 rightOffset 不变，
     * 画面也会整体右移一格 —— 所以下面紧接着要把视野钉回原位。
     * 换数据 / 换周期时重置回设置值：上一份数据上拖出来的几十万根未来
     * 跟这份数据无关，留着只会让占位点到很远的过去或未来去。
     */
    refreshFuture(tfChanged || !sameDataset)

    /**
     * 同一次回放里的数据推进：把视野按“是否贴边”摆回去。
     *
     *  · 贴边：整体右移这一格新增的根数，保持宽度和右侧未来空白不变 ——
     *    最新 K 线始终落在窗内，不会从右边溢出去；
     *  · 历史区：原样钉死，不自动跟随、不自动归正。
     *
     * 数据更新（setData / update / 重铺未来占位）都会让图表按新的最后一根
     * 重算右偏移，所以两种分支都要在最后显式设一次。
     */
    // 拖拽事件丢失的兜底：超过 5 秒还认为按着，就当成松手了，别把主图永久冻在旧位置
    if (
      pointerDownRef.current &&
      performance.now() - pointerDownAtRef.current > 5000
    ) {
      pointerDownRef.current = false
      pointerDownAtRef.current = 0
    }

    if (sameDataset && !tfChanged && prevLogical && !pointerDownRef.current) {
      const delta = Math.max(0, visibleCount - prevLen)
      const shift = wasAtLiveEdge ? delta : 0
      const target = { from: prevLogical.from + shift, to: prevLogical.to + shift }
      /**
       * 贴边时至少给最新一根留一段未来空白。
       *
       * 以前这里只是原样平移：如果主图之前被副窗的“右端=最后一根”同步过，
       * 平移后仍然贴着右边框，最新一根没有呼吸空间。这里按视窗宽度补 6%
       * （夹在 5~30 根），只在贴边时做；用户翻到历史区不会被动。
       */
      if (wasAtLiveEdge) {
        const span = target.to - target.from
        const minPad = Math.max(5, Math.min(30, Math.round(span * 0.06)))
        const minTo = visibleCount - 1 + minPad
        if (target.to < minTo) {
          const add = minTo - target.to
          target.from += add
          target.to += add
        }
      }
      autoRangeAtRef.current = performance.now()
      chart.timeScale().setVisibleLogicalRange(target)
      requestAnimationFrame(() => {
        if (pointerDownRef.current) return
        const c = chartRef.current
        if (!c) return
        c.timeScale().setVisibleLogicalRange(target)
      })
    }

    redrawRef.current()
  }, [bars, cursor, partialBar, active])

  // ---------- 设置里改了「未来」根数：只重铺占位点，不重建图表 ----------
  const prevFutureBarsRef = useRef(theme.futureBars)
  useEffect(() => {
    if (prevFutureBarsRef.current === theme.futureBars) return
    prevFutureBarsRef.current = theme.futureBars
    // 用户明确改了根数就按新设置收回来，别把之前拖出去的长度顶在这儿
    refreshFuture(true)
  }, [theme.futureBars, refreshFuture])

  // ---------- 指标 series：结构变化时整体重建 ----------
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return

    // 1) 清空旧的指标 series
    for (const [, s] of indicatorRefs.current) {
      try {
        chart.removeSeries(s)
      } catch {
        // 已随 pane 一起移除
      }
    }
    indicatorRefs.current.clear()

    // 2) 删掉所有副图 pane（从后往前，留着 index 0 主图）
    for (let guard = 0; guard < 16; guard++) {
      const panes = chart.panes()
      if (panes.length <= 1) break
      try {
        chart.removePane(panes.length - 1)
      } catch {
        break
      }
    }

    const ensure = (key: string, make: () => AnySeries): AnySeries => {
      const created = make()
      indicatorRefs.current.set(key, created)
      return created
    }

    // 3) 主图叠加（pane 0）
    for (const line of overlayData) {
      ensure(line.key, () =>
        chart.addSeries(
          LineSeries,
          {
            color: line.color,
            lineWidth: 1,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false
          },
          0
        )
      )
    }

    // 4) 副图：每个实例独占一个 pane，顺序跟 subPanes 一致
    subPaneData.forEach((entry, i) => {
      const paneIndex = i + 1
      const isVolume = entry.view.format === 'volume'
      for (const ser of entry.view.series) {
        const key = `${entry.uid}:${ser.key}`
        if (ser.type === 'hist') {
          ensure(key, () =>
            chart.addSeries(
              HistogramSeries,
              {
                priceLineVisible: false,
                lastValueVisible: false,
                ...(isVolume ? { priceFormat: { type: 'volume' as const } } : {})
              },
              paneIndex
            )
          )
        } else {
          ensure(key, () =>
            chart.addSeries(
              LineSeries,
              {
                color: ser.color,
                lineWidth: ser.lineWidth ?? 1,
                priceLineVisible: false,
                lastValueVisible: false
              },
              paneIndex
            )
          )
        }
      }

      // 参考线（RSI 70/30、CCI ±100…）挂在副图第一根 series 上
      const first = entry.view.series[0]
      const holder = first ? indicatorRefs.current.get(`${entry.uid}:${first.key}`) : null
      if (holder && entry.view.guides.length > 0) {
        for (const g of entry.view.guides) {
          try {
            holder.createPriceLine({
              price: g.value,
              color: g.color ?? 'rgba(255,255,255,0.16)',
              lineWidth: 1,
              lineStyle: LineStyle.Dashed,
              axisLabelVisible: false,
              title: ''
            })
          } catch {
            // 参考线画不上不致命
          }
        }
      }
    })

    // 5) 高度分配：主图吃掉剩余，副图总量随个数略微变多但不超过 66%
    const panes = chart.panes()
    const subCount = Math.max(0, panes.length - 1)
    if (subCount > 0) {
      const subTotal = Math.min(0.34 + 0.14 * (subCount - 1), 0.66)
      panes[0].setStretchFactor(1)
      for (let i = 1; i < panes.length; i++) panes[i].setStretchFactor(subTotal / subCount)
    }
    // 主图被副图挤过之后高度变了，缓存的主图分界线位置得重新量
    metricsDirtyRef.current = true
  }, [indicatorStructure, overlayData, subPaneData])

  // ---------- 指标 series：只灌数据 ----------
  useEffect(() => {
    const visibleCount = Math.min(bars.length, cursor + 1)
    const timeAt = (i: number): UTCTimestamp => bars[i].time as UTCTimestamp

    const toLineData = (values: Series): (LineData | WhitespaceData)[] => {
      const out: (LineData | WhitespaceData)[] = []
      for (let i = 0; i < visibleCount; i++) {
        const v = values[i]
        out.push(v == null ? { time: timeAt(i) } : { time: timeAt(i), value: v })
      }
      return out
    }

    for (const line of overlayData) {
      const s = indicatorRefs.current.get(line.key) as ISeriesApi<'Line'> | undefined
      if (s) s.setData(toLineData(line.values))
    }

    for (const entry of subPaneData) {
      for (const ser of entry.view.series) {
        const api = indicatorRefs.current.get(`${entry.uid}:${ser.key}`)
        if (!api) continue
        if (ser.type === 'hist') {
          const data: HistogramData[] = []
          for (let i = 0; i < visibleCount; i++) {
            const v = ser.values[i]
            if (v == null) continue
            const color = ser.colors?.[i]
            data.push(color ? { time: timeAt(i), value: v, color } : { time: timeAt(i), value: v })
          }
          ;(api as ISeriesApi<'Histogram'>).setData(data)
        } else {
          ;(api as ISeriesApi<'Line'>).setData(toLineData(ser.values))
        }
      }
    }

    redrawRef.current()
  }, [indicatorStructure, overlayData, subPaneData, bars, cursor])

  // ---------- 入场 / SL / TP 价格线（每一笔持仓一组） ----------
  useEffect(() => {
    const series = seriesRef.current
    if (!series) return

    // 结构变了就整组重画：笔数、方向、开仓价、有没有设 SL/TP 都会改变线条的形态。
    // 只是价格在动（拖动中）时不走这里，避免每帧销毁重建。
    for (const lines of posLinesRef.current.values()) {
      for (const line of Object.values(lines)) {
        try {
          series.removePriceLine(line)
        } catch {
          // 已移除
        }
      }
    }
    posLinesRef.current.clear()

    for (const p of positions) {
      const lines: { entry?: IPriceLine; sl?: IPriceLine; tp?: IPriceLine; pending?: IPriceLine } = {}
      const isActive = p.id === activePositionId
      // 标签带上方向和手数：多笔同价位时才分得清哪条是谁的
      const tag = t('chart.sideLotTag', {
        side: p.side === 'buy' ? t('chart.sideBuy') : t('chart.sideSell'),
        lot: p.lot.toFixed(2)
      })

      /**
       * 止损 / 止盈还没设全 → 开仓价上放一条「待定性」的线，标签直接写清这次能拖什么。
       *
       * 两个都空：拖到哪边就设哪个（往上=止盈、往下=止损，拖过开仓价还能换回来）；
       * 只缺止损：只能往亏损侧拖止损；只缺止盈：只能往盈利侧拖止盈。
       */
      const needRisk = p.sl == null || p.tp == null
      if (needRisk) {
        // 多头亏损侧在下方、空头在上方 —— 提示里的方向要塞进去，不然用户不知道往哪拖
        const lossSide = p.side === 'buy' ? t('chart.sideDown') : t('chart.sideUp')
        const profitSide = p.side === 'buy' ? t('chart.sideUp') : t('chart.sideDown')
        const only =
          p.sl == null && p.tp == null
            ? t('chart.pendingBoth', { profitSide, lossSide })
            : p.sl == null
              ? t('chart.pendingSl', { lossSide })
              : t('chart.pendingTp', { profitSide })
        lines.pending = series.createPriceLine({
          price: p.entryPrice,
          // 焦点那笔用亮一点的灰，其它压暗，避免多笔时一片糊
          color: isActive ? '#cbd5e1' : '#7b8494',
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: `${tag} · ${only}`
        })
      } else {
        lines.entry = series.createPriceLine({
          price: p.entryPrice,
          color: p.side === 'buy' ? ENTRY_BUY_COLOR : ENTRY_SELL_COLOR,
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: tag
        })
      }

      if (p.sl != null) {
        lines.sl = series.createPriceLine({
          price: p.sl,
          color: isTrailingStop(p) ? TRAIL_COLOR : SL_COLOR,
          // 细虚线：不遮挡 K 线，也一眼能看出是可拖的辅助线
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          // 标签直接写成「SL -$12.40」：这根线打到了到底亏多少，不用自己算
          title: riskTitle(p, 'sl', riskPnlLabel, t('chart.trailingStop'))
        })
      }

      if (p.tp != null) {
        lines.tp = series.createPriceLine({
          price: p.tp,
          color: TP_COLOR,
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: riskTitle(p, 'tp', riskPnlLabel, t('chart.trailingStop'))
        })
      }

      posLinesRef.current.set(p.id, lines)
    }
  }, [posLineSig, activePositionId, positions, t])

  /**
   * 待确认单的三条线。
   *
   * 和持仓分开画，原因有二：
   *  1) 它不是持仓，不该混进 positions 影响浮动盈亏、持仓卡、平仓统计；
   *  2) 它比持仓多两样东西 —— 开仓线不带 title（那一行要留给 HTML 的
   *     「方向+手数 / 风险金额 / 确认 / 取消」），而且拖动语义更简单（只有止损止盈两条可拖）。
   *
   * 用 createPriceLine 而不是 update：线数固定最多三条，重建成本可以忽略，
   * 反而少一堆「线被删了还在 applyOptions」的边界情况要处理。
   */
  const pendingSig = pendingOrder
    ? `${pendingOrder.side}|${pendingOrder.entry}|${pendingOrder.sl}|${pendingOrder.tp}|${pendingOrder.slLabel ?? ''}|${pendingOrder.tpLabel ?? ''}`
    : ''
  useEffect(() => {
    const series = seriesRef.current
    if (!series) return

    for (const pl of Object.values(pendingLinesRef.current)) {
      if (!pl) continue
      try {
        series.removePriceLine(pl)
      } catch {
        // 已经不存在
      }
    }
    pendingLinesRef.current = {}

    const p = pendingRef.current
    if (!p) return

    const sideColor = p.side === 'buy' ? ENTRY_BUY_COLOR : ENTRY_SELL_COLOR
    // 开仓线不带 title：那一行由 HTML 票面（手数 / 风险 / 确认 / 取消）占着，
    // 再让 lightweight-charts 在左端叠一个标题就会两层文字糊在一起
    pendingLinesRef.current.entry = series.createPriceLine({
      price: p.entry,
      color: sideColor,
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: true,
      title: ''
    })
    if (p.sl != null) {
      pendingLinesRef.current.sl = series.createPriceLine({
        price: p.sl,
        color: SL_COLOR,
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: p.slLabel ? `SL ${p.slLabel}` : 'SL'
      })
    }
    if (p.tp != null) {
      pendingLinesRef.current.tp = series.createPriceLine({
        price: p.tp,
        color: TP_COLOR,
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: p.tpLabel ? `TP ${p.tpLabel}` : 'TP'
      })
    }
  }, [pendingSig])

  /** 待确认单没了就把线清干净（卸载时也走一次，别把线留在别的会话里） */
  useEffect(() => {
    return () => {
      const series = seriesRef.current
      for (const pl of Object.values(pendingLinesRef.current)) {
        if (!pl || !series) continue
        try {
          series.removePriceLine(pl)
        } catch {
          // 图表已经销毁
        }
      }
      pendingLinesRef.current = {}
    }
  }, [])

  /**
   * 价格变动（含拖动中每帧）：只改线的位置和标签，不重建。
   *
   * 标签里带着「打到这里净盈亏多少」，而它随止损价一起每帧变化（用户在拖），
   * 所以金额的刷新也放在这里 —— 重建（removePriceLine + createPriceLine）
   * 每帧来一遍会明显掉帧，applyOptions 只是改个属性。
   */
  useEffect(() => {
    const series = seriesRef.current
    if (!series) return
    for (const p of positions) {
      const lines = posLinesRef.current.get(p.id)
      if (!lines) continue
      if (lines.sl && p.sl != null) {
        lines.sl.applyOptions({
          price: p.sl,
          // 拖过成本价的那一刻颜色要跟着换（拖拽中是每帧刷，所以放这里而不是建线那次）
          color: isTrailingStop(p) ? TRAIL_COLOR : SL_COLOR,
          title: riskTitle(p, 'sl', riskPnlLabel, t('chart.trailingStop'))
        })
      }
      if (lines.tp && p.tp != null) {
        lines.tp.applyOptions({ price: p.tp, title: riskTitle(p, 'tp', riskPnlLabel, t('chart.trailingStop')) })
      }
    }
  }, [positions, riskPnlLabel])

  // ---------- 报告 / 日志选中的交易：开/关仓价格线 + 整段展示 ----------
  useEffect(() => {
    const series = seriesRef.current
    const chart = chartRef.current
    if (!series || !chart) return

    for (const pl of focusLinesRef.current) {
      try {
        series.removePriceLine(pl)
      } catch {
        // 已移除
      }
    }
    focusLinesRef.current = []

    focusedRef.current = focusedTrade ?? null
    if (!focusedTrade) {
      redrawRef.current()
      return
    }

    focusLinesRef.current.push(
      series.createPriceLine({
        price: focusedTrade.entryPrice,
        color: '#38bdf8',
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: t('chart.entryLineTitle')
      })
    )
    focusLinesRef.current.push(
      series.createPriceLine({
        price: focusedTrade.exitPrice,
        color: '#eab308',
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: t('chart.exitLineTitle')
      })
    )

    /**
     * 定位订单：固定给「左右一共 150 根」，一次设到位（口径见 ./trade-lines）。
     *
     * 以前是「先整段铺满，如果订单被裁掉再缩过去」，有两个毛病：
     *  1) setVisibleLogicalRange 要等下一帧才真正应用，连设两次会互相覆盖，
     *     屏幕上先闪一下整段、再跳到订单，看着就是「卡一秒才找准」；
     *  2) 「整段放得下吗」是按 0.5px 最小柱宽推算的，几千根时几乎总被算成放得下，
     *     于是压根不缩——点了订单却停在整段，位置还是没对准。
     * 现在统一成固定窗口：跨度永远 150 根，柱宽由宽度决定，每次定位屏幕都是铺满的。
     *
     * 双周期开着、而用户选中的是副周期窗时，主图不再抢着定位：两个窗口各自的
     * 「150 根」跨的时间长度完全不同（M15 是 37 小时、H1 是 6 天），都去设一遍
     * 就是互相覆盖，最后停在谁那儿全看执行顺序。谁被选中谁定位，另一个跟着同步走。
     */
    if (!focusTarget) {
      redrawRef.current()
      return
    }
    const range = focusLogicalRange({
      total: bars.length,
      // 可见上限：回放没走完时就是游标那根，不许把未来露出来
      lastRevealed: revealIndex ?? bars.length - 1,
      idxIn: timeToLogical(focusedTrade.entryTime),
      idxOut: timeToLogical(focusedTrade.exitTime)
    })
    if (range) {
      // 这里故意不盖 autoRangeAtRef 的时间戳：定位之后的这一屏就是用户当下在看的窗口，
      // 让它记进 userWindowRef，接着切周期才会「留在这笔单子附近看」，而不是弹回原处。
      chart.timeScale().setVisibleLogicalRange(range)
    }
    redrawRef.current()
  }, [focusedTrade?.id, focusSeq, bars.length, revealIndex, timeToLogical, t, focusTarget])

  // ---------- 交互：画线 + SL/TP 拖拽 ----------
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const localPoint = (e: MouseEvent) => {
      const rect = el.getBoundingClientRect()
      return { x: e.clientX - rect.left, y: e.clientY - rect.top }
    }

    const mapping = (): ChartMapping | null => buildMapping()

    /**
     * 主图底边（容器坐标）。
     *
     * 副图里不该起笔：形状绑的是**价格轴**，在副图画一笔，换算出来的价格离谱到
     * 主图上根本看不见（绘制又被裁掉了）—— 结果就是「画了个看不见的东西」。
     * 拖拽同理，所以按下时先卡一刀。
     */
    const paneBottomY = (): number => {
      const ch = chartRef.current
      if (!ch) return Number.POSITIVE_INFINITY
      return mainPaneRange(ch, el.getBoundingClientRect()).bottom
    }

    /**
     * 命中测试：返回最近的一条可拖线属于哪笔持仓、是哪种线。
     * 多持仓时所有持仓的线都能拖，取离鼠标最近的那条。
     */
    const hitLine = (y: number): { id: string; key: 'sl' | 'tp' | 'risk' } | null => {
      const series = seriesRef.current
      if (!series) return null

      // 用对象包一层：闭包里给「裸变量」赋值 TS 会认为它还是 null
      const hit: { best: { id: string; key: 'sl' | 'tp' | 'risk'; dist: number } | null } = {
        best: null
      }
      const consider = (id: string, key: 'sl' | 'tp' | 'risk', price: number | null): void => {
        if (price == null) return
        const coord = series.priceToCoordinate(price)
        if (coord == null) return
        const dist = Math.abs((coord as number) - y)
        if (dist <= HIT_TOLERANCE && (!hit.best || dist < hit.best.dist)) {
          hit.best = { id, key, dist }
        }
      }

      for (const pos of positionsRef.current) {
        // 待定性的那条压在开仓价上
        if (pos.sl == null || pos.tp == null) consider(pos.id, 'risk', pos.entryPrice)
        consider(pos.id, 'sl', pos.sl)
        consider(pos.id, 'tp', pos.tp)
      }

      /**
       * 待确认单的线排在最前面判断：它盖在持仓线之上，视觉上就在最上层，
       * 命中也该优先 —— 否则刚按完 B 想去拖止损，一拖却把下面那笔老持仓动了。
       */
      const pend = pendingRef.current
      if (pend) {
        // 两条线都空时，开仓线本身就是「拖出来设哪一条」的把手
        if (pend.sl == null || pend.tp == null) consider(PENDING_ID, 'risk', pend.entry)
        consider(PENDING_ID, 'sl', pend.sl)
        consider(PENDING_ID, 'tp', pend.tp)
      }
      return hit.best ? { id: hit.best.id, key: hit.best.key } : null
    }

    /**
     * 右键专用：命中哪笔持仓的**开仓线**。
     *
     * 和 hitLine 分开写，因为开仓线在图上始终存在（两线都设好时是 entry 线，
     * 缺一条时是压在开仓价上的待定线），但 hitLine 只在「缺线」时才算开仓价 ——
     * 那个判断是给左键拖 SL/TP 用的，右键减仓不该受它限制。
     */
    const hitEntryLine = (y: number): string | null => {
      const series = seriesRef.current
      if (!series) return null
      let best: { id: string; dist: number } | null = null
      for (const pos of positionsRef.current) {
        const coord = series.priceToCoordinate(pos.entryPrice)
        if (coord == null) continue
        const dist = Math.abs((coord as number) - y)
        if (dist <= HIT_TOLERANCE && (!best || dist < best.dist)) best = { id: pos.id, dist }
      }
      return best?.id ?? null
    }

    /** 退出画线模式 */
    const exitTool = () => {
      toolRef.current = null
      el.style.cursor = ''
      onToolChange?.(null)
    }

    /**
     * 把时间夹到「可画范围」内：已加载的 K 线区间 + 右侧预留的未来空白。
     *
     * 上限不是最后一根 —— 允许把锚点落在未来空白里，画预测线 / 趋势线延长用；
     * 再往右就没有坐标可言（图上根本拖不到那里），夹住免得存下一个看不见的点。
     */
    const clampTime = (time: number): number => {
      const { first, last, step } = rangeRef.current
      if (!first || !last) return time
      // 上限用「实际铺了多长」而不是设置值：往右拖过的未来也得能落笔
      const ahead = Math.max(futureBarsRef.current, futureAheadRef.current)
      const futureLimit = last + Math.max(0, ahead) * (step || 60)
      return Math.min(Math.max(time, first), futureLimit)
    }

    /** 提交当前预览（第二下左键 / 单点工具的第一下 / 折线右键收尾） */
    const commitPreview = () => {
      const p = previewRef.current
      if (!p) return
      const id = `d_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`
      let shape: Drawing | null = null

      if (p.type === 'polyline') {
        /**
         * 折线：只收「左键点过的锚点」，跟着鼠标走的那一段直接丢掉。
         * 用户按右键的意思是「就到这里为止」，再把鼠标当前位置塞进去，
         * 等于在最后一个锚点后面又多出一段他没点过的线。
         */
        const pts = (p.anchors ?? []).map((a) => ({ time: clampTime(a.time), price: a.price }))
        // 少于两个点连不成线，等于什么都没画
        if (pts.length >= 2) {
          shape = {
            id,
            type: 'polyline',
            p1: pts[0],
            p2: pts[pts.length - 1],
            points: pts,
            color: DRAWING_COLORS.polyline
          }
        }
      } else if (p.type === 'hline' || p.type === 'vline') {
        shape = {
          id,
          type: p.type,
          p1: { time: clampTime(p.t1), price: p.v1 },
          color: DRAWING_COLORS[p.type]
        }
      } else if (Math.hypot(p.p2.x - p.p1.x, p.p2.y - p.p1.y) >= 3) {
        shape = {
          id,
          type: p.type,
          p1: { time: clampTime(p.t1), price: p.v1 },
          p2: { time: clampTime(p.t2), price: p.v2 },
          color: DRAWING_COLORS[p.type]
        }
      }

      previewRef.current = null
      if (shape) {
        // 刚画完就选中它：右键菜单能直接改色 / 删除，不用再点一下
        selectedRef.current = shape.id
        const next = [...drawingsRef.current, shape]
        drawingsRef.current = next
        onDrawingsChange(next)
      }
      exitTool()
      redrawRef.current()
    }

    /** 取消进行中的画线 */
    const cancelPreview = () => {
      previewRef.current = null
      exitTool()
      redrawRef.current()
    }

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return
      /**
       * 图表里还叠着一层 HTML（待确认单票面、减仓菜单、按钮……）。
       * 这些元素的点击不能当成「按在价格线上」：
       * 待确认单票面正好压在开仓线上，点「确认」时手抖一像素，
       * 就会被下面的命中测试抓去拖止盈，成交后莫名其妙多出一条极窄的 TP。
       */
      const target = e.target as HTMLElement | null
      if (
        target &&
        target.closest(
          'button, input, textarea, select, a, [data-pending-ticket], [data-lot-menu], [data-chart-menu]'
        )
      ) {
        return
      }
      // 点了图表就退出「聚焦某笔交易」状态，否则开/关两条参考线会一直挂着
      onClearFocus?.()
      const { x, y } = localPoint(e)
      const map = mapping()
      if (!map) return

      // 副图里不起笔（见 paneBottomY 的说明）：画了也看不见，还会挂在那挡住副图
      if (y > paneBottomY()) return

      const tool = toolRef.current
      if (tool) {
        const time = map.xToTime(x)
        const v = map.yToPrice(y)
        if (time == null || v == null) return
        e.preventDefault()
        e.stopPropagation()

        // 文本：落点后直接进入输入状态
        if (tool === 'text') {
          exitTool()
          setTextDraft({ x, y, time, price: v })
          return
        }

        /**
         * 折线：左键每点一次落一个锚点，点多少下都行，右键才收尾（见 onContextMenu）。
         *
         * 这里刻意不做「第二下就完成」——那和趋势线一样了。折线的整条线在
         * 右键之前都活在 previewRef 里，画的过程中随时可以 Esc / 右键放弃。
         */
        if (tool === 'polyline') {
          const cur = previewRef.current
          if (!cur) {
            previewRef.current = {
              type: 'polyline',
              p1: { x, y },
              p2: { x, y },
              t1: time,
              v1: v,
              t2: time,
              v2: v,
              anchors: [{ time, price: v }]
            }
          } else {
            cur.anchors = [...(cur.anchors ?? []), { time, price: v }]
            // 锚点一动，起点也就不用再指第一根了，但 p1 保持第一个点（绘制用不到，留着不碍事）
            cur.p2 = { x, y }
            cur.t2 = time
            cur.v2 = v
          }
          redrawRef.current()
          return
        }

        // 已经有第一个锚点 → 这一下左键代表完成
        if (previewRef.current) {
          previewRef.current.p2 = { x, y }
          previewRef.current.t2 = time
          previewRef.current.v2 = v
          commitPreview()
          return
        }

        // 第一下左键：落下锚点
        previewRef.current = { type: tool, p1: { x, y }, p2: { x, y }, t1: time, v1: v, t2: time, v2: v }
        // 水平线 / 垂直线只需一个点，点下即完成
        if (tool === 'hline' || tool === 'vline') commitPreview()
        else redrawRef.current()
        return
      }

      for (let i = drawingsRef.current.length - 1; i >= 0; i--) {
        const d = drawingsRef.current[i]
        const hit = hitTest(d, x, y, map)
        if (!hit) continue
        selectedRef.current = d.id
        const time = map.xToTime(x)
        const v = map.yToPrice(y)
        if (time != null && v != null) {
          drawingDragRef.current = {
            id: d.id,
            handle: hit,
            startTime: time,
            startPrice: v,
            origin: JSON.parse(JSON.stringify(d)) as Drawing
          }
          chartRef.current?.applyOptions({ handleScroll: false, handleScale: false })
          e.preventDefault()
          e.stopPropagation()
        }
        redrawRef.current()
        return
      }

      const hit = hitLine(y)
      if (hit) {
        dragRef.current = hit.key
        dragPosRef.current = hit.id
        dragStartYRef.current = y
        dragMovedRef.current = false
        // 点到哪笔持仓的线，就把它设为操作焦点（持仓卡高亮、价格卡跟着变）。
        // 待确认单不是持仓，不能拿去 selectPosition —— 传进去会找不到这笔而清空焦点。
        if (hit.id !== PENDING_ID) onSelectPosition?.(hit.id)
        /**
         * 拖开仓线之前先按「此刻」的持仓定一下这次允许设什么：
         * 两个都空 → 自由拖（方向决定是止损还是止盈）；
         * 已有止盈 → 只能拖止损；已有止损 → 只能拖止盈。
         */
        if (hit.key === 'risk') {
          const src =
            hit.id === PENDING_ID
              ? pendingRef.current
              : positionsRef.current.find((x) => x.id === hit.id)
          riskModeRef.current = !src
            ? 'free'
            : src.sl == null && src.tp == null
              ? 'free'
              : src.sl == null
                ? 'sl'
                : 'tp'
        } else {
          riskModeRef.current = null
        }
        chartRef.current?.applyOptions({ handleScroll: false, handleScale: false })
        el.style.cursor = 'ns-resize'
        e.preventDefault()
        e.stopPropagation()
        return
      }

      if (selectedRef.current) {
        selectedRef.current = null
        redrawRef.current()
      }
    }

    const onContextMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      if (
        target &&
        target.closest(
          'button, input, textarea, select, a, [data-pending-ticket], [data-lot-menu], [data-chart-menu]'
        )
      ) {
        return
      }
      const { x, y } = localPoint(e)

      // 1) 画到一半：折线右键 = 收尾成形；其它工具右键 = 取消这一次
      if (previewRef.current) {
        e.preventDefault()
        e.stopPropagation()
        if (previewRef.current.type === 'polyline') commitPreview()
        else cancelPreview()
        return
      }

      // 2) 命中已有画线：弹菜单（可删除）
      const map = mapping()
      if (map) {
        for (let i = drawingsRef.current.length - 1; i >= 0; i--) {
          const d = drawingsRef.current[i]
          if (!hitTest(d, x, y, map)) continue
          e.preventDefault()
          e.stopPropagation()
          selectedRef.current = d.id
          setLotMenu(null)
          setMenu({ x, y, id: d.id, type: d.type })
          redrawRef.current()
          return
        }
      }

      /**
       * 3) 右键点在持仓的开仓线上：弹「调整仓位」面板，只能减仓。
       *
       * 画线工具处于激活状态时不抢这个手势 —— 那会儿用户在用十字光标画东西，
       * 右击突然冒出一个仓位面板会打断他（画线命中已经在上面优先处理）。
       */
      if (!toolRef.current) {
        const posId = hitEntryLine(y)
        if (posId) {
          e.preventDefault()
          e.stopPropagation()
          // 点谁的开仓线就把焦点挪给谁，面板里显示的手数才会是这一笔
          onSelectPosition?.(posId)
          setMenu(null)
          setLotMenu({ x, y, id: posId })
          return
        }
      }

      setMenu(null)
      setLotMenu(null)
    }

    /**
     * 双击**文本**画线 → 就地改内容（只有文字是可编辑的，其它图形双击不拦）。
     *
     * 双击必然先来两次 mousedown，那两下已经把这条画线选中、并可能把它拖动了一两像素 ——
     * 这里不做回滚：位置本来就允许拖，改完字接着拖也是正常操作。
     *
     * 输入框里的双击要放过去（否则刚敲的字会被重置回原文），
     * 所以先排除掉输入框和右键菜单内部。
     */
    const onDblClick = (e: MouseEvent) => {
      const node = e.target as HTMLElement | null
      if (node?.closest('input, textarea, [data-draw-menu]')) return

      const map = mapping()
      if (!map) return
      const { x, y } = localPoint(e)
      // 副图上的双击留给副图自己（那里没有文字，裁过之后也点不到）
      if (y > paneBottomY()) return
      for (let i = drawingsRef.current.length - 1; i >= 0; i--) {
        const d = drawingsRef.current[i]
        if (d.type !== 'text') continue
        if (!hitTest(d, x, y, map)) continue
        const ax = map.timeToX(d.p1.time)
        const ay = map.priceToY(d.p1.price)
        if (!Number.isFinite(ax) || !Number.isFinite(ay)) return
        e.preventDefault()
        e.stopPropagation()
        selectedRef.current = d.id
        redrawRef.current()
        // 上一次若是 Esc 取消的，标记还挂着 —— 打开新的编辑前先清掉
        textEditCancelRef.current = false
        // 文字工具刚点下的那一刻也在等输入（双击的第一下会开一个空草稿），
        // 两个输入框叠一起会互相抢焦点，这里把草稿收掉
        setTextDraft(null)
        setTextEdit({ id: d.id, x: ax as number, y: ay as number, initial: d.text ?? '' })
        return
      }
    }

    /** 光标只在真的变了才写（写 style 会让整页样式失效重算） */
    const setCursor = (c: string): void => {
      if (el.style.cursor === c) return
      el.style.cursor = c
    }

    /**
     * 悬停命中测试：一帧最多一次。
     *
     * 鼠标在图上滑动时，「光标该显示成什么」得问过每一条画线 —— 这本身是
     * O(画线数) 的活。而 mousemove 一秒能来几百次（高回报率鼠标更多），以前是
     * 每个事件都完整跑一遍：画线攒到几百条之后，光是移动鼠标就能把主线程喂满，
     * 图表那边自然跟着掉帧。这里把同一帧里的多次移动合并成一次，
     * 并且按住鼠标期间（拖拽 / 长按）直接不算 —— 那会儿光标是什么都没意义。
     */
    let hoverRaf = 0
    let hoverX = 0
    let hoverY = 0
    const runHover = (): void => {
      hoverRaf = 0
      if (toolRef.current) {
        setCursor('crosshair')
        return
      }
      const map = mapping()
      if (!map) return
      const win = visibleTimeWindow()
      let cursor = ''
      for (let i = drawingsRef.current.length - 1; i >= 0; i--) {
        const d = drawingsRef.current[i]
        // 视野外的画线不用问（见 visibleTimeWindow）
        if (win && !inTimeWindow(d, win.lo, win.hi)) continue
        const hit = hitTest(d, hoverX, hoverY, map)
        if (hit) {
          cursor = hit === 'body' ? 'move' : 'crosshair'
          break
        }
      }
      if (!cursor && hitLine(hoverY)) cursor = 'ns-resize'
      setCursor(cursor)
    }

    const onMouseMove = (e: MouseEvent) => {
      const preview = previewRef.current
      const dd = drawingDragRef.current

      /**
       * 没有进行中的交互时，这里只负责悬停反馈 —— 而且只在指针真的落在图上时才算。
       * 鼠标扫过左侧会话列表 / 持仓卡 / 指标图例时，原来也会为每条画线跑一遍命中测试，
       * 完全是白干，还会把主线程占住让图表掉帧。
       */
      if (!preview && !dd && !dragRef.current) {
        const target = e.target as Node | null
        if (!target || !el.contains(target)) return
        // 按住鼠标不放（拖拽 / 长按）期间不用更新光标
        if (e.buttons !== 0) return
        if (toolRef.current) {
          setCursor('crosshair')
          return
        }
        const p = localPoint(e)
        hoverX = p.x
        hoverY = p.y
        if (!hoverRaf) hoverRaf = requestAnimationFrame(runHover)
        return
      }

      const { x, y } = localPoint(e)
      const map = mapping()
      if (!map) return

      if (preview) {
        let px = x
        let py = y
        // 与 TradingView 一致：按住 Shift 把方向约束到 45° 的整数倍
        if (
          e.shiftKey &&
          (preview.type === 'trend' ||
            preview.type === 'ray' ||
            preview.type === 'extline' ||
            preview.type === 'arrow')
        ) {
          const dx = x - preview.p1.x
          const dy = y - preview.p1.y
          const len = Math.hypot(dx, dy)
          const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4)
          px = preview.p1.x + Math.cos(ang) * len
          py = preview.p1.y + Math.sin(ang) * len
        }
        const time = map.xToTime(px)
        const v = map.yToPrice(py)
        preview.p2 = { x: px, y: py }
        if (time != null) preview.t2 = time
        if (v != null) preview.v2 = v
        redrawRef.current()
        return
      }

      if (dd) {
        const time = map.xToTime(x)
        const v = map.yToPrice(y)
        if (time == null || v == null) return
        if (!Number.isFinite(time) || !Number.isFinite(v)) return
        const dv = v - dd.startPrice
        const { first, last } = rangeRef.current
        let dt = time - dd.startTime

        // 整体拖动：把位移夹到「已加载 K 线 + 未来空白」内。
        // 落在图上拖不到的地方，坐标映射就返回 null → 整个图形瞬间消失。
        if (dd.handle === 'body') {
          const { step } = rangeRef.current
          // 同 clampTime：可拖到的右界跟着实际铺开的未来走
          const ahead = Math.max(futureBarsRef.current, futureAheadRef.current)
          const futureLimit = last
            ? last + Math.max(0, ahead) * (step || 60)
            : last
          if (first && last) {
            // 折线要按全部锚点算包围盒，只看 p1/p2 会漏掉中间那些点
            const all = shapePoints(dd.origin)
            const minT = Math.min(...all.map((pt) => pt.time))
            const maxT = Math.max(...all.map((pt) => pt.time))
            const lo = first - minT
            const hi = futureLimit - maxT
            if (lo <= hi) dt = Math.min(Math.max(dt, lo), hi)
          }
          const target = dd.origin.p1.time + dt
          // 只有落在真实 K 线区间内才吸附到整根；未来区没有 K 线可吸，得让锚点停在原地
          if (target <= last) {
            const snapped = nearestBarTime(barsRef.current, target)
            if (snapped != null) {
              const st = first && last ? Math.min(Math.max(snapped, first), last) : snapped
              dt = st - dd.origin.p1.time
            }
          }
        }

        const tNext = clampTime(time)
        /** 折线：拖的是第几个锚点（'pt3' → 3），其余手柄是 null */
        const anchorIdx =
          dd.handle.startsWith('pt') ? Number(dd.handle.slice(2)) : null

        const next = drawingsRef.current.map((d) => {
          if (d.id !== dd.id) return d
          if (dd.handle === 'body') {
            // 整体平移：折线的所有锚点跟着一起走，p1/p2 同步到新的首尾
            if (d.type === 'polyline') {
              const moved = polyPoints(dd.origin).map((pt) => ({
                time: pt.time + dt,
                price: pt.price + dv
              }))
              return { ...d, p1: moved[0], p2: moved[moved.length - 1], points: moved }
            }
            return {
              ...d,
              p1: { time: dd.origin.p1.time + dt, price: dd.origin.p1.price + dv },
              p2: dd.origin.p2
                ? { time: dd.origin.p2.time + dt, price: dd.origin.p2.price + dv }
                : undefined
            }
          }
          // 折线的某个中间/端点锚点：只挪这一个，首尾同步
          if (anchorIdx != null) {
            const pts = polyPoints(d).map((pt, i) =>
              i === anchorIdx ? { time: tNext, price: v } : pt
            )
            return { ...d, p1: pts[0], p2: pts[pts.length - 1], points: pts }
          }
          if (dd.handle === 'p1') return { ...d, p1: { time: tNext, price: v } }
          return { ...d, p2: { time: tNext, price: v } }
        })
        drawingsRef.current = next
        redrawRef.current()
        return
      }

      if (dragRef.current) {
        // 点一下线（没有真正拖动）不算数：3px 以内只当点击，避免手抖带出极窄的 SL/TP
        if (!dragMovedRef.current) {
          if (Math.abs(y - dragStartYRef.current) < 3) return
          dragMovedRef.current = true
        }
        const price = map.yToPrice(y)
        if (price == null) return

        /**
         * 待确认单：只有「拖出来设止损/止盈」这一种语义，没有持仓那边的成本价夹取。
         *
         * 方向判定和持仓那条一样：往上甩是止盈、往下甩是止损（空头相反），
         * 已经有了一边就只认缺的那一边。具体能拖到哪由上层夹取 ——
         * 图表只负责把用户拖到的原始价报上去。
         */
        if (dragPosRef.current === PENDING_ID) {
          const pend = pendingRef.current
          if (!pend) return
          const up = price > pend.entry
          const byDir: 'sl' | 'tp' =
            pend.side === 'buy' ? (up ? 'tp' : 'sl') : up ? 'sl' : 'tp'
          const mode = riskModeRef.current
          const kind: 'sl' | 'tp' =
            dragRef.current === 'sl' || dragRef.current === 'tp'
              ? dragRef.current
              : mode === 'sl'
                ? 'sl'
                : mode === 'tp'
                  ? 'tp'
                  : byDir
          if (kind === 'sl') pendingCbRef.current.sl?.(price)
          else pendingCbRef.current.tp?.(price)
          return
        }

        // 拖的是「按下时命中的那一笔」，不是当前焦点那一笔
        const dragId = dragPosRef.current
        const pos = positionsRef.current.find((p) => p.id === dragId)
        if (!pos) return

        /**
         * 拖开仓那条线设止损/止盈。
         *
         * 按下时已经有一边设好了（比如已有止盈），这一次就只能补另一边 ——
         * 方向不参与判断，只认「缺的那边」。这样价格走顺之后想补一条跟上来的止损，
         * 从开仓线往上一拖就能设（止损落在成本价上方也没关系，被打掉按移动止盈记账），
         * 不用先往下拖一条再往上拖。
         *
         * 两边都空时按「相对开仓价的方向」定：往上甩是止盈、往下甩是止损（空头相反）。
         * 这里刻意不用现价当分界：开完仓行情往往已经跑出去很远，开仓线本身就在现价下方，
         * 手指往上一拖会先穿过现价，于是先被当成止损留下一条线、再变成止盈 ——
         * 凭空多出一条用户没要的止损。
         *
         * 「能拖到哪」由 store 里的夹取负责（止损只能在现价的亏损侧、止盈不能差过成本价）。
         */
        if (dragRef.current === 'risk') {
          const point = Math.pow(10, -pos.digits)
          if (Math.abs(price - pos.entryPrice) < point) return // 还贴在开仓价上，不算数

          const up = price > pos.entryPrice
          const byDir = pos.side === 'buy' ? (up ? 'tp' : 'sl') : up ? 'sl' : 'tp'

          const mode = riskModeRef.current
          const kind = mode === 'sl' ? 'sl' : mode === 'tp' ? 'tp' : byDir

          if (kind === 'sl') onSlChange(pos.id, price)
          else onTpChange(pos.id, price)
          return
        }

        if (dragRef.current === 'sl') onSlChange(pos.id, price)
        else onTpChange(pos.id, price)
        return
      }
    }

    const finish = () => {
      // 画线由「第二下左键」提交，鼠标抬起只负责结束拖拽
      if (drawingDragRef.current) {
        drawingDragRef.current = null
        chartRef.current?.applyOptions({ handleScroll: true, handleScale: true })
        onDrawingsChange(drawingsRef.current)
        return
      }

      if (dragRef.current) {
        dragRef.current = null
        dragPosRef.current = null
        riskModeRef.current = null
        dragMovedRef.current = false
        el.style.cursor = ''
        chartRef.current?.applyOptions({ handleScroll: true, handleScale: true })
      }
    }

    const onKey = (e: KeyboardEvent) => {
      // 在指标参数输入框里敲键盘（退格 / Esc）不该触发画线的删除或取消
      const target = e.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      )
        return

      if (e.key === 'Escape') {
        onClearFocus?.()
        if (previewRef.current) {
          cancelPreview()
        } else if (selectedRef.current) {
          // 与 TradingView 一致：Esc 取消选中
          selectedRef.current = null
          redrawRef.current()
        }
        setMenu(null)
        setLotMenu(null)
        return
      }
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      const id = selectedRef.current
      if (!id) return
      const next = drawingsRef.current.filter((d) => d.id !== id)
      drawingsRef.current = next
      selectedRef.current = null
      onDrawingsChange(next)
      redrawRef.current()
      e.preventDefault()
    }

    el.addEventListener('mousedown', onMouseDown, true)
    el.addEventListener('contextmenu', onContextMenu, true)
    el.addEventListener('dblclick', onDblClick, true)
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', finish)
    window.addEventListener('keydown', onKey)

    return () => {
      if (hoverRaf) cancelAnimationFrame(hoverRaf)
      el.removeEventListener('mousedown', onMouseDown, true)
      el.removeEventListener('contextmenu', onContextMenu, true)
      el.removeEventListener('dblclick', onDblClick, true)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', finish)
      window.removeEventListener('keydown', onKey)
    }
  }, [onSlChange, onTpChange, onSelectPosition, onDrawingsChange, onToolChange, onClearFocus, buildMapping])

  // 点击空白处关闭右键菜单（画线菜单 / 仓位面板各认自己的 data 标记）
  useEffect(() => {
    if (!menu && !lotMenu) return
    const onDown = (e: MouseEvent) => {
      // 右键不算「点空白」：右键换一条开仓线应该是把面板挪过去，不是先关再开
      // （真的点在空白处时由 onContextMenu 兜底关掉）
      if (e.button === 2) return
      const node = e.target as HTMLElement | null
      if (node && node.closest('[data-draw-menu]')) return
      if (node && node.closest('[data-lot-menu]')) return
      setMenu(null)
      setLotMenu(null)
    }
    window.addEventListener('mousedown', onDown, true)
    return () => window.removeEventListener('mousedown', onDown, true)
  }, [menu, lotMenu])

  const applyDrawings = useCallback(
    (next: Drawing[]) => {
      drawingsRef.current = next
      onDrawingsChange(next)
      redrawRef.current()
    },
    [onDrawingsChange]
  )

  const removeDrawing = useCallback(
    (id: string) => {
      selectedRef.current = null
      applyDrawings(drawingsRef.current.filter((d) => d.id !== id))
      setMenu(null)
    },
    [applyDrawings]
  )

  const recolorDrawing = useCallback(
    (id: string, color: string) => {
      applyDrawings(drawingsRef.current.map((d) => (d.id === id ? { ...d, color } : d)))
    },
    [applyDrawings]
  )

  /** 提交文本画线 */
  const commitText = useCallback(
    (value: string) => {
      const draft = textDraft
      if (!draft) return
      const label = value.trim()
      setTextDraft(null)
      if (!label) return
      const shape: Drawing = {
        id: `d_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
        type: 'text',
        p1: {
          time: (() => {
            const { first, last, step } = rangeRef.current
            if (!first || !last) return draft.time
            // 和画线工具同一套口径：右侧未来空白里也能落字（写「目标位」之类）
            const ahead = Math.max(futureBarsRef.current, futureAheadRef.current)
            const futureLimit = last + Math.max(0, ahead) * (step || 60)
            return Math.min(Math.max(draft.time, first), futureLimit)
          })(),
          price: draft.price
        },
        color: DRAWING_COLORS.text,
        text: label
      }
      applyDrawings([...drawingsRef.current, shape])
    },
    [textDraft, applyDrawings]
  )

  /**
   * 提交「双击改字」。
   *
   * 清空 = 删掉这条文本（画布上一条空白文字既看不见又挡鼠标，留着没意义）；
   * 内容没变就直接返回，免得白触发一次落库。
   */
  const commitTextEdit = useCallback(
    (value: string) => {
      const edit = textEdit
      if (!edit) return
      setTextEdit(null)
      // Esc 取消：卸载时可能补一个 blur 进来，别当成提交
      if (textEditCancelRef.current) {
        textEditCancelRef.current = false
        return
      }
      const label = value.trim()
      if (label === edit.initial) return
      const next = label
        ? drawingsRef.current.map((d) => (d.id === edit.id ? { ...d, text: label } : d))
        : drawingsRef.current.filter((d) => d.id !== edit.id)
      applyDrawings(next)
    },
    [textEdit, applyDrawings]
  )

  /** 放弃这次改字（Esc） */
  const cancelTextEdit = useCallback(() => {
    textEditCancelRef.current = true
    setTextEdit(null)
  }, [])

  /**
   * 焦点持仓：提示条按它来决定说什么。
   * activePositionId 可能暂时指不到（刚平掉 / 重开），兜底取最后一笔 = 最新开的。
   */
  const activePos = positions.find((p) => p.id === activePositionId) ?? positions[positions.length - 1] ?? null

  /**
   * 左上角提示条该说什么 —— 按「焦点这笔还差哪条线」来定。
   *
   * 规则是「只补缺的那一边」：两条都没有时随便拖（方向决定是止损还是止盈，拖过开仓价还能换回来），
   * 已经有一条了，另一条只能拖向它该在的那一侧。
   */
  const riskHint: RiskHint | null = (() => {
    if (!activePos) return null
    const lossSide = activePos.side === 'buy' ? t('chart.sideDown') : t('chart.sideUp')
    const profitSide = activePos.side === 'buy' ? t('chart.sideUp') : t('chart.sideDown')
    if (activePos.sl == null && activePos.tp == null) return { kind: 'both', lossSide, profitSide }
    if (activePos.sl == null) return { kind: 'sl', lossSide }
    if (activePos.tp == null) return { kind: 'tp', profitSide }
    return { kind: 'adjust' }
  })()

  /**
   * 主图指标图例占了多高。
   *
   * 图例和拖动提示条原本都摆在 left / top-11 这个位置（图例 z-20、提示条 z-10），
   * 一开指标提示条就被压在下面看不见了。这里量一下图例的真实高度，把提示条顺下去 ——
   * 指标 chip 会换行、加删指标也会变高，所以用 ResizeObserver 跟着走，不写死偏移。
   */
  const [legendH, setLegendH] = useState(0)
  useLayoutEffect(() => {
    const host = rootRef.current
    if (!host) return
    const el = host.querySelector<HTMLElement>('[data-legend-overlays]')
    if (!el) {
      setLegendH(0)
      return
    }
    const sync = (): void => setLegendH(el.offsetHeight)
    sync()
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    return () => ro.disconnect()
  }, [indicatorRows.length])

  return (
    <div ref={rootRef} className="relative h-full w-full">
      <div ref={containerRef} data-chart-container="1" className="h-full w-full" />

      {watermark && (
        <div className="pointer-events-none absolute inset-0 z-0 flex items-center justify-center overflow-hidden">
          <span className="select-none whitespace-nowrap text-[54px] font-bold tracking-[0.2em] text-white/[0.035]">
            {watermark}
          </span>
        </div>
      )}

      <canvas
        ref={canvasRef}
        className="pointer-events-none absolute inset-0 z-10 h-full w-full"
      />

      {/* 待确认单：开仓线那一行的「票面」（手数 / 风险金额 / 确认 / 取消） */}
      {pendingOrder && (
        <PendingTicket
          order={pendingOrder}
          priceToY={pendingPriceToY}
          onConfirm={() => pendingCbRef.current.confirm?.()}
          onCancel={() => pendingCbRef.current.cancel?.()}
        />
      )}

      {/* 指标图例：点名字改参数/线色；十字线移动时在各自左上角显示当前数值 */}
      <IndicatorLegend
        rows={indicatorRows}
        chart={chartApi}
        getSeries={getIndicatorSeries}
        digits={digits}
        onParams={onIndicatorParams}
        onColor={onIndicatorColor}
        onReset={onIndicatorReset}
        onRemove={onIndicatorRemove}
        onHidden={onIndicatorHidden}
      />

      {textDraft && (
        <input
          data-draw-menu="1"
          autoFocus
          placeholder={t('chart.textPlaceholder')}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitText((e.target as HTMLInputElement).value)
            if (e.key === 'Escape') setTextDraft(null)
          }}
          onBlur={(e) => commitText(e.target.value)}
          className="absolute z-30 w-[150px] rounded border border-[var(--c-accent)] bg-[var(--surface-1)]/95 px-1.5 py-0.5 text-[11.5px] text-[var(--text-primary)] outline-none"
          style={{ left: textDraft.x - 2, top: textDraft.y - 14 }}
        />
      )}

      {/*
        双击已有文本 → 就地改字。
        Enter / 失焦提交，Esc 放弃；清空 = 删掉这条文字（空标签既看不见又挡鼠标）。
        用 defaultValue 走非受控：受控的话每敲一个字重渲染一次，光标会往右跑。
      */}
      {textEdit && (
        <input
          data-draw-menu="1"
          data-text-edit="1"
          autoFocus
          defaultValue={textEdit.initial}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitTextEdit((e.target as HTMLInputElement).value)
            if (e.key === 'Escape') cancelTextEdit()
            // 空格是「播放/暂停」的全局热键，在输入框里得当成普通字符
            if (e.key === ' ') e.stopPropagation()
          }}
          onBlur={(e) => commitTextEdit(e.target.value)}
          className="absolute z-30 rounded border border-[var(--c-accent)] bg-[var(--surface-1)] px-1.5 py-0.5 font-semibold text-[11.5px] text-[var(--text-primary)] shadow-lg outline-none"
          style={{
            left: textEdit.x - 3,
            top: textEdit.y - 14,
            width: textBoxWidth(textEdit.initial)
          }}
        />
      )}

      {menu && (
        <div
          data-draw-menu="1"
          className="absolute z-30 w-[176px] overflow-hidden rounded-lg border border-[var(--border-strong)] bg-[var(--surface-1)] shadow-2xl"
          style={{
            left: Math.min(menu.x, Math.max(0, (containerRef.current?.clientWidth ?? 400) - 184)),
            top: menu.y
          }}
          onContextMenu={(e) => e.preventDefault()}
        >
          <div className="px-2.5 pb-1 pt-1.5 text-[10.5px] text-[var(--text-faint)]">
            {DRAWING_TOOLS.find((tool) => tool.type === menu.type)
              ? t(DRAWING_LABEL_KEYS[menu.type])
              : t('chart.menuFallback')}
          </div>
          <div className="flex flex-wrap gap-1 px-2.5 pb-2 pt-0.5">
            {DRAWING_PALETTE.map((c) => {
              const active = drawingsRef.current.find((d) => d.id === menu.id)?.color === c
              return (
                <button
                  key={c}
                  onClick={() => recolorDrawing(menu.id, c)}
                  title={t('chart.changeColor')}
                  className={clsx(
                    'h-3.5 w-3.5 rounded-full border transition-transform hover:scale-110',
                    active ? 'border-white' : 'border-transparent'
                  )}
                  style={{ background: c }}
                />
              )
            })}
          </div>
          <div className="border-t border-[var(--border-subtle)]" />
          <button
            onClick={() => removeDrawing(menu.id)}
            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-[11.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-3)] hover:text-[var(--color-up)]"
          >
            <Trash2 size={11} />
            {t('chart.deleteDrawing')}
            <span className="ml-auto text-[10px] text-[var(--text-faint)]">Del</span>
          </button>
        </div>
      )}

      {/*
        右键开仓线弹出的「调整仓位」面板（只能减仓）。

        key 里带上 position.id 和当前手数：右键换一笔、或者刚减完仓手数变了，
        面板要重新挂载一次，否则会沿用上一笔的默认目标手数。
      */}
      {lotMenu &&
        (() => {
          const p = positions.find((x) => x.id === lotMenu.id)
          if (!p) return null
          return (
            <LotMenu
              key={`${p.id}_${p.lot}`}
              position={p}
              x={lotMenu.x}
              y={lotMenu.y}
              bounds={{
                width: containerRef.current?.clientWidth ?? 400,
                height: containerRef.current?.clientHeight ?? 300
              }}
              lotPnlLabel={lotPnlLabel}
              onConfirm={(newLot) => {
                onReducePosition?.(p.id, newLot)
                setLotMenu(null)
              }}
              onClose={() => setLotMenu(null)}
            />
          )
        })()}

      {/*
        拖动提示条：只说明「焦点那笔」该怎么拖。
        多持仓时每笔各有一组线，拖哪条就选中哪笔，所以这里再补一句笔数。

        位置与层级都要让开三样东西：
        - left-2 top-2 z-20 的浮动画线工具条（在 TrainingPane 里）→ 所以往下挪到 top-11 起；
        - **主图指标图例**也在 left-2 top-11（z-20），两条会叠死 → 再按图例的实际高度往下让，
          偏移由 legendH 动态算（见上面的 useLayoutEffect），加删指标、chip 换行都跟得上；
        - lightweight-charts 自己的画布（它带 z-index，会盖住 z-auto 的兄弟节点）→ 所以给 z-10。
      */}
      {activePos && riskHint && (
        <div
          className="pointer-events-none absolute left-3 z-10 rounded-md border border-[var(--border-subtle)] bg-black/60 px-2 py-1 text-[10px] leading-relaxed text-[var(--text-secondary)] backdrop-blur-sm"
          style={{ top: 44 + (legendH > 0 ? legendH + 4 : 0) }}
        >
          {riskHint.kind === 'both' && (
            <>
              <span>{t('chart.hintDragToSet')}</span>
              <span className="mx-1 text-[#ef4444]">{t('chart.stopLoss')}</span>
              <span>/</span>
              <span className="mx-1 text-[#22c55e]">{t('chart.takeProfit')}</span>
              <span className="text-[var(--text-faint)]">
                {t('chart.hintBothNote', {
                  profitSide: riskHint.profitSide,
                  lossSide: riskHint.lossSide
                })}
              </span>
            </>
          )}
          {riskHint.kind === 'sl' && (
            <>
              <span>{t('chart.hintAlready')}</span>
              <span className="mx-1 text-[#22c55e]">{t('chart.takeProfit')}</span>
              <span className="text-[var(--text-faint)]">{t('chart.hintDragOnly')}</span>
              <span className="mx-1 text-[#ef4444]">
                {t('chart.hintSetSl', { side: riskHint.lossSide })}
              </span>
            </>
          )}
          {riskHint.kind === 'tp' && (
            <>
              <span>{t('chart.hintAlready')}</span>
              <span className="mx-1 text-[#ef4444]">{t('chart.stopLoss')}</span>
              <span className="text-[var(--text-faint)]">{t('chart.hintDragOnly')}</span>
              <span className="mx-1 text-[#22c55e]">
                {t('chart.hintSetTp', { side: riskHint.profitSide })}
              </span>
            </>
          )}
          {riskHint.kind === 'adjust' && (
            <>
              <span className="mr-2">{t('chart.hintDrag')}</span>
              <span className="text-[#ef4444]">SL</span>
              <span className="mx-1">/</span>
              <span className="text-[#22c55e]">TP</span>
              <span className="ml-2 text-[var(--text-faint)]">{t('chart.hintAdjustNote')}</span>
            </>
          )}
          {positions.length > 1 && (
            <span className="ml-2 text-[var(--text-faint)]">
              {t('chart.hintMulti', { n: positions.length })}
            </span>
          )}
          {/*
            右键减仓没有任何视觉线索（开仓线看上去和别的线一样），
            所以在这里明说一句 —— 这条提示条只有在有持仓时才出现，不算噪声。
          */}
          <span className="ml-2 text-[var(--text-faint)]">{t('chart.hintReduce')}</span>
        </div>
      )}
    </div>
  )
}
