import React, { useCallback, useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import {
  BookOpen,
  RefreshCw,
  CheckCircle2,
  ArrowUpRight,
  ChevronsLeft,
  ChevronsRight,
  LineChart
} from 'lucide-react'
import { useTrainingStore, rowToTrade, type ClosedTrade } from '../../stores/training-store'
import { useAppStore } from '../../stores/app-store'
import { ReportContent } from './TrainingReport'
import { SessionParamsCard } from './SessionParams'
import { TradeMetaDialog } from './TradeMetaDialog'
import { formatSigned, formatSpentTime } from '../../utils/format'
import { useT } from '../../i18n'
import { useTimezoneStore } from '../../stores/timezone-store'
import { fmtTzDate, fmtTzShort, tzPartsFromMs } from '@shared/types/timezone'

/** db:listCompletedSessions 返回的行 */
interface CompletedRow {
  id: number
  name: string
  dataset_id: number
  initial_balance: number
  balance: number
  completed_at: number | null
  start_time: number | null
  end_time: number | null
  display_timeframe: string | null
  trade_count: number
  total_pnl: number
  win_count: number
  dataset_symbol: string | null
  /** 建这个回测集时用的时区，日志里的时间按它展示 */
  tz: string | null
  /** 在这个回测集上实际花的时间（秒）；老数据没有统计，是 0 */
  train_seconds: number | null
  // ---- 以下是「训练参数」卡要用的原始设置 ----
  created_at: number | null
  dataset_timeframe: string | null
  dataset_bar_count: number | null
  lot_size: number | null
  risk_per_trade: number | null
  /** 'HH:mm-HH:mm'，null = 全天不限 */
  trade_window: string | null
  /** 会话里保存的指标配置（JSON 文本） */
  indicators_json: string | null
  /** 会话里保存的画线（JSON 文本） */
  drawings_json: string | null
}

/** 秒级时间戳 → YYYY-MM-DD（按设置时区，默认 UTC+8） */
function fmtDate(ts: number | null, tz: string): string {
  if (ts == null) return '--'
  return fmtTzDate(ts, tz)
}

/** 毫秒级时间戳 → MM-DD HH:mm（按设置时区，默认 UTC+8） */
function fmtDateTime(ts: number | null, tz: string): string {
  if (ts == null) return '--'
  const t = tzPartsFromMs(ts, tz)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(t.month)}-${p(t.day)} ${p(t.hour)}:${p(t.minute)}`
}

const LIST_OPEN_KEY = 'tr:journalList'

/**
 * 切到 K 线图再回来时，得站在「原来那一集、原来那一笔」上。
 *
 * 面板是按 activePane 条件渲染的，去训练页就等于把 JournalPane 卸载掉，
 * useState 全丢。所以把「看到哪了」放在模块作用域里带过去 —— 只活在这次运行里，
 * 不落盘：下次启动重新从头看是合理的。
 */
let lastSelectedId: number | null = null
let lastTradeId: string | null = null

export function JournalPane(): React.JSX.Element {
  const { t, locale } = useT()
  // 日志里的所有时间统一按这个时区显示（默认 UTC+8）
  const timezone = useTimezoneStore((s) => s.timezone)
  /** 成本模型（手续费 / 滑点）是全局设置，参数卡里展示当前生效的一套 */
  const executionCost = useTrainingStore((s) => s.executionCost)
  const [rows, setRows] = useState<CompletedRow[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<number | null>(lastSelectedId)
  const [trades, setTrades] = useState<ClosedTrade[]>([])
  const [tradeLoading, setTradeLoading] = useState(false)
  /** 正在编辑思路 / 标签的那一笔（null = 没开编辑框） */
  const [editing, setEditing] = useState<ClosedTrade | null>(null)
  /** 刚从图表跳回来的那一笔，表格里留个高亮，方便接着往下看 */
  const highlightId = lastTradeId

  // 左侧列表是否显示（记住状态，和训练页的会话列表一个套路）
  const [listOpen, setListOpen] = useState<boolean>(
    () => localStorage.getItem(LIST_OPEN_KEY) !== '0'
  )
  useEffect(() => {
    localStorage.setItem(LIST_OPEN_KEY, listOpen ? '1' : '0')
  }, [listOpen])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const list = (await window.api.listCompletedSessions()) as CompletedRow[]
      setRows(list)
      setSelectedId((prev) => {
        if (prev != null && list.some((r) => r.id === prev)) return prev
        return list[0]?.id ?? null
      })
    } catch {
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // 记住「看的是哪一集」，切到图表再回来能接着看
  useEffect(() => {
    lastSelectedId = selectedId
  }, [selectedId])

  /**
   * 从图表回来时，把刚才那一笔滚到视野中间。
   *
   * 报告很长（参数卡 + 概览 + 曲线 + 时段分析 + 明细），回来时停在顶上，
   * 高亮那行在屏幕外面等于没做。等这一帧布局完再滚，否则表格还没渲染出来。
   */
  useEffect(() => {
    if (!highlightId || trades.length === 0) return
    const timer = setTimeout(() => {
      document
        .querySelector(`[data-trade-id="${CSS.escape(highlightId)}"]`)
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }, 60)
    return () => clearTimeout(timer)
  }, [highlightId, trades])

  useEffect(() => {
    if (selectedId == null) {
      setTrades([])
      return
    }
    let alive = true
    setTradeLoading(true)
    void window.api
      .listClosedTrades(selectedId)
      .then((rs: any[]) => {
        if (alive) setTrades((rs as any[]).map(rowToTrade))
      })
      .finally(() => {
        if (alive) setTradeLoading(false)
      })
    return () => {
      alive = false
    }
  }, [selectedId])

  const selected = useMemo(
    () => rows.find((r) => r.id === selectedId) ?? null,
    [rows, selectedId]
  )

  /** 点击交易：打开该回测集并把图表定位到对应 K 线 */
  const jumpToChart = async (trade: ClosedTrade): Promise<void> => {
    if (selectedId == null) return
    await useTrainingStore.getState().openSession(selectedId)
    /**
     * 必须确认目标回测集真的打开成功了再定位。
     * 打开失败（数据集被删、库读不到…）时 activeSession 还是上一个，
     * 这时候把交易塞进去，图表就会对着一份不相干的 K 线去定位 ——
     * 价位、时间全对不上，还容易把视野拖到「未来」。
     */
    if (useTrainingStore.getState().activeSession?.id !== selectedId) return
    useTrainingStore.getState().focusTrade(trade)
    // 记下这一笔：回来时表格里高亮它，接着往下看不用重新找
    lastTradeId = trade.id
    // 告诉训练页「你是从日志点进来的」，那边会挂一个高亮的返回按钮
    useAppStore.getState().setJournalReturn(true)
    useAppStore.getState().setActivePane('training')
  }

  /** 保存一笔交易的思路与标签：先落库，成功了再改本地这份列表 */
  const saveTradeMeta = async (
    trade: ClosedTrade,
    note: string | null,
    tags: string[]
  ): Promise<boolean> => {
    if (selectedId == null) return false
    const ok = await useTrainingStore.getState().patchTradeMeta(selectedId, trade.id, { note, tags })
    if (ok) {
      setTrades((prev) => prev.map((x) => (x.id === trade.id ? { ...x, note, tags } : x)))
    }
    return ok
  }

  return (
    <div className="flex h-full">
      {/* 左：已完成的回测集 */}
      {listOpen ? (
      <aside className="flex w-[350px] shrink-0 flex-col border-r border-[var(--border-subtle)] bg-[var(--surface-1)]">
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-2">
          <BookOpen size={14} className="text-[var(--text-muted)]" />
          <span className="text-[13.5px] font-semibold text-[var(--text-primary)]">
            {t('journal.title')}
          </span>
          <span className="rounded bg-[var(--surface-3)] px-1.5 py-[1px] font-mono text-[11px] text-[var(--text-muted)]">
            {rows.length}
          </span>
          <button
            onClick={() => void load()}
            title={t('common.refresh')}
            className="ml-auto rounded p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-3)] hover:text-[var(--text-primary)]"
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : undefined} />
          </button>
          <button
            onClick={() => setListOpen(false)}
            title={t('journal.hideList')}
            className="rounded p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-3)] hover:text-[var(--text-primary)]"
          >
            <ChevronsLeft size={13} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {rows.length === 0 && !loading && (
            <div className="px-4 py-10 text-center">
              <CheckCircle2 size={28} className="mx-auto mb-2 text-[var(--text-faint)] opacity-40" />
              <p className="text-[13px] text-[var(--text-muted)]">{t('journal.empty.title')}</p>
              <p className="mt-1.5 text-[11.5px] leading-relaxed text-[var(--text-faint)]">
                {t('journal.empty.desc')}
              </p>
            </div>
          )}

          {rows.map((r) => {
            const active = r.id === selectedId
            const winRate = r.trade_count > 0 ? (r.win_count / r.trade_count) * 100 : 0
            const rangeText = `${fmtDate(r.start_time, r.tz ?? timezone)} ~ ${fmtDate(r.end_time, r.tz ?? timezone)}`
            // 自动生成的名字本身就带区间（「XAUUSD 2025-12-03~2025-12-04」），再单列一行就是重复；
            // 而且建会话时算的结束日和按 end_time 显示的日期可能差一天，两行并排会自相矛盾。
            // 所以只判断名字里「有没有日期区间这个东西」，有就不再显示那一行；用户改过名才补回来。
            const nameHasRange = /20\d{2}-\d{2}-\d{2}\s*[~～-]\s*20\d{2}-\d{2}-\d{2}/.test(r.name ?? '')
            const title =
              (r.name ?? '').trim() ||
              `${r.dataset_symbol ?? t('common.unknownSymbol')} ${r.display_timeframe ?? 'M1'}`
            return (
              <button
                key={r.id}
                onClick={() => setSelectedId(r.id)}
                title={`${title}\n${rangeText}`}
                className={clsx(
                  // items-stretch：button 的 UA 样式默认 align-items:center，会让子元素缩到内容宽度，
                  // 导致里面的 ml-auto 推不到右侧
                  'flex w-full flex-col items-stretch gap-1 border-b border-[var(--border-subtle)] px-3 py-2.5 text-left transition-colors',
                  active ? 'bg-[var(--c-accent-tint)]' : 'hover:bg-[var(--surface-2)]'
                )}
              >
                {/* 第 1 行：训练集名称（太长就省略，hover 看全称）+ 时区 */}
                <div className="flex w-full items-center gap-1.5">
                  <span
                    className={clsx(
                      'min-w-0 flex-1 truncate text-[13.5px] font-medium',
                      active ? 'text-[var(--c-accent)]' : 'text-[var(--text-primary)]'
                    )}
                  >
                    {title}
                  </span>
                  <span
                    className="shrink-0 rounded bg-[var(--surface-3)] px-1 py-[1px] font-mono text-[10px] text-[var(--text-faint)]"
                    title={t('journal.tzHint')}
                  >
                    {r.tz ?? timezone}
                  </span>
                </div>

                {/* 第 2 行：时间区间（名字里已含区间时不重复）+ 用时 + 完成时间 */}
                <div className="flex w-full items-center gap-2 font-mono text-[11px] text-[var(--text-faint)]">
                  {!nameHasRange && <span className="min-w-0 truncate">{rangeText}</span>}
                  <span className="ml-auto flex shrink-0 items-center gap-1.5">
                    <span>
                      {t('journal.spent', { time: formatSpentTime(r.train_seconds, locale) })}
                    </span>
                    <span className="text-[var(--text-faint)] opacity-50">·</span>
                    <span>{t('journal.completedAt', { time: fmtDateTime(r.completed_at, timezone) })}</span>
                  </span>
                </div>

                {/* 第 3 行：标的 / 周期 / 笔数 / 盈亏 / 胜率 */}
                <div className="flex w-full items-center gap-2 text-[12px]">
                  <span className="text-[var(--text-muted)]">
                    {r.dataset_symbol ?? t('common.unknownSymbol')}
                  </span>
                  <span className="rounded bg-[var(--surface-3)] px-1 py-[1px] text-[10.5px] text-[var(--text-faint)]">
                    {r.display_timeframe ?? 'M1'}
                  </span>
                  <span className="text-[var(--text-muted)]">
                    {t('common.tradesCount', { n: r.trade_count })}
                  </span>
                  <span
                    className={clsx(
                      'font-mono tabular-nums',
                      r.total_pnl > 0
                        ? 'text-[var(--c-neg)]'
                        : r.total_pnl < 0
                          ? 'text-[var(--c-pos)]'
                          : 'text-[var(--text-muted)]'
                    )}
                  >
                    {formatSigned(r.total_pnl)}
                  </span>
                  <span className="text-[var(--text-faint)]">
                    {t('journal.winRate', { rate: winRate.toFixed(0) })}
                  </span>
                </div>
              </button>
            )
          })}
        </div>
      </aside>
      ) : (
        <div className="flex w-8 shrink-0 flex-col items-center gap-2 border-r border-[var(--border-subtle)] bg-[var(--surface-1)] py-2">
          <button
            onClick={() => setListOpen(true)}
            title={t('journal.showList')}
            className="flex h-6 w-6 items-center justify-center rounded text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-3)] hover:text-[var(--text-primary)]"
          >
            <ChevronsRight size={13} />
          </button>
        </div>
      )}

      {/* 右：报告详情 */}
      <section className="flex min-w-0 flex-1 flex-col bg-[var(--surface-0)]">
        {!selected ? (
          <div className="flex flex-1 items-center justify-center">
            <div className="text-center">
              <LineChart size={36} className="mx-auto mb-3 text-[var(--text-faint)] opacity-30" />
              <p className="text-[13.5px] text-[var(--text-muted)]">{t('journal.pick.title')}</p>
              <p className="mt-1.5 text-[12px] text-[var(--text-faint)]">{t('journal.pick.desc')}</p>
            </div>
          </div>
        ) : (
          <>
            <div className="flex shrink-0 items-start gap-3 border-b border-[var(--border-subtle)] px-4 py-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h2
                    className="min-w-0 truncate text-[16px] font-semibold text-[var(--text-primary)]"
                    title={selected.name ?? undefined}
                  >
                    {(selected.name ?? '').trim() ||
                      selected.dataset_symbol ||
                      t('journal.unknownSession')}
                  </h2>
                  <span className="shrink-0 rounded bg-[var(--surface-3)] px-1.5 py-[1px] text-[11px] text-[var(--text-muted)]">
                    {selected.dataset_symbol ?? t('common.unknownSymbol')} ·{' '}
                    {selected.display_timeframe ?? 'M1'}
                  </span>
                  <span className="flex shrink-0 items-center gap-1 rounded bg-[var(--c-pos-tint)] px-1.5 py-[1px] text-[10.5px] text-[var(--c-pos)]">
                    <CheckCircle2 size={10} />
                    {t('journal.done')}
                  </span>
                </div>
                <p className="mt-1 text-[12px] text-[var(--text-muted)]">
                  {fmtDate(selected.start_time, selected.tz ?? timezone)} ~{' '}
                  {fmtDate(selected.end_time, selected.tz ?? timezone)}
                  {/* 用时 / 初始资金 / 其余设置都收在下面的「训练参数」卡里，这里不重复 */}
                </p>
              </div>
              <button
                onClick={() => {
                  void (async () => {
                    await useTrainingStore.getState().openSession(selected.id)
                    useAppStore.getState().setActivePane('training')
                  })()
                }}
                className="ml-auto flex shrink-0 items-center gap-1 rounded-md border border-[var(--border-strong)] px-2.5 py-1 text-[12.5px] text-[var(--text-secondary)] transition-colors hover:border-[var(--text-muted)] hover:text-[var(--text-primary)]"
              >
                {t('journal.backToChart')}
                <ArrowUpRight size={13} />
              </button>
            </div>

            {tradeLoading ? (
              <div className="flex flex-1 items-center justify-center text-[13px] text-[var(--text-muted)]">
                {t('journal.loadingTrades')}
              </div>
            ) : (
              <ReportContent
                sessionName={selected.name}
                symbol={selected.dataset_symbol ?? ''}
                timeframe={selected.display_timeframe ?? 'M1'}
                initialBalance={selected.initial_balance}
                finalBalance={selected.balance}
                riskPerTrade={(selected as any).risk_per_trade ?? null}
                trades={trades}
                onSelectTrade={(tr) => void jumpToChart(tr)}
                onEditTrade={(tr) => setEditing(tr)}
                highlightTradeId={highlightId}
                topSlot={
                  <SessionParamsCard
                    symbol={selected.dataset_symbol ?? ''}
                    datasetTimeframe={selected.dataset_timeframe ?? null}
                    datasetBarCount={selected.dataset_bar_count ?? null}
                    startTime={selected.start_time}
                    endTime={selected.end_time}
                    displayTimeframe={selected.display_timeframe}
                    tz={selected.tz ?? timezone}
                    initialBalance={selected.initial_balance}
                    finalBalance={selected.balance}
                    lotSize={selected.lot_size ?? 0.1}
                    riskPerTrade={selected.risk_per_trade ?? null}
                    tradeWindow={selected.trade_window ?? null}
                    indicatorsJson={selected.indicators_json ?? null}
                    drawingsJson={selected.drawings_json ?? null}
                    trainSeconds={selected.train_seconds ?? null}
                    createdAt={selected.created_at ?? null}
                    completedAt={selected.completed_at ?? null}
                    executionCost={executionCost}
                  />
                }
              />
            )}
          </>
        )}
      </section>

      {/* 编辑某笔交易的思路 / 标签 */}
      {editing && (
        <TradeMetaDialog
          trade={editing}
          tz={selected?.tz ?? timezone}
          onClose={() => setEditing(null)}
          onSave={(note, tags) => saveTradeMeta(editing, note, tags)}
        />
      )}
    </div>
  )
}
