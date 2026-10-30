// ============================================================
// TraderRewind — Dukascopy 数据下载服务
//
// 数据来源：Dukascopy 银行公开历史 tick 数据
//   http://datafeed.dukascopy.com/datafeed/{SYMBOL}/{YYYY}/{MM0}/{DD}/{HH}h_ticks.bi5
//   - MM0 为「0 索引」月份（00 = 1 月），这一点极易搞错
//   - 文件为 LZMA(alone) 压缩；解压后每条 tick 20 字节，全部大端序：
//       int32  timeOffsetMs   （相对该小时起点的毫秒偏移）
//       uint32 ask            （ask × 10^digits）
//       uint32 bid            （bid × 10^digits）
//       float32 askVolume
//       float32 bidVolume
//   - HTTP 可用（HTTPS 在部分网络下会被中断）
// ============================================================

import type {
  BarTimeframe,
  DownloadPhase,
  DownloadRequest,
  DownloadSnapshot,
  DownloadTaskProgress,
  InstrumentInfo
} from '@shared/types/download'
import { getInstrument, TIMEFRAME_SECONDS } from '@shared/constants/catalog'
import { setMaxListeners } from 'node:events'
import { fetchBuffer, FetchError } from '../utils/http'
import { mergeBars, type BarAccum } from './bi5'
import { Bi5DecodePool } from './decode-pool'
import { saveDownloadedBars } from '../db/dataset-repo'

const FEED_BASE = 'https://datafeed.dukascopy.com'

/** 并行请求数上限（过高会被 Dukascopy 限流返回 429） */
export const MAX_CONCURRENCY = 64
/** 默认并行请求数 */
export const DEFAULT_CONCURRENCY = 24

/** 并发下载单元：某品种某小时的 tick 文件 */
interface Unit {
  symbol: string
  year: number
  month0: number
  day: number
  hour: number
  /** 全局唯一序号，用于在途字节表 */
  seq: number
}

interface SymbolState {
  info: InstrumentInfo
  timeframe: BarTimeframe
  units: Unit[]
  done: number
  receivedBytes: number
  bars: Map<number, BarAccum>
  phase: DownloadPhase
  message: string
  error?: string
  datasetId?: number
  startedAt: number
  endedAt?: number
  avgUnitBytes: number
  meter: SpeedMeter
  /** 失败的文件数（网络错误 / 解压失败等） */
  failedUnits: number
  /** 最近一次失败原因 */
  lastError?: string
}

/** 滑动窗口测速器 */
export class SpeedMeter {
  private samples: { t: number; bytes: number }[] = []
  private total = 0
  private windowMs = 3000

  add(bytes: number): void {
    if (bytes <= 0) return
    this.total += bytes
    const now = Date.now()
    this.samples.push({ t: now, bytes: this.total })
    this.trim(now)
  }

  private trim(now: number): void {
    const cutoff = now - this.windowMs
    while (this.samples.length > 2 && this.samples[0].t < cutoff) {
      this.samples.shift()
    }
  }

  /** 瞬时速度（字节/秒） */
  speed(): number {
    const now = Date.now()
    this.trim(now)
    if (this.samples.length < 2) return 0
    const first = this.samples[0]
    const last = this.samples[this.samples.length - 1]
    const dt = (last.t - first.t) / 1000
    if (dt <= 0.05) return 0
    return Math.max(0, (last.bytes - first.bytes) / dt)
  }

  reset(): void {
    this.samples = []
    this.total = 0
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** 构造某品种某小时的 bi5 地址（注意 0 索引月份） */
export function buildDukascopyUrl(symbol: string, year: number, month0: number, day: number, hour: number): string {
  return `${FEED_BASE}/datafeed/${symbol}/${year}/${pad2(month0)}/${pad2(day)}/${pad2(hour)}h_ticks.bi5`
}

/** 解析日期字符串为 UTC 零点时间戳 */
function parseDateUtc(s: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim())
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
  const probe = new Date(Date.UTC(y, mo - 1, d))
  if (probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null
  return { y, m: mo, d }
}

/**
 * 枚举需要下载的单元
 * 规则：周一至周五全天 24 小时；周日仅 21-23 点（外汇周开盘）；周六跳过
 */
function enumerateUnits(symbol: string, from: { y: number; m: number; d: number }, to: { y: number; m: number; d: number }): Omit<Unit, 'seq'>[] {
  const units: Omit<Unit, 'seq'>[] = []
  const start = Date.UTC(from.y, from.m - 1, from.d)
  const end = Date.UTC(to.y, to.m - 1, to.d)
  const DAY = 86400_000

  for (let ts = start; ts <= end; ts += DAY) {
    const date = new Date(ts)
    const year = date.getUTCFullYear()
    const month0 = date.getUTCMonth()
    const day = date.getUTCDate()
    const dow = date.getUTCDay()

    if (dow === 6) continue // 周六休市
    if (dow === 0) {
      // 周日：仅开盘后的几个小时
      for (let hour = 21; hour < 24; hour++) {
        units.push({ symbol, year, month0, day, hour })
      }
      continue
    }
    for (let hour = 0; hour < 24; hour++) {
      units.push({ symbol, year, month0, day, hour })
    }
  }
  return units
}

export interface DukascopyJobOptions {
  /** 每次快照都会调用，频率约 4-5 次/秒 */
  onSnapshot: (snapshot: DownloadSnapshot) => void
  /** 任务完成（成功或失败）时调用 */
  onFinished?: (snapshot: DownloadSnapshot) => void
}

/**
 * 一次 Dukascopy 下载作业
 * - 全局共用一个并发池，确保总并发可控
 * - 每个品种独立统计进度与速度
 */
export class DukascopyJob {
  readonly jobId: string
  private request: DownloadRequest
  private options: DukascopyJobOptions
  private controller = new AbortController()
  private states = new Map<string, SymbolState>()
  private units: Unit[] = []
  private inFlight = new Map<number, { symbol: string; received: number }>()
  private nextUnitIndex = 0
  private emitting = false
  private tickTimer: NodeJS.Timeout | null = null
  private finished = false
  private globalMeter = new SpeedMeter()
  /** bi5 解压线程池（隔离 CPU 密集任务） */
  private pool: Bi5DecodePool
  /** 429 命中次数：过多时提前中止，避免把限流越打越死 */
  private rateLimitHits = 0
  /** 提前中止的原因（如限流） */
  private abortReason: string | null = null

  constructor(request: DownloadRequest, options: DukascopyJobOptions) {
    this.request = request
    this.options = options
    this.jobId = `dl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    this.pool = new Bi5DecodePool()

    // 高并发下会有大量在途请求同时监听同一个 AbortSignal，抬高上限避免告警
    // （每个请求最多注册 2 个 abort 监听：请求本身 + CONNECT 隧道）
    try {
      const conc = this.effectiveConcurrency()
      setMaxListeners(conc * 3 + 64, this.controller.signal)
    } catch {
      // 旧版本 Node 无此 API，忽略
    }
  }

  /** 归一化后的并发数 */
  private effectiveConcurrency(): number {
    const raw = Number(this.request.concurrency)
    if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_CONCURRENCY
    return Math.max(1, Math.min(MAX_CONCURRENCY, Math.floor(raw)))
  }

  /** 总下载单元数 */
  get unitCount(): number {
    return this.units.length
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

  /** 构建任务列表（用于启动前校验与 UI 预览） */
  prepare(): { ok: boolean; unitCount: number; error?: string } {
    const from = parseDateUtc(this.request.dateFrom)
    const to = parseDateUtc(this.request.dateTo)
    if (!from) return { ok: false, unitCount: 0, error: '起始日期格式无效（应为 YYYY-MM-DD）' }
    if (!to) return { ok: false, unitCount: 0, error: '结束日期格式无效（应为 YYYY-MM-DD）' }
    if (Date.UTC(from.y, from.m - 1, from.d) > Date.UTC(to.y, to.m - 1, to.d)) {
      return { ok: false, unitCount: 0, error: '起始日期不能晚于结束日期' }
    }
    if (!TIMEFRAME_SECONDS[this.request.timeframe]) {
      return { ok: false, unitCount: 0, error: '不支持的周期' }
    }
    if (this.request.symbols.length === 0) {
      return { ok: false, unitCount: 0, error: '请至少选择一个品种' }
    }

    const now = Date.now()
    // 重置（防止 prepare 被重复调用时重复累加）
    this.units = []
    this.states.clear()
    this.nextUnitIndex = 0
    let seq = 0
    for (const symbol of this.request.symbols) {
      const info = getInstrument(symbol)
      if (!info) return { ok: false, unitCount: 0, error: `未知品种：${symbol}` }

      const units = enumerateUnits(symbol, from, to).map((u) => ({ ...u, seq: seq++ }))
      this.units.push(...units)
      this.states.set(symbol, {
        info,
        timeframe: this.request.timeframe,
        units,
        done: 0,
        receivedBytes: 0,
        bars: new Map(),
        phase: 'queued',
        message: '排队中',
        startedAt: now,
        avgUnitBytes: 12 * 1024,
        meter: new SpeedMeter(),
        failedUnits: 0
      })
    }
    return { ok: true, unitCount: this.units.length }
  }

  /** 开始执行 */
  async run(): Promise<void> {
    const concurrency = this.effectiveConcurrency()
    this.tickTimer = setInterval(() => this.emit(), 220)

    try {
      await this.runPool(concurrency)

      if (this.abortReason) {
        for (const state of this.states.values()) {
          if (state.phase !== 'done') {
            state.phase = 'error'
            state.error = this.abortReason
            state.message = this.abortReason
            state.endedAt = Date.now()
          }
        }
        this.emit()
        return
      }

      if (this.controller.signal.aborted) {
        return
      }

      // 聚合完成 → 逐品种落库
      for (const [symbol, state] of this.states) {
        if (state.phase === 'cancelled') continue
        state.phase = 'aggregating'
        state.message = '整理 K 线…'
        this.emit()

        try {
          const sorted = [...state.bars.values()].sort((a, b) => a.time - b.time)

          if (sorted.length === 0) {
            state.phase = 'error'
            state.error = state.lastError ?? '没有可用数据'
            state.message =
              state.failedUnits > 0
                ? `${state.failedUnits} 个文件全部失败：${state.lastError ?? '未知错误'}`
                : '该时间区间没有数据（可能是周末或休市）'
            state.endedAt = Date.now()
            this.emit()
            continue
          }

          state.phase = 'saving'
          state.message = `写入数据库（${sorted.length} 根）…`
          this.emit()

          const datasetId = saveDownloadedBars({
            symbol,
            name: state.info.name,
            timeframe: state.timeframe,
            market: 'fx',
            source: 'dukascopy',
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
            (state.failedUnits > 0 ? ` · ${state.failedUnits} 个文件失败` : '')
        } catch (e: any) {
          state.phase = 'error'
          state.error = e?.message ?? String(e)
          state.message = `保存失败：${state.error}`
        }
        state.endedAt = Date.now()
        this.emit()
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
      await this.pool.destroy().catch(() => undefined)
      this.emit()
      this.options.onFinished?.(this.snapshot())
    }
  }

  private async runPool(concurrency: number): Promise<void> {
    const signal = this.controller.signal
    const workers = Array.from({ length: Math.min(concurrency, this.units.length) }, () => this.workerLoop())
    await Promise.all(workers)
    void signal
  }

  private async workerLoop(): Promise<void> {
    const signal = this.controller.signal
    while (!signal.aborted) {
      const index = this.nextUnitIndex++
      if (index >= this.units.length) return
      const unit = this.units[index]
      const state = this.states.get(unit.symbol)
      if (!state) continue

      if (state.phase === 'queued') {
        state.phase = 'downloading'
        state.message = '下载中…'
      }

      const flight = { symbol: unit.symbol, received: 0 }
      this.inFlight.set(unit.seq, flight)

      try {
        await this.downloadUnit(unit, state, flight, signal)
      } catch (e: any) {
        if (signal.aborted || e?.message === 'aborted' || e?.message === 'pool destroyed') {
          // 取消：不计数
        } else if (e instanceof FetchError && (e.statusCode === 404 || e.statusCode === 400)) {
          // 该小时无数据（周末 / 休市 / 未来时间），属正常情况
        } else if (e instanceof FetchError && e.statusCode === 429) {
          this.rateLimitHits += 1
          if (!state.lastError) state.lastError = 'HTTP 429 数据源限流'
          // 连续大量被限流说明并发过高，提前止损并提示用户
          if (this.rateLimitHits >= 15 && !this.abortReason) {
            this.abortReason = '数据源限流（HTTP 429）：请把并发降到 16~32、或稍后再试'
            this.controller.abort()
          }
        } else {
          state.failedUnits += 1
          if (!state.lastError) {
            state.lastError = e?.message ?? String(e)
          }
        }
      } finally {
        this.inFlight.delete(unit.seq)
        if (state.phase !== 'cancelled' && state.phase !== 'error') {
          state.done += 1
          if (flight.received > 0) {
            // 指数滑动平均估计单文件大小
            state.avgUnitBytes = state.avgUnitBytes * 0.85 + flight.received * 0.15
          }
        }
      }
    }
  }

  private async downloadUnit(
    unit: Unit,
    state: SymbolState,
    flight: { received: number },
    signal: AbortSignal
  ): Promise<void> {
    const url = buildDukascopyUrl(unit.symbol, unit.year, unit.month0, unit.day, unit.hour)
    const scale = Math.pow(10, state.info.digits)

    const compressed = await fetchBuffer(url, {
      proxy: this.request.proxy,
      signal,
      timeoutMs: 25000,
      retries: 1,
      onProgress: (delta) => {
        if (delta > 0) {
          flight.received += delta
          state.receivedBytes += delta
          state.meter.add(delta)
          this.globalMeter.add(delta)
        }
      }
    })

    if (compressed.length === 0) return

    const baseMs = Date.UTC(unit.year, unit.month0, unit.day, unit.hour, 0, 0)
    const tfSec = TIMEFRAME_SECONDS[state.timeframe]

    // 解压 + 聚合在 worker 线程完成，主线程只做合并
    const bars = await this.pool.decode(compressed, scale, baseMs, tfSec)
    if (bars.length > 0) mergeBars(state.bars, bars)
  }

  /** 生成快照 */
  snapshot(): DownloadSnapshot {
    const tasks: DownloadTaskProgress[] = []
    let totalBytesPerSec = 0
    let activeTasks = 0
    let activeRequests = this.inFlight.size

    for (const [symbol, state] of this.states) {
      const total = state.units.length
      const avg = state.avgUnitBytes > 0 ? state.avgUnitBytes : 12 * 1024

      // 在途单元按字节折算为小数进度
      let fractional = 0
      let activeWorkers = 0
      for (const flight of this.inFlight.values()) {
        if (flight.symbol !== symbol) continue
        activeWorkers++
        fractional += Math.min(1, flight.received / avg)
      }

      const percent = total > 0 ? Math.min(100, ((state.done + fractional) / total) * 100) : 0
      const speed = state.meter.speed()
      const elapsed = (state.endedAt ?? Date.now()) - state.startedAt
      const remaining = Math.max(0, total - state.done - fractional)
      const eta = speed > 0 && remaining > 0 ? (remaining * avg) / speed * 1000 : null

      tasks.push({
        taskId: `${this.jobId}:${symbol}`,
        symbol,
        name: state.info.name,
        digits: state.info.digits,
        timeframe: state.timeframe,
        phase: state.phase,
        done: state.done,
        total,
        percent: state.phase === 'done' ? 100 : percent,
        bytesDone: state.receivedBytes,
        bytesPerSec: speed,
        avgBytesPerSec: elapsed > 0 ? (state.receivedBytes / elapsed) * 1000 : 0,
        bars: state.bars.size,
        elapsedMs: elapsed,
        etaMs: state.phase === 'done' ? 0 : eta,
        activeWorkers,
        message: state.message,
        error: state.error,
        datasetId: state.datasetId
      })

      if (state.phase === 'downloading' || state.phase === 'queued' || state.phase === 'saving' || state.phase === 'aggregating') {
        activeTasks++
      }
    }

    totalBytesPerSec = this.globalMeter.speed()

    return {
      jobId: this.jobId,
      tasks,
      totalBytesPerSec,
      activeTasks,
      activeRequests,
      unitCount: this.units.length
    }
  }

  private emit(): void {
    if (this.emitting) return
    this.emitting = true
    try {
      this.options.onSnapshot(this.snapshot())
    } finally {
      this.emitting = false
    }
  }
}
