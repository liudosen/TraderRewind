// ============================================================
// TraderRewind — 加密市场 K 线下载（OKX / Binance）
//
// 和 Dukascopy 那套「抓小时 tick 文件再本地聚合」完全不同：这两个交易所
// 直接给 K 线，一次一页，所以这里的下载单元是「一页」而不是「一小时」。
// 共同点都收在 CandleAdapter 里，作业逻辑（并发、测速、进度、落库）只写一遍。
//
// 两家接口的翻页方向是反的，这点最容易写错：
//   OKX      after=ts  → 返回**更旧**的数据（一页内新的在前），只能从后往前翻
//   Binance  startTime → 返回**更新**的数据（一页内旧的在前），从前往后翻
// 所以适配器不暴露 URL，而是暴露「给定游标，拿下一页和下一个游标」。
// ============================================================

import type {
  BarTimeframe,
  DataSourceId,
  DownloadPhase,
  DownloadRequest,
  DownloadSnapshot,
  DownloadTaskProgress,
  InstrumentInfo
} from '@shared/types/download'
import { getInstrument, TIMEFRAME_SECONDS } from '@shared/constants/catalog'
import { fetchBuffer, describeProxyProblem } from '../utils/http'
import { SpeedMeter } from '../utils/speed-meter'
import { saveDownloadedBars } from '../db/dataset-repo'
import { sharedCtraderClient } from './ctrader-mcp'

/** 一根 1 分钟 K 线（时间单位为秒，与库里一致） */
interface Candle {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

/** 一页请求的结果 */
interface PageResult {
  bars: Candle[]
  /** 下一页的游标；null = 没有更多了 */
  nextCursor: number | null
}

interface CandleAdapter {
  id: Extract<DataSourceId, 'okx' | 'binance' | 'ctrader'>
  /** 单页最多多少根 */
  pageSize: number
  /** 建议并发（交易所都有速率限制，别拿 tick 那套 64 去冲） */
  maxConcurrency: number
  /**
   * 翻页方向，决定游标的初值：
   *  · backward —— 从区间右端（toMs）向左翻，游标是「本页上界」
   *  · forward  —— 从区间左端（fromMs）向右翻
   * 早期只靠 `id === 'okx'` 硬判，加了 cTrader 之后两处都是 backward，
   * 再靠 id 判断就站不住了，所以提成显式字段。
   */
  direction: 'backward' | 'forward'
  /** 落库时的市场标识 */
  market: string
  /** 请求某一页：cursor 的含义由适配器自己解释 */
  page: (
    symbol: string,
    cursor: number,
    fromMs: number,
    toMs: number,
    timeframe: BarTimeframe,
    proxy?: string,
    signal?: AbortSignal
  ) => Promise<PageResult>
  /** 解析响应；返回错误文案表示这一页失败 */
  parseError: (json: any) => string | null
  /**
   * 可选：能否把区间预先切成**互不依赖**的窗口。
   *
   * 交易所接口靠游标翻页（下一页的区间取决于上一页返回的内容），没法预切，
   * 所以只能一条链串行翻。cTrader 的 get_trendbars 接收绝对 from/to，
   * 各页彼此独立，因此可以按固定宽度切开并行拉 —— 实测 16 路能把吞吐
   * 从 2.5 页/秒提到 37 页/秒（服务端没有限流，32 路以后才饱和）。
   */
  planWindows?: (fromMs: number, toMs: number, timeframe: BarTimeframe) => { fromMs: number; toMs: number }[]
}

const MINUTE = 60_000

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : NaN
}

// ------------------------------------------------------------
// OKX：GET /api/v5/market/history-candles
//   data: [[ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm], ...]  新的在前
//   after=ts → 返回比 ts 更旧的记录
// ------------------------------------------------------------
const okxAdapter: CandleAdapter = {
  id: 'okx',
  pageSize: 100,
  maxConcurrency: 6,
  direction: 'backward',
  market: 'crypto',
  parseError: (json) => {
    if (!json || json.code === undefined) return '返回格式异常'
    return json.code === '0' ? null : `${json.code} ${json.msg ?? ''}`.trim()
  },
  page: async (symbol, cursor, fromMs, _toMs, _timeframe, proxy, signal) => {
    const url =
      `https://www.okx.com/api/v5/market/history-candles` +
      `?instId=${encodeURIComponent(symbol)}&bar=1m&limit=100&after=${cursor}`
    const buf = await fetchBuffer(url, { proxy, signal, timeoutMs: 20000, retries: 2 })
    const json = JSON.parse(buf.toString('utf8'))
    const err = okxAdapter.parseError(json)
    if (err) throw new Error(err)

    const rows: any[] = Array.isArray(json.data) ? json.data : []
    if (rows.length === 0) return { bars: [], nextCursor: null }

    // 新的在前 → 反成升序；顺便丢掉早于区间起点的（已经用不上了）
    const bars: Candle[] = []
    for (const r of rows) {
      const t = Math.floor(num(r[0]) / 1000)
      if (!Number.isFinite(t)) continue
      if (t * 1000 < fromMs) continue
      bars.push({
        time: t,
        open: num(r[1]),
        high: num(r[2]),
        low: num(r[3]),
        close: num(r[4]),
        volume: num(r[5])
      })
    }
    bars.sort((a, b) => a.time - b.time)

    // 本页最早的一根再往前一毫秒，就是下一页的游标
    const oldest = Math.min(...rows.map((r) => num(r[0])).filter(Number.isFinite))
    const nextCursor = Number.isFinite(oldest) && oldest > fromMs ? oldest : null
    return { bars, nextCursor }
  }
}

// ------------------------------------------------------------
// Binance：GET /api/v3/klines
//   [openTime, o, h, l, c, volume, closeTime, ...]  旧的在前
//   startTime → 从该时刻往后取
// ------------------------------------------------------------
const binanceAdapter: CandleAdapter = {
  id: 'binance',
  pageSize: 1000,
  maxConcurrency: 4,
  direction: 'forward',
  market: 'crypto',
  parseError: (json) => {
    if (Array.isArray(json)) return null
    return json?.msg ?? '返回格式异常'
  },
  page: async (symbol, cursor, _fromMs, toMs, _timeframe, proxy, signal) => {
    const url =
      `https://data-api.binance.vision/api/v3/klines` +
      `?symbol=${encodeURIComponent(symbol)}&interval=1m&limit=1000` +
      `&startTime=${cursor}&endTime=${toMs}`
    const buf = await fetchBuffer(url, { proxy, signal, timeoutMs: 25000, retries: 2 })
    const json = JSON.parse(buf.toString('utf8'))
    const err = binanceAdapter.parseError(json)
    if (err) throw new Error(err)

    const rows: any[] = Array.isArray(json) ? json : []
    if (rows.length === 0) return { bars: [], nextCursor: null }

    const bars: Candle[] = []
    for (const r of rows) {
      const t = Math.floor(num(r[0]) / 1000)
      if (!Number.isFinite(t)) continue
      bars.push({
        time: t,
        open: num(r[1]),
        high: num(r[2]),
        low: num(r[3]),
        close: num(r[4]),
        volume: num(r[5])
      })
    }
    bars.sort((a, b) => a.time - b.time)

    const last = bars.length > 0 ? bars[bars.length - 1].time : null
    const nextCursor = last != null && (last + 60) * 1000 <= toMs ? (last + 60) * 1000 : null
    return { bars, nextCursor }
  }
}

// ------------------------------------------------------------
// cTrader：走桌面端内置 MCP 服务的 get_trendbars
//
// 和其它两家最大的不同：
//  1) 目标在本机 127.0.0.1，绝不能套代理（套上就被转发到代理网关 502）
//  2) from/to 是绝对时间区间，各页互不依赖 → 可以预切窗口并行
//  3) 服务端硬上限 1000 根/次，且返回的是「靠近 to 的最后一页」，故仍是 backward
//  4) 数据来自用户自己的经纪商（IC Markets），forex/metal，不是 crypto
//  5) 客户端全局单例：服务端只认一个 session，各自 new 会互相踢掉
// ------------------------------------------------------------
const ctraderAdapter: CandleAdapter = {
  id: 'ctrader',
  pageSize: 1000,
  // 压测结论：8~16 路线性扩展，32 路以后吞吐饱和但不出错，取 8 求稳
  maxConcurrency: 8,
  direction: 'backward',
  market: 'fx',
  parseError: (json) => json?.error?.message ?? null,

  /**
   * 每个窗口正好装得下 pageSize 根（窗口宽 = pageSize × 周期秒数），
   * 这样单窗口内不会被 1000 根上限截断，也就不会漏数据。
   * 相邻窗口在边界上可能重复一根，落库时靠 time 去重，无害。
   */
  planWindows: (fromMs, toMs, timeframe) => {
    const tfSec = TIMEFRAME_SECONDS[timeframe] || 60
    const width = 1000 * tfSec * 1000
    const out: { fromMs: number; toMs: number }[] = []
    for (let end = toMs; end > fromMs; end -= width) {
      out.push({ fromMs: Math.max(fromMs, end - width), toMs: end })
    }
    return out
  },

  page: async (symbol, cursor, fromMs, _toMs, timeframe, _proxy, signal) => {
    if (signal?.aborted) throw new Error('aborted')
    const client = sharedCtraderClient()
    // cursor 在这里表示「本窗口的时间上界」
    return client.getTrendbarsPage(symbol, timeframe, fromMs, cursor, 1000)
  }
}

const ADAPTERS: Record<string, CandleAdapter> = {
  okx: okxAdapter,
  binance: binanceAdapter,
  ctrader: ctraderAdapter
}

/** 该数据源是不是走这套 K 线接口 */
export function isCandleSource(id: string): boolean {
  return id in ADAPTERS
}

interface SymbolState {
  info: InstrumentInfo
  phase: DownloadPhase
  done: number
  total: number
  bars: Map<number, Candle>
  message: string
  error?: string
  datasetId?: number
  startedAt: number
  endedAt?: number
  meter: SpeedMeter
  receivedBytes: number
  failedPages: number
  lastError?: string
}

interface JobOptions {
  onSnapshot?: (snapshot: DownloadSnapshot) => void
  onFinished?: (snapshot: DownloadSnapshot) => void
}

/**
 * 加密 K 线下载作业。
 *
 * 分页不是事先切好的（下一段游标依赖上一段返回的内容），所以调度方式是
 * 「每个品种一条自己的翻页链」，链内部串行、品种之间并行 —— 而不是像
 * Dukascopy 那样把所有小时文件摊平成一个池子。交易所对同一交易对本来
 * 也是限速的，串行翻页反而更稳。
 */
export class CandleJob {
  readonly jobId: string
  private readonly request: DownloadRequest
  private readonly adapter: CandleAdapter
  private readonly options: JobOptions
  private readonly controller = new AbortController()
  private readonly states = new Map<string, SymbolState>()
  private tickTimer: NodeJS.Timeout | null = null
  private finished = false
  private fromMs = 0
  private toMs = 0
  private unitCount = 0

  constructor(request: DownloadRequest, options: JobOptions = {}) {
    this.request = request
    this.options = options
    this.jobId = `candle-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const adapter = ADAPTERS[request.source]
    if (!adapter) throw new Error(`不支持的数据源：${request.source}`)
    this.adapter = adapter
  }

  cancel(): void {
    if (this.finished) return
    this.controller.abort()
    for (const state of this.states.values()) {
      if (state.phase !== 'done' && state.phase !== 'error') {
        state.phase = 'cancelled'
        state.message = '已取消'
        state.endedAt = Date.now()
      }
    }
    this.emit()
  }

  prepare(): { ok: boolean; unitCount: number; error?: string } {
    const from = parseDayStart(this.request.dateFrom)
    const to = parseDayEnd(this.request.dateTo)
    if (from == null) return { ok: false, unitCount: 0, error: '起始日期格式无效（应为 YYYY-MM-DD）' }
    if (to == null) return { ok: false, unitCount: 0, error: '结束日期格式无效（应为 YYYY-MM-DD）' }
    if (from >= to) return { ok: false, unitCount: 0, error: '起始日期不能晚于结束日期' }
    if (!TIMEFRAME_SECONDS[this.request.timeframe]) {
      return { ok: false, unitCount: 0, error: '不支持的周期' }
    }
    if (this.request.symbols.length === 0) {
      return { ok: false, unitCount: 0, error: '请至少选择一个品种' }
    }
    // 代理地址先校验再开工，别让错误地址拖到几千个文件全失败才暴露
    const proxyErr = describeProxyProblem(this.request.proxy)
    if (proxyErr) return { ok: false, unitCount: 0, error: proxyErr }

    this.fromMs = from
    this.toMs = to
    this.states.clear()

    // 页数估法：一段时间跨度内每分钟一根，按单页容量切
    const minutes = Math.max(1, Math.ceil((to - from) / MINUTE))
    const pagesPerSymbol = Math.max(1, Math.ceil(minutes / this.adapter.pageSize))
    const now = Date.now()

    for (const symbol of this.request.symbols) {
      const info = getInstrument(symbol)
      if (!info) return { ok: false, unitCount: 0, error: `未知品种：${symbol}` }
      this.states.set(symbol, {
        info,
        phase: 'queued',
        done: 0,
        total: pagesPerSymbol,
        bars: new Map(),
        message: '排队中',
        startedAt: now,
        meter: new SpeedMeter(),
        receivedBytes: 0,
        failedPages: 0
      })
    }

    this.unitCount = pagesPerSymbol * this.request.symbols.length
    return { ok: true, unitCount: this.unitCount }
  }

  async run(): Promise<void> {
    this.tickTimer = setInterval(() => this.emit(), 220)
    const concurrency = Math.max(
      1,
      Math.min(this.adapter.maxConcurrency, Math.floor(Number(this.request.concurrency) || 1))
    )

    try {
      const symbols = [...this.states.keys()]
      let cursorIdx = 0
      const workers = Array.from({ length: Math.min(concurrency, symbols.length) }, async () => {
        while (cursorIdx < symbols.length) {
          const symbol = symbols[cursorIdx++]
          const state = this.states.get(symbol)
          if (!state) continue
          await this.downloadSymbol(state)
        }
      })
      await Promise.all(workers)

      if (this.controller.signal.aborted) {
        this.emit()
        return
      }

      for (const state of this.states.values()) {
        if (state.phase === 'cancelled') continue
        await this.saveSymbol(state)
      }
    } catch (e: any) {
      for (const state of this.states.values()) {
        if (state.phase !== 'done') {
          state.phase = 'error'
          state.error = e?.message ?? String(e)
          state.message = `下载失败：${state.error}`
        }
      }
    } finally {
      this.finished = true
      if (this.tickTimer) clearInterval(this.tickTimer)
      this.emit()
      this.options.onFinished?.(this.snapshot())
    }
  }

  private async downloadSymbol(state: SymbolState): Promise<void> {
    const signal = this.controller.signal

    // 能预切窗口的源（cTrader）走并行分支，把来回串行的 RTT 摊掉
    const windows = this.adapter.planWindows?.(this.fromMs, this.toMs, this.request.timeframe)
    if (windows && windows.length > 0) {
      await this.downloadSymbolWindows(state, windows)
      return
    }

    state.phase = 'downloading'
    state.message = '下载中…'
    this.emit()

    let cursor: number = this.adapter.direction === 'backward' ? this.toMs + 1 : this.fromMs
    let guard = 0

    while (!signal.aborted) {
      // 上限保护：一页都没有新数据时必须停，否则游标不动会打成死循环
      if (guard++ > state.total + 24) break

      let result: PageResult
      try {
        result = await this.adapter.page(
          state.info.symbol,
          cursor,
          this.fromMs,
          this.toMs,
          this.request.timeframe,
          this.request.proxy,
          signal
        )
      } catch (e: any) {
        if (signal.aborted) return
        state.failedPages += 1
        state.lastError = e?.message ?? String(e)
        // 连错 3 页就放弃这个品种，别在那儿无限重试
        if (state.failedPages >= 3) {
          state.phase = 'error'
          state.error = state.lastError
          state.message = `连续失败：${state.lastError}`
          state.endedAt = Date.now()
          this.emit()
          return
        }
        continue
      }

      if (result.bars.length === 0 && result.nextCursor == null) break

      for (const bar of result.bars) {
        state.bars.set(bar.time, bar)
      }
      state.receivedBytes += result.bars.length * 120
      state.meter.add(result.bars.length * 120)
      state.done = Math.min(state.total, state.done + 1)
      state.message = `已取 ${state.bars.size} 根`
      this.emit()

      if (result.nextCursor == null) break
      if (result.nextCursor === cursor) break
      cursor = result.nextCursor
    }

    state.phase = 'aggregating'
    state.endedAt = Date.now()
    this.emit()
  }

  /**
   * 预切窗口的并行下载。
   *
   * 和游标翻页不同：这里每一段的区间事先就定死了，彼此没有依赖，
   * 可以多路同时拉。cTrader 压测结果是 8~16 路线性扩展、零失败，
   * 32 路以后吞吐饱和（服务端有内部串行瓶颈），所以上限取 8。
   */
  private async downloadSymbolWindows(
    state: SymbolState,
    windows: { fromMs: number; toMs: number }[]
  ): Promise<void> {
    const signal = this.controller.signal
    state.phase = 'downloading'
    state.total = windows.length
    state.message = `并行下载 ${windows.length} 段…`
    this.emit()

    const requested = Math.floor(Number(this.request.concurrency) || 0)
    const conc = Math.max(
      1,
      Math.min(
        this.adapter.maxConcurrency,
        requested > 0 ? requested : this.adapter.maxConcurrency,
        windows.length
      )
    )

    let next = 0
    const workers = Array.from({ length: conc }, async () => {
      while (!signal.aborted) {
        const i = next++
        if (i >= windows.length) return
        const w = windows[i]

        let ok = false
        for (let attempt = 0; attempt < 3 && !ok && !signal.aborted; attempt++) {
          try {
            const r = await this.adapter.page(
              state.info.symbol,
              w.toMs,
              w.fromMs,
              w.toMs,
              this.request.timeframe,
              this.request.proxy,
              signal
            )
            for (const bar of r.bars) state.bars.set(bar.time, bar)
            state.receivedBytes += r.bars.length * 120
            state.meter.add(r.bars.length * 120)
            ok = true
          } catch (e: any) {
            if (signal.aborted) return
            state.lastError = e?.message ?? String(e)
            if (attempt === 2) state.failedPages += 1
          }
        }

        state.done += 1
        state.message = `已取 ${state.bars.size} 根（${state.done}/${windows.length} 段）`
        this.emit()
      }
    })
    await Promise.all(workers)

    state.phase = 'aggregating'
    state.endedAt = Date.now()
    this.emit()
  }

  private async saveSymbol(state: SymbolState): Promise<void> {
    const sorted = [...state.bars.values()].sort((a, b) => a.time - b.time)
    if (sorted.length === 0) {
      state.phase = 'error'
      state.error = state.lastError ?? '没有可用数据'
      state.message =
        state.failedPages > 0
          ? `请求全部失败：${state.lastError ?? '未知错误'}`
          : '该区间没有返回数据（检查代理、交易对代码，或换更近的日期）'
      state.endedAt = Date.now()
      this.emit()
      return
    }

    state.phase = 'saving'
    state.message = `写入数据库（${sorted.length} 根）…`
    this.emit()

    try {
      const datasetId = saveDownloadedBars({
        symbol: state.info.symbol,
        name: state.info.name,
        timeframe: this.request.timeframe,
        market: this.adapter.market,
        source: this.adapter.id,
        timezone: 'UTC',
        pointSize: Math.pow(10, -state.info.digits),
        bars: sorted.map((b) => ({
          time: b.time,
          open: b.open,
          high: b.high,
          low: b.low,
          close: b.close,
          volume: b.volume
        }))
      })
      state.datasetId = datasetId
      state.phase = 'done'
      state.message =
        `完成 · ${sorted.length} 根 K 线` +
        (state.failedPages > 0 ? ` · ${state.failedPages} 次请求失败` : '')
    } catch (e: any) {
      state.phase = 'error'
      state.error = e?.message ?? String(e)
      state.message = `保存失败：${state.error}`
    }
    state.endedAt = Date.now()
    this.emit()
  }

  private emit(): void {
    this.options.onSnapshot?.(this.snapshot())
  }

  snapshot(): DownloadSnapshot {
    const tasks: DownloadTaskProgress[] = []
    let totalSpeed = 0
    let activeTasks = 0
    let bytes = 0

    for (const [symbol, state] of this.states) {
      const speed = state.phase === 'downloading' ? state.meter.speed() : 0
      totalSpeed += speed
      if (state.phase === 'downloading') activeTasks += 1
      bytes += state.receivedBytes

      const elapsedMs = (state.endedAt ?? Date.now()) - state.startedAt
      const percent =
        state.phase === 'done'
          ? 100
          : state.total > 0
            ? Math.min(99, (state.done / state.total) * 100)
            : 0

      tasks.push({
        taskId: `${symbol}`,
        symbol,
        name: state.info.name,
        digits: state.info.digits,
        timeframe: 'M1' as BarTimeframe,
        phase: state.phase,
        done: state.done,
        total: state.total,
        percent,
        bytesDone: state.receivedBytes,
        bytesPerSec: speed,
        avgBytesPerSec: elapsedMs > 0 ? (state.receivedBytes / elapsedMs) * 1000 : 0,
        bars: state.bars.size,
        elapsedMs,
        etaMs:
          speed > 0 && state.total > state.done
            ? ((state.total - state.done) / Math.max(1, state.done)) * elapsedMs
            : null,
        activeWorkers: state.phase === 'downloading' ? 1 : 0,
        message: state.message,
        error: state.error,
        datasetId: state.datasetId
      })
    }

    return {
      jobId: this.jobId,
      tasks,
      totalBytesPerSec: totalSpeed,
      activeTasks,
      activeRequests: activeTasks,
      unitCount: this.unitCount || tasks.reduce((s, t) => s + t.total, 0)
    }
  }
}

/** YYYY-MM-DD → 当天 00:00（UTC）的毫秒时间戳 */
function parseDayStart(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((s ?? '').trim())
  if (!m) return null
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0)
}

/** YYYY-MM-DD → 次日 00:00（UTC）的前一毫秒，即「含当天」 */
function parseDayEnd(s: string): number | null {
  const start = parseDayStart(s)
  if (start == null) return null
  return start + 24 * 60 * MINUTE - 1
}
