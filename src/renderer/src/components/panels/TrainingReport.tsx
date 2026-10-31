import React, { useMemo } from 'react'
import {
  X,
  TrendingUp,
  Target,
  Activity,
  AlertTriangle,
  ArrowUpRight,
  ArrowDownRight,
  Pencil
} from 'lucide-react'
import clsx from 'clsx'
import type { ClosedTrade } from '../../stores/training-store'
import { formatPrice, formatSigned } from '../../utils/format'
import { useTimezoneStore } from '../../stores/timezone-store'
import { tzPartsFromSec } from '@shared/types/timezone'
import { useT } from '../../i18n'
import { TagFilter, useTagFilter } from '../common/TagFilter'
import { TradeTimeEdge } from './TradeTimeEdge'

interface Props {
  sessionName: string
  symbol: string
  timeframe: string
  initialBalance: number
  finalBalance: number
  /** 单笔风险（金额）= 1R；缺省按初始资金的 1% */
  riskPerTrade?: number | null
  trades: ClosedTrade[]
  onClose: () => void
  onSelectTrade: (trade: ClosedTrade) => void
  /** 编辑这笔交易的思路 / 标签（只有日志页给了，训练页的报告不给编辑） */
  onEditTrade?: (trade: ClosedTrade) => void
  /** 刚跳转出去看图表的那一笔：回来时高亮一下，方便接着往下看 */
  highlightTradeId?: string | null
  /** 报告最上方插入的自定义区块（日志页用来放「训练参数」卡片） */
  topSlot?: React.ReactNode
}

function money(n: number): string {
  const sign = n < 0 ? '-' : ''
  return `${sign}$${Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`
}

/** R 的展示：+2.50R / -1.00R */
function fmtR(n: number): string {
  if (!Number.isFinite(n)) return '--'
  const sign = n > 0 ? '+' : n < 0 ? '-' : ''
  return `${sign}${Math.abs(n).toFixed(2)}R`
}

/** 订单时间 MM-DD HH:mm，按设置时区（默认 UTC+8） */
function fmtTime(ts: number, tz: string): string {
  const parts = tzPartsFromSec(ts, tz)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(parts.month)}-${p(parts.day)} ${p(parts.hour)}:${p(parts.minute)}`
}

export function ReportContent({
  sessionName,
  symbol,
  timeframe,
  initialBalance,
  finalBalance,
  riskPerTrade,
  trades,
  onSelectTrade,
  onEditTrade,
  highlightTradeId,
  topSlot
}: Omit<Props, 'onClose'>): React.JSX.Element {
  const { t } = useT()
  /** 订单时间统一按当前生效时区显示（会话自己的时区，没有则全局默认 UTC+8） */
  const timezone = useTimezoneStore((s) => s.effective)
  /** 1R 的金额：会话里设定的单笔风险，老会话按初始资金 1% 兜底 */
  const risk =
    riskPerTrade && riskPerTrade > 0 ? riskPerTrade : Math.max(1, initialBalance * 0.01)

  /**
   * 按订单标签筛选：统计口径跟着筛选走，方便只看某一类单子表现。
   * 支持多选，选中多个时取交集（一笔要带上所有选中标签才算命中）。
   */
  const { selected, toggle, select, label, tags, counts, filtered, filtering } =
    useTagFilter(trades)

  const stats = useMemo(() => {
    const list = filtered
    const wins = list.filter((trade) => trade.pnl > 0)
    const losses = list.filter((trade) => trade.pnl < 0)
    const grossWin = wins.reduce((s, trade) => s + trade.pnl, 0)
    const grossLoss = Math.abs(losses.reduce((s, trade) => s + trade.pnl, 0))
    // 未筛选时用会话余额差（含隐性成本），筛选后只能用子集盈亏求和
    const totalPnl = filtering
      ? list.reduce((s, trade) => s + trade.pnl, 0)
      : finalBalance - initialBalance
    /** 这批单子被成本吃掉的钱（手续费；滑点已经体现在成交价里，算在价差盈亏内） */
    const commission = list.reduce((s, trade) => s + (trade.commission ?? 0), 0)

    // 权益曲线（金额）+ 最大回撤：筛选后从初始资金重新起算「只做这些单」的曲线
    let equity = initialBalance
    let peak = initialBalance
    let maxDd = 0
    const curve: number[] = [initialBalance]
    for (const trade of list) {
      equity += trade.pnl
      curve.push(equity)
      if (equity > peak) peak = equity
      const dd = peak - equity
      if (dd > maxDd) maxDd = dd
    }

    // R 曲线：每笔盈亏 ÷ 单笔风险，累加
    let r = 0
    let rPeak = 0
    let maxDdR = 0
    const rCurve: number[] = [0]
    const rList: number[] = []
    for (const trade of list) {
      const tradeR = trade.pnl / risk
      rList.push(tradeR)
      r += tradeR
      rCurve.push(r)
      if (r > rPeak) rPeak = r
      const ddR = rPeak - r
      if (ddR > maxDdR) maxDdR = ddR
    }

    return {
      totalPnl,
      commission,
      returnPct: initialBalance > 0 ? (totalPnl / initialBalance) * 100 : 0,
      winRate: list.length > 0 ? (wins.length / list.length) * 100 : 0,
      wins: wins.length,
      losses: losses.length,
      count: list.length,
      avgWin: wins.length > 0 ? grossWin / wins.length : 0,
      avgLoss: losses.length > 0 ? grossLoss / losses.length : 0,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : wins.length > 0 ? Infinity : 0,
      maxDrawdown: maxDd,
      maxDdPct: peak > 0 ? (maxDd / peak) * 100 : 0,
      curve,
      // R 口径
      rList,
      rCurve,
      totalR: r,
      maxDdR,
      avgR: list.length > 0 ? r / list.length : 0,
      avgWinR: wins.length > 0 ? grossWin / wins.length / risk : 0,
      avgLossR: losses.length > 0 ? grossLoss / losses.length / risk : 0,
      bestR: rList.length > 0 ? Math.max(...rList) : 0,
      worstR: rList.length > 0 ? Math.min(...rList) : 0
    }
  }, [filtered, filtering, initialBalance, finalBalance, risk])

  const positive = stats.totalPnl >= 0
  const accent = positive ? 'var(--c-neg)' : 'var(--c-pos)' // 红涨绿跌

  // SVG 曲线（R 口径，基线 0R）
  const chart = useMemo(() => {
    const w = 1000
    const h = 180
    const values = stats.rCurve
    if (values.length < 2) return null
    const min = Math.min(0, ...values)
    const max = Math.max(0, ...values)
    const span = max - min || 1
    const pad = 10
    const x = (i: number) => (i / (values.length - 1)) * w
    const y = (v: number) => pad + (1 - (v - min) / span) * (h - pad * 2)
    const line = values.map((v, i) => `${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(' ')
    const zeroY = y(0)
    const area = `0,${zeroY} ${line} ${w},${zeroY}`
    return { w, h, line, area, baseY: zeroY }
  }, [stats.rCurve])

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {/* 调用方插入的区块（日志页放训练参数卡），跟着报告一起滚动 */}
          {topSlot && <div className="mb-3">{topSlot}</div>}

          {/* 概览 */}
          <div className="grid grid-cols-5 gap-2.5">
            <Metric
              label={t('report.metric.totalR')}
              value={fmtR(stats.totalR)}
              sub={t('report.metric.totalRSub', {
                pnl: `${stats.totalPnl >= 0 ? '+' : ''}${money(stats.totalPnl)}`,
                risk: money(risk)
              })}
              tone={stats.totalR >= 0 ? 'pos' : 'neg'}
              icon={<TrendingUp size={14} />}
            />
            <Metric
              label={t('report.metric.perTrade')}
              value={fmtR(stats.avgR)}
              sub={t('report.metric.perTradeSub', {
                best: fmtR(stats.bestR),
                worst: fmtR(stats.worstR)
              })}
              tone={stats.avgR >= 0 ? 'pos' : 'neg'}
              icon={<ArrowUpRight size={14} />}
            />
            <Metric
              label={t('report.metric.winRate')}
              value={`${stats.winRate.toFixed(0)}%`}
              sub={t('report.metric.winRateSub', { wins: stats.wins, losses: stats.losses })}
              icon={<Target size={14} />}
            />
            <Metric
              label={t('report.metric.profitFactor')}
              value={
                Number.isFinite(stats.profitFactor)
                  ? stats.profitFactor.toFixed(2)
                  : '∞'
              }
              sub={t('report.metric.profitFactorSub', {
                win: fmtR(stats.avgWinR),
                loss: fmtR(-stats.avgLossR)
              })}
              icon={<Activity size={14} />}
            />
            <Metric
              label={t('report.metric.maxDrawdown')}
              value={fmtR(-stats.maxDdR)}
              sub={`${money(stats.maxDrawdown)} · ${stats.maxDdPct.toFixed(1)}%`}
              tone={stats.maxDdR > 0 ? 'neg' : undefined}
              icon={<AlertTriangle size={14} />}
            />
          </div>

          {/* 收益曲线（R 口径） */}
          <div className="mt-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-0)] p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)]">
                {t('report.curve.title')}
              </span>
              <span className="font-mono text-[11px] text-[var(--text-faint)]">
                {t('report.curve.summary', {
                  total: fmtR(stats.totalR),
                  n: stats.count,
                  risk: money(risk)
                })}
                {stats.commission > 0 && (
                  <span title={t('report.curve.commissionHint')}>
                    {' '}
                    · {t('report.curve.commission', { amount: money(stats.commission) })}
                  </span>
                )}
              </span>
            </div>

            {chart ? (
              <div className="relative h-[150px]">
                <svg
                  viewBox={`0 0 ${chart.w} ${chart.h}`}
                  preserveAspectRatio="none"
                  className="h-full w-full"
                >
                  <line
                    x1={0}
                    x2={chart.w}
                    y1={chart.baseY}
                    y2={chart.baseY}
                    stroke="rgba(255,255,255,0.18)"
                    strokeDasharray="6 5"
                    strokeWidth={1}
                  />
                  <polygon points={chart.area} fill={accent} opacity={0.12} />
                  <polyline
                    points={chart.line}
                    fill="none"
                    stroke={accent}
                    strokeWidth={2}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                </svg>
              </div>
            ) : (
              <div className="py-10 text-center text-[12px] text-[var(--text-faint)]">
                {t('report.curve.empty')}
              </div>
            )}
          </div>

          {/* 交易时段分析：哪个小时最容易赚钱。口径跟着上面的标签筛选一起走 */}
          <TradeTimeEdge trades={filtered} tz={timezone} risk={risk} />

          {/* 交易明细 */}
          <div className="mt-3">
            <div className="mb-1.5 flex flex-wrap items-center gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)]">
                {t('report.trades.title')}
              </span>
              <span className="text-[11px] text-[var(--text-faint)]">
                {onEditTrade ? t('report.trades.hintEditable') : t('report.trades.hint')}
              </span>
              {filtering && (
                <span className="text-[11px] text-[var(--c-accent)]">
                  {t('report.trades.filteredCount', {
                    tags: label,
                    n: stats.count,
                    total: trades.length
                  })}
                </span>
              )}
            </div>

            {tags.length > 0 && (
              <div className="mb-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-0)] px-2.5 py-1.5">
                <TagFilter
                  tags={tags}
                  counts={counts}
                  value={selected}
                  onChange={select}
                  total={trades.length}
                />
              </div>
            )}

            {trades.length === 0 ? (
              <div className="rounded-lg border border-dashed border-[var(--border-subtle)] py-10 text-center text-[12px] text-[var(--text-faint)]">
                {t('report.trades.empty')}
              </div>
            ) : filtered.length === 0 ? (
              <div className="rounded-lg border border-dashed border-[var(--border-subtle)] py-10 text-center text-[12px] text-[var(--text-faint)]">
                {t('report.trades.emptyFiltered', { tags: label })}
              </div>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-[var(--border-subtle)]">
                <table className="w-full text-left">
                  <thead className="bg-[var(--surface-2)]">
                    <tr className="text-[10px] uppercase tracking-wider text-[var(--text-faint)]">
                      <th className="px-2.5 py-1.5 font-medium">#</th>
                      <th className="px-2.5 py-1.5 font-medium">
                        {t('report.col.open')}
                        <span className="ml-0.5 normal-case opacity-70">({timezone})</span>
                      </th>
                      <th className="px-2.5 py-1.5 font-medium">{t('report.col.close')}</th>
                      <th className="px-2.5 py-1.5 font-medium">{t('report.col.side')}</th>
                      <th className="px-2.5 py-1.5 text-right font-medium">
                        {t('report.col.lots')}
                      </th>
                      <th className="px-2.5 py-1.5 text-right font-medium">
                        {t('report.col.entry')}
                      </th>
                      <th className="px-2.5 py-1.5 text-right font-medium">
                        {t('report.col.exit')}
                      </th>
                      <th className="px-2.5 py-1.5 text-right font-medium">R</th>
                      <th className="px-2.5 py-1.5 font-medium">{t('report.col.reason')}</th>
                      <th className="px-2.5 py-1.5 font-medium">{t('report.col.tags')}</th>
                      <th className="px-2.5 py-1.5 text-right font-medium">
                        {t('report.col.pnl')}
                      </th>
                      <th className="px-2.5 py-1.5 font-medium">{t('report.col.note')}</th>
                      {onEditTrade && (
                        <th className="px-1.5 py-1.5 text-center font-medium">
                          {t('report.col.edit')}
                        </th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((trade, i) => (
                      <tr
                        key={trade.id}
                        data-trade-id={trade.id}
                        onClick={() => onSelectTrade(trade)}
                        className={clsx(
                          'cursor-pointer border-t border-[var(--border-subtle)] text-[12px] transition-colors hover:bg-[var(--c-accent-tint)]',
                          // 刚从图 K 线跳回来的那一笔：留一条左侧色条，眼睛能找到落点
                          highlightTradeId === trade.id &&
                            'bg-[var(--c-accent-tint)] shadow-[inset_2px_0_0_0_var(--c-accent)]'
                        )}
                        title={t('report.row.jumpHint')}
                      >
                        <td className="px-2.5 py-1 font-mono text-[var(--text-faint)]">{i + 1}</td>
                        <td
                          className="px-2.5 py-1 font-mono tabular-nums text-[var(--text-muted)]"
                          title={
                            trade.openLocal
                              ? trade.tz
                                ? t('report.row.openRecordTz', {
                                    time: trade.openLocal,
                                    tz: trade.tz
                                  })
                                : t('report.row.openRecord', { time: trade.openLocal })
                              : undefined
                          }
                        >
                          {fmtTime(trade.entryTime, timezone)}
                        </td>
                        <td
                          className="px-2.5 py-1 font-mono tabular-nums text-[var(--text-muted)]"
                          title={
                            trade.closeLocal
                              ? trade.tz
                                ? t('report.row.closeRecordTz', {
                                    time: trade.closeLocal,
                                    tz: trade.tz
                                  })
                                : t('report.row.closeRecord', { time: trade.closeLocal })
                              : undefined
                          }
                        >
                          {fmtTime(trade.exitTime, timezone)}
                        </td>
                        <td className="px-2.5 py-1">
                          <span
                            className={clsx(
                              'inline-flex items-center gap-0.5 rounded px-1 py-px text-[10.5px] font-medium',
                              trade.side === 'buy'
                                ? 'bg-[var(--c-neg-tint)] text-[var(--c-neg)]'
                                : 'bg-[var(--c-pos-tint)] text-[var(--c-pos)]'
                            )}
                          >
                            {trade.side === 'buy' ? (
                              <ArrowUpRight size={10} />
                            ) : (
                              <ArrowDownRight size={10} />
                            )}
                            {trade.side === 'buy' ? t('report.side.long') : t('report.side.short')}
                          </span>
                        </td>
                        <td className="px-2.5 py-1 text-right font-mono tabular-nums text-[var(--text-secondary)]">
                          {trade.lot.toFixed(2)}
                        </td>
                        <td className="px-2.5 py-1 text-right font-mono tabular-nums text-[var(--text-secondary)]">
                          {formatPrice(trade.entryPrice, trade.digits)}
                        </td>
                        <td className="px-2.5 py-1 text-right font-mono tabular-nums text-[var(--text-secondary)]">
                          {formatPrice(trade.exitPrice, trade.digits)}
                        </td>
                        <td
                          className={clsx(
                            'px-2.5 py-1 text-right font-mono font-semibold tabular-nums',
                            trade.pnl >= 0 ? 'text-[var(--c-neg)]' : 'text-[var(--c-pos)]'
                          )}
                          title={`${money(trade.pnl)} ÷ ${money(risk)}`}
                        >
                          {fmtR(trade.pnl / risk)}
                        </td>
                        <td className="px-2.5 py-1 text-[11px] text-[var(--text-muted)]">
                          {trade.reason === 'sl'
                            ? t('report.reason.sl')
                            : trade.reason === 'tp'
                              ? t('report.reason.tp')
                              : trade.reason === 'trail'
                                ? t('report.reason.trail')
                                : trade.reason === 'partial'
                                  ? t('report.reason.partial')
                                  : t('report.reason.manual')}
                        </td>
                        <td className="px-2.5 py-1">
                          {trade.tags.length > 0 ? (
                            <span className="flex flex-wrap gap-1">
                              {trade.tags.map((g) => {
                                const active = selected.includes(g)
                                return (
                                  <button
                                    key={g}
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      // 和筛选条一致：点一下点亮，再点一下取消
                                      toggle(g)
                                    }}
                                    title={
                                      active
                                        ? t('tagFilter.offHint', { tag: g })
                                        : t('tagFilter.onHint', { tag: g })
                                    }
                                    className={clsx(
                                      'rounded border px-1 py-px text-[10.5px] leading-none transition-colors',
                                      active
                                        ? 'border-[var(--c-accent)] bg-[var(--c-accent-tint)] text-[var(--c-accent)]'
                                        : 'border-[var(--border-subtle)] bg-[var(--surface-2)] text-[var(--text-muted)] hover:border-[var(--c-accent)] hover:text-[var(--c-accent)]'
                                    )}
                                  >
                                    {g}
                                  </button>
                                )
                              })}
                            </span>
                          ) : (
                            <span className="text-[11px] text-[var(--text-faint)]">—</span>
                          )}
                        </td>
                        <td
                          className={clsx(
                            'px-2.5 py-1 text-right font-mono tabular-nums',
                            trade.pnl >= 0 ? 'text-[var(--c-neg)]' : 'text-[var(--c-pos)]'
                          )}
                        >
                          {formatSigned(trade.pnl)}
                        </td>
                        <td className="max-w-[240px] px-2.5 py-1 text-[11.5px] text-[var(--text-muted)]">
                          {trade.note ? (
                            <span
                              className="line-clamp-2 whitespace-pre-wrap break-words"
                              title={trade.note}
                            >
                              {trade.note}
                            </span>
                          ) : (
                            <span className="text-[var(--text-faint)]">—</span>
                          )}
                        </td>
                        {onEditTrade && (
                          <td className="px-1.5 py-1 text-center">
                            <button
                              onClick={(e) => {
                                // 别触发整行的「跳到图表」
                                e.stopPropagation()
                                onEditTrade(trade)
                              }}
                              title={t('report.row.editHint')}
                              className="rounded p-1 text-[var(--text-faint)] transition-colors hover:bg-[var(--surface-3)] hover:text-[var(--c-accent)]"
                            >
                              <Pencil size={11} />
                            </button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
    </div>
  )
}

/** 弹窗版训练报告（训练页使用） */
export function TrainingReport(props: Props): React.JSX.Element {
  const { t } = useT()
  const risk =
    props.riskPerTrade && props.riskPerTrade > 0
      ? props.riskPerTrade
      : Math.max(1, props.initialBalance * 0.01)
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="flex h-full max-h-[760px] w-full max-w-[1080px] flex-col overflow-hidden rounded-xl border border-[var(--border-strong)] bg-[var(--surface-1)] shadow-2xl">
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-[var(--border-subtle)] px-4 py-3">
          <div>
            <h2 className="text-[16px] font-semibold text-[var(--text-primary)]">
              {t('report.title')}
            </h2>
            <p className="mt-0.5 text-[12px] text-[var(--text-muted)]">
              {t('report.header', {
                name: props.sessionName,
                symbol: props.symbol,
                tf: props.timeframe,
                n: props.trades.length,
                risk: money(risk)
              })}
            </p>
          </div>
          <button
            onClick={props.onClose}
            className="rounded-md p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-3)] hover:text-[var(--text-primary)]"
          >
            <X size={16} />
          </button>
        </div>
        <ReportContent {...props} />
      </div>
    </div>
  )
}

function Metric({
  label,
  value,
  sub,
  tone,
  icon
}: {
  label: string
  value: string
  sub?: string
  tone?: 'pos' | 'neg'
  icon?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-0)] px-2.5 py-2">
      <div className="flex items-center gap-1 text-[10.5px] text-[var(--text-faint)]">
        {icon}
        {label}
      </div>
      <div
        className={clsx(
          'mt-0.5 font-mono text-[15.5px] font-semibold tabular-nums',
          tone === 'pos'
            ? 'text-[var(--c-neg)]'
            : tone === 'neg'
              ? 'text-[var(--c-pos)]'
              : 'text-[var(--text-primary)]'
        )}
      >
        {value}
      </div>
      {sub && <div className="mt-0.5 truncate text-[10px] text-[var(--text-faint)]">{sub}</div>}
    </div>
  )
}
