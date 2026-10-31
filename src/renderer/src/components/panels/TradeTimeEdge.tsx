// ============================================================
// TraderRewind — 交易时段分析（报告里的一小块）
//
// 回答一个问题：这个回测集里，**哪个小时最容易赚钱**？
// 只做统计和展示，不碰任何数据；口径跟着报告上方的标签筛选走。
// ============================================================

import React, { useMemo } from 'react'
import clsx from 'clsx'
import { Clock3, TrendingUp, TrendingDown } from 'lucide-react'
import type { ClosedTrade } from '../../stores/training-store'
import { formatSigned } from '../../utils/format'
import { tzPartsFromSec } from '@shared/types/timezone'
import { useT } from '../../i18n'

interface Props {
  trades: ClosedTrade[]
  /** 显示时区（和订单表一致，默认 UTC+8） */
  tz: string
  /** 1R 的金额，用来算每小时的均值 R */
  risk: number
}

interface HourStat {
  hour: number
  n: number
  wins: number
  pnl: number
  r: number
}

/** 一个小时内至少要几笔，才允许它当「最容易赚钱」——太少的样本纯属运气 */
const MIN_SAMPLE = 2

function p2(n: number): string {
  return String(n).padStart(2, '0')
}

export function TradeTimeEdge({ trades, tz, risk }: Props): React.JSX.Element {
  const { t } = useT()

  /**
   * 按「开仓时的小时」分组。
   *
   * 用开仓时间而不是平仓时间：用户想找的是「什么时候进场最容易赚」，
   * 一笔跨小时的持仓（22:50 进、次日 01:30 出）归到进场那小时才有意义。
   */
  const hours = useMemo(() => {
    const map = new Map<number, HourStat>()
    for (const trade of trades) {
      const h = tzPartsFromSec(trade.entryTime, tz).hour
      const cur = map.get(h) ?? { hour: h, n: 0, wins: 0, pnl: 0, r: 0 }
      cur.n += 1
      cur.pnl += trade.pnl
      cur.r += trade.pnl / risk
      if (trade.pnl > 0) cur.wins += 1
      map.set(h, cur)
    }
    return [...map.values()].sort((a, b) => a.hour - b.hour)
  }, [trades, tz, risk])

  /** 样本足够的小时（不够就退回全部，并在界面上说明） */
  const ranked = useMemo(() => {
    const solid = hours.filter((h) => h.n >= MIN_SAMPLE)
    const pool = solid.length > 0 ? solid : hours
    const byPnl = [...pool].sort((a, b) => b.pnl - a.pnl)
    return { best: byPnl[0], worst: byPnl[byPnl.length - 1], solid: solid.length > 0, pool }
  }, [hours])

  const maxAbs = useMemo(
    () => hours.reduce((m, h) => Math.max(m, Math.abs(h.pnl)), 0),
    [hours]
  )

  if (trades.length === 0) {
    return (
      <div className="mt-3 rounded-lg border border-dashed border-[var(--border-subtle)] py-6 text-center text-[12px] text-[var(--text-faint)]">
        {t('report.edge.empty')}
      </div>
    )
  }

  const { best, worst, solid, pool } = ranked
  const pct = (h: HourStat): number => (h.n > 0 ? (h.wins / h.n) * 100 : 0)
  /** 时间段标签：14 时 → 「14:00–15:00」 */
  const span = (h: number): string =>
    `${p2(h)}:00–${h === 23 ? '00' : p2(h + 1)}:00`

  /** 前 3 名（赚得最多的三个小时），给一个紧凑排行 */
  const top = [...pool].sort((a, b) => b.pnl - a.pnl).slice(0, 3)

  return (
    <div className="mt-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-0)] p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Clock3 size={12} className="text-[var(--text-muted)]" />
        <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)]">
          {t('report.edge.title')}
        </span>
        <span className="text-[11px] text-[var(--text-faint)]">{t('report.edge.hint', { tz })}</span>
      </div>

      {/* 结论：最容易赚钱 / 最亏钱的那一个小时 */}
      <div className="grid grid-cols-2 gap-2">
        <HourCallout
          tone="best"
          label={t('report.edge.best')}
          span={best ? span(best.hour) : '--'}
          detail={
            best
              ? t('report.edge.stat', {
                  n: best.n,
                  rate: pct(best).toFixed(0),
                  pnl: formatSigned(best.pnl)
                })
              : '--'
          }
          extra={best ? t('report.edge.avgR', { r: (best.r / Math.max(1, best.n)).toFixed(2) }) : ''}
        />
        <HourCallout
          tone="worst"
          label={t('report.edge.worst')}
          span={worst && worst.hour !== best?.hour ? span(worst.hour) : '--'}
          detail={
            worst && worst.hour !== best?.hour
              ? t('report.edge.stat', {
                  n: worst.n,
                  rate: pct(worst).toFixed(0),
                  pnl: formatSigned(worst.pnl)
                })
              : '--'
          }
          extra={
            worst && worst.hour !== best?.hour
              ? t('report.edge.avgR', { r: (worst.r / Math.max(1, worst.n)).toFixed(2) })
              : ''
          }
        />
      </div>

      {/* 样本提醒：结论是“哪一小时”，样本太少就得说清楚 */}
      {(!solid || (best && best.n < 3)) && (
        <div className="mt-1.5 text-[10.5px] text-[var(--text-faint)]">
          {solid ? t('report.edge.lowSample', { n: best?.n ?? 0 }) : t('report.edge.fallbackAll')}
        </div>
      )}

      {/* 24 小时柱状图：0 轴居中，赚的红、亏的绿（红涨绿跌） */}
      <div className="mt-2.5 flex items-end gap-[3px]">
        {Array.from({ length: 24 }, (_, h) => {
          const stat = hours.find((x) => x.hour === h)
          const isBest = best != null && best.hour === h && stat != null
          const h2 = maxAbs > 0 && stat ? (Math.abs(stat.pnl) / maxAbs) * 30 : 0
          const up = stat != null && stat.pnl >= 0
          return (
            <div
              key={h}
              className="flex min-w-0 flex-1 flex-col items-center"
              title={
                stat
                  ? `${span(h)} · ${t('report.edge.stat', {
                      n: stat.n,
                      rate: pct(stat).toFixed(0),
                      pnl: formatSigned(stat.pnl)
                    })}`
                  : `${span(h)} · ${t('report.edge.none')}`
              }
            >
              {/* 上半：盈利柱从 0 轴往上长 */}
              <div className="flex h-[30px] w-full items-end justify-center">
                {stat && up && (
                  <div
                    className={clsx(
                      'w-full rounded-t-sm bg-[var(--c-neg)] transition-[height] duration-200',
                      // 主题色是十六进制，#rrggbb/40 这种透明度写法 Tailwind 生成不出来，
                      // 必须退回 opacity 工具类，否则柱子直接看不见
                      !isBest && 'opacity-50'
                    )}
                    style={{ height: `${Math.max(2, h2)}px` }}
                  />
                )}
              </div>
              <div
                className={clsx(
                  'h-px w-full',
                  isBest ? 'bg-[var(--c-accent)]' : 'bg-[var(--border-strong)]'
                )}
              />
              {/* 下半：亏损柱从 0 轴往下长 */}
              <div className="flex h-[30px] w-full items-start justify-center">
                {stat && !up && (
                  <div
                    className="w-full rounded-b-sm bg-[var(--c-pos)] opacity-50 transition-[height] duration-200"
                    style={{ height: `${Math.max(2, h2)}px` }}
                  />
                )}
              </div>
              <span
                className={clsx(
                  'mt-1 font-mono text-[9px] leading-none',
                  isBest ? 'text-[var(--c-accent)]' : 'text-[var(--text-faint)]'
                )}
              >
                {h % 3 === 0 ? p2(h) : ''}
              </span>
            </div>
          )
        })}
      </div>

      {/* 排行：赚得最多的三个小时，点不着（纯粹给结论做支撑） */}
      {top.length > 1 && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--border-subtle)] pt-2 text-[10.5px]">
          <span className="text-[var(--text-faint)]">{t('report.edge.rankTitle')}</span>
          {top.map((h, i) => (
            <span key={h.hour} className="flex items-center gap-1 font-mono tabular-nums">
              <span className="text-[var(--text-faint)]">{i + 1}.</span>
              <span
                className={
                  h.pnl >= 0 ? 'text-[var(--text-secondary)]' : 'text-[var(--text-muted)]'
                }
              >
                {span(h.hour)}
              </span>
              <span className={h.pnl >= 0 ? 'text-[var(--c-neg)]' : 'text-[var(--c-pos)]'}>
                {formatSigned(h.pnl)}
              </span>
              <span className="text-[var(--text-faint)]">({h.n})</span>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

/** 结论条：最赚 / 最亏各一条 */
function HourCallout({
  tone,
  label,
  span,
  detail,
  extra
}: {
  tone: 'best' | 'worst'
  label: string
  span: string
  detail: string
  extra: string
}): React.JSX.Element {
  const best = tone === 'best'
  return (
    <div
      className={clsx(
        'rounded-md border px-2.5 py-1.5',
        best
          ? 'border-[var(--c-neg)] bg-[var(--c-neg-tint)]'
          : 'border-[var(--border-subtle)] bg-[var(--surface-1)]'
      )}
    >
      <div
        className={clsx(
          'flex items-center gap-1 text-[10px]',
          best ? 'text-[var(--c-neg)]' : 'text-[var(--text-faint)]'
        )}
      >
        {best ? <TrendingUp size={10} /> : <TrendingDown size={10} />}
        {label}
      </div>
      <div className="mt-0.5 flex items-baseline gap-1.5">
        <span
          className={clsx(
            'font-mono text-[15px] font-semibold tabular-nums',
            best ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'
          )}
        >
          {span}
        </span>
        {extra && <span className="text-[10px] text-[var(--text-faint)]">{extra}</span>}
      </div>
      <div className="mt-0.5 truncate text-[10.5px] text-[var(--text-muted)]">{detail}</div>
    </div>
  )
}
