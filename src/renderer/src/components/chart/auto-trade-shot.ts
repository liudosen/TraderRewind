// ============================================================
// TraderRewind — 订单结束后的自动截图
//
// 用户可以在设置里选最多 5 个周期；一笔订单完全平仓后，这里按每个周期
// 离屏建一张 K 线图（和手动「添加截图」同一套取数 / 画线 / 合成逻辑），
// 截成 PNG 存进这笔交易的截图里。
//
// 截图是异步的，进队列串行做，不阻塞回放推进；任何一张失败都不影响订单本身。
// ============================================================

import {
  CandlestickSeries,
  LineSeries,
  LineStyle,
  TickMarkType,
  createChart,
  createSeriesMarkers,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp
} from 'lightweight-charts'
import { isChartTimeframe } from '@shared/utils/timeframe'
import { DEFAULT_CHART_THEME, type ChartTheme } from '@shared/types/chart-theme'
import { tzPartsFromSec } from '@shared/types/timezone'
import { useChartThemeStore } from '../../stores/chart-theme-store'
import { translate, useLocaleStore } from '../../i18n'
import {
  composeTradeShot,
  loadTradeBars,
  snapBarTime,
  TRADE_SHOT_CSS_HEIGHT,
  TRADE_SHOT_CSS_WIDTH
} from './trade-shot'
import type { ClosedTrade } from '../../stores/training-store'

export interface AutoTradeShotOptions {
  sessionId: number
  datasetId: number
  /** 会话时区；没有就跟随全局 */
  tz: string
  timeframes: string[]
}

const queue: Array<() => Promise<void>> = []
let running = false

/** 把一笔已平仓订单丢进自动截图队列 */
export function enqueueAutoTradeShots(trade: ClosedTrade, opts: AutoTradeShotOptions): void {
  if (!opts.timeframes || opts.timeframes.length === 0) return
  queue.push(() => captureTrade(trade, opts))
  void drain()
}

async function drain(): Promise<void> {
  if (running) return
  running = true
  try {
    while (queue.length > 0) {
      const job = queue.shift()
      if (!job) continue
      try {
        await job()
      } catch (e) {
        console.warn('[auto-shot] 截图失败', e)
      }
    }
  } finally {
    running = false
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 等两帧 + 一小段延时，让 lightweight-charts 把 canvas 画完 */
function waitForPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 60)))
  })
}

async function captureTrade(trade: ClosedTrade, opts: AutoTradeShotOptions): Promise<void> {
  const locale = useLocaleStore.getState().locale
  const t = (key: Parameters<typeof translate>[1]): string => translate(locale, key)
  const sideText =
    trade.side === 'buy' ? t('report.side.long') : t('report.side.short')
  const theme = useChartThemeStore.getState().theme ?? DEFAULT_CHART_THEME

  let baseTf = 'M1'
  try {
    const ds: any = await window.api.getDataset(opts.datasetId)
    if (ds && isChartTimeframe(ds.timeframe)) baseTf = ds.timeframe
  } catch {
    return
  }

  const timeframes = [...new Set(opts.timeframes)].filter((tf) => isChartTimeframe(tf))
  for (const tf of timeframes) {
    // 数据集本身不是 M1 时没法往上聚合，只截原始周期
    if (baseTf !== 'M1' && tf !== baseTf) continue
    try {
      await captureOne(trade, tf, baseTf, sideText, theme, t, opts)
    } catch (e) {
      console.warn(`[auto-shot] ${tf} 截图失败`, e)
    }
  }
}

async function captureOne(
  trade: ClosedTrade,
  tf: string,
  baseTf: string,
  sideText: string,
  theme: ChartTheme,
  t: (key: Parameters<typeof translate>[1]) => string,
  opts: AutoTradeShotOptions
): Promise<void> {
  const bars = await loadTradeBars(opts.datasetId, trade.entryTime, trade.exitTime, tf, baseTf)
  if (bars.length === 0) return

  const host = document.createElement('div')
  host.style.cssText = `position:fixed;left:-${TRADE_SHOT_CSS_WIDTH + 200}px;top:0;width:${TRADE_SHOT_CSS_WIDTH}px;height:${TRADE_SHOT_CSS_HEIGHT}px;pointer-events:none;`
  document.body.appendChild(host)

  const chart = createChart(host, {
    autoSize: true,
    layout: {
      background: { color: theme.background },
      textColor: theme.textColor,
      fontSize: 11,
      fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif'
    },
    grid: {
      vertLines: { color: theme.gridColor, visible: theme.gridVisible },
      horzLines: { color: theme.gridColor, visible: theme.gridVisible }
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
        const p = tzPartsFromSec(Number(time), opts.tz)
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
        const p = tzPartsFromSec(Number(time), opts.tz)
        const n = (v: number): string => String(v).padStart(2, '0')
        return `${p.year}-${n(p.month)}-${n(p.day)} ${n(p.hour)}:${n(p.minute)}`
      }
    }
  })

  const series = chart.addSeries(CandlestickSeries, {
    upColor: theme.upColor,
    downColor: theme.downColor,
    borderUpColor: theme.upColor,
    borderDownColor: theme.downColor,
    wickUpColor: theme.upColor,
    wickDownColor: theme.downColor,
    borderVisible: theme.showBorder,
    wickVisible: theme.showWick,
    priceLineVisible: false,
    lastValueVisible: false,
    priceFormat: { type: 'price', precision: trade.digits, minMove: Math.pow(10, -trade.digits) }
  })
  const connector = chart.addSeries(LineSeries, {
    color: '#38bdf8',
    lineWidth: 1,
    lineStyle: LineStyle.Dotted,
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false,
    autoscaleInfoProvider: () => null
  })
  const markers: ISeriesMarkersPluginApi<Time> = createSeriesMarkers(series, [])

  try {
    series.setData(
      bars.map((b) => ({
        time: b.time as UTCTimestamp,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close
      }))
    )

    const entryT = snapBarTime(bars, trade.entryTime)
    const exitT = snapBarTime(bars, Math.max(trade.exitTime, trade.entryTime))
    const entryColor = trade.side === 'buy' ? '#38bdf8' : '#f97316'

    series.createPriceLine({
      price: trade.entryPrice,
      color: entryColor,
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: t('tradeShot.entry')
    })
    series.createPriceLine({
      price: trade.exitPrice,
      color: '#eab308',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: t('tradeShot.exit')
    })
    const markerList: SeriesMarker<Time>[] = []
    if (entryT != null) {
      markerList.push({
        time: entryT as UTCTimestamp,
        position: trade.side === 'buy' ? 'belowBar' : 'aboveBar',
        color: entryColor,
        shape: trade.side === 'buy' ? 'arrowUp' : 'arrowDown',
        text: t('tradeShot.entry')
      })
    }
    if (exitT != null && exitT !== entryT) {
      markerList.push({
        time: exitT as UTCTimestamp,
        position: trade.side === 'buy' ? 'aboveBar' : 'belowBar',
        color: '#eab308',
        shape: 'circle',
        text: t('tradeShot.exit')
      })
    }
    markers.setMarkers([...markerList].sort((a, b) => Number(a.time) - Number(b.time)))

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
    await waitForPaint()

    const shot = chart.takeScreenshot()
    if (!shot || shot.width === 0 || shot.height === 0) return
    const image = composeTradeShot(shot, {
      trade,
      timeframe: tf,
      tz: opts.tz,
      theme,
      sideText,
      cssWidth: TRADE_SHOT_CSS_WIDTH
    })
    if (!image.dataUrl) return
    await saveShot(opts.sessionId, trade.id, tf, image)
  } finally {
    try {
      markers.detach()
    } catch {
      // 图表已经销毁时忽略
    }
    chart.remove()
    host.remove()
  }
}

/**
 * 截图用 `closed_trades` 里那一行也会校验交易是否存在。
 * 平仓时这行是异步落库的，可能比截图队列还慢；遇 `no-trade` 就等一会儿重试。
 */
async function saveShot(
  sessionId: number,
  tradeId: string,
  timeframe: string,
  image: { dataUrl: string; width: number; height: number }
): Promise<void> {
  for (let attempt = 0; attempt < 15; attempt++) {
    const res: any = await window.api.addTradeScreenshot({
      sessionId,
      tradeId,
      dataUrl: image.dataUrl,
      width: image.width,
      height: image.height,
      timeframe
    })
    if (res?.ok) return
    if (res?.error !== 'no-trade') return
    await sleep(200)
  }
}
