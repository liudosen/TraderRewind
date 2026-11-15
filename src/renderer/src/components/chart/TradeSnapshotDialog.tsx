// ============================================================
// TraderRewind — 交易截图（独立 K 线图 + 照相机）
//
// 日志 / 训练页点「添加截图」时弹出来：只读地读一小段该笔交易前后的行情，
// 在独立图表上画出开平仓价格线和交易连线，用户调好视野后按照相机截图，
// 图片交给上层存进这笔交易的附件里。
//
// 这里刻意不复用回放图表：回放图有游标、画线、指标、下单票面一堆状态，
// 为了截一张图去动它，既容易把用户正在打的回放弄乱，也没必要。
// ============================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { Camera, Loader2, RotateCcw, X } from 'lucide-react'
import {
  CandlestickSeries,
  LineSeries,
  LineStyle,
  TickMarkType,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp
} from 'lightweight-charts'
import { isChartTimeframe, timeframeCode, type Bar } from '@shared/utils/timeframe'
import { DEFAULT_CHART_THEME } from '@shared/types/chart-theme'
import { tzPartsFromSec } from '@shared/types/timezone'
import { type ClosedTrade } from '../../stores/training-store'
import { useChartThemeStore } from '../../stores/chart-theme-store'
import { useT } from '../../i18n'
import { formatPrice, formatSigned } from '../../utils/format'
import { composeTradeShot, loadTradeBars, snapBarTime, stampTime } from './trade-shot'

/** 可选周期：数据本身是 M1 才能往上聚合 */
const ALL_TIMEFRAMES = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1']

export interface TradeShotPayload {
  dataUrl: string
  width: number
  height: number
}

interface Props {
  trade: ClosedTrade
  datasetId: number
  /** 会话显示周期，作为默认值 */
  timeframe?: string | null
  /** 展示时区（会话时区，缺省全局） */
  tz: string
  onClose: () => void
  /** 返回 true 表示已存进这笔交易（对话框可以关掉） */
  onCapture: (shot: TradeShotPayload) => Promise<boolean>
}

export function TradeSnapshotDialog({
  trade,
  datasetId,
  timeframe,
  tz,
  onClose,
  onCapture
}: Props): React.JSX.Element {
  const { t } = useT()
  const theme = useChartThemeStore((s) => s.theme) ?? DEFAULT_CHART_THEME

  const hostRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const connectorRef = useRef<ISeriesApi<'Line'> | null>(null)
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null)
  const priceLinesRef = useRef<IPriceLine[]>([])

  /** 数据集的原始周期（决定能聚合成哪些周期） */
  const [baseTf, setBaseTf] = useState<string | null>(null)
  const [tf, setTf] = useState<string>(() =>
    isChartTimeframe(timeframe) ? timeframe : 'M5'
  )
  const [bars, setBars] = useState<Bar[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  /** 图表实例的「第几次建好」：StrictMode 下 effect 会重跑，用它确保重画覆盖层 */
  const [chartSeq, setChartSeq] = useState(0)

  const digits = trade.digits
  const sideText = trade.side === 'buy' ? t('report.side.long') : t('report.side.short')
  const pnlColor = trade.pnl >= 0 ? '#ef4444' : '#22c55e'

  const availableTfs = useMemo(
    () => (baseTf && baseTf !== 'M1' ? [baseTf] : ALL_TIMEFRAMES),
    [baseTf]
  )

  // Esc 只关这张截图弹窗。编辑交易框的 Esc 在它外面，不拦的话会连编辑框一起关掉
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  // ---------- 建图：只建一次 ----------
  useEffect(() => {
    const el = hostRef.current
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
        scaleMargins: { top: 0.16, bottom: 0.16 }
      },
      timeScale: {
        borderColor: '#2a2a2a',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 3,
        barSpacing: 7,
        tickMarkFormatter: (time: Time, type: TickMarkType): string => {
          const p = tzPartsFromSec(Number(time), tz)
          const n = (v: number): string => String(v).padStart(2, '0')
          if (type === TickMarkType.Year) return String(p.year)
          if (type === TickMarkType.Month) return `${p.year}-${n(p.month)}`
          if (type === TickMarkType.DayOfMonth) return `${n(p.month)}-${n(p.day)}`
          if (type === TickMarkType.TimeWithSeconds) {
            return `${n(p.hour)}:${n(p.minute)}:${n(p.second)}`
          }
          return `${n(p.hour)}:${n(p.minute)}`
        }
      },
      crosshair: { mode: 0 },
      localization: {
        locale: 'zh-CN',
        timeFormatter: (time: Time): string => {
          const p = tzPartsFromSec(Number(time), tz)
          const n = (v: number): string => String(v).padStart(2, '0')
          return `${p.year}-${n(p.month)}-${n(p.day)} ${n(p.hour)}:${n(p.minute)}`
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
      // 截图是给复盘看的：不要「最新价」那条灰线，避免和开平仓线混在一起
      priceLineVisible: false,
      lastValueVisible: false,
      priceFormat: { type: 'price', precision: digits, minMove: Math.pow(10, -digits) }
    })

    // 开→平的虚线连线：不参与价格自动缩放，位置由开平仓价决定
    const connector = chart.addSeries(LineSeries, {
      color: '#38bdf8',
      lineWidth: 1,
      lineStyle: LineStyle.Dotted,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
      autoscaleInfoProvider: () => null
    })

    chartRef.current = chart
    seriesRef.current = series
    connectorRef.current = connector
    markersRef.current = createSeriesMarkers(series, [])
    setChartSeq((n) => n + 1)

    return () => {
      markersRef.current?.detach()
      markersRef.current = null
      priceLinesRef.current = []
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
      connectorRef.current = null
    }
  }, [digits, tz])

  // ---------- 读数据集：确认原始周期 ----------
  useEffect(() => {
    let alive = true
    void window.api
      .getDataset(datasetId)
      .then((ds: any) => {
        if (!alive) return
        if (!ds) {
          setError('no-data')
          setLoading(false)
          return
        }
        const base = isChartTimeframe(ds.timeframe) ? ds.timeframe : 'M1'
        setBaseTf(base)
        // 数据集本身不是 M1 时没有聚合的意义，直接锁成原始周期
        if (base !== 'M1') setTf(base)
      })
      .catch(() => {
        if (!alive) return
        setError('load-failed')
        setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [datasetId])

  // ---------- 读这一笔前后的 K 线 ----------
  useEffect(() => {
    if (!baseTf) return
    let alive = true
    setLoading(true)
    setError(null)
    void (async () => {
      try {
        // 和自动截图共用同一段取数逻辑：开仓前至少 150 根，平仓后 60 根
        const list = await loadTradeBars(
          datasetId,
          trade.entryTime,
          trade.exitTime,
          tf,
          baseTf
        )
        if (!alive) return
        setBars(list)
        setError(list.length === 0 ? 'no-data' : null)
      } catch {
        if (alive) setError('load-failed')
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [datasetId, tf, baseTf, trade.entryTime, trade.exitTime])

  // ---------- 数据到位后画 K 线、开平仓线、标记、连线 ----------
  useEffect(() => {
    const chart = chartRef.current
    const series = seriesRef.current
    const connector = connectorRef.current
    if (!chartSeq || !chart || !series || !connector) return

    series.setData(
      bars.map((b) => ({
        time: b.time as UTCTimestamp,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close
      }))
    )

    for (const line of priceLinesRef.current) {
      try {
        series.removePriceLine(line)
      } catch {
        // 图已经换过数据，线可能不在了
      }
    }
    priceLinesRef.current = []

    if (bars.length === 0) {
      markersRef.current?.setMarkers([])
      connector.setData([])
      return
    }

    const entryT = snapBarTime(bars, trade.entryTime)
    const exitT = snapBarTime(bars, Math.max(trade.exitTime, trade.entryTime))
    const entryColor = trade.side === 'buy' ? '#38bdf8' : '#f97316'

    priceLinesRef.current.push(
      series.createPriceLine({
        price: trade.entryPrice,
        color: entryColor,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: t('tradeShot.entry')
      }),
      series.createPriceLine({
        price: trade.exitPrice,
        color: '#eab308',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: t('tradeShot.exit')
      })
    )

    const markers: SeriesMarker<Time>[] = []
    if (entryT != null) {
      markers.push({
        time: entryT as UTCTimestamp,
        position: trade.side === 'buy' ? 'belowBar' : 'aboveBar',
        color: entryColor,
        shape: trade.side === 'buy' ? 'arrowUp' : 'arrowDown',
        text: t('tradeShot.entry')
      })
    }
    if (exitT != null && exitT !== entryT) {
      markers.push({
        time: exitT as UTCTimestamp,
        position: trade.side === 'buy' ? 'aboveBar' : 'belowBar',
        color: '#eab308',
        shape: 'circle',
        text: t('tradeShot.exit')
      })
    }
    markersRef.current?.setMarkers(
      [...markers].sort((a, b) => Number(a.time) - Number(b.time))
    )

    if (entryT != null && exitT != null && exitT > entryT) {
      connector.applyOptions({ color: entryColor })
      connector.setData([
        { time: entryT as UTCTimestamp, value: trade.entryPrice },
        { time: exitT as UTCTimestamp, value: trade.exitPrice }
      ])
    } else {
      connector.setData([])
    }

    chart.timeScale().fitContent()
  }, [bars, chartSeq, trade, digits, t])

  /** 重置视野：把整段重新铺满 */
  const resetView = useCallback(() => {
    chartRef.current?.timeScale().fitContent()
  }, [])

  /**
   * 截图：图表画布 + 顶部信息条。
   *
   * 合成逻辑和自动截图共用（见 ./trade-shot），保证手动 / 自动两个入口
   * 出来的图片一模一样。
   */
  const capture = useCallback(async (): Promise<void> => {
    const chart = chartRef.current
    const host = hostRef.current
    if (!chart || saving) return
    setSaving(true)
    setSaveError(null)
    try {
      const shot = chart.takeScreenshot()
      if (!shot || shot.width === 0 || shot.height === 0) throw new Error('empty-shot')
      const image = composeTradeShot(shot, {
        trade,
        timeframe: tf,
        tz,
        theme,
        sideText,
        cssWidth: host?.clientWidth || shot.width
      })
      if (!image.dataUrl) throw new Error('no-canvas')
      const ok = await onCapture(image)
      if (!ok) setSaveError(t('tradeShot.failed'))
    } catch {
      setSaveError(t('tradeShot.failed'))
    } finally {
      setSaving(false)
    }
  }, [saving, theme, trade, sideText, tf, tz, onCapture, t])

  const pill = (id: string): React.JSX.Element => {
    const on = id === tf
    const disabled = !availableTfs.includes(id)
    return (
      <button
        key={id}
        onClick={() => !disabled && setTf(id)}
        disabled={disabled}
        className={clsx(
          'h-6 rounded px-1.5 font-mono text-[11px] transition-colors',
          on
            ? 'bg-[var(--c-accent)] text-white'
            : disabled
              ? 'cursor-not-allowed text-[var(--text-faint)] opacity-40'
              : 'text-[var(--text-secondary)] hover:bg-[var(--surface-3)] hover:text-[var(--text-primary)]'
        )}
      >
        {timeframeCode(id)}
      </button>
    )
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="flex h-full max-h-[860px] w-full max-w-[1120px] flex-col overflow-hidden rounded-xl border border-[var(--border-strong)] bg-[var(--surface-1)] shadow-2xl">
        <div className="flex shrink-0 items-start gap-3 border-b border-[var(--border-subtle)] px-4 py-2.5">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Camera size={14} className="text-[var(--c-accent)]" />
              <span className="text-[13.5px] font-semibold text-[var(--text-primary)]">
                {t('tradeShot.title')}
              </span>
              <span className="rounded bg-[var(--surface-3)] px-1.5 py-[1px] text-[10.5px] text-[var(--text-muted)]">
                {trade.symbol}
              </span>
            </div>
            <p className="mt-0.5 truncate font-mono text-[10.5px] text-[var(--text-muted)]">
              {sideText} · {trade.lot.toFixed(2)} {t('report.col.lots')} ·{' '}
              {formatPrice(trade.entryPrice, digits)} → {formatPrice(trade.exitPrice, digits)} ·{' '}
              <span style={{ color: pnlColor }}>{formatSigned(trade.pnl)}</span> ·{' '}
              {stampTime(trade.entryTime, tz)} → {stampTime(trade.exitTime, tz)}
            </p>
          </div>
          <button
            onClick={onClose}
            className="ml-auto rounded p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-3)] hover:text-[var(--text-primary)]"
          >
            <X size={15} />
          </button>
        </div>

        <div className="relative min-h-0 flex-1 bg-[#0b0b0b]">
          <div ref={hostRef} className="h-full w-full" />
          {loading && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 bg-black/40 text-[12px] text-[var(--text-muted)]">
              <Loader2 size={14} className="animate-spin" />
              {t('tradeShot.loading')}
            </div>
          )}
          {!loading && error && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[12px] text-[var(--text-faint)]">
              {error === 'no-data' ? t('tradeShot.noData') : t('tradeShot.loadFailed')}
            </div>
          )}
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-[var(--border-subtle)] px-4 py-2">
          <div className="flex items-center gap-0.5 rounded-md border border-[var(--border-subtle)] px-1 py-0.5">
            {ALL_TIMEFRAMES.map(pill)}
          </div>
          <button
            onClick={resetView}
            title={t('tradeShot.reset')}
            className="flex h-6 items-center gap-1 rounded px-1.5 text-[11px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-3)] hover:text-[var(--text-primary)]"
          >
            <RotateCcw size={12} />
            {t('tradeShot.reset')}
          </button>
          <span className="text-[10.5px] text-[var(--text-faint)]">{t('tradeShot.hint')}</span>

          <div className="ml-auto flex items-center gap-2">
            {saveError && <span className="text-[10.5px] text-[var(--c-pos)]">{saveError}</span>}
            <button
              onClick={onClose}
              className="rounded-md border border-[var(--border-subtle)] px-2.5 py-1 text-[12px] text-[var(--text-secondary)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
            >
              {t('tradeEdit.cancel')}
            </button>
            <button
              onClick={() => void capture()}
              disabled={saving || loading || !!error}
              className="flex items-center gap-1.5 rounded-md border border-[var(--c-accent)] bg-[var(--c-accent-tint)] px-3 py-1 text-[12px] font-medium text-[var(--c-accent)] transition-colors hover:bg-[var(--c-accent)] hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? <Loader2 size={12} className="animate-spin" /> : <Camera size={12} />}
              {saving ? t('tradeShot.capturing') : t('tradeShot.capture')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
