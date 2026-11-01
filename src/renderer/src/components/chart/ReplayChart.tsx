import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { Check, X } from 'lucide-react'
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
  polyPoints,
  shapePoints,
  type ChartMapping,
  type DrawingHit
} from './drawings'
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
}

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

/** 待确认单在命中判定里用的伪 id：和真实持仓 id（`pos_…`）不会撞 */
const PENDING_ID = '__pending_order__'

const ENTRY_COLOR = '#9ca3af'
/** 多/空开仓线：对冲时两条线并排，用颜色区分方向和持仓卡里的标签对应 */
const ENTRY_BUY_COLOR = '#f87171'
const ENTRY_SELL_COLOR = '#4ade80'
const SL_COLOR = '#ef4444'
const TP_COLOR = '#22c55e'
/** 止损被拖到盈利侧（移动止盈）：换琥珀色，和「亏损止损」一眼分辨 */
const TRAIL_COLOR = '#f59e0b'
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

/**
 * 止损 / 止盈线轴标签的文案：`SL` / `TP` 前缀 + 金额。
 *
 * 金额一律由上层给（手数、合约量、佣金、报价货币汇率都在那边），
 * 图表这边只负责拼字符串 —— 没设线或算不出来时就退回裸的 SL / TP。
 *
 * 止损被拖到成本价的盈利侧之后，它其实是「移动止盈」：
 * 标签后面缀一句，免得看到一根红线写着正号金额还以为是止损打错了方向。
 */
function riskTitle(
  p: Position,
  kind: 'sl' | 'tp',
  label?: (position: Position, kind: 'sl' | 'tp') => string,
  trailingLabel?: string
): string {
  const base = kind === 'sl' ? 'SL' : 'TP'
  const money = label ? label(p, kind) : ''
  const trailing = kind === 'sl' && isTrailingStop(p)
  const title = money ? `${base} ${money}` : base
  return trailing && trailingLabel ? `${title} · ${trailingLabel}` : title
}

/**
 * 止损是不是已经被拖到了成本价的盈利侧。
 *
 * 到了盈利侧它就不再是「认亏出局」而是「锁住已有的浮盈」，
 * 所以标签要额外说明、线的颜色也要换掉，否则红线上挂着正数金额看着像算错了。
 */
function isTrailingStop(p: Position): boolean {
  return p.sl != null && (p.side === 'buy' ? p.sl > p.entryPrice : p.sl < p.entryPrice)
}

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

/** 盈利 = 红、亏损 = 绿（跟随全局的国内配色约定） */
const WIN_COLOR = '#ef4444'
const LOSS_COLOR = '#22c55e'
/** 成交端点三角形：半宽 / 高 */
const TRI_HALF = 5
const TRI_H = 7.5

/**
 * 点击订单定位时固定显示的 K 线根数。
 *
 * 固定「相对根数」而不是「整段铺满」，好处是每次定位屏幕上的柱宽都一样：
 * 150 根按图表宽度均分，窗口一屏正好铺满，既不挤成一团也不会只占半屏。
 */
const FOCUS_VISIBLE_BARS = 150

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

/** 订单时间 MM-DD HH:MM（默认 UTC+8，跟成交列表一致）；withDate=false 只留 HH:MM */
function fmtClock(ts: number, withDate = true): string {
  const tz = currentTimezone()
  const t = tzPartsFromSec(ts, tz)
  const p = (n: number): string => String(n).padStart(2, '0')
  const hm = `${p(t.hour)}:${p(t.minute)}`
  return withDate ? `${p(t.month)}-${p(t.day)} ${hm}` : hm
}

/** 坐标轴刻度：按设置里的时区渲染（lightweight-charts 默认走 UTC，会跟成交列表差 8 小时） */
function fmtTickMark(ts: number, type: TickMarkType, t: Translator): string {
  const parts = tzPartsFromSec(ts, currentTimezone())
  const p = (n: number): string => String(n).padStart(2, '0')
  switch (type) {
    case TickMarkType.Year:
      return String(parts.year)
    case TickMarkType.Month:
      return t('chart.axisMonth', { m: parts.month })
    case TickMarkType.DayOfMonth:
      return t('chart.axisDay', { d: parts.day })
    case TickMarkType.Time:
      return `${p(parts.hour)}:${p(parts.minute)}`
    case TickMarkType.TimeWithSeconds:
      return `${p(parts.hour)}:${p(parts.minute)}:${p(parts.second)}`
    default:
      return ''
  }
}

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
 * 历史成交连线：把每一笔已平仓订单的「开仓价 @ 开仓时间」和「平仓价 @ 平仓时间」
 * 用一条细虚线连起来，一眼就能看出这单走了多远、是赚是亏。
 * 端点用小三角形表示方向：做多开仓朝上、平仓朝下；做空正好相反。
 * 整段超出可视区时由 canvas 自动裁掉。
 */
function drawTrades(
  ctx: CanvasRenderingContext2D,
  trades: ClosedTrade[],
  map: ChartMapping,
  view: { width: number; height: number },
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

    const color = t.pnl >= 0 ? WIN_COLOR : LOSS_COLOR
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

/**
 * 票面底色。必须是不透明的实色：它是浮在 K 线上的，半透明会让影线从字缝里穿过去。
 * 取 surface-2（#1a1a1a）而不是 surface-0（#0b0b0b）—— 比图表底色亮一档，
 * 才看得出这是「浮在上面的一张票」而不是画进图里的一个元素。
 */
const PANEL_BG = '#1a1a1a'

/**
 * 待确认单贴在开仓线上的那一行「票面」。
 *
 * 布局：[方向+手数] [风险金额] [确认] [取消✕]
 *
 * 为什么用 HTML 而不是画在 canvas 上：这四个都是要点的（确认/取消是按钮），
 * 画在 canvas 上就得自己做命中判定、悬停态、键盘可达性 —— 用 DOM 全是白送的。
 * 它跟着价格线走，所以自己跑一个 requestAnimationFrame 取 y；
 * 只在这个组件内部 setState，不牵动整个图表重渲染。
 */
function PendingTicket({
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
      {/* 左框：方向 + 手数（手数用等宽字体，扫一眼就能分清 0.10 还是 0.01）
          底色写死实色：`bg-[var(--surface-1)]/97` 这种写法 Tailwind 加了透明度修饰符
          也生成不出合法声明（CSS 变量没法在编译期算 alpha），结果是透明 —— K 线直接从
          框里穿过去，金额根本看不清。 */}
      <span
        className="inline-flex h-[21px] items-center rounded-[3px] border px-2 text-[11px] font-medium leading-none shadow-[0_1px_5px_rgba(0,0,0,0.7)]"
        style={{
          borderColor: sideColor,
          color: sideColor,
          backgroundColor: PANEL_BG
        }}
      >
        {order.lotText}
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
      </button>

      <button
        onClick={onCancel}
        title={t('chart.pendingCancelHint')}
        className="inline-flex h-[21px] w-[21px] items-center justify-center rounded-[3px] border border-[var(--border-strong)] text-[var(--text-muted)] shadow-[0_1px_5px_rgba(0,0,0,0.7)] transition-colors hover:border-[var(--c-neg)] hover:text-[var(--c-neg)]"
        style={{ backgroundColor: PANEL_BG }}
      >
        <X size={12} />
      </button>
    </div>
  )
}

export function ReplayChart({
  bars,
  cursor,
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
  drawings,
  onDrawingsChange,
  activeTool,
  onToolChange,
  watermark,
  timeframe,
  trades,
  focusedTrade,
  focusSeq,
  revealIndex,
  onClearFocus,
  pendingOrder,
  onPendingSlChange,
  onPendingTpChange,
  onPendingConfirm,
  onPendingCancel
}: ReplayChartProps): React.JSX.Element {
  const { t, locale } = useT()
  const theme = useChartThemeStore((s) => s.theme)
  // 当前生效时区：历史会话用它自己打单时记录的时区
  const timezone = useTimezoneStore((s) => s.effective)

  const containerRef = useRef<HTMLDivElement>(null)
  /** 最外层容器：用来量「主图指标图例占了多高」（提示条要排在它下面） */
  const rootRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  /** 同一个 chart 实例的 state 版：图例要订阅十字线，必须能拿到实例并在挂载后重渲染 */
  const [chartApi, setChartApi] = useState<IChartApi | null>(null)

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
    rangeRef.current = {
      first: bars[0].time,
      last: bars[lastIndex].time,
      step: bars.length > 1 ? bars[1].time - bars[0].time : 0,
      lastIndex
    }
  }, [bars, cursor])

  // 重绘函数存 ref，供各处调用而不引起依赖变化
  const redrawRef = useRef<() => void>(() => undefined)
  /** 上一次重绘时价格轴的样子（见 priceScaleSignature） */
  const scaleSigRef = useRef('')

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
      subPanes.map((inst) => ({
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
        segs: overlayData
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
        // 落在最后一根右侧的空白区 / 第一根左侧：贴边，不要卡住拖拽
        const { first, last } = rangeRef.current
        if (!first || !last) return null
        const lastX = ts.timeToCoordinate(last as UTCTimestamp)
        if (lastX != null && x > (lastX as number)) return last
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
   */
  const pendingPriceToY = useCallback(
    (price: number): number | null => buildMapping()?.priceToY(price) ?? null,
    [buildMapping]
  )

  const redraw = useCallback(() => {
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
    const dpr = window.devicePixelRatio || 1
    const hostRect = host.getBoundingClientRect()
    const cssW = Math.max(1, Math.round(hostRect.width))
    const cssH = Math.max(1, Math.round(hostRect.height))

    if (canvas.style.width !== `${cssW}px`) canvas.style.width = `${cssW}px`
    if (canvas.style.height !== `${cssH}px`) canvas.style.height = `${cssH}px`
    const bmpW = Math.round(cssW * dpr)
    const bmpH = Math.round(cssH * dpr)
    if (canvas.width !== bmpW) canvas.width = bmpW
    if (canvas.height !== bmpH) canvas.height = bmpH

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cssW, cssH)
    const rect = { width: cssW, height: cssH }

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
    const pane = mainPaneRange(chart, hostRect)
    const clipTop = Math.max(0, pane.top)
    const clipBottom = Math.max(clipTop + 1, pane.bottom)
    const view = { width: rect.width, height: clipBottom }

    ctx.save()
    ctx.beginPath()
    ctx.rect(0, clipTop, rect.width, clipBottom - clipTop)
    ctx.clip()

    for (const d of drawingsRef.current) {
      drawShape(ctx, d, map, view, d.id === selectedRef.current)
    }

    drawTrades(ctx, tradesRef.current, map, view, focusedRef.current?.id ?? null)

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
  }, [buildMapping])

  redrawRef.current = redraw

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
          fmtTickMark(Number(time), type, t)
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
        timeFormatter: (time: Time): string => fmtClock(Number(time))
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

    chartRef.current = chart
    seriesRef.current = series
    setChartApi(chart)

    if (import.meta.env.DEV) {
      ;(window as any).__rw_chart = { chart, series }
    }

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
      // 刚由代码设过视野（120ms 内）就不算用户操作
      if (byUser && performance.now() - autoRangeAtRef.current > 120) {
        userWindowRef.current = readVisibleWindow(chart)
      }
      redrawRef.current()
    }
    const onRangeByUser = () => onRange(true)
    const onCrosshair = () => onRange(false)
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRangeByUser)
    chart.subscribeCrosshairMove(onCrosshair)
    const ro = new ResizeObserver(() => redrawRef.current())
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
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRangeByUser)
      chart.unsubscribeCrosshairMove(onCrosshair)
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
      setChartApi(null)
      indicatorRefs.current.clear()
      posLinesRef.current.clear()
      riskModeRef.current = null
      dragPosRef.current = null
      prevLenRef.current = 0
      prevBarsRef.current = null
    }
  }, [])

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
          fmtTickMark(Number(time), type, t)
      },
      localization: {
        locale: 'zh-CN',
        timeFormatter: (time: Time): string => fmtClock(Number(time))
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
      prevLenRef.current = 0
      prevBarsRef.current = bars
      return
    }

    const sameDataset = prevBarsRef.current === bars
    const appendedOne = sameDataset && visibleCount === prevLenRef.current + 1

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

    if (appendedOne) {
      const bar = partialBar ?? bars[cursor]
      series.update({
        time: bar.time as UTCTimestamp,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close
      })
      const range = chart.timeScale().getVisibleLogicalRange()
      if (range && visibleCount > range.to - 3) {
        chart.timeScale().scrollToPosition(0, false)
      }
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
        const pad = visibleCount <= 10 ? 3 : 7
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
      } else if (!sameDataset || Math.abs(visibleCount - prevLenRef.current) > 2) {
        const pad = visibleCount <= 10 ? 3 : 7
        autoRangeAtRef.current = performance.now()
        chart.timeScale().setVisibleLogicalRange({
          from: Math.max(0, visibleCount - 110),
          to: visibleCount + pad
        })
      }
    }

    prevLenRef.current = visibleCount
    prevBarsRef.current = bars
    redrawRef.current()
  }, [bars, cursor, partialBar])

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

    // 定位订单：固定给「左右一共 150 根」，一次设到位。
    //
    // 之前是「先整段铺满，如果订单被裁掉再缩过去」。两个毛病：
    //  1) setVisibleLogicalRange 要等下一帧才真正应用，连设两次会互相覆盖，
    //     屏幕上先闪一下整段、再跳到订单，看着就是「卡一秒才找准」；
    //  2) 「整段放得下吗」是按 0.5px 最小柱宽推算的，几千根时几乎总被算成放得下，
    //     于是压根不缩——点了订单却停在整段，位置还是没对准。
    // 现在统一成固定窗口：跨度永远 150 根，柱宽由宽度决定，每次定位屏幕都是铺满的。
    const n = bars.length
    const idxIn = timeToLogical(focusedTrade.entryTime)
    const idxOut = timeToLogical(focusedTrade.exitTime)
    /**
     * 可见上限：回放没走完时就是游标那根（revealIndex）。
     *
     * 那张固定 150 根的窗口以前是「以订单为中心」铺开的，订单就在游标上时
     * 右半边（74 根）直接铺到游标之后——屏幕上一片空白加上价格线，
     * 用户看到的就是「点了订单能看到未来的 K 线」。定位必须以它封顶。
     */
    const last = Math.max(0, Math.min(revealIndex ?? n - 1, n - 1))
    if (idxIn != null && Math.round(idxIn) > last) {
      // 这笔单在游标之后（或压根不属于这一段），宁可不定位也不许把未来露出来
      redrawRef.current()
      return
    }
    // 以开仓那根为锚点；但这笔单子本身不到一屏时，改用「开→平」的中点，
    // 不然持仓很久的单子只能看到开仓、平仓被挤出屏幕外。
    let anchor = idxIn
    if (idxIn != null && idxOut != null && idxOut > idxIn && idxOut - idxIn <= FOCUS_VISIBLE_BARS - 20) {
      anchor = (idxIn + idxOut) / 2
    }
    if (n > 1 && anchor != null) {
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
      // —— 认的是 last（游标），不是 n-1（整段数据的末尾）
      if (to > last) {
        from = Math.max(0, from - (to - last))
        to = last
      }

      // 这里故意不盖 autoRangeAtRef 的时间戳：定位之后的这一屏就是用户当下在看的窗口，
      // 让它记进 userWindowRef，接着切周期才会「留在这笔单子附近看」，而不是弹回原处。
      chart.timeScale().setVisibleLogicalRange({ from, to })
    }
    redrawRef.current()
  }, [focusedTrade?.id, focusSeq, bars.length, revealIndex, timeToLogical, t])

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
     * 把时间夹到「已加载的 K 线范围」内。
     * 落在最后一根之后的时间无法映射成坐标，画线会保存成功却看不见。
     */
    const clampTime = (time: number): number => {
      const { first, last } = rangeRef.current
      if (!first || !last) return time
      return Math.min(Math.max(time, first), last)
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

    const onMouseMove = (e: MouseEvent) => {
      const { x, y } = localPoint(e)
      const map = mapping()
      if (!map) return

      const preview = previewRef.current
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

      const dd = drawingDragRef.current
      if (dd) {
        const time = map.xToTime(x)
        const v = map.yToPrice(y)
        if (time == null || v == null) return
        if (!Number.isFinite(time) || !Number.isFinite(v)) return
        const dv = v - dd.startPrice
        const { first, last } = rangeRef.current
        let dt = time - dd.startTime

        // 整体拖动：把位移夹到「已加载 K 线区间」内，并吸附到整根 K 线。
        // 不夹的话，图形右端会先于鼠标越过最后一根，时间点落到数据之外，
        // 坐标映射返回 null → 整个图形瞬间消失（回放里最后一根正好是当前价格线所在处）
        if (dd.handle === 'body') {
          if (first && last) {
            // 折线要按全部锚点算包围盒，只看 p1/p2 会漏掉中间那些点
            const all = shapePoints(dd.origin)
            const minT = Math.min(...all.map((pt) => pt.time))
            const maxT = Math.max(...all.map((pt) => pt.time))
            const lo = first - minT
            const hi = last - maxT
            if (lo <= hi) dt = Math.min(Math.max(dt, lo), hi)
          }
          const target = dd.origin.p1.time + dt
          const snapped = nearestBarTime(barsRef.current, target)
          if (snapped != null) {
            const st = first && last ? Math.min(Math.max(snapped, first), last) : snapped
            dt = st - dd.origin.p1.time
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

      if (toolRef.current) {
        el.style.cursor = 'crosshair'
        return
      }
      let cursor = ''
      for (let i = drawingsRef.current.length - 1; i >= 0; i--) {
        const hit = hitTest(drawingsRef.current[i], x, y, map)
        if (hit) {
          cursor = hit === 'body' ? 'move' : 'crosshair'
          break
        }
      }
      if (!cursor && hitLine(y)) cursor = 'ns-resize'
      el.style.cursor = cursor
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
            const { first, last } = rangeRef.current
            if (!first || !last) return draft.time
            return Math.min(Math.max(draft.time, first), last)
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
