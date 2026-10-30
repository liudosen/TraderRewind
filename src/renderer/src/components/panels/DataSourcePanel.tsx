import React, { useEffect, useMemo, useState } from 'react'
import {
  Search,
  Download,
  X,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Trash2,
  Database,
  Server,
  RefreshCw,
  ChevronRight,
  Info
} from 'lucide-react'
import clsx from 'clsx'
import { useDownloadStore, type DatasetRow } from '../../stores/download-store'
import { ProgressBar } from '../common/ProgressBar'
import { DateRangePicker } from '../common/DateRangePicker'
import { eachDayKey, estimateHourFiles, localDayKeyFromTs, parseYmd } from '@shared/utils/daterange'
import { parseProxyEndpoint } from '@shared/utils/proxy'
import { describeContract } from '@shared/utils/pnl'
import type {
  DownloadPhase,
  DownloadTaskProgress,
  InstrumentCategory,
  InstrumentInfo
} from '@shared/types/download'
import { useT, instrumentLabel, translateLabel, type MessageKey } from '../../i18n'
import {
  formatBytes,
  formatDuration,
  formatNumber,
  formatSpeed
} from '../../utils/format'

/** 阶段文案走词典：这里只留键名，组件里 t() */
const PHASE_META: Record<
  DownloadPhase,
  {
    labelKey: MessageKey
    tone: 'accent' | 'positive' | 'negative' | 'muted'
    dot: string
  }
> = {
  queued: { labelKey: 'ds.phase.queued', tone: 'muted', dot: 'bg-neutral-500' },
  downloading: { labelKey: 'ds.phase.downloading', tone: 'accent', dot: 'bg-[var(--c-accent)]' },
  aggregating: { labelKey: 'ds.phase.aggregating', tone: 'accent', dot: 'bg-[var(--c-accent)]' },
  saving: { labelKey: 'ds.phase.saving', tone: 'accent', dot: 'bg-[var(--c-accent)]' },
  done: { labelKey: 'ds.phase.done', tone: 'positive', dot: 'bg-[var(--c-pos)]' },
  cancelled: { labelKey: 'ds.phase.cancelled', tone: 'muted', dot: 'bg-neutral-500' },
  error: { labelKey: 'ds.phase.error', tone: 'negative', dot: 'bg-[var(--c-neg)]' }
}

const CATEGORY_LABEL_KEY: Record<string, MessageKey> = {
  major: 'ds.cat.major',
  cross: 'ds.cat.cross',
  metal: 'ds.cat.metal',
  crypto: 'ds.cat.crypto'
}

/** 并行请求数上限 */
export const MAX_CONCURRENCY = 64

export function clampConcurrency(n: number): number {
  if (!Number.isFinite(n)) return 24
  return Math.max(1, Math.min(MAX_CONCURRENCY, Math.round(n)))
}

export function DataSourcePanel(): React.JSX.Element {
  const { t, locale } = useT()
  const catalog = useDownloadStore((s) => s.catalog)
  const catalogLoaded = useDownloadStore((s) => s.catalogLoaded)
  const loadCatalog = useDownloadStore((s) => s.loadCatalog)
  const sourceId = useDownloadStore((s) => s.sourceId)
  const setSource = useDownloadStore((s) => s.setSource)
  const selected = useDownloadStore((s) => s.selected)
  const toggleSymbol = useDownloadStore((s) => s.toggleSymbol)
  const setSelected = useDownloadStore((s) => s.setSelected)
  const clearSelection = useDownloadStore((s) => s.clearSelection)
  const dateFrom = useDownloadStore((s) => s.dateFrom)
  const dateTo = useDownloadStore((s) => s.dateTo)
  const concurrency = useDownloadStore((s) => s.concurrency)
  const proxy = useDownloadStore((s) => s.proxy)
  const patchConfig = useDownloadStore((s) => s.patchConfig)
  const starting = useDownloadStore((s) => s.starting)
  const error = useDownloadStore((s) => s.error)
  const snapshot = useDownloadStore((s) => s.snapshot)
  const startDownload = useDownloadStore((s) => s.startDownload)
  const cancelDownload = useDownloadStore((s) => s.cancelDownload)
  const clearSnapshot = useDownloadStore((s) => s.clearSnapshot)
  const bindProgress = useDownloadStore((s) => s.bindProgress)
  const datasets = useDownloadStore((s) => s.datasets)
  const loadingDatasets = useDownloadStore((s) => s.loadingDatasets)
  const loadDatasets = useDownloadStore((s) => s.loadDatasets)
  const removeDataset = useDownloadStore((s) => s.removeDataset)

  const [search, setSearch] = useState('')

  useEffect(() => {
    void loadCatalog()
    void loadDatasets()
    const off = bindProgress()
    return off
  }, [loadCatalog, loadDatasets, bindProgress])

  const source = catalog.find((s) => s.id === sourceId) ?? catalog[0]
  const instruments = source?.instruments ?? []

  const selectedSet = useMemo(() => new Set(selected), [selected])

  const filtered = useMemo(() => {
    const kw = search.trim().toLowerCase()
    if (!kw) return instruments
    return instruments.filter(
      (i) => i.symbol.toLowerCase().includes(kw) || i.name.includes(kw)
    )
  }, [instruments, search])

  /**
   * 按分类分组。顺序写死而不是按字母排 —— 「主要货币对 → 交叉盘 → 贵金属 → 加密」
   * 是从熟悉到陌生、从高频到低频的阅读顺序，字母序会把它打乱。
   */
  const grouped = useMemo(() => {
    const order: InstrumentCategory[] = ['major', 'cross', 'metal', 'crypto']
    const groups = {} as Record<InstrumentCategory, InstrumentInfo[]>
    for (const cat of order) groups[cat] = []
    for (const item of filtered) {
      if (!groups[item.category]) groups[item.category] = []
      groups[item.category].push(item)
    }
    return order.map((cat) => ({ cat, list: groups[cat] ?? [] })).filter((g) => g.list.length > 0)
  }, [filtered])

  const fromYmd = parseYmd(dateFrom)
  const toYmd = parseYmd(dateTo)

  // 已下载覆盖的日期（所有选中品种都已有数据时才算「已下载」，避免漏下其它品种）
  const blockedDays = useMemo(() => {
    if (selected.length === 0 || datasets.length === 0) return new Set<string>()
    const coverage: Array<Set<string>> = []
    for (const sym of selected) {
      const set = new Set<string>()
      for (const d of datasets) {
        if (d.symbol !== sym) continue
        if (!d.first_time || !d.last_time || d.candle_count <= 0) continue
        for (const k of eachDayKey(
          localDayKeyFromTs(d.first_time),
          localDayKeyFromTs(d.last_time)
        )) {
          set.add(k)
        }
      }
      coverage.push(set)
    }
    if (coverage.length === 0) return new Set<string>()
    const [first, ...rest] = coverage
    const out = new Set<string>()
    for (const k of first) {
      if (rest.every((set) => set.has(k))) out.add(k)
    }
    return out
  }, [datasets, selected])

  /**
   * 预估下载单元。
   *
   * 外汇是按「小时 tick 文件」下的，所以估的是文件数；
   * 加密那边一次一页 K 线，没有文件概念，估的是 1 分钟根数。
   * 两种口径都塞进同一个变量（totalUnits），下游只关心「非零才能开始下载」。
   */
  const isCandle = source?.kind === 'candle'
  const totalUnits = useMemo(() => {
    if (!fromYmd || !toYmd) return 0
    let perSymbol = 0
    for (const key of eachDayKey(dateFrom, dateTo)) {
      if (blockedDays.has(key)) continue
      const day = parseYmd(key)
      if (!day) continue
      // 加密：一天 1440 根 1 分钟；外汇：一天里有多少个小时文件
      perSymbol += isCandle ? 1440 : estimateHourFiles(day, day)
    }
    return perSymbol * selected.length
  }, [dateFrom, dateTo, blockedDays, selected.length, fromYmd, toYmd, isCandle])

  const rangeDays = useMemo(() => eachDayKey(dateFrom, dateTo), [dateFrom, dateTo])
  const rangeFullyCovered =
    rangeDays.length > 0 && rangeDays.every((k) => blockedDays.has(k))
  /** 外汇的 bi5 文件约 12 KB；加密一行 K 线按 120 字节估 */
  const estBytes = isCandle ? totalUnits * 120 : totalUnits * 12 * 1024

  /**
   * 加密接口限速更严，滑杆上限只有 8。但保存下来的并发值可能是外汇时期设的 64
   * （启动时从 meta 读回），直接塞给 max=8 的滑杆会显示成「超出刻度的 64」，
   * 看着像坏了。这里按上限夹一下再显示。
   */
  const maxConcurrency = isCandle ? 8 : 64
  const shownConcurrency = Math.min(concurrency, maxConcurrency)

  /**
   * 代理地址边输边校验。手打的地址最常见的错是全角冒号「：」、
   * 冒号后多一个空格、IP 少写一段 —— 这些等跑到网络层只会得到一句
   * ENOTFOUND，几千个文件全失败之后才暴露。这里当场把话说清楚。
   */
  const proxyParse = parseProxyEndpoint(proxy)
  const proxyProblem =
    proxyParse.state === 'invalid'
      ? t(
          proxyParse.code === 'ip-short'
            ? 'ds.proxyInvalidIp'
            : proxyParse.code === 'port'
              ? 'ds.proxyInvalidPort'
              : 'ds.proxyInvalidHost'
        )
      : null

  const isRunning = useMemo(() => {
    if (!snapshot) return false
    return snapshot.tasks.some(
      (task) => task.phase !== 'done' && task.phase !== 'error' && task.phase !== 'cancelled'
    )
  }, [snapshot])

  const overallPercent = useMemo(() => {
    if (!snapshot || snapshot.tasks.length === 0) return 0
    const sum = snapshot.tasks.reduce((acc, task) => acc + task.percent, 0)
    return sum / snapshot.tasks.length
  }, [snapshot])

  const totalBars = useMemo(
    () => (snapshot ? snapshot.tasks.reduce((acc, task) => acc + task.bars, 0) : 0),
    [snapshot]
  )

  const totalBytes = useMemo(
    () => (snapshot ? snapshot.tasks.reduce((acc, task) => acc + task.bytesDone, 0) : 0),
    [snapshot]
  )

  return (
    <div className="h-full flex min-h-0">
      {/* ── 左：品种选择 ───────────────────────────── */}
      <aside className="w-[292px] shrink-0 border-r border-[var(--border-subtle)] flex flex-col min-h-0 bg-[var(--surface-1)]">
        {/* 数据源切换：外汇 / OKX / Binance 三个来源的品种完全不重叠，
            放在最上面才能让人先选定「从哪儿取数」再挑品种 */}
        <div className="flex shrink-0 items-center gap-1 border-b border-[var(--border-subtle)] px-2.5 py-2">
          {catalog.length === 0 && (
            <span className="text-[10.5px] text-[var(--text-faint)]">{t('ds.loading')}</span>
          )}
          {catalog.map((s) => {
            const active = s.id === source?.id
            return (
              <button
                key={s.id}
                onClick={() => setSource(s.id)}
                title={translateLabel(locale, s.description)}
                className={clsx(
                  'rounded px-2 py-[3px] text-[11px] transition-colors',
                  active
                    ? 'bg-[var(--c-accent-tint)] font-medium text-[var(--c-accent)]'
                    : 'text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]'
                )}
              >
                {s.name}
              </button>
            )
          })}
        </div>

        <div className="px-4 pt-3 pb-3 border-b border-[var(--border-subtle)]">
          <div className="flex items-center gap-2 mb-2">
            <Server size={14} className="text-[var(--c-accent)]" />
            <span className="text-[12px] font-semibold text-[var(--text-primary)]">
              {source?.name ?? t('ds.source')}
            </span>
            <span className="ml-auto rounded-full bg-[var(--c-pos-tint)] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-[var(--c-pos)]">
              {t('ds.free')}
            </span>
          </div>
          <p className="text-[10.5px] leading-relaxed text-[var(--text-muted)]">
            {source?.description ? translateLabel(locale, source.description) : t('ds.loading')}
          </p>
          {source?.note && (
            <p className="mt-1.5 flex items-start gap-1 text-[10px] leading-relaxed text-amber-400/80">
              <Info size={10} className="mt-[3px] shrink-0" />
              <span>{translateLabel(locale, source.note)}</span>
            </p>
          )}
        </div>

        <div className="px-3 py-2 border-b border-[var(--border-subtle)]">
          <div className="relative">
            <Search
              size={13}
              className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-faint)]"
            />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('ds.search')}
              className="w-full rounded-md border border-[var(--border-subtle)] bg-[var(--surface-2)] py-1.5 pl-7 pr-2 text-[11.5px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-faint)] focus:border-[var(--border-strong)]"
            />
          </div>
          <div className="mt-2 flex items-center justify-between text-[10px] text-[var(--text-faint)]">
            <span>{t('ds.selected', { n: selected.length, total: instruments.length })}</span>
            <div className="flex gap-2">
              <button
                onClick={() => setSelected(instruments.map((i) => i.symbol))}
                className="hover:text-[var(--text-secondary)]"
              >
                {t('ds.selectAll')}
              </button>
              <button onClick={clearSelection} className="hover:text-[var(--text-secondary)]">
                {t('ds.clear')}
              </button>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto py-1">
          <InstrumentList
            catalogLoaded={catalogLoaded}
            groups={grouped}
            empty={filtered.length === 0}
            selectedSet={selectedSet}
            onToggle={toggleSymbol}
            onSelectGroup={(symbols) => setSelected(symbols)}
            onClear={clearSelection}
          />
        </div>
      </aside>

      {/* ── 右：配置 + 进度 + 已下载 ───────────────── */}
      <div className="flex-1 min-w-0 overflow-y-auto">
        <div className="px-6 pt-5 pb-4 border-b border-[var(--border-subtle)]">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-[17px] font-semibold tracking-tight text-[var(--text-primary)]">
                {t('ds.title')}
              </h1>
              <p className="mt-1 text-[11.5px] text-[var(--text-muted)]">{t('ds.subtitle')}</p>
            </div>
          </div>
        </div>

        {/* 配置区 */}
        <section className="px-6 py-4 border-b border-[var(--border-subtle)]">
          <div className="grid grid-cols-2 gap-x-5 gap-y-3.5 max-w-[760px]">
            <Field label={t('ds.granularity')}>
              <div className="flex items-center gap-2 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-2)] px-2.5 py-1.5">
                <span className="font-mono text-[12px] text-[var(--text-primary)]">
                  {t('ds.oneMinute')}
                </span>
                <span className="rounded bg-[var(--surface-4)] px-1.5 py-px font-mono text-[9px] text-[var(--text-secondary)]">
                  M1
                </span>
                <span className="ml-auto text-[10px] text-[var(--text-faint)]">
                  {t('ds.fixed')}
                </span>
              </div>
            </Field>

            <Field label={t('ds.concurrency')}>
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={1}
                  max={maxConcurrency}
                  step={1}
                  value={shownConcurrency}
                  onChange={(e) => patchConfig({ concurrency: clampConcurrency(Number(e.target.value)) })}
                  className="flex-1 accent-[var(--c-accent)]"
                />
                <input
                  type="number"
                  min={1}
                  max={maxConcurrency}
                  value={shownConcurrency}
                  onChange={(e) => {
                    const v = Number(e.target.value)
                    if (!Number.isFinite(v) || e.target.value === '') return
                    patchConfig({ concurrency: clampConcurrency(v) })
                  }}
                  className="w-14 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-2)] px-1.5 py-1 text-center font-mono text-[11px] text-[var(--text-primary)] outline-none focus:border-[var(--border-strong)]"
                />
              </div>
              <p className="mt-1 text-[10px] leading-tight text-[var(--text-faint)]">
                {isCandle ? t('ds.concurrencyHintCandle') : t('ds.concurrencyHint')}
              </p>
            </Field>

            <div className="col-span-2">
              <Field label={t('ds.range')}>
                <DateRangePicker
                  from={dateFrom}
                  to={dateTo}
                  blockedDays={blockedDays}
                  onChange={(f, to) => patchConfig({ dateFrom: f, dateTo: to })}
                />
              </Field>
            </div>

            <div className="col-span-2">
              <Field label={t('ds.proxy')}>
                <div className="flex items-center gap-2">
                  <input
                    value={proxy}
                    onChange={(e) => patchConfig({ proxy: e.target.value })}
                    placeholder="127.0.0.1:7890"
                    className={clsx(
                      'w-full max-w-[280px] rounded-md border bg-[var(--surface-2)] px-2.5 py-1.5 font-mono text-[11.5px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-faint)]',
                      proxyProblem
                        ? 'border-amber-500/60 focus:border-amber-500'
                        : 'border-[var(--border-subtle)] focus:border-[var(--border-strong)]'
                    )}
                  />
                  <span className="text-[10.5px] text-[var(--text-faint)]">
                    {t('ds.proxyHint')}
                  </span>
                </div>
                {proxyProblem && (
                  <p className="mt-1 flex items-start gap-1 text-[10.5px] leading-tight text-amber-400">
                    <AlertCircle size={11} className="mt-[1px] shrink-0" />
                    <span>{proxyProblem}</span>
                  </p>
                )}
              </Field>
            </div>
          </div>

          <p className="mt-3 max-w-[760px] text-[10.5px] leading-relaxed text-[var(--text-faint)]">
            {t('ds.m1Note')}
          </p>

          {rangeFullyCovered && (
            <div className="mt-3 flex max-w-[760px] items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11.5px] text-amber-300">
              <AlertCircle size={13} className="mt-0.5 shrink-0" />
              <span>{t('ds.fullyCovered')}</span>
            </div>
          )}

          {/* 预估 + 操作 */}
          <div className="mt-4 flex items-center gap-3">
            <button
              onClick={() => void startDownload()}
              disabled={
                starting || isRunning || selected.length === 0 || totalUnits === 0 || !!proxyProblem
              }
              title={proxyProblem ?? undefined}
              className={clsx(
                'inline-flex items-center gap-1.5 rounded-md px-3.5 py-1.5 text-[12px] font-medium transition-colors',
                'bg-[var(--c-accent)] text-white hover:brightness-110',
                'disabled:cursor-not-allowed disabled:opacity-40'
              )}
            >
              {starting ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
              {isRunning ? t('ds.downloading') : t('ds.start')}
            </button>

            {isRunning && (
              <button
                onClick={() => void cancelDownload()}
                className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border-subtle)] px-3 py-1.5 text-[12px] text-[var(--text-secondary)] hover:border-[var(--c-neg)] hover:text-[var(--c-neg)]"
              >
                <X size={13} />
                {t('ds.cancel')}
              </button>
            )}

            {snapshot && !isRunning && (
              <button
                onClick={clearSnapshot}
                className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border-subtle)] px-3 py-1.5 text-[12px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              >
                {t('ds.clearLog')}
              </button>
            )}

            <div className="ml-auto flex items-center gap-1.5 text-[10.5px] text-[var(--text-faint)]">
              <Info size={11} />
              {isCandle
                ? t('ds.estimateCandles', {
                    bars: formatNumber(totalUnits),
                    size: formatBytes(estBytes)
                  })
                : t('ds.estimate', {
                    files: formatNumber(totalUnits),
                    size: formatBytes(estBytes),
                    bars: formatNumber(totalUnits * 60)
                  })}
            </div>
          </div>

          {error && (
            <div className="mt-3 flex items-start gap-2 rounded-md border border-[var(--c-neg)]/40 bg-[var(--c-neg-tint)] px-3 py-2 text-[11.5px] text-[var(--c-neg)]">
              <AlertCircle size={13} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </section>

        {/* 进度区 */}
        {snapshot && snapshot.tasks.length > 0 && (
          <section className="px-6 py-4 border-b border-[var(--border-subtle)]">
            <div className="mb-3 flex items-center gap-3">
              <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)]">
                {t('ds.progress')}
              </span>
              <span className="rounded-full bg-[var(--surface-3)] px-2 py-0.5 font-mono text-[10px] text-[var(--text-secondary)]">
                {overallPercent.toFixed(1)}%
              </span>
              <div className="ml-auto flex items-center gap-4 text-[10.5px] text-[var(--text-muted)]">
                <span className="inline-flex items-center gap-1">
                  <span className="h-1.5 w-1.5 rounded-full bg-[var(--c-pos)]" />
                  {t('ds.totalSpeed', { speed: formatSpeed(snapshot.totalBytesPerSec) })}
                </span>
                <span>{t('ds.activeRequests', { n: snapshot.activeRequests })}</span>
                <span>{t('ds.downloaded', { size: formatBytes(totalBytes) })}</span>
                <span>{t('ds.barsSummary', { n: formatNumber(totalBars) })}</span>
              </div>
            </div>

            <div className="space-y-2">
              {snapshot.tasks.map((task) => (
                <TaskRow key={task.taskId} task={task} isCandle={!!isCandle} />
              ))}
            </div>
          </section>
        )}

        {/* 已下载数据 */}
        <section className="px-6 py-4">
          <div className="mb-3 flex items-center gap-2">
            <Database size={13} className="text-[var(--text-muted)]" />
            <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)]">
              {t('ds.datasets')}
            </span>
            <span className="rounded-full bg-[var(--surface-3)] px-2 py-0.5 font-mono text-[10px] text-[var(--text-secondary)]">
              {datasets.length}
            </span>
            <button
              onClick={() => void loadDatasets()}
              className="ml-auto inline-flex items-center gap-1 text-[10.5px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            >
              <RefreshCw size={11} className={loadingDatasets ? 'animate-spin' : ''} />
              {t('common.refresh')}
            </button>
          </div>

          {datasets.length === 0 ? (
            <div className="rounded-lg border border-dashed border-[var(--border-subtle)] py-10 text-center">
              <p className="text-[11.5px] text-[var(--text-faint)]">{t('ds.emptyDatasets')}</p>
            </div>
          ) : (
            <DatasetTable datasets={datasets} onDelete={(id) => void removeDataset(id)} />
          )}
        </section>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[10.5px] font-medium text-[var(--text-muted)]">
        {label}
      </span>
      {children}
    </label>
  )
}

const InstrumentRow = React.memo(function InstrumentRow({
  item,
  checked,
  onToggle
}: {
  item: InstrumentInfo
  checked: boolean
  onToggle: (symbol: string) => void
}): React.JSX.Element {
  const { t, locale } = useT()
  // 合约规格是固定的，算一次就够：让用户点之前就知道「1 手到底是多少」
  const contract = describeContract(item.symbol, locale)
  return (
    <button
      onClick={() => onToggle(item.symbol)}
      title={[
        t('ds.contractLot', { symbol: item.symbol, size: contract.sizeText }),
        t('ds.contractPoint', { point: contract.pointQuoteText }) +
          (contract.pointUsdText ? t('ds.contractPointUsd', { usd: contract.pointUsdText }) : ''),
        contract.note
      ].join('\n')}
      className={clsx(
        'flex w-full items-center gap-2 px-4 py-[5px] text-left transition-colors',
        checked ? 'bg-[var(--c-accent-tint)]' : 'hover:bg-[var(--surface-2)]'
      )}
    >
      <span
        className={clsx(
          'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border',
          checked
            ? 'border-[var(--c-accent)] bg-[var(--c-accent)] text-white'
            : 'border-[var(--border-strong)]'
        )}
      >
        {checked && (
          <svg viewBox="0 0 10 10" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M1.5 5.2 3.8 7.5 8.5 2.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </span>
      <span className="font-mono text-[11.5px] font-medium text-[var(--text-primary)]">
        {item.symbol}
      </span>
      <span className="truncate text-[10.5px] text-[var(--text-muted)]">
        {instrumentLabel(locale, item.symbol, item.name)}
      </span>
      <span className="ml-auto shrink-0 font-mono text-[9px] text-[var(--text-faint)]">
        {t('ds.digits', { n: item.digits })}
      </span>
    </button>
  )
})

/**
 * 品种列表：用 memo 与下载进度更新隔离。
 * 进度快照每 200ms 更新一次，若列表跟着重渲染会明显拖慢滚动。
 *
 * 每个分类是一个可折叠的分组：加密市场一组十几个品种，平铺会把别的组挤到
 * 屏幕外。默认全部展开（第一次进来就能看到全貌），用户折叠过哪一组就记在
 * localStorage 里，下次进来还是上次的样子。
 */
const COLLAPSED_KEY = 'rw.data.collapsedGroups'

function loadCollapsed(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY)
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {}
  } catch {
    return {}
  }
}

const InstrumentList = React.memo(function InstrumentList({
  catalogLoaded,
  groups,
  empty,
  selectedSet,
  onToggle,
  onSelectGroup,
  onClear
}: {
  catalogLoaded: boolean
  groups: { cat: InstrumentCategory; list: InstrumentInfo[] }[]
  empty: boolean
  selectedSet: Set<string>
  onToggle: (symbol: string) => void
  /** 整组选中/取消（传该组全部代码） */
  onSelectGroup: (symbols: string[]) => void
  onClear: () => void
}): React.JSX.Element {
  const { t } = useT()
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => loadCollapsed())

  const toggleGroup = (cat: string): void => {
    setCollapsed((prev) => {
      const next = { ...prev, [cat]: !prev[cat] }
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next))
      } catch {
        // 隐私模式写不了，忽略
      }
      return next
    })
  }

  return (
    <>
      {!catalogLoaded && (
        <div className="px-4 py-6 text-center text-[11px] text-[var(--text-faint)]">
          {t('ds.loadingCatalog')}
        </div>
      )}

      {groups.map(({ cat, list }) => {
        const isCollapsed = !!collapsed[cat]
        const picked = list.filter((i) => selectedSet.has(i.symbol)).length
        const allPicked = picked === list.length && list.length > 0
        return (
          <div key={cat} className="mb-0.5">
            <div className="group/hd flex items-center gap-1 px-2 py-1 hover:bg-[var(--surface-2)]">
              <button
                type="button"
                onClick={() => toggleGroup(cat)}
                className="flex min-w-0 flex-1 items-center gap-1 py-0.5 text-left"
                title={isCollapsed ? t('ds.expandGroup') : t('ds.collapseGroup')}
              >
                <ChevronRight
                  size={11}
                  className={clsx(
                    'shrink-0 text-[var(--text-faint)] transition-transform',
                    !isCollapsed && 'rotate-90'
                  )}
                />
                <span className="truncate text-[9.5px] font-semibold uppercase tracking-[0.14em] text-[var(--text-faint)]">
                  {t(CATEGORY_LABEL_KEY[cat])}
                </span>
                <span className="shrink-0 rounded bg-[var(--surface-3)] px-1 font-mono text-[9px] text-[var(--text-faint)]">
                  {picked > 0 ? `${picked}/${list.length}` : list.length}
                </span>
              </button>
              {/* 整组勾选：加密一组十几个，一个个点太费劲 */}
              <button
                type="button"
                onClick={() => (allPicked ? onClear() : onSelectGroup(list.map((i) => i.symbol)))}
                className="shrink-0 rounded px-1 py-0.5 text-[9.5px] text-[var(--text-faint)] opacity-0 transition-opacity hover:text-[var(--c-accent)] group-hover/hd:opacity-100"
                title={allPicked ? t('ds.clearGroup') : t('ds.selectGroup')}
              >
                {allPicked ? t('ds.clear') : t('ds.selectAll')}
              </button>
            </div>

            {!isCollapsed &&
              list.map((item) => (
                <InstrumentRow
                  key={item.symbol}
                  item={item}
                  checked={selectedSet.has(item.symbol)}
                  onToggle={onToggle}
                />
              ))}
          </div>
        )
      })}

      {catalogLoaded && empty && (
        <div className="px-4 py-8 text-center text-[11px] text-[var(--text-faint)]">
          {t('ds.noMatch')}
        </div>
      )}
    </>
  )
})

function TaskRow({
  task,
  isCandle
}: {
  task: DownloadTaskProgress
  /** 加密是「翻页拿 K 线」，不是「下小时文件」，进度单位得跟着换 */
  isCandle: boolean
}): React.JSX.Element {
  const { t, locale } = useT()
  const meta = PHASE_META[task.phase] ?? PHASE_META.queued
  const isActive = task.phase === 'downloading' || task.phase === 'aggregating' || task.phase === 'saving'

  return (
    <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-1)] px-3 py-2">
      <div className="flex items-center gap-2">
        <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', meta.dot, isActive && 'animate-pulse')} />
        <span className="font-mono text-[11.5px] font-semibold text-[var(--text-primary)]">
          {task.symbol}
        </span>
        <span className="text-[10px] text-[var(--text-faint)]">{task.name}</span>
        <span className="rounded bg-[var(--surface-3)] px-1.5 py-px font-mono text-[9px] text-[var(--text-secondary)]">
          {task.timeframe}
        </span>

        <span
          className={clsx(
            'rounded px-1.5 py-px text-[9px] font-medium',
            task.phase === 'done' && 'bg-[var(--c-pos-tint)] text-[var(--c-pos)]',
            task.phase === 'error' && 'bg-[var(--c-neg-tint)] text-[var(--c-neg)]',
            isActive && 'bg-[var(--c-accent-tint)] text-[var(--c-accent)]',
            (task.phase === 'queued' || task.phase === 'cancelled') &&
              'bg-[var(--surface-3)] text-[var(--text-muted)]'
          )}
        >
          {t(meta.labelKey)}
        </span>

        <span className="ml-auto font-mono text-[11px] tabular-nums text-[var(--text-secondary)]">
          {task.percent.toFixed(1)}%
        </span>
      </div>

      <div className="mt-1.5">
        <ProgressBar percent={task.percent} animated={isActive} tone={meta.tone} />
      </div>

      <div className="mt-1.5 flex items-center gap-3 text-[9.5px] text-[var(--text-faint)]">
        <span className="tabular-nums">
          {t(isCandle ? 'ds.pages' : 'ds.files', {
            done: formatNumber(task.done),
            total: formatNumber(task.total)
          })}
        </span>
        <span className="tabular-nums">↓ {formatSpeed(task.bytesPerSec)}</span>
        <span className="tabular-nums">
          {t('ds.avgSpeed', { speed: formatSpeed(task.avgBytesPerSec) })}
        </span>
        <span className="tabular-nums">{t('ds.bars', { n: formatNumber(task.bars) })}</span>
        <span className="tabular-nums">{formatBytes(task.bytesDone)}</span>
        {task.phase === 'done' ? (
          <span className="inline-flex items-center gap-1 text-[var(--c-pos)]">
            <CheckCircle2 size={10} /> {t('ds.spent', { time: formatDuration(task.elapsedMs, locale) })}
          </span>
        ) : (
          <span className="tabular-nums">
            {t('ds.remaining', { time: formatDuration(task.etaMs, locale) })}
          </span>
        )}
        {task.message && (
          <span className="ml-auto truncate text-[var(--text-muted)]">{task.message}</span>
        )}
      </div>
    </div>
  )
}

function DatasetTable({
  datasets,
  onDelete
}: {
  datasets: DatasetRow[]
  onDelete: (id: number) => void
}): React.JSX.Element {
  const { t, locale } = useT()
  return (
    <div className="overflow-hidden rounded-lg border border-[var(--border-subtle)]">
      <table className="w-full text-left">
        <thead>
          <tr className="border-b border-[var(--border-subtle)] bg-[var(--surface-2)] text-[9.5px] uppercase tracking-wider text-[var(--text-faint)]">
            <th className="px-3 py-2 font-medium">{t('ds.col.symbol')}</th>
            <th className="px-3 py-2 font-medium">{t('ds.col.timeframe')}</th>
            <th className="px-3 py-2 font-medium">{t('ds.col.range')}</th>
            <th className="px-3 py-2 text-right font-medium">{t('ds.col.bars')}</th>
            <th className="px-3 py-2 font-medium">{t('ds.col.source')}</th>
            <th className="px-3 py-2 text-right font-medium">{t('ds.col.actions')}</th>
          </tr>
        </thead>
        <tbody>
          {datasets.map((d) => (
            <tr
              key={d.id}
              className="border-b border-[var(--border-subtle)] last:border-0 text-[11px] hover:bg-[var(--surface-2)]"
            >
              <td className="px-3 py-2 font-mono font-medium text-[var(--text-primary)]">
                {d.symbol}
              </td>
              <td className="px-3 py-2 font-mono text-[var(--text-secondary)]">{d.timeframe}</td>
              <td className="px-3 py-2 font-mono text-[10.5px] tabular-nums text-[var(--text-muted)]">
                {fmtUtc(d.first_time)} → {fmtUtc(d.last_time)}
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-[var(--text-secondary)]">
                {formatNumber(d.candle_count)}
              </td>
              <td className="px-3 py-2 text-[10.5px] text-[var(--text-muted)]">
                {translateLabel(locale, d.group_name ?? d.source)}
              </td>
              <td className="px-3 py-2 text-right">
                <button
                  onClick={() => onDelete(d.id)}
                  title={t('ds.deleteDataset')}
                  className="rounded p-1 text-[var(--text-faint)] hover:bg-[var(--c-neg-tint)] hover:text-[var(--c-neg)]"
                >
                  <Trash2 size={12} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function fmtUtc(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return '--'
  const d = new Date(ts * 1000)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  return `${y}-${m}-${day} ${hh}:${mm}`
}
