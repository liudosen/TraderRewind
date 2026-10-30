import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react'
import clsx from 'clsx'
import { eachDayKey } from '@shared/utils/daterange'
import { useT } from '../../i18n'

// ---------- 日期工具（纯 Y/M/D 运算，避免时区问题） ----------

interface Ymd {
  y: number
  m: number // 1-12
  d: number
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function toKey({ y, m, d }: Ymd): string {
  return `${y}-${pad2(m)}-${pad2(d)}`
}

function parse(key: string): Ymd | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key)
  if (!match) return null
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) }
}

function todayYmd(): Ymd {
  const now = new Date()
  return { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() }
}

function daysInMonth(y: number, m: number): number {
  return new Date(y, m, 0).getDate()
}

/** 周一为一周第一天，返回 0-6 */
function weekdayMon(y: number, m: number, d: number): number {
  const w = new Date(y, m - 1, d).getDay()
  return (w + 6) % 7
}

function addMonths(y: number, m: number, delta: number): { y: number; m: number } {
  const total = y * 12 + (m - 1) + delta
  return { y: Math.floor(total / 12), m: (total % 12) + 1 }
}

function addDays(base: Ymd, delta: number): Ymd {
  const dt = new Date(base.y, base.m - 1, base.d)
  dt.setDate(dt.getDate() + delta)
  return { y: dt.getFullYear(), m: dt.getMonth() + 1, d: dt.getDate() }
}

function cmp(a: Ymd, b: Ymd): number {
  return a.y * 10000 + a.m * 100 + a.d - (b.y * 10000 + b.m * 100 + b.d)
}

function diffDays(a: Ymd, b: Ymd): number {
  const t1 = new Date(a.y, a.m - 1, a.d).getTime()
  const t2 = new Date(b.y, b.m - 1, b.d).getTime()
  return Math.round((t2 - t1) / 86400000)
}

function display(key: string): string {
  const v = parse(key)
  if (!v) return '--'
  return `${v.y}/${pad2(v.m)}/${pad2(v.d)}`
}

const WEEK_LABELS: Record<'zh' | 'en', string[]> = {
  zh: ['一', '二', '三', '四', '五', '六', '日'],
  en: ['M', 'T', 'W', 'T', 'F', 'S', 'S']
}

// 预设只存天数，文案在渲染时按语言拼（「最近 7 天」/「Last 7 days」）
const PRESET_DAYS = [3, 7, 30, 90]

/**
 * 当前在改哪一头。
 * 点上面那两张「开始日期 / 结束日期」卡片切换，然后直接在下面的日历里点日期，
 * 点到的日期就写进当前这一头 —— 不再走「先点开始、再点结束」的隐式两步。
 */
type Field = 'start' | 'end'

interface Props {
  from: string
  to: string
  onChange: (from: string, to: string) => void
  maxDate?: string
  /** 可选的最小日期（YYYY-MM-DD），默认不限 */
  minDate?: string
  /** 已下载、不可再选的日期（YYYY-MM-DD） */
  blockedDays?: Set<string>
}

export function DateRangePicker({ from, to, onChange, maxDate, minDate, blockedDays }: Props): React.JSX.Element {
  const { t, locale } = useT()
  const [open, setOpen] = useState(false)
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null)

  const [field, setField] = useState<Field>('start')
  const [start, setStart] = useState<Ymd | null>(null)
  const [end, setEnd] = useState<Ymd | null>(null)
  const [hovered, setHovered] = useState<Ymd | null>(null)

  const triggerRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)

  const maxYmd = useMemo(() => parse(maxDate ?? '') ?? todayYmd(), [maxDate])
  const minYmd = useMemo(() => parse(minDate ?? ''), [minDate])
  const fromYmd = useMemo(() => parse(from), [from])
  const toYmd = useMemo(() => parse(to), [to])

  const [view, setView] = useState<{ y: number; m: number }>(() => {
    const base = toYmd ?? todayYmd()
    return { y: base.y, m: base.m }
  })

  const committedDays = useMemo(() => {
    if (!fromYmd || !toYmd) return 0
    return diffDays(fromYmd, toYmd) + 1
  }, [fromYmd, toYmd])

  const years = useMemo(() => {
    const current = todayYmd().y
    const list: number[] = []
    for (let y = current; y >= 2003; y--) list.push(y)
    return list
  }, [])

  const reposition = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
    const width = 320
    const height = 400
    let left = rect.left
    if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8
    if (left < 8) left = 8
    let top = rect.bottom + 6
    if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6)
    setCoords({ top, left })
  }, [])

  const openPicker = useCallback(() => {
    // 打开时把现有区间灌进草稿
    setStart(fromYmd)
    setEnd(toYmd)
    // 已有开始但还没结束 → 直接落到「选结束」；否则从「选开始」进场
    setField(fromYmd && !toYmd ? 'end' : 'start')
    setHovered(null)
    const base = toYmd ?? todayYmd()
    setView({ y: base.y, m: base.m })
    setOpen(true)
  }, [fromYmd, toYmd])

  useEffect(() => {
    if (!open) return
    reposition()
    const onScroll = () => reposition()
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [open, reposition])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (popRef.current?.contains(target)) return
      if (triggerRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const closeAndReset = () => {
    setOpen(false)
    setField('start')
    setHovered(null)
  }

  const isBlocked = useCallback(
    (date: Ymd): boolean => blockedDays != null && blockedDays.has(toKey(date)),
    [blockedDays]
  )

  /** 预设区间是否已全部下载 */
  const presetFullyBlocked = useCallback(
    (presetDays: number): boolean => {
      if (!blockedDays || blockedDays.size === 0) return false
      const endKey = toKey(maxYmd)
      const startKey = toKey(addDays(maxYmd, -(presetDays - 1)))
      const keys = eachDayKey(startKey, endKey)
      return keys.length > 0 && keys.every((k) => blockedDays.has(k))
    },
    [blockedDays, maxYmd]
  )

  /**
   * 草稿是否可提交。
   * 只要选了起点就算有效——只选一天时自动变成「单日区间」，
   * 避免用户点完一个日期后「确认」是灰的、点了没反应。
   */
  const canConfirm = start != null

  /** 实际写回的结束日：没选结束就退化成单日 */
  const draftEnd = end ?? start

  const draftDays = useMemo(() => {
    if (!start || !draftEnd) return 0
    return diffDays(start, draftEnd) + 1
  }, [start, draftEnd])

  /** 点「确认」才真正把草稿写回去，并立即关闭 */
  const applyDraft = () => {
    if (!start) return
    const other = end ?? start
    const s = cmp(start, other) <= 0 ? start : other
    const e = cmp(start, other) <= 0 ? other : start
    onChange(toKey(s), toKey(e))
    closeAndReset()
  }

  /**
   * 取消 = 用「推荐范围」，也就是打开选择器时的那一套（新建会话里就是默认的最近 30 天）。
   * 不把用户上一次的点选留在草稿里，然后关掉。
   */
  const applyRecommended = () => {
    if (from && to) onChange(from, to)
    closeAndReset()
  }

  /** 一次点击只改「当前选中的那一头」，不提交、也不跳到另一头 */
  const setEndpoint = (date: Ymd) => {
    if (cmp(date, maxYmd) > 0) return
    if (minYmd != null && cmp(date, minYmd) < 0) return
    if (isBlocked(date)) return

    if (field === 'start') {
      // 开始日往后挪、越过了原来的结束日 → 结束日跟着挪，保证「结束 ≥ 开始」
      if (end && cmp(date, end) > 0) setEnd(date)
      setStart(date)
      return
    }

    // 选结束：早于开始日的日期在日历里已禁用，这里再兜一次
    if (!start) {
      setStart(date)
      setField('start')
      return
    }
    if (cmp(date, start) < 0) return
    setEnd(date)
  }

  /** 只选年月时，默认取该月 1 号 */
  const pickMonthFirst = () => {
    const first: Ymd = { y: view.y, m: view.m, d: 1 }
    if (cmp(first, maxYmd) > 0 || isBlocked(first)) return
    setEndpoint(first)
  }

  /** 预设只填草稿，仍需点确认 */
  const applyPreset = (presetDays: number) => {
    const e = maxYmd
    const s = addDays(e, -(presetDays - 1))
    setStart(s)
    setEnd(e)
    setHovered(null)
  }

  const grid = useMemo(() => {
    const offset = weekdayMon(view.y, view.m, 1)
    const total = daysInMonth(view.y, view.m)
    const cells: (Ymd | null)[] = []
    for (let i = 0; i < offset; i++) cells.push(null)
    for (let d = 1; d <= total; d++) cells.push({ y: view.y, m: view.m, d })
    while (cells.length % 7 !== 0) cells.push(null)
    return cells
  }, [view])

  // 高亮区间：选结束阶段实时预览
  // 高亮区间：正在选结束、且鼠标悬停时实时预览
  const range = useMemo(() => {
    if (field === 'end' && start) {
      if (hovered && cmp(hovered, start) >= 0) {
        return { start, end: hovered }
      }
      return { start, end }
    }
    return { start, end }
  }, [field, start, end, hovered])

  // 回车 = 确认（焦点在 select 或输入框时让位给原生行为）
  useEffect(() => {
    if (!open) return
    const onEnter = (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return
      const el = e.target as HTMLElement | null
      const tag = el?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return
      if (!canConfirm) return
      e.preventDefault()
      applyDraft()
    }
    window.addEventListener('keydown', onEnter)
    return () => window.removeEventListener('keydown', onEnter)
  }, [open, canConfirm, start, end, onChange])

  /** 底部：只选年月 / 状态提示 + 取消确认 */
  const viewMonthFirst: Ymd = { y: view.y, m: view.m, d: 1 }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? setOpen(false) : openPicker())}
        className={clsx(
          'flex w-full items-center gap-2 rounded-md border bg-[var(--surface-2)] px-2.5 py-1.5 text-left transition-colors',
          open
            ? 'border-[var(--c-accent)]'
            : 'border-[var(--border-subtle)] hover:border-[var(--border-strong)]'
        )}
      >
        <CalendarDays size={13} className="shrink-0 text-[var(--text-faint)]" />
        <span className="font-mono text-[12px] text-[var(--text-primary)]">{display(from)}</span>
        <span className="text-[var(--text-faint)]">→</span>
        <span className="font-mono text-[12px] text-[var(--text-primary)]">{display(to)}</span>
        <span className="ml-auto shrink-0 rounded-full bg-[var(--surface-3)] px-1.5 py-px text-[9.5px] text-[var(--text-secondary)]">
          {t('dr.daysShort', { n: committedDays })}
        </span>
      </button>

      {/*
        浮层挂到 body 上，而不是留在原地。
        原因：调用方通常把整个选择器包在 <label> 里（「回测时间范围」「时间范围」），
        浮层作为 label 的后代，点里面任何一个按钮，浏览器都会把点击再转发给
        label 关联的控件 —— 也就是这个触发器按钮。于是「确认」先正确提交并关闭，
        紧接着触发器又收到一次点击、把浮层重新打开并退回「选开始」，
        用户看到的就是「点确认收不起来，反而又去选开始时间了」。
        Portal 之后浮层不在 label 里，转发自然消失；顺带也不会被祖先的
        transform / overflow 影响定位与裁切。
      */}
      {open &&
        coords &&
        createPortal(
          <div
            ref={popRef}
            style={{ top: coords.top, left: coords.left }}
            className="fixed z-50 w-[320px] rounded-lg border border-[var(--border-strong)] bg-[var(--surface-1)] shadow-2xl shadow-black/60"
            >
            {/* ── 开始 / 结束 两个选择格：点哪个，下面的日历就改哪个 ── */}
            <div className="flex items-center gap-1.5 border-b border-[var(--border-subtle)] p-2">
              <button
                type="button"
                onClick={() => {
                  setField('start')
                  setHovered(null)
                }}
                className={clsx(
                  'flex-1 rounded-md border px-2 py-1 text-left transition-colors',
                  field === 'start'
                    ? 'border-[var(--c-accent)] bg-[var(--c-accent-tint)]'
                    : 'border-[var(--border-subtle)] hover:border-[var(--border-strong)]'
                )}
              >
                <div
                  className={clsx(
                    'flex items-center gap-1 text-[9px]',
                    field === 'start' ? 'text-[var(--c-accent)]' : 'text-[var(--text-faint)]'
                  )}
                >
                  {t('dr.startDate')}
                  {field === 'start' && <span className="text-[8px]">{t('dr.picking')}</span>}
                </div>
                <div
                  className={clsx(
                    'font-mono text-[11.5px]',
                    start ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)]'
                  )}
                >
                  {start ? display(toKey(start)) : t('dr.pick')}
                </div>
              </button>

              <span className="shrink-0 text-[var(--text-faint)]">→</span>

              <button
                type="button"
                onClick={() => {
                  setField('end')
                  setHovered(null)
                }}
                disabled={!start}
                title={start ? t('dr.pickEndHint') : t('dr.pickStartFirst')}
                className={clsx(
                  'flex-1 rounded-md border px-2 py-1 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-40',
                  field === 'end'
                    ? 'border-[var(--c-accent)] bg-[var(--c-accent-tint)]'
                    : 'border-[var(--border-subtle)] hover:border-[var(--border-strong)]'
                )}
              >
                <div
                  className={clsx(
                    'flex items-center gap-1 text-[9px]',
                    field === 'end' ? 'text-[var(--c-accent)]' : 'text-[var(--text-faint)]'
                  )}
                >
                  {t('dr.endDate')}
                  {field === 'end' && <span className="text-[8px]">{t('dr.picking')}</span>}
                </div>
                <div
                  className={clsx(
                    'font-mono text-[11.5px]',
                    end ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)]'
                  )}
                >
                  {end ? display(toKey(end)) : t('dr.pick')}
                </div>
              </button>
            </div>

            {/* ── 预设 ── */}
            <div className="flex flex-wrap gap-1 border-b border-[var(--border-subtle)] px-2 py-1.5">
              {PRESET_DAYS.map((days) => {
                const label = t('dr.lastDays', { n: days })
                const blockedPreset = presetFullyBlocked(days)
                return (
                  <button
                    key={days}
                    onClick={() => applyPreset(days)}
                    disabled={blockedPreset}
                    title={
                      blockedPreset ? t('dr.allDownloaded') : t('dr.choosePreset', { label })
                    }
                    className="rounded border border-[var(--border-subtle)] px-1.5 py-0.5 text-[10.5px] text-[var(--text-secondary)] transition-colors hover:border-[var(--c-accent)] hover:text-[var(--c-accent)] disabled:cursor-not-allowed disabled:border-transparent disabled:text-[var(--text-faint)]/50 disabled:line-through disabled:hover:border-transparent disabled:hover:text-[var(--text-faint)]/50"
                  >
                    {label}
                  </button>
                )
              })}
            </div>

            {/* ── 年月快速跳转 ── */}
            <div className="flex items-center gap-1 px-2 pb-1 pt-2">
              <button
                onClick={() => setView((v) => addMonths(v.y, v.m, -1))}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-3)] hover:text-[var(--text-primary)]"
              >
                <ChevronLeft size={14} />
              </button>

              <select
                value={view.y}
                onChange={(e) => setView((v) => ({ ...v, y: Number(e.target.value) }))}
                className="rounded border border-[var(--border-subtle)] bg-[var(--surface-2)] px-1 py-0.5 text-[11px] text-[var(--text-primary)] outline-none focus:border-[var(--c-accent)]"
              >
                {years.map((y) => (
                  <option key={y} value={y}>
                    {y} 年
                  </option>
                ))}
              </select>

              <select
                value={view.m}
                onChange={(e) => setView((v) => ({ ...v, m: Number(e.target.value) }))}
                className="rounded border border-[var(--border-subtle)] bg-[var(--surface-2)] px-1 py-0.5 text-[11px] text-[var(--text-primary)] outline-none focus:border-[var(--c-accent)]"
              >
                {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                  <option key={m} value={m}>
                    {m} 月
                  </option>
                ))}
              </select>

              <button
                onClick={() => setView((v) => addMonths(v.y, v.m, 1))}
                className="ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-3)] hover:text-[var(--text-primary)]"
              >
                <ChevronRight size={14} />
              </button>
            </div>

            {/* ── 星期表头 ── */}
            <div className="grid grid-cols-7 px-1.5 pb-1">
              {WEEK_LABELS[locale].map((w, i) => (
                <div
                  key={`${w}${i}`}
                  className="py-0.5 text-center text-[9.5px] font-medium text-[var(--text-faint)]"
                >
                  {w}
                </div>
              ))}
            </div>

            {/* ── 日期网格 ── */}
            <div className="grid grid-cols-7 px-1.5 pb-1.5">
              {grid.map((cell, idx) => {
                if (!cell) return <div key={`e${idx}`} className="h-7" />

                const blocked = isBlocked(cell)
                const tooEarly = minYmd != null && cmp(cell, minYmd) < 0
                // 正在选结束日时，早于开始日的一律不可选 —— 结束不能小于开始
                const beforeStart = field === 'end' && start != null && cmp(cell, start) < 0
                const disabled = cmp(cell, maxYmd) > 0 || blocked || tooEarly || beforeStart
                // 已下载的日期只显示划线，不再叠加区间高亮，避免与「已选中」混淆
                const isStart = !blocked && range.start != null && cmp(cell, range.start) === 0
                const isEnd = !blocked && range.end != null && cmp(cell, range.end) === 0
                const inRange =
                  !blocked &&
                  range.start != null &&
                  range.end != null &&
                  cmp(cell, range.start) >= 0 &&
                  cmp(cell, range.end) <= 0
                const isToday = cmp(cell, todayYmd()) === 0

                return (
                  <button
                    key={toKey(cell)}
                    disabled={disabled}
                    title={
                      blocked
                        ? t('dr.alreadyDownloaded')
                        : beforeStart
                          ? t('dr.endBeforeStart')
                          : undefined
                    }
                    onMouseEnter={() => field === 'end' && !disabled && setHovered(cell)}
                    onMouseLeave={() => field === 'end' && setHovered(null)}
                    onClick={() => setEndpoint(cell)}
                    className={clsx(
                      'relative flex h-7 items-center justify-center text-[11px] transition-colors',
                      disabled ? 'cursor-not-allowed text-[var(--text-faint)]/40' : 'cursor-pointer',
                      (tooEarly || beforeStart) && 'opacity-40',
                      blocked && 'line-through decoration-[var(--text-faint)]/50',
                      inRange && !isStart && !isEnd && 'bg-[var(--c-accent-tint)]',
                      isStart && 'rounded-l bg-[var(--c-accent)] font-semibold text-white',
                      isEnd && 'rounded-r bg-[var(--c-accent)] font-semibold text-white',
                      isStart && isEnd && 'rounded',
                      !inRange && !isStart && !isEnd && !disabled && 'rounded hover:bg-[var(--surface-3)]',
                      !inRange && !isStart && !isEnd && 'text-[var(--text-secondary)]'
                    )}
                  >
                    {cell.d}
                    {isToday && !isStart && !isEnd && (
                      <span className="absolute bottom-0.5 h-0.5 w-0.5 rounded-full bg-[var(--c-accent)]" />
                    )}
                  </button>
                )
              })}
            </div>

            {/* ── 底部：快捷取月日 + 状态提示 + 取消 / 确认 ── */}
            <div className="flex items-center gap-1.5 border-t border-[var(--border-subtle)] px-2 py-1.5">
              <button
                onClick={pickMonthFirst}
                disabled={cmp(viewMonthFirst, maxYmd) > 0 || isBlocked(viewMonthFirst)}
                title={t('dr.monthFirstHint')}
                className="shrink-0 rounded border border-[var(--border-subtle)] px-1.5 py-0.5 text-[10px] text-[var(--text-secondary)] transition-colors hover:border-[var(--c-accent)] hover:text-[var(--c-accent)] disabled:opacity-40"
              >
                {t('dr.monthFirstShort', { m: view.m })}
              </button>

              <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[10px] text-[var(--text-faint)]">
                {blockedDays && blockedDays.size > 0 && (
                  <span className="inline-flex shrink-0 items-center gap-1">
                    <span className="h-px w-3 bg-[var(--text-faint)]/60" />
                    {t('dr.legendDownloaded')}
                  </span>
                )}
                <span className="truncate">
                  {field === 'start' ? t('dr.clickStart') : t('dr.clickEnd')}
                  {draftDays > 0 ? t('dr.daysCount', { n: draftDays }) : ''}
                </span>
              </span>

              <button
                onClick={applyRecommended}
                title={t('dr.cancelHint', { from: display(from), to: display(to) })}
                className="shrink-0 rounded px-1.5 py-0.5 text-[10.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-3)] hover:text-[var(--text-primary)]"
              >
                {t('dr.cancel')}
              </button>

              <button
                onClick={applyDraft}
                disabled={!canConfirm}
                title={
                  canConfirm
                    ? t('dr.apply', {
                        from: toKey(start!),
                        to: toKey(draftEnd!),
                        n: draftDays
                      })
                    : t('dr.pickDateFirst')
                }
                className={clsx(
                  'shrink-0 rounded px-2 py-0.5 text-[10.5px] font-medium transition-colors',
                  canConfirm
                    ? 'bg-[var(--c-accent)] text-white hover:opacity-90'
                    : 'cursor-not-allowed bg-[var(--surface-3)] text-[var(--text-faint)]'
                )}
              >
                {t('dr.confirm')}
              </button>
            </div>
          </div>,
          document.body
        )}
    </>
  )
}
