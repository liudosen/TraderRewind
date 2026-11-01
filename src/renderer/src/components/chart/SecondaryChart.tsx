// ============================================================
// TraderRewind — 副周期 K 线窗（双周期里「另一个周期」那个小窗）
//
// 为什么要单独一个图表实例：lightweight-charts 一个图表里所有 pane 共用同一条
// 时间轴，同一个 x 只能对应一个时刻。想同时看 M5 和 H1，就只能开两个实例，
// 再把两边的时间范围互相同步 —— 这也是副图（MACD/RSI）留在主图里的原因：
// 那些指标和价格共用一条时间轴，放得下。
//
// 两条硬规矩：
// 1. 只画到当前回放进度（revealTime），绝不把还没走到的 K 线露出来；
// 2. 同步是双向的，但要用时间戳挡一下自己的程序化改动，否则两边会互相推来推去。
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
  type Time,
  type UTCTimestamp
} from 'lightweight-charts'
import { ChevronDown, X } from 'lucide-react'
import clsx from 'clsx'
import type { Bar, ClosedTrade } from '../../stores/training-store'
import {
  BASE_TIMEFRAMES,
  aggregateBars,
  indexAtTime,
  timeframeCode,
  timeframeName
} from '@shared/utils/timeframe'
import { DEFAULT_CHART_THEME } from '@shared/types/chart-theme'
import { useChartThemeStore } from '../../stores/chart-theme-store'
import { useTimezoneStore } from '../../stores/timezone-store'
import { tzPartsFromSec } from '@shared/types/timezone'
import { useT, translateLabel } from '../../i18n'
import type { ChartMapping } from './drawings'
import { drawTrades, focusLogicalRange } from './trade-lines'

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
  /** 这个窗口是不是「选中的那个」：选中的负责驱动，另一个跟着走 */
  active: boolean
  /** 已平仓的历史交易：两个窗口都要看得见 */
  trades: ClosedTrade[]
  /** 报告/日志里点选的那一笔：两边都高亮，只有选中窗口负责跳过去 */
  focusedTrade: ClosedTrade | null
  /** 定位序号：同一笔被反复点选时用它强制重新定位 */
  focusSeq: number
  /** 这一笔要不要由本窗去定位（= 本窗是选中的那个） */
  followFocus: boolean
  onTimeframeChange: (tf: string) => void
  onClose: () => void
}

type Range = { from: number; to: number }
/** 只用到时间轴这两个方法 —— 收窄类型就不必关心 lightweight-charts 的泛型 */
type TimeScaleLike = ITimeScaleApi<Time>

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

export function SecondaryChart({
  rawBars,
  revealTime,
  timeframe,
  digits,
  symbol,
  mainChart,
  active,
  trades,
  focusedTrade,
  focusSeq,
  followFocus,
  onTimeframeChange,
  onClose
}: Props): React.JSX.Element {
  const { t, locale } = useT()
  const theme = useChartThemeStore((s) => s.theme ?? DEFAULT_CHART_THEME)
  const timezone = useTimezoneStore((s) => s.effective)

  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  /** 上一批数据的第一根时间 / 根数：用来判断「只是最后一根在走」还是「换了一批」 */
  const firstTimeRef = useRef(0)
  const lenRef = useRef(0)
  /** 这些数据是灌给哪个 series 的。图表重建过（StrictMode 双挂载）就必须整批重灌 */
  const ownerRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  /** 当前是不是在驱动方（进 ref，免得数据 effect 因为选中变化重跑一遍 setData） */
  const activeRef = useRef(active)
  activeRef.current = active

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
        const sig = [
          r ? Number(r.from) : 0,
          r ? Number(r.to) : 0,
          canvas.clientWidth,
          canvas.clientHeight,
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

  /** 我刚推给主图的 / 我刚推给副窗的范围：用来挡掉随之而来的「回声」 */
  const pushedToMainRef = useRef<Range | null>(null)
  const pushedToSelfRef = useRef<Range | null>(null)

  /**
   * 把两个窗口拉齐到「选中的那个」的视野。
   * 建图、换数据、切换选中窗口时各调用一次。
   */
  const alignToDriver = (): void => {
    const chart = chartRef.current
    if (!chart || !mainChart) return
    const selfTs = chart.timeScale()
    const mainTs = mainChart.timeScale()
    const r = activeRef.current ? readRange(selfTs) : readRange(mainTs)
    if (!r) return
    if (activeRef.current) {
      pushedToMainRef.current = r
      pushRange(mainTs, r)
    } else {
      pushedToSelfRef.current = r
      pushRange(selfTs, r)
    }
  }

  // 数据换了一批：先灌数据，再把两个窗口拉齐
  useEffect(() => {
    const series = seriesRef.current
    if (!series) return
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
     * 就地 update，别 setData —— setData 会把视野拽回去，等于每秒抢一次用户的平移。
     */
    if (!freshChart && lenRef.current === bars.length && firstTimeRef.current === head) {
      series.update(toCandle(tail))
      probePriceRef.current = tail.close
      return
    }

    firstTimeRef.current = head
    lenRef.current = bars.length
    probePriceRef.current = tail.close
    series.setData(bars.map((b) => toCandle(b)))
    // setData 之后 lightweight-charts 会自己挪一次视野，等它落定再纠正
    requestAnimationFrame(alignToDriver)
    // alignToDriver 只读 ref 和 props，不需要进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bars, mainChart])

  // ---------- 同步：两边都跟，但挡掉自己推过去的「回声」 ----------
  /**
   * 为什么不是「只让选中的那个驱动」：
   * 回放推进时主图会自动往右滚（贴边跟随最新一根），这时候就算选中的是副窗，
   * 主图也在动 —— 只订阅一方的话两边立刻走散。
   *
   * 所以两边都订阅，只用「我刚推过去的那个范围」做回声抑制：
   * 对方报上来的范围跟我刚推过去的一模一样，那就是我自己的动作，忽略一次。
   * 比按时间窗挡（80ms 内的真实用户操作会被误吞）准得多。
   */
  useEffect(() => {
    const chart = chartRef.current
    if (!mainChart || !chart) return
    const selfTs = chart.timeScale()
    const mainTs = mainChart.timeScale()

    const same = (a: Range | null, b: Range | null): boolean =>
      !!a && !!b && Math.abs(a.from - b.from) < 0.5 && Math.abs(a.to - b.to) < 0.5

    const onSelf = (): void => {
      const r = readRange(selfTs)
      if (!r) return
      // 这是刚被主图推过来的：不往回推，否则两个窗口会互相推着跑
      if (same(r, pushedToSelfRef.current)) {
        pushedToSelfRef.current = null
        return
      }
      pushedToMainRef.current = r
      pushRange(mainTs, r)
    }
    const onMain = (): void => {
      const r = readRange(mainTs)
      if (!r) return
      if (same(r, pushedToMainRef.current)) {
        pushedToMainRef.current = null
        return
      }
      pushedToSelfRef.current = r
      pushRange(selfTs, r)
    }

    // 刚建图 / 刚切换选中窗口：先对齐一次，再开始跟
    const raf = requestAnimationFrame(alignToDriver)
    selfTs.subscribeVisibleTimeRangeChange(onSelf)
    mainTs.subscribeVisibleTimeRangeChange(onMain)

    return () => {
      cancelAnimationFrame(raf)
      selfTs.unsubscribeVisibleTimeRangeChange(onSelf)
      mainTs.unsubscribeVisibleTimeRangeChange(onMain)
    }
    // alignToDriver 只读 ref
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mainChart, active])

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
      {/* 抬头：这个窗口展示哪个周期，就在这儿换 —— 不用回工具栏找 */}
      <div
        className={clsx(
          'relative flex h-[22px] shrink-0 items-center gap-1.5 border-b px-2',
          active
            ? 'border-[var(--c-accent)] bg-[var(--c-accent-tint)]'
            : 'border-[var(--border-subtle)] bg-[var(--surface-2)]'
        )}
      >
        <span
          className={clsx(
            'text-[10px] font-medium uppercase tracking-[0.12em]',
            active ? 'text-[var(--c-accent)]' : 'text-[var(--text-faint)]'
          )}
        >
          {t('chart.secondaryPane')}
        </span>
        <button
          onClick={() => setMenuOpen((v) => !v)}
          title={t('chart.secondaryTfHint')}
          className="flex items-center gap-0.5 rounded px-1 py-[1px] text-[11px] font-semibold text-[var(--c-accent)] transition-colors hover:bg-[var(--surface-3)]"
        >
          {timeframeCode(timeframe)}
          <ChevronDown size={10} />
        </button>
        <span className="truncate text-[10.5px] text-[var(--text-muted)]">
          {symbol} · {translateLabel(locale, timeframeName(timeframe))}
        </span>
        <button
          onClick={onClose}
          title={t('chart.secondaryClose')}
          className="ml-auto flex h-4 w-4 shrink-0 items-center justify-center rounded text-[var(--text-faint)] transition-colors hover:bg-[var(--surface-3)] hover:text-[var(--c-neg)]"
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
        {/* 成交连线画在图表上面一层：跟主图同一套 drawTrades，两边看起来才是同一张图 */}
        <canvas ref={canvasRef} data-secondary-overlay="1" className="pointer-events-none absolute left-0 top-0" />
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
