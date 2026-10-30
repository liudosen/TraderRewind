// ============================================================
// TraderRewind — 日志详情里的「训练参数」卡片
//
// 建立一次回测时用户其实设了不少东西：标的 / 数据周期 / 回放区间 / 显示周期 /
// 单笔风险 / 交易时段 / 时区 / 初始资金 / 手数 / 指标参数 / 画线 / 成本模型，
// 还有这次到底花了多长时间。这些以前只在训练页的选单里能看到，日志里翻历史
// 回测时全丢了，只能靠记忆。
//
// 这里把它们按「数据与区间 / 账户与风控 / 图表与指标 / 时间」四组平铺出来，
// 只读、不做任何修改。
// ============================================================

import React, { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, SlidersHorizontal } from 'lucide-react'
import { indicatorTitle } from '@shared/utils/indicators'
import { normalizeIndicatorPrefs } from '@shared/types/indicator-prefs'
import { normalizeTradeWindow } from '@shared/types/trade-window'
import { fmtExecutionCost, hasExecutionCost, type ExecutionCost } from '@shared/types/execution-cost'
import { fmtTzDate, tzPartsFromMs } from '@shared/types/timezone'
import { formatNumber, formatSpentTime } from '../../utils/format'
import { useT, translateLabel, type Translator } from '../../i18n'

export interface SessionParamsProps {
  symbol: string
  /** 行情数据集自己的周期（不是看图用的显示周期） */
  datasetTimeframe: string | null
  /** 行情数据集总共有多少根 K 线 */
  datasetBarCount: number | null
  /** 回放区间，秒级时间戳 */
  startTime: number | null
  endTime: number | null
  /** 看图用的显示周期 */
  displayTimeframe: string | null
  /** 这个回测集建立时所用的时区，区间日期按它显示 */
  tz: string
  initialBalance: number
  finalBalance: number
  lotSize: number
  /** 单笔风险（金额）= 1R */
  riskPerTrade: number | null
  /** 交易时段，库里存 'HH:mm-HH:mm' 字符串，null = 全天不限 */
  tradeWindow: string | null
  /** sessions.indicators_json 原文 */
  indicatorsJson: string | null
  /** sessions.drawings_json 原文 */
  drawingsJson: string | null
  /** 在这个回测集上实际花的时间（秒） */
  trainSeconds: number | null
  /** 毫秒级时间戳 */
  createdAt: number | null
  completedAt: number | null
  /** 成本模型是全局设置（所有回测集共用），由调用方从 store 传入 */
  executionCost: ExecutionCost
}

const OPEN_KEY = 'tr:journalParams'

function money(n: number): string {
  const sign = n < 0 ? '-' : ''
  return `${sign}$${Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`
}

/** 毫秒级时间戳 → MM-DD HH:mm（按回测集自己的时区） */
function fmtDateTime(ts: number | null, tz: string): string {
  if (ts == null) return '--'
  const parts = tzPartsFromMs(ts, tz)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(parts.month)}-${p(parts.day)} ${p(parts.hour)}:${p(parts.minute)}`
}

/**
 * 回放区间有多长（秒级时间戳差）。
 * 用「天 + 时」而不是「小时」：日志里的区间动辄两三天，47 时 59 分不好读。
 */
function fmtSpan(sec: number, t: Translator): string {
  if (!Number.isFinite(sec) || sec <= 0) return '--'
  const totalMin = Math.round(sec / 60)
  if (totalMin < 60) return t('params.duration.minutes', { n: totalMin })
  const hours = Math.floor(totalMin / 60)
  const mins = totalMin % 60
  if (hours < 24) {
    return mins > 0
      ? t('params.duration.hoursMinutes', { h: hours, m: mins })
      : t('params.duration.hours', { h: hours })
  }
  const days = Math.floor(hours / 24)
  const restH = hours % 24
  return restH > 0
    ? t('params.duration.daysHours', { d: days, h: restH })
    : t('params.duration.days', { d: days })
}

/** 一行「标签 —— 值」 */
function Row({
  label,
  value,
  title,
  tone
}: {
  label: string
  value: React.ReactNode
  title?: string
  tone?: 'pos' | 'neg'
}): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3 text-[11.5px] leading-[1.6]">
      <span className="shrink-0 text-[var(--text-faint)]">{label}</span>
      <span
        title={title}
        className={
          'min-w-0 truncate text-right font-mono tabular-nums ' +
          (tone === 'pos'
            ? 'text-[var(--c-neg)]'
            : tone === 'neg'
              ? 'text-[var(--c-pos)]'
              : 'text-[var(--text-secondary)]')
        }
      >
        {value}
      </span>
    </div>
  )
}

function Group({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="min-w-0">
      <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-[var(--text-faint)]">
        {title}
      </div>
      <div className="flex flex-col">{children}</div>
    </div>
  )
}

export function SessionParamsCard(props: SessionParamsProps): React.JSX.Element {
  const { t, locale } = useT()
  const [open, setOpen] = useState<boolean>(() => localStorage.getItem(OPEN_KEY) !== '0')

  /** 展开状态记在本地，下次进来还是同样的样子 */
  const toggle = (): void => {
    setOpen((v) => {
      localStorage.setItem(OPEN_KEY, v ? '0' : '1')
      return !v
    })
  }

  /** 指标配置：老数据可能是 id 字符串数组，交给统一的规范化函数吃进来 */
  const indicators = useMemo(() => {
    if (!props.indicatorsJson) return null
    try {
      return normalizeIndicatorPrefs(JSON.parse(props.indicatorsJson))
    } catch {
      return null
    }
  }, [props.indicatorsJson])

  const overlayText =
    indicators && indicators.overlays.length > 0
      ? indicators.overlays
          .map((i) => translateLabel(locale, indicatorTitle(i.id, i.params)))
          .join(t('params.listSep'))
      : t('params.none')
  const subText =
    indicators && indicators.subPanes.length > 0
      ? indicators.subPanes
          .map((i) => translateLabel(locale, indicatorTitle(i.id, i.params)))
          .join(t('params.listSep'))
      : t('params.none')

  /** 画线条数：只统计数量，具体坐标对复盘没意义 */
  const drawingCount = useMemo(() => {
    if (!props.drawingsJson) return 0
    try {
      const arr = JSON.parse(props.drawingsJson)
      return Array.isArray(arr) ? arr.length : 0
    } catch {
      return 0
    }
  }, [props.drawingsJson])

  const window = normalizeTradeWindow(props.tradeWindow)

  const rangeText =
    props.startTime != null && props.endTime != null
      ? `${fmtTzDate(props.startTime, props.tz)} ~ ${fmtTzDate(props.endTime, props.tz)}`
      : t('params.wholeRange')

  const spanText =
    props.startTime != null && props.endTime != null
      ? fmtSpan(props.endTime - props.startTime, t)
      : '--'

  const pnl = props.finalBalance - props.initialBalance
  const risk =
    props.riskPerTrade != null && props.riskPerTrade > 0
      ? props.riskPerTrade
      : props.initialBalance * 0.01

  return (
    <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-0)]">
      <button
        type="button"
        onClick={toggle}
        title={open ? t('params.collapse') : t('params.expand')}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--surface-2)]"
      >
        {open ? (
          <ChevronDown size={13} className="shrink-0 text-[var(--text-muted)]" />
        ) : (
          <ChevronRight size={13} className="shrink-0 text-[var(--text-muted)]" />
        )}
        <SlidersHorizontal size={13} className="shrink-0 text-[var(--text-muted)]" />
        <span className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)]">
          {t('params.title')}
        </span>
        <span className="min-w-0 truncate text-[11px] text-[var(--text-faint)]">
          {t('params.subtitle')}
        </span>
        {/* 用时放在标题条右侧：收起时也看得见，是这个页面最常被问的一个指标 */}
        <span
          className="ml-auto flex shrink-0 items-center gap-1 font-mono text-[11px] text-[var(--text-faint)]"
          title={
            props.trainSeconds != null
              ? t('params.spentExact', { n: props.trainSeconds })
              : t('params.spentUnknown')
          }
        >
          <span>{t('params.spent')}</span>
          <span className="text-[var(--text-secondary)]">
            {formatSpentTime(props.trainSeconds, locale)}
          </span>
        </span>
      </button>

      {open && (
        <div className="grid grid-cols-2 gap-x-7 gap-y-3 border-t border-[var(--border-subtle)] px-3 pb-2.5 pt-2.5 xl:grid-cols-4">
          <Group title={t('params.group.data')}>
            <Row label={t('params.symbol')} value={props.symbol || '--'} />
            <Row
              label={t('params.datasetTimeframe')}
              value={props.datasetTimeframe ?? '--'}
              title={t('params.datasetTimeframeHint')}
            />
            <Row
              label={t('params.datasetBars')}
              value={
                props.datasetBarCount != null
                  ? t('params.barsCount', { n: formatNumber(props.datasetBarCount) })
                  : '--'
              }
              title={t('params.datasetBarsHint')}
            />
            <Row label={t('params.range')} value={rangeText} title={rangeText} />
            <Row label={t('params.rangeSpan')} value={spanText} />
            <Row
              label={t('params.displayTimeframe')}
              value={props.displayTimeframe ?? '--'}
              title={t('params.displayTimeframeHint')}
            />
          </Group>

          <Group title={t('params.group.account')}>
            <Row label={t('params.initialBalance')} value={money(props.initialBalance)} />
            <Row
              label={t('params.finalBalance')}
              value={money(props.finalBalance)}
              tone={pnl > 0 ? 'pos' : pnl < 0 ? 'neg' : undefined}
            />
            <Row
              label={t('params.pnl')}
              value={`${pnl >= 0 ? '+' : ''}${money(pnl)}`}
              tone={pnl > 0 ? 'pos' : pnl < 0 ? 'neg' : undefined}
            />
            <Row
              label={t('params.lotSize')}
              value={t('params.lotsCount', { n: props.lotSize.toFixed(2) })}
            />
            <Row
              label={t('params.riskPerTrade')}
              value={`${money(risk)} = 1R`}
              title={t('params.riskHint')}
            />
            <Row
              label={t('params.tradeWindow')}
              value={window ? `${window.from} – ${window.to}` : t('params.anyTime')}
              title={
                window
                  ? window.from > window.to
                    ? t('params.windowOvernightHint')
                    : t('params.windowHint')
                  : t('params.windowNoneHint')
              }
            />
          </Group>

          <Group title={t('params.group.chart')}>
            <Row label={t('params.overlay')} value={overlayText} title={overlayText} />
            <Row label={t('params.subPane')} value={subText} title={subText} />
            <Row
              label={t('params.drawings')}
              value={t('params.drawingsCount', { n: drawingCount })}
              title={t('params.drawingsHint')}
            />
            <Row
              label={t('params.costModel')}
              value={
                hasExecutionCost(props.executionCost)
                  ? fmtExecutionCost(props.executionCost, locale)
                  : t('params.off')
              }
              title={t('params.costHint')}
            />
          </Group>

          <Group title={t('params.group.time')}>
            <Row label={t('params.createdAt')} value={fmtDateTime(props.createdAt, props.tz)} />
            <Row label={t('params.completedAt')} value={fmtDateTime(props.completedAt, props.tz)} />
            <Row
              label={t('params.timezone')}
              value={props.tz}
              title={t('params.timezoneHint')}
            />
          </Group>
        </div>
      )}
    </div>
  )
}
