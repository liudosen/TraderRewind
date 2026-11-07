// ============================================================
// TraderRewind — 副周期 K 线窗（多窗口里除主图以外的那几个小窗）
//
// 为什么要单独一个图表实例：lightweight-charts 一个图表里所有 pane 共用同一条
// 时间轴，同一个 x 只能对应一个时刻。想同时看 M5 和 H1，就只能开两个实例，
// 再把两边的时间范围互相同步 —— 这也是副图（MACD/RSI）留在主图里的原因：
// 那些指标和价格共用一条时间轴，放得下。
//
// 两条硬规矩：
// 1. 只画到当前回放进度（revealTime），绝不把还没走到的 K 线露出来；
// 2. 同步是「主图 ↔ 自己」一条边：跟随主图时双向同步，不跟随就完全不管；
//    程序化推送要用时间戳挡一下回声，否则两边会互相推来推去。
// ============================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  createChart,
  CandlestickSeries,
  type CandlestickData,
  type IChartApi,
  type IPriceLine,
  type ITimeScaleApi,
  type ISeriesApi,
  type MouseEventParams,
  type Time,
  type UTCTimestamp
} from 'lightweight-charts'
import { ChevronDown, Link2, Unlink2, X } from 'lucide-react'
import clsx from 'clsx'
import type { Bar, ClosedTrade, Position } from '../../stores/training-store'
import {
  BASE_TIMEFRAMES,
  aggregateBars,
  indexAtTime,
  timeframeCode,
  timeframeName,
  timeframeSeconds
} from '@shared/utils/timeframe'
import { DEFAULT_CHART_THEME } from '@shared/types/chart-theme'
import { useChartThemeStore } from '../../stores/chart-theme-store'
import { useTimezoneStore } from '../../stores/timezone-store'
import { tzPartsFromSec } from '@shared/types/timezone'
import { useT, translateLabel } from '../../i18n'
import type { ChartMapping } from './drawings'
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

interface Props {
  /** 1 分钟原始 K 线（本会话全量） */
  rawBars: Bar[]
  /** 当前已揭示到哪一秒（含）—— 副图只能画到这儿 */
  revealTime: number
  /** 这个窗口要显示的周期 */
  timeframe: string
  digits: number
  symbol: string
  /** 主图实例：用来双向同步时间范围 */
  mainChart: IChartApi | null
  /**
   * 主图的 K 线 series。
   * 跨图十字线要用它换算价格 —— `setCrosshairPosition(price, time, series)` 的第三个
   * 参数就是「按哪个 series 的价格轴来定位」，光有时间轴画不出横线。
   */
  mainSeries: ISeriesApi<'Candlestick'> | null
  /** 这个窗口是不是「选中的那个」：只影响描边和快捷键落点，跟时间同步无关 */
  active: boolean
  /**
   * 要不要跟随主窗口的时间范围。
   * 开：两边双向同步（在哪个窗口拖，另一个都跟着走）。
   * 关：这个窗口脱钩，主图怎么动都不碰它，它自己也能随便缩放/平移。
   */
  follow: boolean
  /** 抬头上的名字：窗口 2 / 窗口 3 */
  label: string
  /** 已平仓的历史交易：所有窗口都要看得见 */
  trades: ClosedTrade[]
  /** 当前持仓：三个窗口都要画开仓 / 止损 / 止盈线，并且都能拖 */
  positions: Position[]
  /** 当前操作焦点那笔持仓：线和标签亮一点 */
  activePositionId: string | null
  onSelectPosition: (positionId: string) => void
  onSlChange: (positionId: string, price: number) => void
  onTpChange: (positionId: string, price: number) => void
  /** 止损/止盈轴上金额文案；和主图、持仓卡共用同一套 */
  riskPnlLabel?: (position: Position, kind: 'sl' | 'tp') => string
  /** 报告/日志里点选的那一笔：两边都高亮，只有选中窗口负责跳过去 */
  focusedTrade: ClosedTrade | null
  /** 定位序号：同一笔被反复点选时用它强制重新定位 */
  focusSeq: number
  /** 这一笔要不要由本窗去定位（= 本窗是选中的那个） */
  followFocus: boolean
  /**
   * 「归位」信号：主窗口按空格 / 点归位时 +1。
   * 只有收到信号的那个副窗把视野拉回最新一根 —— 播放过程中绝不自己动。
   */
  recenterSeq: number
  onTimeframeChange: (tf: string) => void
  /** 点抬头那个「跟随 / 独立」按钮 */
  onToggleFollow: () => void
  onClose: () => void
}

type Range = { from: number; to: number }
/** 只用到时间轴这两个方法 —— 收窄类型就不必关心 lightweight-charts 的泛型 */
type TimeScaleLike = ITimeScaleApi<Time>
/**
 * 程序化推送后的静默窗长度（毫秒）。
 * 够盖住 setVisibleRange 之后图表自己再落定那一两次回调，又不至于把用户紧接着的
 * 一次真实拖动也吞掉。
 */
const SYNC_MUTE_MS = 150
/** 第一次落图 / 换回测集时，默认给多少根 K 线的视野 */
const DEFAULT_VISIBLE_BARS = 80
/**
 * 「最新一根」右侧预留大约多少**时间**。
 *
 * 两个作用：
 *  1) rightOffset=0 会把最后一根**中心**顶在右边界上，留白后最新一根完整可见；
 *  2) 播放时视野完全不动（不自动跟随），新 K 线只会慢慢填进这段留白，
 *     20 分钟内最新一根仍然在窗口里，不会“刚播几根就溢出到窗户外”。
 *
 * 换算成根数时按周期夹在 2~20 根：M1 是 20 根，M30/H1 只留 2 根，
 * 不会让粗周期窗口右边空出一大段。
 */
const LIVE_MARGIN_SECONDS = 20 * 60
/** 价格线抓取判定 / 真正开始拖动的像素阈值 */
const POS_HIT_TOLERANCE = 9
const POS_DRAG_START_PX = 3

/** 读某个时间轴当前的可视范围；还算不出来时给 null */
function readRange(ts: TimeScaleLike): Range | null {
  const r = ts.getVisibleRange()
  if (!r || r.from == null || r.to == null) return null
  const from = Number(r.from)
  const to = Number(r.to)
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null
  return { from, to }
}

function pushRange(ts: TimeScaleLike, r: Range): void {
  ts.setVisibleRange({ from: r.from as UTCTimestamp, to: r.to as UTCTimestamp })
}

/** 按周期算右侧留白根数：M1 约 20 根，M5 约 4 根，M30 以上至少 2 根 */
function latestRightPad(tf: string): number {
  const secs = timeframeSeconds(tf)
  if (secs <= 0) return 2
  return Math.max(2, Math.min(20, Math.round(LIVE_MARGIN_SECONDS / secs)))
}

/** 跟随窗口右侧留白：约视窗宽度的 10%，夹在 2~30 根 */
function followPad(span: number): number {
  return Math.max(2, Math.min(30, Math.round(span * 0.1), Math.max(2, Math.floor(span) - 2)))
}

/** 把视野落到「最新一根 + 右侧留白」，保持原来的根数（夹在合理范围内） */
function latestLogicalRange(lastIndex: number, span: number, pad: number): Range {
  const n = Math.max(1, Math.min(2000, Math.round(span)))
  const to = lastIndex + pad
  return { from: Math.max(0, to - n), to }
}

export function SecondaryChart({
  rawBars,
  revealTime,
  timeframe,
  digits,
  symbol,
  mainChart,
  mainSeries,
  active,
  follow,
  label,
  trades,
  positions,
  activePositionId,
  onSelectPosition,
  onSlChange,
  onTpChange,
  riskPnlLabel,
  focusedTrade,
  focusSeq,
  followFocus,
  recenterSeq,
  onTimeframeChange,
  onToggleFollow,
  onClose
}: Props): React.JSX.Element {
  const { t, locale } = useT()
  const theme = useChartThemeStore((s) => s.theme ?? DEFAULT_CHART_THEME)
  const timezone = useTimezoneStore((s) => s.effective)

  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  /** 持仓价格线：每笔一组开仓 / SL / TP，三线都展示在副窗里 */
  const posLinesRef = useRef<
    Map<string, { entry?: IPriceLine; sl?: IPriceLine; tp?: IPriceLine; pending?: IPriceLine }>
  >(new Map())
  const positionsRef = useRef<Position[]>(positions)
  positionsRef.current = positions
  /** 副窗里正在拖的那条持仓线 */
  const posDragRef = useRef<{
    id: string
    key: 'sl' | 'tp' | 'risk'
    mode: 'free' | 'sl' | 'tp'
    startY: number
    moved: boolean
  } | null>(null)
  /** 上一批数据的第一根时间 / 根数：用来判断「只是最后一根在走」还是「换了一批」 */
  const firstTimeRef = useRef(0)
  const lenRef = useRef(0)
  /**
   * 上一份 1 分钟源数据的引用。
   * 播放推进时 rawBars 是同一个数组；只有换会话 / 重新载入才会换引用 ——
   * 用它区分「新数据要落到最新」和「同一次回放里继续推进，视野必须钉住」。
   */
  const prevRawBarsRef = useRef<Bar[] | null>(null)
  /** 这些数据是灌给哪个 series 的。图表重建过（StrictMode 双挂载）就必须整批重灌 */
  const ownerRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  /** 当前是不是在跟随主图（进 ref，免得数据 effect / 订阅回调因为开关变化重跑） */
  const followRef = useRef(follow)
  followRef.current = follow
  /** 主图进 ref：alignToMain 挂在 rAF 里，闭包读不到最新 props */
  const mainChartRef = useRef<IChartApi | null>(mainChart)
  mainChartRef.current = mainChart
  /** 主图 K 线 series 也进 ref：判断主图是不是贴着最新时要用它的根数 */
  const mainSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(mainSeries)
  mainSeriesRef.current = mainSeries

  /** 成交连线与定位都读 ref：它们挂在 rAF / 事件回调里，闭包读不到最新 props */
  const tradesRef = useRef<ClosedTrade[]>(trades)
  tradesRef.current = trades
  const focusedRef = useRef<ClosedTrade | null>(focusedTrade)
  focusedRef.current = focusedTrade
  const barsRef = useRef<Bar[]>([])
  /** 被定位那笔的开/平仓价格线 */
  const focusLinesRef = useRef<IPriceLine[]>([])
  /** 价格轴自动缩放的探针：拿它换算出的 y 变了就说明纵轴动过，要重画 */
  const probePriceRef = useRef(0)

  const [menuOpen, setMenuOpen] = useState(false)

  /**
   * 副周期数据：先二分找到「已揭示」的最后一根原始 K 线，再聚合。
   *
   * 不能直接聚合全量再截断 —— 聚合出来的最后一根会把游标之后的原始 K 线
   * 也算进 high/low/close，等于提前泄露了收盘价。只喂已揭示的部分，
   * 那根「进行中」的 K 线自然就是当前进度该有的样子。
   */
  const bars = useMemo(() => {
    if (rawBars.length === 0) return []
    if (!revealTime) return aggregateBars(rawBars, timeframe)
    const cut = indexAtTime(rawBars, revealTime)
    const end = rawBars[cut] && rawBars[cut].time <= revealTime ? cut + 1 : 0
    if (end <= 0) return []
    return aggregateBars(rawBars.slice(0, end), timeframe)
  }, [rawBars, timeframe, revealTime])
  barsRef.current = bars

  // ---------- 建图 ----------
  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const t0 = useChartThemeStore.getState().theme ?? DEFAULT_CHART_THEME

    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { color: t0.background },
        textColor: t0.textColor,
        fontSize: 10,
        fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif'
      },
      grid: {
        vertLines: { color: t0.gridColor, visible: t0.gridVisible },
        horzLines: { color: t0.gridColor, visible: t0.gridVisible }
      },
      rightPriceScale: {
        borderColor: '#2a2a2a',
        scaleMargins: { top: 0.15, bottom: 0.15 }
      },
      timeScale: {
        borderColor: '#2a2a2a',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 0,
        /**
         * 新 K 线来了要不要自己把视野往右推。
         *
         * 交给下面的「数据 effect」按窗口角色决定，图表这边一律不动：
         * 只有正在被播放（选中）且贴在最右边的窗口跟着走，其它窗口原地不动。
         * 交给库自己推的话，所有窗口都会跟着动 —— 步进一根，别的窗口的视野就被改了。
         */
        shiftVisibleRangeOnNewBar: false,
        // 副图小，刻度挤，只显示「日 时:分」
        tickMarkFormatter: (time: Time): string => {
          const p = tzPartsFromSec(Number(time), useTimezoneStore.getState().effective)
          const hm = `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`
          return `${String(p.day).padStart(2, '0')} ${hm}`
        }
      },
      crosshair: {
        mode: t0.crosshairMagnet ? 1 : 0,
        vertLine: {
          color: t0.crosshairColor,
          width: t0.crosshairWidth,
          style: t0.crosshairStyle,
          labelVisible: false
        },
        horzLine: {
          color: t0.crosshairColor,
          width: t0.crosshairWidth,
          style: t0.crosshairStyle,
          labelVisible: true,
          labelBackgroundColor: '#2a2a2a'
        }
      },
      localization: {
        locale: 'zh-CN',
        timeFormatter: (time: Time): string => {
          const p = tzPartsFromSec(Number(time), useTimezoneStore.getState().effective)
          return `${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')} ${String(
            p.hour
          ).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`
        }
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
      priceFormat: { type: 'price' as const, precision: 2, minMove: 0.01 }
    })

    chartRef.current = chart
    seriesRef.current = series

    if (import.meta.env.DEV) {
      ;(window as any).__rw_chart2 = { chart, series }
    }

    return () => {
      chartRef.current = null
      seriesRef.current = null
      // 图没了，缓存的价格线引用也失效；下一张图要靠 positions effect 重新建
      posLinesRef.current.clear()
      // 调试钩子要一起清掉，否则关掉副窗之后还读得到一个已经 remove 掉的死图表
      if (import.meta.env.DEV) (window as any).__rw_chart2 = null
      chart.remove()
    }
  }, [])

  // 主题变了跟着变
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    chart.applyOptions({
      layout: { background: { color: theme.background }, textColor: theme.textColor },
      grid: {
        vertLines: { color: theme.gridColor, visible: theme.gridVisible },
        horzLines: { color: theme.gridColor, visible: theme.gridVisible }
      },
      crosshair: {
        mode: theme.crosshairMagnet ? 1 : 0,
        vertLine: { color: theme.crosshairColor, width: theme.crosshairWidth, style: theme.crosshairStyle },
        horzLine: { color: theme.crosshairColor, width: theme.crosshairWidth, style: theme.crosshairStyle }
      }
    })
    seriesRef.current?.applyOptions({
      upColor: theme.upColor,
      downColor: theme.downColor,
      borderUpColor: theme.upColor,
      borderDownColor: theme.downColor,
      wickUpColor: theme.upColor,
      wickDownColor: theme.downColor,
      borderVisible: theme.showBorder,
      wickVisible: theme.showWick
    })
  }, [theme])

  // 精度跟着品种走（5 位小数 vs 3 位）
  useEffect(() => {
    const p = Math.pow(10, -digits)
    seriesRef.current?.applyOptions({
      priceFormat: { type: 'price', precision: digits, minMove: p }
    })
  }, [digits])

  // ---------- 历史成交连线 ----------

  /** 本窗的坐标映射：接口和主图那套一致，drawTrades 才能原样复用 */
  const buildMapping = useCallback((): ChartMapping | null => {
    const chart = chartRef.current
    const series = seriesRef.current
    if (!chart || !series) return null
    const ts = chart.timeScale()

    /**
     * 时间 → x。
     *
     * 这里必须带插值兜底：成交时间（比如 23:58）几乎不会正好落在 K 线的时间点上
     * （M30 的桶是 23:30），而 `timeToCoordinate` 对「不在数据集里的时间」直接返回 null。
     * 少了这层兜底，所有成交连线都会被判成「算不出坐标」而一笔都画不出来。
     */
    const timeToX = (time: number): number | null => {
      const c = ts.timeToCoordinate(time as UTCTimestamp)
      if (c != null) return c as number

      const list = barsRef.current
      const n = list.length
      if (n === 0) return null
      const i = indexAtTime(list, time)
      const j = Math.min(i + 1, n - 1)
      const t0 = list[i].time
      const xa = ts.timeToCoordinate(t0 as UTCTimestamp)
      if (xa == null) return null
      const t1 = list[j].time
      if (j === i || t1 === t0) return xa as number
      const xb = ts.timeToCoordinate(t1 as UTCTimestamp)
      if (xb == null) return xa as number
      const frac = Math.min(1, Math.max(0, (time - t0) / (t1 - t0)))
      return (xa as number) + ((xb as number) - (xa as number)) * frac
    }

    return {
      timeToX,
      xToTime: (x) => {
        const t = ts.coordinateToTime(x)
        return t == null ? null : Number(t)
      },
      priceToY: (price) => {
        const c = series.priceToCoordinate(price)
        return c == null ? null : (c as number)
      },
      yToPrice: (y) => {
        const p = series.coordinateToPrice(y)
        return p == null ? null : Number(p)
      }
    }
  }, [])

  const redraw = useCallback(() => {
    const canvas = canvasRef.current
    const chart = chartRef.current
    if (!canvas || !chart) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    // 量父容器：量画布自己会陷入「设宽度 → 影响下次测量」的循环
    const host = canvas.parentElement
    if (!host) return
    const dpr = window.devicePixelRatio || 1
    const rect = host.getBoundingClientRect()
    const cssW = Math.max(1, Math.round(rect.width))
    const cssH = Math.max(1, Math.round(rect.height))
    if (canvas.style.width !== `${cssW}px`) canvas.style.width = `${cssW}px`
    if (canvas.style.height !== `${cssH}px`) canvas.style.height = `${cssH}px`
    const bmpW = Math.round(cssW * dpr)
    const bmpH = Math.round(cssH * dpr)
    if (canvas.width !== bmpW) canvas.width = bmpW
    if (canvas.height !== bmpH) canvas.height = bmpH

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cssW, cssH)
    const map = buildMapping()
    if (!map) return
    drawTrades(ctx, tradesRef.current, map, { width: cssW, height: cssH }, focusedRef.current?.id ?? null)
  }, [buildMapping])

  /**
   * 尺寸变化立刻补画一次。
   *
   * 光靠下面那个每帧比指纹的循环不够：画布宽高是我们按**父容器**量出来再写上去的，
   * 指纹里如果只有画布自己的 clientWidth/clientHeight，那么「首帧量到 0 尺寸 → 画布
   * 被写成 1×1」之后指纹就再也不会变，画布永远停在 1×1 —— 表现在界面上就是
   * 「副窗一条订单线都没有」。
   */
  useEffect(() => {
    const host = canvasRef.current?.parentElement
    if (!host) return
    const ro = new ResizeObserver(() => redraw())
    ro.observe(host)
    return () => ro.disconnect()
  }, [redraw])

  /**
   * 什么时候重画。
   *
   * lightweight-charts 不会为「价格轴自动缩放」发事件，而成交连线的 y 全靠价格轴换算 ——
   * 只订阅时间范围变化的话，滚一下纵轴线条就跟 K 线错位了。所以每帧算一个指纹
   * （视野 + 尺寸 + 成交笔数 + 被定位的那笔 + 价格轴换算出的一个采样 y），变了才重画。
   */
  useEffect(() => {
    let raf = 0
    let lastSig = ''
    const tick = (): void => {
      const chart = chartRef.current
      const series = seriesRef.current
      const canvas = canvasRef.current
      if (chart && series && canvas) {
        const r = chart.timeScale().getVisibleRange()
        // 父容器尺寸也要进指纹 —— 见上面 ResizeObserver 那段注释
        const host = canvas.parentElement
        const sig = [
          r ? Number(r.from) : 0,
          r ? Number(r.to) : 0,
          host ? host.clientWidth : 0,
          host ? host.clientHeight : 0,
          canvas.width,
          canvas.height,
          tradesRef.current.length,
          focusedRef.current?.id ?? '',
          series.priceToCoordinate(probePriceRef.current) ?? -1
        ].join('|')
        if (sig !== lastSig) {
          lastSig = sig
          redraw()
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [redraw])

  // ---------- 十字线联动 ----------
  /**
   * 鼠标在一个窗口里移动，另一个窗口也画出对应的十字线。
   *
   * 用的是公开 API `setCrosshairPosition(price, time, series)` / `clearCrosshairPosition()`。
   * 两个要点：
   *  1. 传的**不是像素**，是「价格 + 时间」。两个窗口的 x 换算比例、y 换算比例都不一样，
   *     传像素过去只会对不上；传价格和时间过去，各自按自己的坐标轴落点，才对得上同一根 K 线、
   *     同一个价位。
   *  2. 程序化设十字线会反过来触发对方（也就是自己）的 crosshairMove，用静默窗挡一下，
   *     否则两边会互相设、一路抖。
   */
  useEffect(() => {
    const chart = chartRef.current
    const series = seriesRef.current
    if (!chart || !series || !mainChart || !mainSeries) return

    /** 谁被我程序化设过十字线：短时间里它报上来的 crosshairMove 都是回声 */
    const mute = { self: 0, main: 0 }
    const GUARD_MS = 50

    /** 鼠标位置 → 该传给对方的「时间」。优先用图表算好的 time，取不到再从 x 反推。 */
    const timeAt = (
      param: MouseEventParams,
      ts: ITimeScaleApi<Time>
    ): Time | null => {
      if (param.time != null) return param.time
      if (!param.point) return null
      const t2 = ts.coordinateToTime(param.point.x)
      return t2 == null ? null : t2
    }

    const onSelf = (param: MouseEventParams): void => {
      if (performance.now() < mute.self) return
      const ts = chart.timeScale()
      const t2 = timeAt(param, ts)
      const price = param.point ? series.coordinateToPrice(param.point.y) : null
      mute.main = performance.now() + GUARD_MS
      if (t2 == null || price == null) {
        // 鼠标离开 / 停在空白处：另一边的十字线也要一起消失
        mainChart.clearCrosshairPosition()
        return
      }
      mainChart.setCrosshairPosition(Number(price), t2, mainSeries)
    }

    const onMain = (param: MouseEventParams): void => {
      if (performance.now() < mute.main) return
      const ts = mainChart.timeScale()
      const t2 = timeAt(param, ts)
      const price = param.point ? mainSeries.coordinateToPrice(param.point.y) : null
      mute.self = performance.now() + GUARD_MS
      if (t2 == null || price == null) {
        chart.clearCrosshairPosition()
        return
      }
      chart.setCrosshairPosition(Number(price), t2, series)
    }

    chart.subscribeCrosshairMove(onSelf)
    mainChart.subscribeCrosshairMove(onMain)

    return () => {
      chart.unsubscribeCrosshairMove(onSelf)
      mainChart.unsubscribeCrosshairMove(onMain)
      // 拆掉的时候把留在对方身上的十字线擦干净，否则关掉副窗会留一根线挂在那儿
      mute.main = performance.now() + GUARD_MS
      try {
        mainChart.clearCrosshairPosition()
      } catch {
        // 主图可能已经先一步销毁了
      }
    }
  }, [mainChart, mainSeries])

  /** 被定位的那一笔：两边都画开/平仓价格线，只有选中的那个窗口才把视野挪过去 */
  useEffect(() => {
    const series = seriesRef.current
    if (!series) return
    for (const pl of focusLinesRef.current) {
      try {
        series.removePriceLine(pl)
      } catch {
        // 已经随图表一起没了
      }
    }
    focusLinesRef.current = []
    if (!focusedTrade) {
      redraw()
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
    redraw()
  }, [focusedTrade?.id, redraw, t])

  // ---------- 持仓：开仓 / 止损 / 止盈线（每个副窗都要画，也都能拖） ----------
  /**
   * 结构指纹只关心「有几笔、哪一边、开仓价、有没有 SL/TP、手数」。
   * 拖动时价格每帧都变，不能靠重建线条；价格更新走下面那个 applyOptions。
   */
  const posLineSig = positions
    .map(
      (p) =>
        `${p.id}:${p.side}:${p.entryPrice}:${p.sl != null ? 1 : 0}${p.tp != null ? 1 : 0}:${p.lot}`
    )
    .join('|')

  useEffect(() => {
    const series = seriesRef.current
    if (!series) return
    for (const lines of posLinesRef.current.values()) {
      for (const line of Object.values(lines)) {
        try {
          series.removePriceLine(line)
        } catch {
          // 已随图表一起移除
        }
      }
    }
    posLinesRef.current.clear()

    for (const p of positions) {
      const lines: { entry?: IPriceLine; sl?: IPriceLine; tp?: IPriceLine; pending?: IPriceLine } = {}
      const isActive = p.id === activePositionId
      const tag = t('chart.sideLotTag', {
        side: p.side === 'buy' ? t('chart.sideBuy') : t('chart.sideSell'),
        lot: p.lot.toFixed(2)
      })

      /**
       * 和主图完全同一套语义：
       *  - 两线未设全：开仓价上一条「待定性」线，拖上/拖下决定是 TP 还是 SL；
       *  - 两线设全：开仓线正常显示；SL/TP 各自一条可拖线。
       */
      const needRisk = p.sl == null || p.tp == null
      if (needRisk) {
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
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
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
  }, [activePositionId, posLineSig, t])

  /** 拖动 / 价格推进时只改线的属性和标签，不重建（每帧重建会掉帧） */
  useEffect(() => {
    for (const p of positions) {
      const lines = posLinesRef.current.get(p.id)
      if (!lines) continue
      if (lines.sl && p.sl != null) {
        lines.sl.applyOptions({
          price: p.sl,
          color: isTrailingStop(p) ? TRAIL_COLOR : SL_COLOR,
          title: riskTitle(p, 'sl', riskPnlLabel, t('chart.trailingStop'))
        })
      }
      if (lines.tp && p.tp != null) {
        lines.tp.applyOptions({
          price: p.tp,
          title: riskTitle(p, 'tp', riskPnlLabel, t('chart.trailingStop'))
        })
      }
    }
  }, [positions, riskPnlLabel, t])

  /** 副窗卸载：把线摘干净，别留在别的会话/别的图里 */
  useEffect(() => {
    return () => {
      const series = seriesRef.current
      if (series) {
        for (const lines of posLinesRef.current.values()) {
          for (const line of Object.values(lines)) {
            try {
              series.removePriceLine(line)
            } catch {
              // 图表已经一起销毁
            }
          }
        }
      }
      posLinesRef.current.clear()
    }
  }, [])

  /**
   * 副窗里拖持仓的 SL/TP 线。
   *
   * 命中、夹取规则跟主图完全一致；区别只是坐标从本窗的 series 换算。
   * 拖动结果直接写回全局 store，所以主图和另一个副窗会立刻跟着更新。
   */
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const hitLine = (y: number): { id: string; key: 'sl' | 'tp' | 'risk' } | null => {
      const series = seriesRef.current
      if (!series) return null
      // 用对象包一层：闭包里给裸变量赋值，TS 的控制流收窄会把它当成永远是 null
      const hit: { best: { id: string; key: 'sl' | 'tp' | 'risk'; dist: number } | null } = {
        best: null
      }
      const consider = (id: string, key: 'sl' | 'tp' | 'risk', price: number | null): void => {
        if (price == null) return
        const coord = series.priceToCoordinate(price)
        if (coord == null) return
        const dist = Math.abs((coord as number) - y)
        if (dist <= POS_HIT_TOLERANCE && (!hit.best || dist < hit.best.dist)) {
          hit.best = { id, key, dist }
        }
      }
      for (const pos of positionsRef.current) {
        if (pos.sl == null || pos.tp == null) consider(pos.id, 'risk', pos.entryPrice)
        consider(pos.id, 'sl', pos.sl)
        consider(pos.id, 'tp', pos.tp)
      }
      return hit.best ? { id: hit.best.id, key: hit.best.key } : null
    }

    const onDown = (e: MouseEvent): void => {
      if (e.button !== 0) return
      const target = e.target as HTMLElement | null
      if (target?.closest('button, input, textarea, select, a, [data-pending-ticket]')) return
      const chart = chartRef.current
      const series = seriesRef.current
      if (!chart || !series) return
      const rect = host.getBoundingClientRect()
      const y = e.clientY - rect.top
      // 时间轴那一条不算价格区，别把轴上的点当成价格线
      if (y < 0 || y > rect.height - chart.timeScale().height()) return

      const hit = hitLine(y)
      if (!hit) return
      const pos = positionsRef.current.find((p) => p.id === hit.id)
      if (!pos) return
      const mode: 'free' | 'sl' | 'tp' =
        pos.sl == null && pos.tp == null ? 'free' : pos.sl == null ? 'sl' : 'tp'
      posDragRef.current = { id: hit.id, key: hit.key, mode, startY: y, moved: false }
      onSelectPosition(pos.id)
      chart.applyOptions({ handleScroll: false, handleScale: false })
      host.style.cursor = 'ns-resize'
      e.preventDefault()
      e.stopPropagation()
    }

    const onMove = (e: MouseEvent): void => {
      const drag = posDragRef.current
      if (!drag) return
      const chart = chartRef.current
      const series = seriesRef.current
      if (!chart || !series) return
      const rect = host.getBoundingClientRect()
      const y = e.clientY - rect.top
      // 点一下不拖：避免点选持仓时手抖带出一条极窄的止损/止盈
      if (!drag.moved) {
        if (Math.abs(y - drag.startY) < POS_DRAG_START_PX) return
        drag.moved = true
      }
      const price = series.coordinateToPrice(y)
      if (price == null) return
      const pos = positionsRef.current.find((p) => p.id === drag.id)
      if (!pos) return

      if (drag.key === 'sl') {
        onSlChange(pos.id, Number(price))
      } else if (drag.key === 'tp') {
        onTpChange(pos.id, Number(price))
      } else {
        const point = Math.pow(10, -pos.digits)
        if (Math.abs(Number(price) - pos.entryPrice) < point) return
        const up = Number(price) > pos.entryPrice
        const byDir: 'sl' | 'tp' =
          pos.side === 'buy' ? (up ? 'tp' : 'sl') : up ? 'sl' : 'tp'
        const kind = drag.mode === 'sl' ? 'sl' : drag.mode === 'tp' ? 'tp' : byDir
        if (kind === 'sl') onSlChange(pos.id, Number(price))
        else onTpChange(pos.id, Number(price))
      }
      e.preventDefault()
    }

    const onUp = (): void => {
      if (!posDragRef.current) return
      posDragRef.current = null
      host.style.cursor = ''
      chartRef.current?.applyOptions({ handleScroll: true, handleScale: true })
    }

    host.addEventListener('mousedown', onDown, true)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      host.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      host.style.cursor = ''
      posDragRef.current = null
    }
  }, [onSelectPosition, onSlChange, onTpChange])

  // 定位：只有「被选中的那个窗口」把视野挪到这笔单上，另一个靠时间范围同步跟过来
  useEffect(() => {
    if (!followFocus) return
    const chart = chartRef.current
    const trade = focusedRef.current
    const list = barsRef.current
    if (!chart || !trade || list.length < 2) return
    const range = focusLogicalRange({
      total: list.length,
      // 本窗的 bars 已经只到回放进度，最后一根就是上限
      lastRevealed: list.length - 1,
      idxIn: indexAtTime(list, trade.entryTime),
      idxOut: indexAtTime(list, trade.exitTime)
    })
    if (range) chart.timeScale().setVisibleLogicalRange(range)
  }, [focusedTrade?.id, focusSeq, followFocus])

  /**
   * 手动「归位」：只有收到 recenterSeq 的那个窗口把视野拉回最新一根。
   *
   * 播放过程中的数据 effect 一根都不动；用户想回最新时按空格，落点就是这里。
   * 保留当前根数，右边按周期留一点空白，确保最新 K 线完整落在窗口内。
   */
  const seenRecenterRef = useRef(recenterSeq)
  useEffect(() => {
    if (recenterSeq === seenRecenterRef.current) return
    seenRecenterRef.current = recenterSeq
    // 三个窗口都收到同一个序号，但只有当前选中的那个负责动
    if (!active) return
    const chart = chartRef.current
    const list = barsRef.current
    if (!chart || list.length === 0) return
    const r = chart.timeScale().getVisibleLogicalRange()
    const span = r ? r.to - r.from : DEFAULT_VISIBLE_BARS
    const next = latestLogicalRange(list.length - 1, span, latestRightPad(timeframe))
    muteRef.current.self = 0
    chart.timeScale().setVisibleLogicalRange(next)
  }, [active, recenterSeq, timeframe])

  // ---------- 时间范围同步：主图是唯一的基准，跟随它的窗口围着它转 ----------
  /**
   * 程序化推送的「静默窗」：推给哪个窗口，就在接下来这段时间里把它的变化当成自己的回声吞掉。
   *
   * 为什么不能比数值：
   * 以前的做法是「把刚推过去的范围存下来，对方报回来的如果一模一样就忽略一次」。
   * 但两个窗口的桶不一样粗 —— 把主图 M5 的 [21:00, 23:58] 推给 M30 副窗，副窗的
   * 可视范围会**被夹到自己最近的那根 K 线上**，比如 [21:30, 23:30]。这个被夹窄的
   * 范围跟推过去的不相等，于是判定「不是回声」，又推回主图；主图再夹一次、再推回来……
   * 每一轮左右两条边都往里缩一格，视野就一路收窄 —— 用户看到的就是「往右看自动放大」。
   *
   * 按来源挡就没有这个问题：谁被我推过，谁在静默窗内报什么我都不信。
   */
  const muteRef = useRef({ self: 0, main: 0 })

  const pushToSelf = useCallback((r: Range): void => {
    const chart = chartRef.current
    if (!chart) return
    muteRef.current.self = performance.now() + SYNC_MUTE_MS
    pushRange(chart.timeScale(), r)
  }, [])

  const pushToMain = useCallback((r: Range): void => {
    const main = mainChartRef.current
    if (!main) return
    muteRef.current.main = performance.now() + SYNC_MUTE_MS
    pushRange(main.timeScale(), r)
  }, [])

  /**
   * 跟随主图时，右侧再留一点「未来空间」。
   *
   * 主图的可见范围右端常常正好落在最后一根 K 线上（甚至更靠左），
   * 直接按这个时间范围设给副窗，副窗的最后一根就贴死在右边框上，
   * 看起来没有行情要走的空间。这里只在副窗本来就处在最新附近时，
   * 把右端再加宽视窗宽度的约 10%（夹在 2~30 根）：
   * 不改变左端看的历史位置，只在右边露出一段空白。
   *
   * 用户翻到历史区间（右端离最新还差很多）时不做这件事 —— 那是「跟随同一段」，
   * 硬加未来空白会把主图的历史位置也带偏。
   */
  const ensureFollowSpace = useCallback((): void => {
    const chart = chartRef.current
    const list = barsRef.current
    if (!chart || list.length === 0) return
    const lr = chart.timeScale().getVisibleLogicalRange()
    if (!lr) return
    const last = list.length - 1
    // 只有本来就在看最新附近才补未来空白
    if (lr.to < last - 1) return
    const span = lr.to - lr.from
    if (!Number.isFinite(span) || span <= 0) return
    const pad = followPad(span)
    if (lr.to >= last + pad) return
    muteRef.current.self = performance.now() + SYNC_MUTE_MS
    chart.timeScale().setVisibleLogicalRange({
      from: last + pad - span,
      to: last + pad
    })
  }, [])

  /** 主图是不是已经贴着它自己的最新一根（= 主图在播最新，不是在翻历史） */
  const mainAtLiveEdge = useCallback((): boolean => {
    const main = mainChartRef.current
    const series = mainSeriesRef.current
    if (!main || !series) return false
    const data = series.data()
    if (data.length === 0) return false
    const lr = main.timeScale().getVisibleLogicalRange()
    if (!lr) return false
    return lr.to >= data.length - 3
  }, [])

  /**
   * 把主图的视野推给本窗。
   *
   * 推完的下一帧再补右侧：主图贴最新时，按本窗自己的最新一根重新落位
   * （避免粗周期主图把细周期副窗的最新几根挡在右边界外）；主图在翻历史时
   * 只补未来空白，保持同一段历史。
   */
  const applyMainRange = useCallback(
    (r: Range): void => {
      const chart = chartRef.current
      const list = barsRef.current
      if (!chart || list.length === 0) return

      /**
       * 主图在播最新、而本窗周期更细时，主图推过来的右端只是它自己的桶时间。
       * 如果先按这个时间推过去、下一帧再跳到本窗最新，画面会“闪一下才归位”。
       * 这里直接一步落到本窗最新一根，同一个事件循环内完成，不经过中间态。
       */
      if (followRef.current && mainAtLiveEdge()) {
        const lr = chart.timeScale().getVisibleLogicalRange()
        const span = lr ? lr.to - lr.from : DEFAULT_VISIBLE_BARS
        if (!Number.isFinite(span) || span <= 0) return
        const next = latestLogicalRange(list.length - 1, span, followPad(span))
        muteRef.current.self = performance.now() + SYNC_MUTE_MS
        chart.timeScale().setVisibleLogicalRange({ from: next.from, to: next.to })
        requestAnimationFrame(() => {
          if (!followRef.current) return
          chart.timeScale().setVisibleLogicalRange({ from: next.from, to: next.to })
        })
        return
      }

      pushToSelf(r)
      requestAnimationFrame(ensureFollowSpace)
    },
    [ensureFollowSpace, mainAtLiveEdge, pushToSelf]
  )

  /**
   * 把本窗拉齐到主图的视野。建图、换数据、打开「跟随」时各调用一次。
   * 不跟随的时候什么都不做 —— 用户自己摆好的视野不该被主图拽走。
   */
  const alignToMain = useCallback((): void => {
    const chart = chartRef.current
    const main = mainChartRef.current
    if (!chart || !main || !followRef.current) return
    const r = readRange(main.timeScale())
    if (r) applyMainRange(r)
  }, [applyMainRange])

  /**
   * 把视野原样钉住。
   *
   * 这里用**逻辑范围**（第几根到第几根），不用时间范围：
   * 逻辑范围就是“我正在看这几十根”，`setData` 之后原样设回去即可，
   * 不受右偏移重算、时间轴夹取的影响；新 K 线来了就老老实实呆在右边外面 ——
   * 这才叫“不自动跟随”。
   */
  const pinLogicalRange = useCallback((r: Range): void => {
    const chart = chartRef.current
    if (!chart) return
    muteRef.current.self = performance.now() + SYNC_MUTE_MS
    chart.timeScale().setVisibleLogicalRange({ from: r.from, to: r.to })
  }, [])

  // 数据换了一批：先灌数据，再把视野按原样钉住（或落到最新）
  useEffect(() => {
    const series = seriesRef.current
    const chart = chartRef.current
    if (!series || !chart) return
    if (bars.length === 0) {
      series.setData([])
      firstTimeRef.current = 0
      lenRef.current = 0
      return
    }

    const head = bars[0].time
    const tail = bars[bars.length - 1]
    /**
     * 图表是不是新建的。
     * 开发模式下 StrictMode 会把 effect 跑两遍：第一次灌进旧图表，图表被 remove 之后
     * 第二次面对的是一张空图 —— 这时如果还按「根数没变就 update 最后一根」走，
     * 屏幕上就只剩一根 K 线。
     */
    const freshChart = ownerRef.current !== series
    ownerRef.current = series
    /**
     * 只是最后一根在往前走（回放每推进一格就一次）：
     * 就地 update，不碰时间轴，也不碰视野。
     */
    if (!freshChart && lenRef.current === bars.length && firstTimeRef.current === head) {
      series.update(toCandle(tail))
      probePriceRef.current = tail.close
      return
    }

    /**
     * setData 之前先记下当前视野（逻辑范围）、旧根数和这份源数据是不是换过。
     *
     *  · 跟随 + 本来就贴着最新：整体右移这一格新增的根数，最新 K 线不会溢出右边框；
     *  · 独立 / 跟随但已经翻到历史：把逻辑范围原样设回去，一步都不动；
     *  · 第一次落图 / 换了会话：落到「最新一根 + 右侧留白」，保证一打开就能看见最新 K 线。
     *
     * 跟随窗口靠主图的时间范围同步只能覆盖“主图自己动了”的情况；
     * 主图不动、数据自己在长的时候，必须由这里按新增根数平移，否则最新 K 线会从右边溢出去。
     */
    const ts = chart.timeScale()
    const prev = ts.getVisibleLogicalRange()
    const datasetChanged =
      prevRawBarsRef.current !== null && prevRawBarsRef.current !== rawBars
    prevRawBarsRef.current = rawBars
    firstTimeRef.current = head
    lenRef.current = bars.length
    probePriceRef.current = tail.close

    // 灌数据本身也会触发一次 range 回调，先静音，别把它当成用户操作推给主图
    muteRef.current.self = performance.now() + SYNC_MUTE_MS
    series.setData(bars.map((b) => toCandle(b)))

    if (!prev || freshChart || datasetChanged) {
      // 新数据：落回最新一根，保留用户原来的根数（第一次就给默认根数）
      const span = prev ? prev.to - prev.from : DEFAULT_VISIBLE_BARS
      const next = latestLogicalRange(bars.length - 1, span, latestRightPad(timeframe))
      pinLogicalRange(next)
      requestAnimationFrame(() => pinLogicalRange(next))
      // 跟随模式在换数据时对齐一次主图；播放推进时不会再对齐
      if (followRef.current) requestAnimationFrame(alignToMain)
      return
    }

    // 同一次回放：跟随窗口贴边时跟着新增根数平移；独立/历史区原样钉死
    const followMainLive = followRef.current && mainAtLiveEdge()
    if (followMainLive) {
      /**
       * 主图在播最新：不要按主图的桶时间对齐，直接以本窗自己的最新一根落位。
       * 主图 M30、副窗 M1 时，主图右端可能只到 15:30，副窗已经有 15:55，
       * 按主图时间设过去会把 25 分钟的新 K 线全甩到右边框外。
       *
       * 目标范围用**更新前**的 prev 宽度算，并且 setData 后立刻设回去；
       * 不能等下一帧再读“已经被 setData 撑歪”的范围，否则画面会闪一下才归位。
       */
      const span = prev.to - prev.from
      const next = latestLogicalRange(bars.length - 1, span, followPad(span))
      pinLogicalRange(next)
      requestAnimationFrame(() => pinLogicalRange(next))
      return
    }
    // 主图在看历史 / 独立窗口：逻辑范围原样钉死，一步都不动
    const target = { from: prev.from, to: prev.to }
    pinLogicalRange(target)
    requestAnimationFrame(() => pinLogicalRange(target))
  }, [alignToMain, bars, mainAtLiveEdge, pinLogicalRange, rawBars, timeframe])

  // ---------- 同步：只订阅「主图 ↔ 自己」这一条边 ----------
  /**
   * 三个窗口如果两两同步是 6 条边，静默窗互相打架，很容易抖起来。
   * 改成星形：主图是唯一的基准，每个副窗只管自己跟不跟随。
   *   - 跟随：主图变了推给我，我变了也推给主图（所以在任意一个跟随窗里拖，
   *     其余的跟随窗也会经主图跟过来）；
   *   - 不跟随：两个方向都直接 return，互不干涉。
   * 谁被我程序化推过，谁在静默窗内报上来的变化一律不相信（见 muteRef）。
   */
  useEffect(() => {
    const chart = chartRef.current
    if (!mainChart || !chart) return
    const selfTs = chart.timeScale()
    const mainTs = mainChart.timeScale()

    const onSelf = (): void => {
      if (performance.now() < muteRef.current.self) return
      if (!followRef.current) return
      const r = readRange(selfTs)
      if (!r) return
      pushToMain(r)
    }
    const onMain = (): void => {
      if (performance.now() < muteRef.current.main) return
      if (!followRef.current) return
      const r = readRange(mainTs)
      if (!r) return
      applyMainRange(r)
    }

    // 刚建图 / 主图刚重建：先对齐一次，再开始跟
    const raf = requestAnimationFrame(alignToMain)
    selfTs.subscribeVisibleTimeRangeChange(onSelf)
    mainTs.subscribeVisibleTimeRangeChange(onMain)

    return () => {
      cancelAnimationFrame(raf)
      selfTs.unsubscribeVisibleTimeRangeChange(onSelf)
      mainTs.unsubscribeVisibleTimeRangeChange(onMain)
    }
  }, [alignToMain, applyMainRange, mainChart, pushToMain])

  // 打开「跟随」的那一刻立刻对齐；关掉时保持现状，把视野还给用户
  useEffect(() => {
    if (!follow) return
    const raf = requestAnimationFrame(alignToMain)
    return () => cancelAnimationFrame(raf)
  }, [alignToMain, follow])

  const tfMenu = (
    <div className="absolute left-0 top-full z-40 mt-1 w-[136px] rounded-md border border-[var(--border-strong)] bg-[var(--surface-1)] p-1 shadow-2xl">
      {BASE_TIMEFRAMES.map((o) => (
        <button
          key={o.id}
          onClick={() => {
            onTimeframeChange(o.id)
            setMenuOpen(false)
          }}
          className={clsx(
            'flex w-full items-center justify-between rounded px-2 py-1 text-[11.5px] transition-colors',
            o.id === timeframe
              ? 'bg-[var(--c-accent-tint)] text-[var(--c-accent)]'
              : 'text-[var(--text-secondary)] hover:bg-[var(--surface-3)] hover:text-[var(--text-primary)]'
          )}
        >
          <span>{timeframeCode(o.id)}</span>
          <span className="text-[10.5px] text-[var(--text-faint)]">
            {translateLabel(locale, timeframeName(o.id))}
          </span>
        </button>
      ))}
    </div>
  )

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden">
      {/* 选中的窗口描一圈主色边：快捷键、滚轮、平移作用在哪一边，一眼看得出来 */}
      {active && (
        <div className="pointer-events-none absolute inset-0 z-20 border border-[var(--c-accent)]" />
      )}
      {/* 抬头：这个窗口展示哪个周期、跟不跟主图，都在这儿设 —— 不用回工具栏找 */}
      <div
        className={clsx(
          'relative flex h-[22px] shrink-0 items-center gap-1 border-b px-1.5',
          active
            ? 'border-[var(--c-accent)] bg-[var(--c-accent-tint)]'
            : 'border-[var(--border-subtle)] bg-[var(--surface-2)]'
        )}
      >
        <span
          className={clsx(
            'shrink-0 text-[10px] font-medium',
            active ? 'text-[var(--c-accent)]' : 'text-[var(--text-faint)]'
          )}
        >
          {label}
        </span>
        <button
          onClick={() => setMenuOpen((v) => !v)}
          title={t('chart.secondaryTfHint')}
          className="flex shrink-0 items-center gap-0.5 rounded px-1 py-[1px] text-[11px] font-semibold text-[var(--c-accent)] transition-colors hover:bg-[var(--surface-3)]"
        >
          {timeframeCode(timeframe)}
          <ChevronDown size={10} />
        </button>
        {/* 品种和周期名只是提示，窄窗口先让它缩到 0，别把右边两个按钮挤出去 */}
        <span className="min-w-0 flex-1 truncate text-[10px] text-[var(--text-muted)]">
          {symbol} · {translateLabel(locale, timeframeName(timeframe))}
        </span>
        {/* 跟随主图的时间范围：开着跟主图一起动，关掉就能自己看自己那一段 */}
        <button
          onClick={onToggleFollow}
          title={follow ? t('chart.followOnHint') : t('chart.followOffHint')}
          aria-pressed={follow}
          className={clsx(
            // 两种状态都要有边框和底色：以前「独立」只是暗灰文字，
            // 看起来像状态标签，用户根本不知道它能点。
            'flex shrink-0 items-center gap-0.5 rounded border px-1.5 py-[2px] text-[10px] font-medium leading-none shadow-[0_1px_2px_rgba(0,0,0,0.35)] transition-colors',
            follow
              ? 'border-[var(--c-accent-border)] bg-[var(--c-accent-tint)] text-[var(--c-accent)] hover:brightness-110'
              : 'border-[var(--border-strong)] bg-[var(--surface-4)] text-[var(--text-primary)] hover:border-[var(--c-accent)] hover:text-[var(--c-accent)]'
          )}
        >
          {follow ? <Link2 size={10} /> : <Unlink2 size={10} />}
          <span>{follow ? t('chart.followOn') : t('chart.followOff')}</span>
        </button>
        <button
          onClick={onClose}
          title={t('chart.closeSubPane')}
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-[var(--text-faint)] transition-colors hover:bg-[var(--surface-3)] hover:text-[var(--c-neg)]"
        >
          <X size={11} />
        </button>
        {menuOpen && tfMenu}
        {menuOpen && (
          <div className="fixed inset-0 z-30" onMouseDown={() => setMenuOpen(false)} />
        )}
      </div>

      <div className="relative min-h-0 flex-1">
        <div ref={hostRef} data-secondary-chart="1" className="h-full w-full" />
        {/* 成交连线画在图表上面一层：跟主图同一套 drawTrades，两边看起来才是同一张图。
            这里必须显式给 z-index —— lightweight-charts 自己的画布是 position:absolute 且
            z-index:1/2，我们这块只写 absolute 的话处于 z-index:auto(0)，会整块被压在
            蜡烛底下，像素明明画上去了、用户却一条也看不见。 */}
        <canvas
          ref={canvasRef}
          data-secondary-overlay="1"
          className="pointer-events-none absolute inset-0 z-10 h-full w-full"
        />
      </div>
    </div>
  )
}

function toCandle(b: Bar): CandlestickData {
  return {
    time: b.time as UTCTimestamp,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close
  }
}
