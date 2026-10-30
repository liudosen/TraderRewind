import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { X, RotateCcw } from 'lucide-react'
import { useT, translateLabel } from '../../i18n'
import type { IChartApi, ISeriesApi, MouseEventParams } from 'lightweight-charts'
import {
  INDICATOR_COLORS,
  indicatorColorSlots,
  indicatorFields,
  indicatorLabel,
  resolveColors,
  type IndicatorId,
  type IndicatorInstance,
  type IndicatorKind
} from '@shared/utils/indicators'

/** 一行读数里的一段线（一条线一个色块一个数值） */
export interface IndicatorRowSeg {
  /** series key（`${uid}:${lineKey}`），用来从十字线数据里取值 */
  key: string
  color: string
}

/** 一个指标实例对应的一行描述，由 ReplayChart 算好传进来 */
export interface IndicatorRow {
  kind: IndicatorKind
  inst: IndicatorInstance
  /** 0 = 主图叠加；1..n = 第 n 块副图 */
  pane: number
  title: string
  format: 'volume' | 'price' | 'plain'
  segs: IndicatorRowSeg[]
}

interface Props {
  rows: IndicatorRow[]
  chart: IChartApi | null
  /** series key → series 实例，十字线数值从它取 */
  getSeries: (key: string) => ISeriesApi<any> | undefined
  /** 价格小数位 */
  digits: number
  onParams?: (kind: IndicatorKind, uid: string, key: string, value: number) => void
  onColor?: (kind: IndicatorKind, uid: string, slot: string, color: string) => void
  onReset?: (kind: IndicatorKind, uid: string) => void
  onRemove?: (kind: IndicatorKind, uid: string) => void
}

/** 读数格式化：成交量类用 K/M 缩写，价格按品种精度，其余两位小数 */
function fmtValue(v: number, format: IndicatorRow['format'], digits: number): string {
  if (!Number.isFinite(v)) return '—'
  if (format === 'volume') {
    const a = Math.abs(v)
    if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`
    if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`
    if (a >= 1e4) return `${(v / 1e3).toFixed(1)}K`
    // Dukascopy 的 tick volume 只有 0.0x 量级，统一 toFixed(0) 会全变成 0
    if (a >= 100) return v.toFixed(0)
    if (a >= 1) return v.toFixed(2)
    if (a >= 0.01) return v.toFixed(3)
    return v.toFixed(4)
  }
  if (format === 'price') return v.toFixed(digits)
  return Math.abs(v) >= 1000 ? v.toFixed(1) : v.toFixed(2)
}

/**
 * K 线图左上角的指标图例，同时充当十字线读数。
 *
 * 布局（互不重叠）：
 *  · 主图指标的 chip 挂在画图工具条正下方（top-11），参数面板向下展开
 *  · 每个副图在**自己那块 pane 的左上角**有一行标题 + 数值，参数面板从右侧展开
 *  · 十字线移动时，数值出现在对应指标的名字后面，颜色跟那条线一致
 */
export function IndicatorLegend({
  rows,
  chart,
  getSeries,
  digits,
  onParams,
  onColor,
  onReset,
  onRemove
}: Props): React.JSX.Element | null {
  const [open, setOpen] = useState<{ kind: IndicatorKind; uid: string } | null>(null)
  /** 十字线所在时刻各条线的值；null = 鼠标不在图上 */
  const [values, setValues] = useState<Record<string, number | null> | null>(null)
  /**
   * tops[i] = 第 i 块 pane 的顶边距（相对图表容器）。
   * 注意不能只在悬停时算：没悬停时也得知道副图标签该放在哪，否则会全堆到顶部。
   */
  const [tops, setTops] = useState<number[]>([])
  const rootRef = useRef<HTMLDivElement>(null)
  const rafRef = useRef<number | null>(null)

  /** 读各 pane 高度换算成顶边距；布局还没算好（高度为 0）时返回 null */
  const measureTops = useCallback((): number[] | null => {
    if (!chart) return null
    const heights = chart.panes().map((p) => p.getHeight())
    if (heights.length === 0 || heights.some((h) => !(h > 0))) return null
    const out: number[] = []
    let acc = 0
    for (const h of heights) {
      out.push(acc)
      acc += h
    }
    return out
  }, [chart])

  // 结构变化 / 尺寸变化时重算 pane 顶边距（刚建好的 pane 高度可能是 0，重试几帧）
  const paneKey = rows.map((r) => r.pane).join(',')
  useEffect(() => {
    if (!chart) return
    let cancelled = false
    let tries = 0
    const tick = (): void => {
      if (cancelled) return
      const next = measureTops()
      if (next) {
        setTops(next)
        return
      }
      if (tries++ < 30) requestAnimationFrame(tick)
    }
    tick()

    const ro = new ResizeObserver(() => {
      const next = measureTops()
      if (next) setTops(next)
    })
    if (rootRef.current) ro.observe(rootRef.current)

    return () => {
      cancelled = true
      ro.disconnect()
    }
  }, [chart, paneKey, measureTops])

  // 订阅十字线：rAF 合并，避免每次 mousemove 都 setState
  useEffect(() => {
    if (!chart) return
    let pending: MouseEventParams | null = null

    const flush = (): void => {
      rafRef.current = null
      const param = pending
      pending = null
      if (!param) return
      if (param.time === undefined || !param.point || !param.seriesData) {
        setValues(null)
        return
      }

      // 顺手校正一次 pane 顶边距（窗口缩放后不用等 ResizeObserver）
      const nextTops = measureTops()
      if (nextTops) setTops((prev) => (prev.join(',') === nextTops.join(',') ? prev : nextTops))

      const next: Record<string, number | null> = {}
      for (const row of rows) {
        for (const seg of row.segs) {
          const api = getSeries(seg.key)
          const item = api ? (param.seriesData.get(api) as { value?: number } | undefined) : undefined
          next[seg.key] = typeof item?.value === 'number' ? item.value : null
        }
      }
      setValues(next)
    }

    const onMove = (param: MouseEventParams): void => {
      pending = param
      if (rafRef.current == null) rafRef.current = requestAnimationFrame(flush)
    }

    chart.subscribeCrosshairMove(onMove)
    return () => {
      chart.unsubscribeCrosshairMove(onMove)
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [chart, rows, getSeries, measureTops])

  if (rows.length === 0) return null

  const current = open ? rows.find((r) => r.kind === open.kind && r.inst.uid === open.uid) : undefined
  const overlayRows = rows.filter((r) => r.pane === 0)
  const subRows = rows.filter((r) => r.pane > 0)

  const isActive = (row: IndicatorRow): boolean =>
    open != null && open.kind === row.kind && open.uid === row.inst.uid

  const panel = (row: IndicatorRow, side: 'below' | 'right', anchorTop: number): React.JSX.Element => (
    <IndicatorPanel
      row={row}
      side={side}
      anchorTop={anchorTop}
      // 主图的面板往下展开时，底边不许越过第一块副图的图例行
      limitBottom={side === 'below' && tops.length > 1 ? tops[1] - 4 : undefined}
      hostRef={rootRef}
      onParams={onParams}
      onColor={onColor}
      onReset={onReset}
      onRemove={onRemove}
      onClose={() => setOpen(null)}
    />
  )

  return (
    <div
      ref={rootRef}
      data-indicator-legend="1"
      className="pointer-events-none absolute inset-0 z-20"
    >
      {/* 主图指标：画图工具条（top-2，高 28）正下方，两者永不重叠 */}
      {overlayRows.length > 0 && (
        <div
          // 给图表那边量高度用：拖动提示条要排在它下面，否则两行会叠在同一个位置
          data-legend-overlays="1"
          className="pointer-events-auto absolute left-2 top-11 max-w-[calc(100%-96px)]"
          // 面板比一排 chip 高得多，会伸到副图那一带；不抬高层级就会被后来的副图行盖住
          style={{ zIndex: current && current.pane === 0 ? 40 : undefined }}
        >
          <div className="group relative flex flex-wrap items-center gap-x-1 gap-y-0.5 rounded-md border border-[var(--border-subtle)]/70 bg-[var(--surface-0)]/80 px-1.5 py-1 backdrop-blur-[2px]">
            {overlayRows.map((row) => (
              <IndicatorChip
                key={row.inst.uid}
                row={row}
                active={isActive(row)}
                values={values}
                digits={digits}
                onToggle={() =>
                  setOpen(isActive(row) ? null : { kind: row.kind, uid: row.inst.uid })
                }
                onRemove={() => {
                  if (isActive(row)) setOpen(null)
                  onRemove?.(row.kind, row.inst.uid)
                }}
              />
            ))}
            {current && current.pane === 0 && panel(current, 'below', 44)}
          </div>
        </div>
      )}

      {/* 副图指标：各自 pane 的左上角；参数面板从 chip 右侧展开，不再压住下一块图例 */}
      {subRows.map((row) => {
        const top = (tops[row.pane] ?? 0) + 3
        const active = isActive(row)
        return (
          <div
            key={row.inst.uid}
            className="pointer-events-auto absolute left-2"
            style={{ top, zIndex: active ? 40 : undefined }}
          >
            <div className="group relative flex items-center rounded border border-[var(--border-subtle)]/60 bg-[var(--surface-0)]/75 px-1 py-[1px] backdrop-blur-[2px]">
              <IndicatorChip
                row={row}
                active={active}
                values={values}
                digits={digits}
                onToggle={() =>
                  setOpen(active ? null : { kind: row.kind, uid: row.inst.uid })
                }
                onRemove={() => {
                  if (active) setOpen(null)
                  onRemove?.(row.kind, row.inst.uid)
                }}
              />
              {active && panel(row, 'right', top)}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** 十字线读数：每条线一个数值，颜色跟线一致；没悬停 / 该时刻没值就不画 */
function RowValues({
  row,
  values,
  digits
}: {
  row: IndicatorRow
  values: Record<string, number | null> | null
  digits: number
}): React.JSX.Element | null {
  if (!values) return null
  const shown = row.segs
    .map((seg) => ({ seg, v: values[seg.key] }))
    .filter((x): x is { seg: IndicatorRowSeg; v: number } => typeof x.v === 'number')
  if (shown.length === 0) return null
  return (
    <span className="ml-1 flex shrink-0 items-center gap-1.5">
      {shown.map(({ seg, v }) => (
        <span
          key={seg.key}
          className="font-mono text-[10.5px] leading-[15px] tabular-nums"
          style={{ color: seg.color }}
        >
          {fmtValue(v, row.format, digits)}
        </span>
      ))}
    </span>
  )
}

/** 一行可点的指标 chip（主图和副图只是外面的容器不同） */
function IndicatorChip({
  row,
  active,
  values,
  digits,
  onToggle,
  onRemove
}: {
  row: IndicatorRow
  active: boolean
  values: Record<string, number | null> | null
  digits: number
  onToggle: () => void
  onRemove: () => void
}): React.JSX.Element {
  const { t } = useT()
  return (
    <div className="flex items-center rounded transition-colors">
      <button
        type="button"
        onClick={onToggle}
        title={t('ind.paramsHint')}
        className={clsx(
          'inline-flex items-center gap-1 rounded px-1 py-[1px] text-left',
          active
            ? 'bg-[var(--c-accent-tint)] text-[var(--c-accent)]'
            : 'text-[var(--text-secondary)] hover:bg-[var(--surface-3)]'
        )}
      >
        <ColorBar id={row.inst.id as IndicatorId} colors={row.inst.colors} params={row.inst.params} />
        <span className="font-mono text-[10.5px] leading-[15px]">{row.title}</span>
        <RowValues row={row} values={values} digits={digits} />
      </button>
      <button
        type="button"
        onClick={onRemove}
        title={t('ind.removeHint')}
        className="mr-0.5 rounded p-[1px] text-[var(--text-faint)] opacity-0 transition-opacity hover:text-[var(--c-neg)] group-hover:opacity-100"
      >
        <X size={9} />
      </button>
    </div>
  )
}

/**
 * 参数 + 颜色面板。
 *
 * 位置策略（副图一多就不会互相压住的关键）：
 *  · 主图 chip 行在页面顶部（top-11），空间充足 → 向下展开（below）
 *  · 副图 chip 行在各自 pane 的左上角，而面板（约 200px 高）比一块副图还高，
 *    向下展开必然盖住下一块副图的图例 → 改成从 chip **右侧**展开（right），
 *    只压住 K 线区域，不再和图例打架
 *  · 无论哪种，打开后量一次实际高度：溢出图表区底部就整体上移，最多上移到容器顶部
 */
function IndicatorPanel({
  row,
  side,
  anchorTop,
  limitBottom,
  hostRef,
  onParams,
  onColor,
  onReset,
  onRemove,
  onClose
}: {
  row: IndicatorRow
  side: 'below' | 'right'
  /** chip 行所在 pane 的顶边距，尺寸变化时要重算位置 */
  anchorTop: number
  /** 面板底边不许越过的位置（相对图表容器）；不传就用容器底部 */
  limitBottom?: number
  hostRef: React.RefObject<HTMLDivElement>
  onParams?: (kind: IndicatorKind, uid: string, key: string, value: number) => void
  onColor?: (kind: IndicatorKind, uid: string, slot: string, color: string) => void
  onReset?: (kind: IndicatorKind, uid: string) => void
  onRemove?: (kind: IndicatorKind, uid: string) => void
  onClose: () => void
}): React.JSX.Element {
  const id = row.inst.id as IndicatorId
  const { t, locale } = useT()
  const fields = indicatorFields(id)
  const slots = indicatorColorSlots(id)
  const resolved = resolveColors(id, row.inst.colors)
  const boxRef = useRef<HTMLDivElement>(null)
  const [shift, setShift] = useState(0)
  /** EMA 的「周期3」填 0 就是没开，那一格压暗并标注 */
  const slotOff = (slot: string): boolean =>
    row.inst.id === 'ema' && (row.inst.params[slot] ?? 0) <= 0

  /**
   * 量一次实际尺寸再决定要不要上移。
   * 位置一律从 chip 行的 rect 推（不受本面板 transform 影响），所以重复测量不会自激。
   */
  useLayoutEffect(() => {
    const box = boxRef.current
    const host = hostRef.current
    const wrap = box?.parentElement
    if (!box || !host || !wrap) return

    const place = (): void => {
      const hostRect = host.getBoundingClientRect()
      const wrapRect = wrap.getBoundingClientRect()
      const top = side === 'below' ? wrapRect.top - hostRect.top + wrapRect.height + 4 : wrapRect.top - hostRect.top - 2
      const bottomLimit = Math.min(hostRect.height - 6, limitBottom ?? Number.POSITIVE_INFINITY)
      const overflow = top + box.offsetHeight - bottomLimit
      setShift(overflow > 0 ? -Math.min(overflow, Math.max(0, top - 4)) : 0)
    }

    place()
    // 内容高度变了（缩放字体 / 以后加了别的字段）也要重新贴边
    const ro = new ResizeObserver(place)
    ro.observe(box)
    return () => ro.disconnect()
  }, [row.inst.uid, row.pane, side, anchorTop, limitBottom, hostRef])

  return (
    <div
      ref={boxRef}
      style={shift ? { transform: `translateY(${shift}px)` } : undefined}
      className={clsx(
        'absolute z-30 w-[214px] rounded-md border border-[var(--border-strong)] bg-[var(--surface-1)] p-2 text-left shadow-2xl',
        side === 'below' ? 'left-0 top-full mt-1' : 'left-full top-[-2px] ml-1'
      )}
    >
      <div className="mb-1.5 flex items-center gap-1">
        <ColorBar id={id} colors={row.inst.colors} params={row.inst.params} />
        <span className="text-[11px] font-medium text-[var(--text-primary)]">
          {translateLabel(locale, indicatorLabel(id))}
        </span>
        <button
          type="button"
          onClick={onClose}
          title={t('ind.collapse')}
          className="ml-auto rounded p-[1px] text-[var(--text-faint)] hover:text-[var(--text-primary)]"
        >
          <X size={11} />
        </button>
      </div>

      {fields.length === 0 && slots.length === 0 && (
        <p className="text-[10.5px] leading-relaxed text-[var(--text-faint)]">
          {t('ind.noParams')}
        </p>
      )}

      {fields.map((f) => (
        <label key={f.key} className="mb-1 flex items-center gap-2">
          <span className="w-[38px] shrink-0 text-[10.5px] text-[var(--text-muted)]">
            {translateLabel(locale, f.label)}
          </span>
          <input
            type="number"
            value={row.inst.params[f.key] ?? 0}
            min={f.min}
            max={f.max}
            step={f.step}
            onChange={(e) => {
              const v = Number(e.target.value)
              if (!Number.isFinite(v)) return
              const clamped = Math.min(f.max, Math.max(f.min, v))
              onParams?.(row.kind, row.inst.uid, f.key, clamped)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose()
            }}
            className="h-6 w-full min-w-0 rounded border border-[var(--border-subtle)] bg-[var(--surface-0)] px-1.5 font-mono text-[11px] text-[var(--text-primary)] outline-none focus:border-[var(--c-accent)]"
          />
          {f.zeroOff && (
            <span className="shrink-0 text-[9px] text-[var(--text-faint)]">{t('ind.zeroOff')}</span>
          )}
        </label>
      ))}

      {slots.length > 0 && (
        <>
          <div className="mt-2 mb-1 flex items-center gap-1.5 border-t border-[var(--border-subtle)] pt-1.5">
            <span className="text-[10px] text-[var(--text-muted)]">{t('ind.color')}</span>
            {slots.length > 1 && (
              <span className="text-[9px] text-[var(--text-faint)]">{t('ind.perLine')}</span>
            )}
          </div>
          <div className="flex flex-wrap gap-x-2 gap-y-1">
            {slots.map((s) => (
              <label
                key={s.slot}
                title={
                  slotOff(s.slot)
                    ? t('ind.slotOffHint', { label: s.label })
                    : t('ind.slotColorHint', { label: s.label })
                }
                className={clsx('flex items-center gap-1', slotOff(s.slot) && 'opacity-40')}
              >
                <input
                  type="color"
                  value={resolved[s.slot]}
                  onChange={(e) => onColor?.(row.kind, row.inst.uid, s.slot, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') onClose()
                  }}
                  className="h-[18px] w-[22px] shrink-0 cursor-pointer rounded border border-[var(--border-subtle)] bg-transparent p-0 [&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:rounded-[2px] [&::-webkit-color-swatch]:border-0"
                />
                <span className="text-[10px] text-[var(--text-muted)]">
                  {translateLabel(locale, s.label)}
                </span>
              </label>
            ))}
          </div>
        </>
      )}

      {slots.length === 0 && (
        <p className="mt-1.5 border-t border-[var(--border-subtle)] pt-1.5 text-[9.5px] leading-relaxed text-[var(--text-faint)]">
          {t('ind.followTheme')}
        </p>
      )}

      <div className="mt-2 flex items-center gap-1 border-t border-[var(--border-subtle)] pt-1.5">
        <button
          type="button"
          onClick={() => onReset?.(row.kind, row.inst.uid)}
          title={t('ind.resetHint')}
          className="inline-flex items-center gap-1 rounded border border-[var(--border-subtle)] px-1.5 py-[1px] text-[10px] text-[var(--text-secondary)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
        >
          <RotateCcw size={9} />
          {t('ind.reset')}
        </button>
        <button
          type="button"
          onClick={() => {
            onClose()
            onRemove?.(row.kind, row.inst.uid)
          }}
          className="ml-auto rounded border border-[var(--border-subtle)] px-1.5 py-[1px] text-[10px] text-[var(--text-secondary)] transition-colors hover:border-[var(--c-neg)] hover:text-[var(--c-neg)]"
        >
          {t('ind.remove')}
        </button>
      </div>
    </div>
  )
}

/** 图例上的小色条：单线指标一根，多线指标并排几段；关掉的线不画 */
function ColorBar({
  id,
  colors,
  params
}: {
  id: IndicatorId
  colors?: Record<string, string>
  params?: Record<string, number>
}): React.JSX.Element {
  const allSlots = indicatorColorSlots(id)
  if (allSlots.length === 0) {
    return (
      <span
        className="h-[3px] w-2.5 shrink-0 rounded-full"
        style={{ background: INDICATOR_COLORS[id] ?? '#94a3b8' }}
      />
    )
  }
  const resolved = resolveColors(id, colors)
  // EMA 的槽位键就是参数键：p1/p2/p3，值为 0 表示这条线没开
  const slots = id === 'ema' && params ? allSlots.filter((s) => (params[s.slot] ?? 0) > 0) : allSlots
  const shown = slots.length > 0 ? slots : [allSlots[0]]
  return (
    <span className="flex shrink-0 items-center gap-[1px]">
      {shown.map((s) => (
        <span
          key={s.slot}
          className={clsx('h-[3px] rounded-full', shown.length === 1 ? 'w-2.5' : 'w-[4px]')}
          style={{ background: resolved[s.slot] }}
        />
      ))}
    </span>
  )
}
