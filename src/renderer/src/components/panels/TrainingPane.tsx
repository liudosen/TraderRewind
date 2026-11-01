import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Play,
  Pause,
  SkipForward,
  Plus,
  Minus,
  X,
  TrendingUp,
  TrendingDown,
  RefreshCw,
  Trash2,
  FolderOpen,
  PenLine,
  Square,
  Ruler,
  SlidersHorizontal,
  FileText,
  ChevronsLeft,
  ChevronsRight,
  ArrowUpRight,
  MoveUpRight,
  MoveHorizontal,
  MousePointer2,
  CheckCircle2,
  Circle,
  Type,
  Waypoints,
  RotateCcw,
  AlertTriangle,
  ArrowLeft
} from 'lucide-react'
import clsx from 'clsx'
import { useHotkeys } from 'react-hotkeys-hook'
import {
  useTrainingStore,
  quoteUsdRate,
  crossRateAt,
  activeTradeWindow,
  tradeWindowBlock,
  MAX_TRADE_TAGS,
  MAX_TRADE_TAG_LEN,
  revealIndexOf,
  type ClosedTrade,
  type Position
} from '../../stores/training-store'
import { ReplayChart, type PendingOrderView } from '../chart/ReplayChart'
import { TradeMetaDialog } from './TradeMetaDialog'
import { useTrainingClock } from '../../hooks/use-training-clock'
import { DateRangePicker } from '../common/DateRangePicker'
import { TagFilter, useTagFilter } from '../common/TagFilter'
import { TrainingReport } from './TrainingReport'
import { useAppStore } from '../../stores/app-store'
import {
  BASE_TIMEFRAMES,
  DEFAULT_TOOLBAR_TIMEFRAMES,
  timeframeCode,
  timeframeName
} from '@shared/utils/timeframe'
import { OVERLAYS, SUB_PANES, MAX_SUB_PANES } from '@shared/utils/indicators'
import { DRAWING_TOOLS, type DrawingType } from '@shared/types/drawing'
import { formatNumber, formatPrice, formatSigned } from '../../utils/format'
import { ExecutionCostCard } from '../common/ExecutionCostCard'
import { getContractSize } from '@shared/constants/catalog'
import { describeContract, pointValuePerLot, rateSourceLabel } from '@shared/utils/pnl'
import { closeBreakdown, commissionPerSide, slippagePrice } from '@shared/types/execution-cost'
import { useTimezoneStore } from '../../stores/timezone-store'
import { useT, translateLabel, type MessageKey } from '../../i18n'
import { tzPartsFromSec } from '@shared/types/timezone'
import {
  fmtTradeWindow,
  inTradeWindow,
  isOvernight,
  normalizeTradeWindow,
  tradeWindowMinutes,
  type TradeWindow
} from '@shared/types/trade-window'

const SPEED_OPTIONS = [1, 2, 5, 10]
/** 新建会话弹窗里的交易时段预设 */
const SESSION_WINDOW_PRESETS: ReadonlyArray<{ labelKey: MessageKey; from: string; to: string }> = [
  { labelKey: 'training.new.presetIntraday', from: '07:00', to: '23:00' },
  { labelKey: 'training.new.presetAsia', from: '07:00', to: '16:00' },
  { labelKey: 'training.new.presetUS', from: '21:00', to: '04:00' }
]
/** 工具栏周期最多可勾选数量 */
const MAX_TOOLBAR_TFS = 10
/** 平仓记录面板默认高度 */
const DEFAULT_TRADE_PANEL_H = 172
/** 拖动时的高度上下限 */
const MIN_TRADE_PANEL_H = 96

/** 周期列表（工具栏周期面板）自定义排序的存储键 */
const TF_ORDER_KEY = 'tr:toolbarTfOrder'
const CUSTOM_TF_RE = /^C\d+$/
/** 判定为「开始拖动」的最小位移（px），避免误吞掉勾选点击 */
const TF_DRAG_THRESHOLD = 4

/**
 * C 键「连按两次」的时间窗（ms）。
 *
 * 单击 C = 按开仓顺序平掉最早的一笔；两次落在窗口内 = 把剩下的全部平掉。
 * 这里刻意**不做**「等一下看是不是双击」的延迟：单按本来就有确定动作，
 * 延迟只会让平仓慢半拍。第二下命中窗口时升级成全平，最终结果仍是全部平掉。
 */
const CLOSE_ALL_PRESS_MS = 400

/**
 * 生成周期面板的展示顺序：已保存的顺序优先，
 * 新增的自定义周期插到最后一个自定义周期后面，其余缺项补到末尾。
 */
function buildTfOrder(saved: unknown, customs: string[]): string[] {
  const customIds = [...customs].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
  const all = [...customIds, ...BASE_TIMEFRAMES.map((o) => o.id as string)]
  const out: string[] = []
  if (Array.isArray(saved)) {
    for (const id of saved) {
      if (typeof id === 'string' && all.includes(id) && !out.includes(id)) out.push(id)
    }
  }
  for (const id of all) {
    if (out.includes(id)) continue
    if (!customIds.includes(id)) {
      out.push(id)
      continue
    }
    let at = -1
    for (let i = out.length - 1; i >= 0; i--) {
      if (customIds.includes(out[i])) {
        at = i
        break
      }
    }
    out.splice(at + 1, 0, id)
  }
  return out
}

function loadTfOrder(customs: string[], extra: readonly string[] = []): string[] {
  // 工具栏里可能残留已不在 customTfs 里的 C{n}，一并列出来，避免应用时被静默丢掉
  const merged = [...customs]
  for (const id of extra) {
    if (!merged.includes(id) && CUSTOM_TF_RE.test(id)) merged.push(id)
  }
  try {
    const raw = localStorage.getItem(TF_ORDER_KEY)
    return buildTfOrder(raw ? JSON.parse(raw) : null, merged)
  } catch {
    return buildTfOrder(null, merged)
  }
}

/** 把 from 位置的元素插到 to 位置（to 基于移动前的索引） */
function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from === to - 1) return list
  const next = list.slice()
  const [item] = next.splice(from, 1)
  next.splice(to > from ? to - 1 : to, 0, item)
  return next
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function dayKeyUtc(ts: number): string {
  const d = new Date(ts * 1000)
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
}

function dayStartSec(key: string): number {
  const [y, m, d] = key.split('-').map(Number)
  return Math.floor(Date.UTC(y, m - 1, d) / 1000)
}

function dayEndSec(key: string): number {
  return dayStartSec(key) + 86399
}

export function TrainingPane(): React.JSX.Element {
  const { t, locale } = useT()
  const datasets = useTrainingStore((s) => s.datasets)
  const sessions = useTrainingStore((s) => s.sessions)
  const activeSession = useTrainingStore((s) => s.activeSession)
  const symbol = useTrainingStore((s) => s.symbol)
  const timeframe = useTrainingStore((s) => s.timeframe)
  const digits = useTrainingStore((s) => s.digits)
  const bars = useTrainingStore((s) => s.bars)
  const cursor = useTrainingStore((s) => s.cursor)
  /** 精确到分钟的回放位置（= 最后一根已揭示的 1 分钟 K 线的时间） */
  const cursorTime = useTrainingStore((s) => s.cursorTime)
  /** 当前这根只走到一半时的截断版；走完了是 null */
  const partialBar = useTrainingStore((s) => s.partialBar)
  /** 回放窗口的起点（会话开头带的历史参考 K 线不算进度） */
  const initialCursor = useTrainingStore((s) => s.initialCursor)
  const playing = useTrainingStore((s) => s.playing)
  const setPlaying = useTrainingStore((s) => s.setPlaying)
  const barsPerSec = useTrainingStore((s) => s.barsPerSec)
  const initialBalance = useTrainingStore((s) => s.initialBalance)
  const riskPerTrade = useTrainingStore((s) => s.riskPerTrade)
  const balance = useTrainingStore((s) => s.balance)
  const lot = useTrainingStore((s) => s.lot)
  /** 当前所有持仓（可多笔、可多空对冲） */
  const positions = useTrainingStore((s) => s.positions)
  const activePositionId = useTrainingStore((s) => s.activePositionId)
  const selectPosition = useTrainingStore((s) => s.selectPosition)
  const closeAllPositions = useTrainingStore((s) => s.closeAllPositions)
  /** 右键开仓线减仓（只能减，不能加） */
  const reducePosition = useTrainingStore((s) => s.reducePosition)
  /**
   * 当前「操作焦点」的持仓。
   * activePositionId 可能因为关单/重开而暂时指不到（比如旧值），
   * 兜底取最后一笔（= 最新开的），这样价格卡的 SL/TP 永远有东西可显示。
   */
  const activePosition = useMemo(
    () =>
      positions.find((p) => p.id === activePositionId) ?? positions[positions.length - 1] ?? null,
    [positions, activePositionId]
  )
  const closedTrades = useTrainingStore((s) => s.closedTrades)
  const loading = useTrainingStore((s) => s.loading)
  const error = useTrainingStore((s) => s.error)

  // 实际回测用时：会话开着就自动计时（停表规则见 useTrainingClock）
  useTrainingClock(activeSession?.id ?? null, playing)

  const loadDatasets = useTrainingStore((s) => s.loadDatasets)
  const loadSessions = useTrainingStore((s) => s.loadSessions)
  const createSession = useTrainingStore((s) => s.createSession)
  const openSession = useTrainingStore((s) => s.openSession)
  const deleteSession = useTrainingStore((s) => s.deleteSession)
  const closeActiveSession = useTrainingStore((s) => s.closeActiveSession)
  const setTimeframe = useTrainingStore((s) => s.setTimeframe)
  const togglePlay = useTrainingStore((s) => s.togglePlay)
  const setBarsPerSec = useTrainingStore((s) => s.setBarsPerSec)
  const advance = useTrainingStore((s) => s.advance)
  const skipToNextTradeWindow = useTrainingStore((s) => s.skipToNextTradeWindow)
  const setLot = useTrainingStore((s) => s.setLot)
  const openPosition = useTrainingStore((s) => s.openPosition)
  const closePosition = useTrainingStore((s) => s.closePosition)
  const closeOldestPosition = useTrainingStore((s) => s.closeOldestPosition)
  const setSl = useTrainingStore((s) => s.setSl)
  const setTp = useTrainingStore((s) => s.setTp)
  const drawings = useTrainingStore((s) => s.drawings)
  const overlays = useTrainingStore((s) => s.overlays)
  const subPanes = useTrainingStore((s) => s.subPanes)
  const setDrawings = useTrainingStore((s) => s.setDrawings)
  const addIndicator = useTrainingStore((s) => s.addIndicator)
  const removeIndicator = useTrainingStore((s) => s.removeIndicator)
  const setIndicatorParams = useTrainingStore((s) => s.setIndicatorParams)
  const setIndicatorColor = useTrainingStore((s) => s.setIndicatorColor)
  const resetIndicatorParams = useTrainingStore((s) => s.resetIndicatorParams)
  const focusedTrade = useTrainingStore((s) => s.focusedTrade)
  const focusSeq = useTrainingStore((s) => s.focusSeq)
  const completedAt = useTrainingStore((s) => s.completedAt)
  const openedAtEnd = useTrainingStore((s) => s.openedAtEnd)
  const resetSession = useTrainingStore((s) => s.resetSession)
  const focusTrade = useTrainingStore((s) => s.focusTrade)
  const setFocusedTrade = useTrainingStore((s) => s.setFocusedTrade)
  const focusNote = useTrainingStore((s) => s.focusNote)
  const clearFocusNote = useTrainingStore((s) => s.clearFocusNote)

  /**
   * 是不是「从日志点某笔交易跳过来的」。
   * 是的话顶栏挂一个高亮的「返回日志」，让人一眼看到回头路怎么走。
   */
  const journalReturn = useAppStore((s) => s.journalReturn)
  const backToJournal = useCallback(() => {
    useAppStore.getState().setActivePane('journal')
  }, [])

  /**
   * 当前允许图表显示到哪一根 K 线（含）：回放没走完就是游标那根。
   *
   * 这一条是全场的统一口径 —— 图表定位、订单跳转、报告跳转都认它，
   * 不许任何一条路径越过游标去展示还没走到的行情。
   */
  const revealIndex = useMemo(
    () => revealIndexOf(bars, cursor, completedAt),
    [bars, cursor, completedAt]
  )

  /** 「这笔单暂不定位」的提示只闪一下，别一直挂在那儿 */
  useEffect(() => {
    if (!focusNote) return
    const timer = setTimeout(() => clearFocusNote(), 4500)
    return () => clearTimeout(timer)
  }, [focusNote, clearFocusNote])

  /** 订单时间按当前生效时区显示：历史会话用它自己打单时记录的时区 */
  const timezone = useTimezoneStore((s) => s.effective)
  /** 设置页维护的标签库：下单时可一键点亮 */
  const tagLibrary = useTrainingStore((s) => s.tagLibrary)
  /** 交易成本模型（手续费 + 滑点）：下单条右侧那张卡 */
  const executionCost = useTrainingStore((s) => s.executionCost)
  const setExecutionCost = useTrainingStore((s) => s.setExecutionCost)

  /** 平仓记录的标签筛选：只影响下方列表，不动图表定位与余额 */
  const tradeTags = useTagFilter(closedTrades)

  /**
   * 正在编辑备注/标签的那一笔已平仓交易。
   *
   * 只改 note 与 tags —— 价格和盈亏是回放当场算出来的，事后一律不动，
   * 否则「这笔单当时赚了多少」就跟着备注一起被改写了，复盘失去意义。
   */
  const [editingTrade, setEditingTrade] = useState<ClosedTrade | null>(null)

  const [dialogOpen, setDialogOpen] = useState(false)
  /** 待确认删除的会话 id（点击一次垃圾桶就弹确认浮窗） */
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null)
  /** 重置确认浮窗 */
  const [confirmReset, setConfirmReset] = useState(false)
  const [tool, setTool] = useState<DrawingType | null>(null)
  const [indicatorMenu, setIndicatorMenu] = useState(false)
  // 工具栏显示的周期（可配置）
  const [toolbarTfs, setToolbarTfs] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem('tr:toolbarTimeframes')
      const arr = raw ? JSON.parse(raw) : null
      if (Array.isArray(arr) && arr.length > 0) return arr.filter((x: any) => typeof x === 'string')
    } catch {
      // 忽略
    }
    return [...DEFAULT_TOOLBAR_TIMEFRAMES]
  })
  const [tfMenuOpen, setTfMenuOpen] = useState(false)
  const [tfDraft, setTfDraft] = useState<string[]>([])
  // 用户创建过的自定义周期（持久化，排在列表最上方）
  const [customTfs, setCustomTfs] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem('tr:customTimeframes')
      const arr = raw ? JSON.parse(raw) : null
      if (Array.isArray(arr)) return arr.filter((x: any) => typeof x === 'string')
    } catch {
      // 忽略
    }
    return []
  })
  // 自定义周期输入
  const [customOpen, setCustomOpen] = useState(false)
  const [customVal, setCustomVal] = useState('')
  // 周期面板的展示顺序（可拖动调整，应用后落盘）
  const [tfOrder, setTfOrder] = useState<string[]>(() => loadTfOrder(customTfs, toolbarTfs))
  // 拖动排序的中间态
  const [tfDragId, setTfDragId] = useState<string | null>(null)
  const [tfDropIndex, setTfDropIndex] = useState<number | null>(null)
  const tfDragRef = useRef<{
    id: string
    index: number
    startY: number
    active: boolean
    drop: number | null
  } | null>(null)
  /** 刚结束拖动：抑制随之而来的 click，避免顺手把勾选也切换掉 */
  const tfJustDraggedRef = useRef(false)
  const tfListRef = useRef<HTMLDivElement>(null)
  /** 上一次按 C 的时刻，用来判定「快速连按两次」（见 CLOSE_ALL_PRESS_MS） */
  const lastCPressRef = useRef(0)

  /**
   * 持仓列表的滚动容器。
   *
   * 持仓超过 4 笔时这块要滚动，而新开的仓默认追加在末尾、正好落在可视区外——
   * 用户刚点完「买入」反而看不到自己那笔。所以焦点一换就把对应行滚进视野。
   *
   * 这里自己算 scrollTop 而不用 scrollIntoView：后者会把外层所有可滚动祖先
   * （包括整个 main）一起滚，界面会莫名跳一下。
   */
  const posListRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const box = posListRef.current
    const id = activePosition?.id
    if (!box || !id) return
    const row = box.querySelector<HTMLElement>(`[data-pos-row="${id}"]`)
    if (!row) return
    const r = row.getBoundingClientRect()
    const b = box.getBoundingClientRect()
    // 行比容器还高（极端情况）时优先保证顶部可见
    if (r.top < b.top) box.scrollTop -= b.top - r.top
    else if (r.bottom > b.bottom) box.scrollTop += r.bottom - b.bottom
  }, [activePosition?.id, positions.length])

  useEffect(() => {
    localStorage.setItem('tr:customTimeframes', JSON.stringify(customTfs))
  }, [customTfs])

  /** 周期面板的拖动排序（上下拖动手柄式交互，不依赖第三方库） */
  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      const d = tfDragRef.current
      if (!d) return
      if (!d.active) {
        if (Math.abs(e.clientY - d.startY) < TF_DRAG_THRESHOLD) return
        d.active = true
        setTfDragId(d.id)
        setTfDropIndex(d.index)
        document.body.style.userSelect = 'none'
        document.body.style.cursor = 'grabbing'
      }
      // 贴近列表上下边缘时自动滚动
      const box = tfListRef.current
      if (box) {
        const r = box.getBoundingClientRect()
        if (e.clientY < r.top + 22) box.scrollTop -= 10
        else if (e.clientY > r.bottom - 22) box.scrollTop += 10
      }
      const hit = document.elementFromPoint(e.clientX, e.clientY)
      const rowEl = hit instanceof Element ? hit.closest('[data-tf-row]') : null
      if (!rowEl) return
      const idx = Number(rowEl.getAttribute('data-tf-index'))
      if (!Number.isFinite(idx)) return
      const r = rowEl.getBoundingClientRect()
      d.drop = e.clientY < r.top + r.height / 2 ? idx : idx + 1
      setTfDropIndex(d.drop)
    }

    const onUp = (): void => {
      const d = tfDragRef.current
      tfDragRef.current = null
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      setTfDragId(null)
      setTfDropIndex(null)
      if (!d || !d.active) return
      tfJustDraggedRef.current = true
      const to = d.drop
      if (to != null) setTfOrder((prev) => moveItem(prev, d.index, to))
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [])

  const onTfRowPointerDown = (e: React.PointerEvent, id: string, index: number): void => {
    if (e.button !== 0) return
    tfJustDraggedRef.current = false
    tfDragRef.current = { id, index, startY: e.clientY, active: false, drop: null }
  }

  const openTfMenu = (): void => {
    setTfDraft([...toolbarTfs])
    setTfOrder(loadTfOrder(customTfs, toolbarTfs))
    setCustomOpen(false)
    setCustomVal('')
    setTfMenuOpen(true)
  }

  /** 添加自定义周期（分钟），范围 1~10080（一周） */
  const addCustomTf = (): void => {
    const n = Math.floor(Number(customVal))
    if (!Number.isFinite(n) || n < 1 || n > 10080) return
    const id = `C${n}`
    setCustomTfs((prev) => (prev.includes(id) ? prev : [...prev, id]))
    setTfOrder((prev) => buildTfOrder(prev, [...customTfs, id]))
    setTfDraft((prev) =>
      prev.includes(id) || prev.length >= MAX_TOOLBAR_TFS ? prev : [...prev, id]
    )
    setCustomVal('')
    setCustomOpen(false)
  }

  const applyTfDraft = (): void => {
    // 工具栏顺序 = 列表顺序，勾选只决定「显不显示」
    let next = tfOrder.filter((id) => tfDraft.includes(id))
    if (next.length === 0) next = DEFAULT_TOOLBAR_TIMEFRAMES.filter((id) => tfOrder.includes(id))
    if (next.length === 0) next = tfOrder.slice(0, MAX_TOOLBAR_TFS)
    // 当前周期必须可见
    if (!next.includes(timeframe)) next = [...next, timeframe]
    // 超出上限时从末尾裁掉，但保留当前周期
    if (next.length > MAX_TOOLBAR_TFS) {
      const keep = next.filter((x) => x !== timeframe).slice(0, MAX_TOOLBAR_TFS - 1)
      next = [...keep, timeframe]
    }
    setToolbarTfs(next)
    localStorage.setItem('tr:toolbarTimeframes', JSON.stringify(next))
    localStorage.setItem(TF_ORDER_KEY, JSON.stringify(tfOrder))
    setTfMenuOpen(false)
    setCustomOpen(false)
    setCustomVal('')
  }
  const [reportOpen, setReportOpen] = useState(false)
  // 会话列表是否显示
  const [sessionSidebarOpen, setSessionSidebarOpen] = useState<boolean>(
    () => localStorage.getItem('tr:sessionSidebar') !== '0'
  )

  /**
   * 右侧主列的实时宽度（px）。
   *
   * 这个面板到处都是「一行里塞很多东西」的横条：顶部工具条、下单条、平仓记录。
   * 以前它们都是不换行 + 子项 shrink-0，窗口一窄就往外顶，而外层 main 是
   * overflow-hidden —— 多出来的部分被直接裁掉，用户看到的就是
   * 「窗口化之后右侧被遮盖」：报告 / 重置 / 进度 / 关闭按钮全都不见了，
   * 也没有任何滚动条可以找回来。
   *
   * 解决办法是拿到真实可用宽度，按档位把次要信息收起来，保证主要操作永远在屏幕内。
   * 0 表示还没量到（第一帧），此时按最宽档位渲染，避免刚打开时闪一下。
   */
  const [colW, setColW] = useState(0)
  const colRoRef = useRef<ResizeObserver | null>(null)
  const colRef = useCallback((el: HTMLDivElement | null) => {
    colRoRef.current?.disconnect()
    colRoRef.current = null
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0]?.contentRect.width ?? 0)
      // 宽度没变就不写 state，避免 RO → render → RO 的空转
      setColW((prev) => (prev === w ? prev : w))
    })
    ro.observe(el)
    colRoRef.current = ro
  }, [])

  /** 收起「纯展示」信息：品种徽标、已完成徽标、进度百分比 */
  const barTight = colW > 0 && colW < 980
  /** 速度选择器压缩成一个循环按钮 + 下单条卡片收紧 */
  const barMid = colW > 0 && colW < 900
  /** 最窄档：按钮只留图标（已经到底了，再窄只能水平滚动） */
  const barNarrow = colW > 0 && colW < 560

  useEffect(() => {
    localStorage.setItem('tr:sessionSidebar', sessionSidebarOpen ? '1' : '0')
  }, [sessionSidebarOpen])
  const [orderSide, setOrderSide] = useState<'buy' | 'sell' | null>(null)
  /**
   * 图上那张「待确认的下单」。
   *
   * 按 B/S 只创建它，不直接开仓：用户在图上看得见开仓线、能拖止损止盈、
   * 能看见这笔要下多少手、亏多少，点「确认」才进备注浮窗，填完才真正成交。
   *
   * 手数不存这里 —— 直接跟着工具栏那个 `lot` 走，这样按 ↑/↓ 时票面上的手数
   * 立刻变，不会出现「票面写 0.10、实际下 0.20」的两套数。
   */
  const [orderDraft, setOrderDraft] = useState<{
    side: 'buy' | 'sell'
    entry: number
    entryTime: number
    sl: number | null
    tp: number | null
  } | null>(null)
  const [orderNote, setOrderNote] = useState('')
  /** 开仓时给这笔单子打的标签（最多 10 个，随订单存进当前回测集） */
  const [orderTags, setOrderTags] = useState<string[]>([])
  /** 标签输入框是否展开（点小加号才出现） */
  const [tagEditing, setTagEditing] = useState(false)
  const [tagDraft, setTagDraft] = useState('')
  /** 图表上的一闪而过的提示（比如「不在交易时段」） */
  const [notice, setNotice] = useState<string | null>(null)
  const noticeTimer = useRef<number | null>(null)
  const flash = (msg: string): void => {
    setNotice(msg)
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(null), 2800)
  }
  useEffect(() => () => { if (noticeTimer.current) window.clearTimeout(noticeTimer.current) }, [])

  /**
   * 跳到下一个交易时段。
   *
   * 只有「设了交易时段」且「当前不在时段内」才真的跳；其余情况 store 会把原因
   * 返回回来，这里翻译成一句话弹出去 —— 按了没反应是最难排查的交互。
   */
  const jumpToNextWindow = (): void => {
    if (!activeSession) return
    const r = skipToNextTradeWindow()
    if (r === 'ok') return
    flash(
      t(
        r === 'no-window'
          ? 'training.skipNoWindow'
          : r === 'in-window'
            ? 'training.skipInWindow'
            : r === 'has-positions'
              ? 'training.skipHasPositions'
              : 'training.skipNoData'
      )
    )
  }
  const tagInputRef = useRef<HTMLInputElement>(null)
  const autoReportRef = useRef<number | null>(null)

  // 平仓记录面板高度（可拖动，记忆到 localStorage）
  const [tradePanelH, setTradePanelH] = useState<number>(() => {
    const saved = Number(localStorage.getItem('tr:tradePanelH'))
    return Number.isFinite(saved) && saved >= MIN_TRADE_PANEL_H ? saved : DEFAULT_TRADE_PANEL_H
  })
  const resizeRef = useRef<{ startY: number; startH: number } | null>(null)

  useEffect(() => {
    localStorage.setItem('tr:tradePanelH', String(tradePanelH))
  }, [tradePanelH])

  const beginResize = (e: React.MouseEvent): void => {
    e.preventDefault()
    resizeRef.current = { startY: e.clientY, startH: tradePanelH }
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
  }

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const st = resizeRef.current
      if (!st) return
      // 向上拖变大，向下拖变小
      const next = st.startH - (e.clientY - st.startY)
      const max = Math.max(220, window.innerHeight - 280)
      setTradePanelH(Math.max(MIN_TRADE_PANEL_H, Math.min(max, next)))
    }
    const onUp = () => {
      if (!resizeRef.current) return
      resizeRef.current = null
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  useEffect(() => {
    void loadDatasets()
    void loadSessions()
  }, [loadDatasets, loadSessions])

  // 回放定时器
  useEffect(() => {
    if (!playing) return
    const interval = window.setInterval(() => advance(), 1000 / barsPerSec)
    return () => window.clearInterval(interval)
  }, [playing, barsPerSec, advance])

  useEffect(() => {
    return () => {
      useTrainingStore.getState().persistState()
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setTool(null)
        setIndicatorMenu(false)
        setConfirmDeleteId(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /** 切周期：顺便清掉聚焦交易的参考线（跨周期看那两条线没有意义） */
  const changeTimeframe = (tf: string): void => {
    setFocusedTrade(null)
    setTimeframe(tf)
  }

  /**
   * 指向「最新那一版」的提交函数。
   *
   * 全局热键 B/S 的回调只依赖 orderSide（不随备注每次输入重新注册），所以它闭包里
   * 拿到的 beginOrder / submitOrder 都是**弹窗打开那一刻**的旧版本 —— 直接调用会把
   * 用户后来写进框里的备注、点亮的标签全部丢掉。用 ref 转一手，永远调到最新那版。
   */
  const submitOrderRef = useRef<(withNote: boolean) => void>(() => {})

  const beginOrder = (side: 'buy' | 'sell'): void => {
    // 注意：这里不再拦「已有持仓」—— 允许同向加仓，也允许同时开反向单对冲
    // 交易时段外直接拦掉：连备注浮窗都不弹，避免用户填完才发现下不了单
    const block = tradeWindowBlock()
    if (block) {
      setOrderSide(null)
      setOrderDraft(null)
      flash(translateLabel(locale, block))
      return
    }
    // 浮窗已经开着、又按了同一个方向键 = 直接下单（B/B、S/S 都能这么用）
    // 走 ref 调到最新那版 submitOrder，这样框里已经写好的备注、点亮的标签都会带上
    if (orderSide === side) {
      submitOrderRef.current(true)
      return
    }
    // 待确认单已经在图上、又按了同方向 = 进备注浮窗（等同点票面上的「确认」）
    if (orderDraft?.side === side) {
      const st = useTrainingStore.getState()
      if (st.playing) st.setPlaying(false)
      setOrderSide(side)
      return
    }
    // 开仓弹窗打开时行情继续跑会让人来不及看清价格，先暂停自动播放。
    // 这里必须用 getState() 取最新值：热键回调是按依赖数组缓存的，
    // 闭包里的 playing 可能是旧值，导致「弹窗打开了但还在播放」。
    const st = useTrainingStore.getState()
    if (st.playing) st.setPlaying(false)

    /**
     * 在图上摆一条待确认的下单线，而不是先弹浮窗。
     *
     * 成交价在**按下这一刻**就定死：回放已经暂停，用户拖止损止盈、看金额都基于这条线，
     * 确认时若再按当时的价格重算，线会跳一下，等于把用户刚才拖的东西作废。
     * 滑点在这里就计进去 —— 票面上写的价，就是他真正会成交的价。
     */
    const bar = st.partialBar ?? st.bars[st.cursor]
    // 一根 K 线都没有时摆不出价格线，直接什么都不做
    if (!bar) return
    const slip = slippagePrice(st.executionCost, st.digits)
    const raw = side === 'buy' ? bar.close + slip : bar.close - slip
    setOrderDraft({
      side,
      entry: Number(raw.toFixed(st.digits)),
      entryTime: st.cursorTime || bar.time,
      sl: null,
      tp: null
    })
    setOrderSide(null)
    setOrderNote('')
    setOrderTags([])
    setTagDraft('')
    setTagEditing(false)
  }

  const submitOrder = (withNote: boolean): void => {
    if (!orderSide) return
    // 浮窗开着的时候行情可能已经跑出时段，提交前再判一次
    const block = tradeWindowBlock()
    if (block) {
      setOrderSide(null)
      setOrderDraft(null)
      flash(translateLabel(locale, block))
      return
    }
    // 输入框里还没回车的标签也一起带上：点「确认下单」时输入框先失焦，
    // 状态更新未必赶在这一次 click 之前，这里兜一次底
    const pending = tagDraft.trim().slice(0, MAX_TRADE_TAG_LEN)
    const tags =
      pending && !orderTags.includes(pending) && orderTags.length < MAX_TRADE_TAGS
        ? [...orderTags, pending]
        : orderTags
    /**
     * 成交价 / 手数 / 止损止盈都取图上那张待确认单的 —— 用户在图上看到什么，
     * 成交就是什么。没有待确认单（老路径，理论上走不到）就交给 store 按当前 K 线算。
     */
    openPosition(
      orderSide,
      withNote ? orderNote : undefined,
      tags,
      orderDraft
        ? {
            entry: orderDraft.entry,
            entryTime: orderDraft.entryTime,
            sl: orderDraft.sl,
            tp: orderDraft.tp,
            lot
          }
        : undefined
    )
    setOrderSide(null)
    setOrderDraft(null)
    setOrderNote('')
    setOrderTags([])
    setTagDraft('')
    setTagEditing(false)
  }

  // 每次渲染后把 ref 指向最新那版 submitOrder（它闭包里的备注/标签/方向都是最新的）
  useEffect(() => {
    submitOrderRef.current = submitOrder
  })

  /** 确认当前输入框里的标签 */
  const commitTag = (): void => {
    const value = tagDraft.trim().slice(0, MAX_TRADE_TAG_LEN)
    setTagDraft('')
    setTagEditing(false)
    if (!value) return
    setOrderTags((prev) =>
      prev.includes(value) || prev.length >= MAX_TRADE_TAGS ? prev : [...prev, value]
    )
  }

  const removeTag = (tag: string): void => {
    setOrderTags((prev) => prev.filter((tagItem) => tagItem !== tag))
  }

  // 展开标签输入框后立刻聚焦，省一次点击
  useEffect(() => {
    if (tagEditing) tagInputRef.current?.focus()
  }, [tagEditing])

  // 备注框【不自动聚焦】。
  // 原因：焦点一旦落进 textarea，react-hotkeys-hook 就不再响应表单元素里的按键，
  // 用户想「再按一次 B 下单」会失效（键被输入框吃掉了）——所以由 textarea 自己的
  // onKeyDown 接管这个键，见下面的 JSX。
  // 想写备注就自己点一下框，不写就保持全局热键可用。

  // 开仓弹窗打开时按 Esc 关闭（焦点不在 textarea 时也能用）
  useEffect(() => {
    if (!orderSide) return
    // 打开时不聚焦备注框，但也不让焦点留在「买入」按钮上——
    // 让出焦点后 B/S/C/空格 这些全局热键才稳定收得到按键。
    const active = document.activeElement as HTMLElement | null
    if (active && active !== document.body && typeof active.blur === 'function') active.blur()

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOrderSide(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [orderSide])

  /**
   * 待确认单的 Esc：撤掉这张单子。
   *
   * 和浮窗那个 Esc 分开写、优先级也分开 —— 两个状态不会同时存在
   * （点「确认」时浮窗接手、单子仍然留在图上，此时 Esc 该关浮窗而不是撕单）。
   */
  useEffect(() => {
    if (!orderDraft || orderSide) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // 输入框里按 Esc 是「退出输入」的意思，别顺手把单子撕了
      const el = e.target as HTMLElement | null
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return
      setOrderDraft(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [orderDraft, orderSide])

  // 关窗 / 切走 / 离开训练页时，把当前回放进度写进会话，下次打开接着打
  useEffect(() => {
    if (!activeSession) return
    const flush = (): void => {
      useTrainingStore.getState().flushPersist()
    }
    const onHide = (): void => {
      if (document.visibilityState === 'hidden') flush()
    }
    window.addEventListener('beforeunload', flush)
    document.addEventListener('visibilitychange', onHide)
    return () => {
      window.removeEventListener('beforeunload', flush)
      document.removeEventListener('visibilitychange', onHide)
      flush()
    }
  }, [activeSession?.id])

  // 回放走到最后一根且有交易时，自动弹出一次训练报告。
  // 但「打开时就停在末尾」的已完成回测集不算——那种情况用户只想看盘，不想被报告糊脸。
  useEffect(() => {
    if (!activeSession) return
    if (openedAtEnd) return
    if (reportOpen) return
    if (closedTrades.length === 0) return
    if (bars.length === 0 || cursor < bars.length - 1) return
    if (autoReportRef.current === activeSession.id) return
    autoReportRef.current = activeSession.id
    setReportOpen(true)
  }, [cursor, bars.length, closedTrades.length, activeSession?.id, openedAtEnd, reportOpen])

  /**
   * 回放进度（只做展示，不可拖动）。
   *
   * 分母用「回测区间根数」。`initialCursor` 是当前周期数组里的下标，
   * 切过周期后由 store 按时间重算；这里再夹一次，防止历史脏数据把它推到数组外，
   * 一越界分母就会被兜成 1，进度直接显示成满格。
   */
  const replayStart = Math.min(Math.max(0, initialCursor), Math.max(0, bars.length - 1))
  const replayBars = Math.max(1, bars.length - 1 - replayStart + 1)
  const progress = bars.length > 1
    ? Math.min(1, Math.max(0, (cursor - replayStart) / Math.max(1, bars.length - 1 - replayStart)))
    : 0
  /**
   * 「现在」这根 K 线 = 已经揭示到的位置。
   *
   * 显示周期比 1 分钟大时，`bars[cursor]` 是整根（含还没走到的分钟），
   * 它的 close 是未来的价格 —— 价格卡、下单按钮上的报价、浮动盈亏都必须用
   * `partialBar`，否则切到大周期就等于提前看到了这一格的收盘价。
   */
  const currentBar = partialBar ?? bars[cursor]
  /** 界面上的「当前时刻」：精确到分钟，比 bars[cursor].time 的桶起点准 */
  const currentTime = cursorTime || currentBar?.time || 0
  const priceDigits = digits

  /**
   * 回放窗口的起点下标。
   *
   * 会话开头会带一段「历史参考」K 线（见 store 里的 warmupSeconds）——
   * 它们只用来给用户看盘，不会被回放推进到。所以进度和「第几根 / 共几根」
   * 都要从这根算起，否则一打开会话就显示完成了 20%，看着像进度丢了。
   * 具体取值见上面的 replayStart（已经夹在数组范围内）。
   */

  /** 当前回测集的交易时段（null = 全天不限）；按会话自己的时区判定 */
  const sessionTradeWindow = useTrainingStore((s) => s.activeSession?.trade_window)
  const tradeWindow = useMemo(() => normalizeTradeWindow(sessionTradeWindow), [sessionTradeWindow])
  const inWindowNow = currentBar ? inTradeWindow(currentTime, timezone, tradeWindow) : true

  /**
   * 交叉盘的「报价货币 → 美元」汇率序列（本机美元直盘）。
   * 美元报价/美元基准的品种是 null，汇率就靠自身价格推。
   */
  const crossRate = useTrainingStore((s) => s.crossRate)

  /** 「当下这一帧」的报价货币→美元汇率。多笔持仓共用同一次查表，避免每笔都二分一遍。 */
  const quoteToUsdNow = useMemo(
    () => crossRateAt(crossRate, currentTime),
    [crossRate, currentTime]
  )

  /**
   * 「现在就把这 N 手平掉，净落袋多少」—— 全页唯一的平仓估价入口。
   *
   * 算术和 store 里的 settlePosition 共用 `closeBreakdown`，
   * 所以面板上预览的数、真平仓出来的数、图表 SL/TP 线上的金额永远一致：
   *  · 平仓端吃不吃滑点由 slippage 决定（止损/市价吃，止盈是限价成交不吃）；
   *  · 开仓佣金按整笔手数收的，结算 N 手只带走 N / 总手数 那部分；
   *  · 平仓那侧佣金按本次成交价的名义价值现算；
   *  · 交叉盘再按出场价把报价货币盈亏折成美元。
   */
  const closeAt = useCallback(
    (p: Position, lotSize: number, rawPrice: number, slippage: boolean) =>
      closeBreakdown({
        pos: p,
        cutLot: lotSize,
        rawExitPrice: rawPrice,
        cost: executionCost,
        quoteToUsd: quoteToUsdNow,
        slippage
      }),
    [executionCost, quoteToUsdNow]
  )

  /** 金额的统一写法：+$36.50 / -$12.40 / $0.00（轴标签窄，不铺开成 "USD 36.50"） */
  const money = useCallback(
    (n: number): string => `${n > 0 ? '+' : n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`,
    []
  )

  /**
   * 「打到这条止盈/止损线，这笔单子到底赚多少 / 亏多少」—— 图表价格线轴标签上那串金额。
   *
   * 必须和真正成交时走同一套算法，否则线上写 +30、平出来 +28，用户会以为算错了。
   * 现在直接调 closeAt，连滑点和两边佣金都和结算一致，不用再各写一遍。
   */
  const riskPnlLabel = useCallback(
    (p: Position, kind: 'sl' | 'tp'): string => {
      const target = kind === 'sl' ? p.sl : p.tp
      if (target == null || !Number.isFinite(target)) return ''
      return money(closeAt(p, p.lot, target, kind === 'sl').net)
    },
    [closeAt, money]
  )

  /**
   * 减仓面板里的实时预览：按**当前收盘价**把 `lotSize` 手平掉，大约落袋多少。
   *
   * 减仓是市价单，所以吃滑点（和 store 里 reason='partial' 的处理一致）；
   * 用到的价格是 currentBar.close，回放前进一根，这个数就跟着变。
   */
  const lotPnlLabel = useCallback(
    (p: Position, lotSize: number): string => {
      if (!currentBar) return ''
      return money(closeAt(p, lotSize, currentBar.close, true).net)
    },
    [currentBar, closeAt, money]
  )

  /**
   * 待确认单在图上那张票面：左边「方向+手数」、右边「风险金额」。
   *
   * 金额不是随手估的 —— 拿一个**假的 Position** 去调 `closeAt`，
   * 用的就是真实成交那套算法（开仓佣金、平仓佣金、滑点、交叉盘折算）。
   * 这样票面上写 -$12.40，确认成交后止损线上写的也一定是 -$12.40；
   * 各算一套的话，两个数对不上，用户会以为哪边算错了。
   *
   * 手数直接取工具栏那个 `lot`：按 ↑/↓ 调手数时票面立刻跟着变。
   */
  const pendingView = useMemo<PendingOrderView | null>(() => {
    if (!orderDraft) return null
    const contractSize = symbol ? getContractSize(symbol) : 100
    const entryRate = quoteUsdRate(symbol ?? '', orderDraft.entry, { quoteToUsd: quoteToUsdNow }).rate
    const synthetic: Position = {
      id: '__pending__',
      side: orderDraft.side,
      symbol: symbol ?? '',
      lot,
      entryPrice: orderDraft.entry,
      entryTime: orderDraft.entryTime,
      sl: orderDraft.sl,
      tp: orderDraft.tp,
      digits: priceDigits,
      contractSize,
      entryCommission: commissionPerSide(executionCost, lot, contractSize, orderDraft.entry, entryRate),
      note: null,
      tags: []
    }
    // 止损是市价单（吃滑点），止盈是限价成交（不吃）—— 与 riskPnlLabel 一致
    const slNet = orderDraft.sl != null ? closeAt(synthetic, lot, orderDraft.sl, true).net : null
    const tpNet = orderDraft.tp != null ? closeAt(synthetic, lot, orderDraft.tp, false).net : null
    return {
      side: orderDraft.side,
      entry: orderDraft.entry,
      sl: orderDraft.sl,
      tp: orderDraft.tp,
      lotText: t('chart.pendingLot', {
        side: orderDraft.side === 'buy' ? t('training.buy') : t('training.sell'),
        lot: lot.toFixed(2)
      }),
      riskText: slNet == null ? t('chart.pendingNoSl') : money(slNet),
      riskIsLoss: slNet != null && slNet < 0,
      slLabel: slNet == null ? '' : money(slNet),
      tpLabel: tpNet == null ? '' : money(tpNet)
    }
  }, [orderDraft, lot, symbol, priceDigits, executionCost, quoteToUsdNow, closeAt, money, t])

  /**
   * 拖待确认单的止损/止盈。
   *
   * 夹取规则比持仓宽松一点，因为这时候还没有持仓、也就没有「现价」可参考：
   * 止损只能落在开仓价的亏损侧、止盈只能落在盈利侧，各自至少离一个最小跳动。
   * 反向越界不是「拒绝」，而是贴着边界 —— 手感上像拖到墙，不会突然弹回去。
   */
  const setPendingRisk = useCallback(
    (kind: 'sl' | 'tp', price: number): void => {
      setOrderDraft((d) => {
        if (!d) return d
        const point = Math.pow(10, -priceDigits)
        const buy = d.side === 'buy'
        const v = Number(price.toFixed(priceDigits))
        if (kind === 'sl') {
          const maxSl = Number((d.entry - point).toFixed(priceDigits))
          const minSl = Number((d.entry + point).toFixed(priceDigits))
          return { ...d, sl: buy ? Math.min(v, maxSl) : Math.max(v, minSl) }
        }
        const minTp = Number((d.entry + point).toFixed(priceDigits))
        const maxTp = Number((d.entry - point).toFixed(priceDigits))
        return { ...d, tp: buy ? Math.max(v, minTp) : Math.min(v, maxTp) }
      })
    },
    [priceDigits]
  )

  /**
   * 浮动盈亏 = 所有持仓各自的净浮动之和。
   *
   * 多持仓 / 双向对冲时不能只看一笔：一边多一边空的时候，
   * 两条腿的盈亏会互相抵掉，只有加起来才是账户真实的浮动。每笔都按当下汇率折美元。
   *
   * 每笔都是**净额**（扣掉开仓佣金 + 平仓佣金 + 平仓滑点），所以「权益 = 余额 + 浮动」
   * 就等于「现在全部平掉之后账上有多少钱」，和真平完的结果一分不差。
   * 以前这里只算价差，于是同一笔单子在图上 SL 标签写 -96.59、持仓行写 -95.89，
   * 差的 0.90 正好是 0.1 手黄金的双边成本；止损拉得越紧，这点固定成本占的比例越大
   * （1 美元止损要多付 9%，20 美元止损只多付 0.5%），
   * 看起来就像「同样手数有时亏得多、有时亏得少」。
   */
  const floatingPnl = useMemo(() => {
    if (positions.length === 0 || !currentBar) return 0
    return positions.reduce((sum, p) => sum + closeAt(p, p.lot, currentBar.close, true).net, 0)
  }, [positions, currentBar, closeAt])

  /** 多空两头各自的手数，持仓卡上给个一眼可读的净敞口 */
  const exposure = useMemo(() => {
    let long = 0
    let short = 0
    for (const p of positions) {
      if (p.side === 'buy') long += p.lot
      else short += p.lot
    }
    return { long, short, net: long - short }
  }, [positions])

  /**
   * 「真实每手价值」：1 手代表多少合约 + 当前手数下每 1 点值多少美元。
   * 美元报价的品种点值是常数；USDJPY / 交叉盘的点值随汇率浮动，所以按当前 K 线价实时算。
   */
  const lotValue = useMemo(() => {
    if (!symbol) return null
    const price = currentBar ? currentBar.close : 0
    const pv = pointValuePerLot(symbol, price, {
      quoteToUsd: crossRateAt(crossRate, currentTime)
    })
    return {
      ...pv,
      desc: describeContract(symbol, locale),
      perPointAtLot: pv.usd * lot,
      perPointPerLot: pv.usd
    }
  }, [symbol, currentBar, currentTime, crossRate, lot, locale])

  const equity = balance + floatingPnl

  const stats = useMemo(() => {
    const total = closedTrades.reduce((s, trade) => s + trade.pnl, 0)
    const wins = closedTrades.filter((trade) => trade.pnl > 0).length
    const winRate = closedTrades.length > 0 ? (wins / closedTrades.length) * 100 : 0
    return { total, winRate, count: closedTrades.length }
  }, [closedTrades])

  useHotkeys(
    'space',
    (e) => {
      e.preventDefault()
      // 备注浮窗开着时不响应：否则会在弹窗背后偷偷开始/暂停回放
      if (orderSide || orderDraft) return
      if (activeSession) togglePlay()
    },
    [activeSession, togglePlay, orderSide, orderDraft]
  )
  // 回放控制：Shift+→ 逐根前进、空格 播放/暂停
  // 回测不允许回退（不提供「上一根」），避免用户反悔已发生的行情
  useHotkeys(
    'shift+arrowright',
    (e) => {
      e.preventDefault()
      if (orderSide || orderDraft) return
      if (activeSession) advance()
    },
    [activeSession, advance, orderSide, orderDraft]
  )
  // T = 跳到下一个交易时段。只在「当前不在时段内」时生效；
  // 没设交易时段的会话按了不生效（只弹一句为什么）。
  useHotkeys(
    't',
    (e) => {
      e.preventDefault()
      if (orderSide || orderDraft) return
      jumpToNextWindow()
    },
    [orderSide, orderDraft, jumpToNextWindow]
  )

  // B / S / C 开平仓快捷键
  // 弹窗打开时会再把焦点交还给页面（不自动聚焦备注框），所以这里始终能收到按键：
  // 连按两次 B = 跳过备注直接下单。
  useHotkeys(
    'b',
    (e) => {
      e.preventDefault()
      beginOrder('buy')
    },
    [orderSide, orderDraft]
  )
  useHotkeys(
    's',
    (e) => {
      e.preventDefault()
      beginOrder('sell')
    },
    [orderSide, orderDraft]
  )
  // C = 平仓：单击按「开仓顺序」平掉最早的一笔，快速连按两次 = 全部平仓
  useHotkeys(
    'c',
    (e) => {
      e.preventDefault()
      if (orderSide || orderDraft) return
      if (positions.length === 0) return

      const now = Date.now()
      const doubled = now - lastCPressRef.current <= CLOSE_ALL_PRESS_MS
      lastCPressRef.current = now

      // 第二下落在时间窗内：不再一笔一笔来，直接把剩下的全平掉
      if (doubled) closeAllPositions('manual')
      else closeOldestPosition('manual')
    },
    [positions.length, orderSide, orderDraft, closeAllPositions, closeOldestPosition]
  )

  /** 手数步进：默认 0.01，按住 Shift 走 0.1 */
  const stepLot = (dir: 1 | -1, big = false): void => {
    const delta = (big ? 0.1 : 0.01) * dir
    setLot(Math.max(0.01, Math.round((lot + delta) * 100) / 100))
  }
  useHotkeys('up', (e) => { e.preventDefault(); if (activeSession && !orderSide) stepLot(1) }, [lot, activeSession, orderSide])
  useHotkeys('down', (e) => { e.preventDefault(); if (activeSession && !orderSide) stepLot(-1) }, [lot, activeSession, orderSide])
  useHotkeys('shift+up', (e) => { e.preventDefault(); if (activeSession && !orderSide) stepLot(1, true) }, [lot, activeSession, orderSide])
  useHotkeys('shift+down', (e) => { e.preventDefault(); if (activeSession && !orderSide) stepLot(-1, true) }, [lot, activeSession, orderSide])

  // ← / → 在工具栏周期之间左右循环切换（顺序 = 用户在周期面板里拖出来的顺序）
  // 不用 useHotkeys：需要排除 Shift+→（那是「下一根」），单独判断更直观
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return
      const el = e.target as HTMLElement | null
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return
      // 备注浮窗开着时不切周期
      if (orderSide || orderDraft) return
      if (!activeSession || toolbarTfs.length < 2) return
      e.preventDefault()
      const idx = toolbarTfs.indexOf(timeframe)
      if (idx < 0) {
        changeTimeframe(toolbarTfs[0])
        return
      }
      const step = e.key === 'ArrowRight' ? 1 : -1
      const next = toolbarTfs[(idx + step + toolbarTfs.length) % toolbarTfs.length]
      if (next && next !== timeframe) changeTimeframe(next)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeSession, toolbarTfs, timeframe, setTimeframe, orderSide, orderDraft])

  // 待删除的会话（用于确认浮窗）
  const pendingDelete =
    confirmDeleteId == null ? null : (sessions.find((s) => s.id === confirmDeleteId) ?? null)

  return (
    <div className="h-full flex">
      {sessionSidebarOpen ? (
      <aside className="w-[252px] shrink-0 border-r border-[var(--border-subtle)] bg-[var(--surface-1)] flex flex-col min-h-0">
        <div className="border-b border-[var(--border-subtle)] px-3 py-2.5">
          <div className="mb-2 flex items-center gap-1.5">
            <span className="text-[12.5px] font-semibold text-[var(--text-primary)]">
              {t('training.sessionsTitle')}
            </span>
            <button
              onClick={() => {
                void loadDatasets()
                void loadSessions()
              }}
              className="ml-auto text-[var(--text-faint)] hover:text-[var(--text-secondary)]"
              title={t('common.refresh')}
            >
              <RefreshCw size={12} />
            </button>
            <button
              onClick={() => setSessionSidebarOpen(false)}
              className="text-[var(--text-faint)] hover:text-[var(--text-secondary)]"
              title={t('training.hideSessionList')}
            >
              <ChevronsLeft size={13} />
            </button>
          </div>
          <button
            onClick={() => setDialogOpen(true)}
            disabled={datasets.length === 0}
            className="flex w-full items-center justify-center gap-1.5 rounded-md bg-[var(--c-accent)] py-2 text-[12.5px] font-medium text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <FolderOpen size={13} />
            {t('training.newTraining')}
          </button>
          {datasets.length === 0 && (
            <p className="mt-1.5 text-[11px] text-[var(--text-faint)]">
              {t('training.noMarketData')}
            </p>
          )}
        </div>

        <div className="flex-1 overflow-y-auto py-1">
          {sessions.length === 0 && (
            <div className="px-3 py-6 text-center text-[12px] text-[var(--text-faint)]">
              {t('training.noSessions')}
            </div>
          )}
          {sessions.map((s) => {
            const isActive = activeSession?.id === s.id
            /**
             * 正在打的这一集用内存里的实时游标，别用数据库快照。
             *
             * 列表数据是打开页面时查出来的一份拷贝，回放每前进一根只会节流落库，
             * 从来不会回写这份拷贝 —— 直接拿它渲染，进度条就会一直停在打开那一刻
             * （比如停在 71%，实际已经跑过好几千根）。
             */
            // 正在打的这一集用「精确到分钟」的游标时间，切大周期也不会往后退一整格
            // 余额同理：列表那份是快照，不跟着实时值走的话这一行会一直显示开仓前的钱
            const row = isActive && currentBar
              ? { ...s, current_bar_time: currentTime, balance }
              : s
            const done = isActive ? completedAt != null : s.completed_at != null
            const pct = done ? 100 : sessionProgress(row)
            return (
            <div
              key={s.id}
              className={clsx(
                'group flex items-start gap-1 px-2 py-2 transition-colors',
                isActive
                  ? 'bg-[var(--c-accent-tint)]'
                  : 'hover:bg-[var(--surface-2)]'
              )}
            >
              <button
                onClick={() => void openSession(s.id)}
                className="min-w-0 flex-1 text-left"
              >
                <div className="truncate text-[13px] font-medium leading-tight text-[var(--text-primary)]">
                  {s.name}
                </div>
                <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-[var(--text-faint)]">
                  <span className="font-mono">{s.dataset_symbol ?? '--'}</span>
                  <span>·</span>
                  <span className="font-mono">{s.display_timeframe ?? 'M5'}</span>
                  <span className="ml-auto font-mono tabular-nums">{money(s.balance)}</span>
                </div>
                {/* 回放进度：按会话区间的时间比例展示，下次打开会从这里继续 */}
                <div
                  title={t('training.sessionProgressTitle', {
                    time: row.current_bar_time
                      ? fmtTime(row.current_bar_time, timezone)
                      : t('training.startPoint'),
                    state: done
                      ? t('journal.done')
                      : t('training.progressPct', { p: pct })
                  })}
                  className="mt-1.5 h-[3px] w-full overflow-hidden rounded-full bg-[var(--surface-3)]"
                >
                  <div
                    className={clsx(
                      'h-full rounded-full transition-[width] duration-200',
                      done ? 'bg-[var(--c-pos)]' : 'bg-[var(--c-accent)]'
                    )}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </button>

              <button
                onClick={() => setConfirmDeleteId(s.id)}
                title={t('training.deleteSession')}
                className={clsx(
                  'mt-0.5 shrink-0 rounded p-1 transition-colors',
                  confirmDeleteId === s.id
                    ? 'bg-[var(--c-neg-tint)] text-[var(--c-neg)]'
                    : 'text-[var(--text-faint)] opacity-0 group-hover:opacity-100 hover:bg-[var(--c-neg-tint)] hover:text-[var(--c-neg)]'
                )}
              >
                <Trash2 size={13} />
              </button>
            </div>
            )
          })}
        </div>
      </aside>
      ) : (
        <div className="flex w-8 shrink-0 flex-col items-center gap-2 border-r border-[var(--border-subtle)] bg-[var(--surface-1)] py-2">
          <button
            onClick={() => setSessionSidebarOpen(true)}
            title={t('training.showSessionList')}
            className="flex h-6 w-6 items-center justify-center rounded text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-3)] hover:text-[var(--text-primary)]"
          >
            <ChevronsRight size={13} />
          </button>
        </div>
      )}

      {activeSession ? (
        <div ref={colRef} className="flex-1 min-w-0 flex flex-col">
          {/* 顶部工具条：周期在最左，单行固定高度 */}
          <div className="flex h-11 shrink-0 items-center gap-2 overflow-visible border-b border-[var(--border-subtle)] px-3">
            {/* 周期条：窗口窄时是它会先让步（内部 overflow-hidden），
                但「…」按钮永远留着，所以任何宽度都能打开周期面板 */}
            <div className="relative flex max-w-[360px] min-w-[84px] shrink items-center gap-0.5 rounded-md bg-[var(--surface-2)] p-0.5">
              {/* 固定宽度，超出直接裁切，不挤压右侧按钮 */}
              <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden">
                {toolbarTfs.map((id) => (
                  <button
                    key={id}
                    onClick={() => changeTimeframe(id)}
                    title={t('training.switchTimeframe', {
                      name: translateLabel(locale, timeframeName(id))
                    })}
                    className={clsx(
                      'shrink-0 rounded px-1.5 py-1 text-[11.5px] font-medium transition-colors',
                      timeframe === id
                        ? 'bg-[var(--c-accent)] text-white'
                        : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
                    )}
                  >
                    {timeframeCode(id)}
                  </button>
                ))}
              </div>
              <button
                onClick={() => (tfMenuOpen ? setTfMenuOpen(false) : openTfMenu())}
                title={t('training.choiceTimeframes')}
                className={clsx(
                  'shrink-0 rounded px-1.5 py-1 text-[11.5px] font-medium transition-colors',
                  tfMenuOpen
                    ? 'bg-[var(--surface-4)] text-[var(--text-primary)]'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
                )}
              >
                …
              </button>

              {tfMenuOpen && (
                // z 要高过 lightweight-charts 的副图分隔条（z-index: 50 的透明拖拽条），
                // 否则菜单伸到图表里那一段会被它盖住、点不动
                <div className="absolute left-0 top-full z-[60] mt-1.5 w-[210px] rounded-lg border border-[var(--border-strong)] bg-[var(--surface-1)] shadow-2xl">
                  <div className="flex items-center border-b border-[var(--border-subtle)] px-3 py-2">
                    <span className="text-[11.5px] font-medium text-[var(--text-primary)]">
                      {t('training.toolbarTimeframes')}
                    </span>
                    <span className="ml-auto font-mono text-[10px] text-[var(--text-faint)]">
                      {tfDraft.length}/{MAX_TOOLBAR_TFS}
                    </span>
                  </div>

                  <div
                    ref={tfListRef}
                    title={t('training.tfDragHint')}
                    className="max-h-[min(336px,calc(100vh-300px))] overflow-y-auto py-1"
                  >
                    {tfOrder.map((id, i) => {
                      const row = { id, name: timeframeName(id), custom: CUSTOM_TF_RE.test(id) }
                      const checked = tfDraft.includes(row.id)
                      // 已到上限且当前项未勾选 → 不可再选
                      const atLimit = !checked && tfDraft.length >= MAX_TOOLBAR_TFS
                      const dragging = tfDragId === row.id
                      return (
                        <label
                          key={row.id}
                          data-tf-row="1"
                          data-tf-index={i}
                          onPointerDown={(e) => onTfRowPointerDown(e, row.id, i)}
                          onClick={(e) => {
                            // 刚拖动过：吃掉这一次 click，别顺手切换勾选
                            if (tfJustDraggedRef.current) {
                              tfJustDraggedRef.current = false
                              e.preventDefault()
                              e.stopPropagation()
                            }
                          }}
                          title={
                            atLimit
                              ? t('training.tfLimit', { n: MAX_TOOLBAR_TFS })
                              : t('training.tfDragHintShort')
                          }
                          style={
                            tfDropIndex === i
                              ? { boxShadow: 'inset 0 2px 0 0 var(--c-accent)' }
                              : tfDropIndex === tfOrder.length && i === tfOrder.length - 1
                                ? { boxShadow: 'inset 0 -2px 0 0 var(--c-accent)' }
                                : undefined
                          }
                          className={clsx(
                            'group flex touch-none items-center gap-2 px-3 py-1 text-[11.5px]',
                            dragging && 'bg-[var(--surface-4)] opacity-60',
                            !dragging && 'hover:bg-[var(--surface-3)]',
                            atLimit
                              ? 'cursor-not-allowed text-[var(--text-secondary)] opacity-40'
                              : 'cursor-grab text-[var(--text-secondary)]'
                          )}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={atLimit}
                            onChange={() =>
                              setTfDraft((prev) =>
                                checked
                                  ? prev.filter((x) => x !== row.id)
                                  : prev.length >= MAX_TOOLBAR_TFS
                                    ? prev
                                    : [...prev, row.id]
                              )
                            }
                            className="h-3.5 w-3.5 accent-[var(--c-accent)]"
                          />
                          <span className={clsx(row.custom && 'text-[var(--c-accent)]')}>
                            {timeframeCode(row.id)}
                          </span>
                          <span className="ml-auto text-[10px] text-[var(--text-faint)]">
                            {translateLabel(locale, row.name)}
                          </span>
                          {row.custom && (
                            <button
                              onClick={(e) => {
                                e.preventDefault()
                                setCustomTfs((prev) => prev.filter((x) => x !== row.id))
                                setTfOrder((prev) => prev.filter((x) => x !== row.id))
                                setTfDraft((prev) => prev.filter((x) => x !== row.id))
                              }}
                              title={t('training.deleteCustomTf')}
                              className="text-[var(--text-faint)] opacity-0 transition-opacity hover:text-[var(--color-up)] group-hover:opacity-100"
                            >
                              <X size={9} />
                            </button>
                          )}
                        </label>
                      )
                    })}
                  </div>

                  <div className="border-t border-[var(--border-subtle)] p-2">
                    {customOpen ? (
                      <div className="flex items-center gap-1">
                        <input
                          autoFocus
                          value={customVal}
                          inputMode="numeric"
                          placeholder={t('training.customTfPlaceholder')}
                          onChange={(e) => setCustomVal(e.target.value.replace(/[^\d]/g, ''))}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') addCustomTf()
                            if (e.key === 'Escape') setCustomOpen(false)
                          }}
                          className="w-0 flex-1 rounded border border-[var(--border-subtle)] bg-[var(--surface-2)] px-2 py-1 text-[11px] text-[var(--text-primary)] outline-none focus:border-[var(--c-accent)]"
                        />
                        {(() => {
                          // 实时预览会显示成什么单位，避免用户以为 120 分钟会变成 M120
                          const n = Math.floor(Number(customVal))
                          if (!customVal || !Number.isFinite(n) || n < 1 || n > 10080) return null
                          const id = `C${n}`
                          return (
                            <span
                              title={translateLabel(locale, timeframeName(id))}
                              className="shrink-0 rounded bg-[var(--surface-3)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--c-accent)]"
                            >
                              {timeframeCode(id)}
                            </span>
                          )
                        })()}
                        <button
                          onClick={addCustomTf}
                          className="rounded bg-[var(--c-accent)] px-2 py-1 text-[11px] font-medium text-white transition hover:brightness-110"
                        >
                          {t('training.add')}
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setCustomOpen(true)}
                        className="w-full rounded border border-[var(--border-subtle)] py-1 text-[11px] text-[var(--text-secondary)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
                      >
                        {t('training.customTf')}
                      </button>
                    )}
                    <button
                      onClick={applyTfDraft}
                      className="mt-1.5 w-full rounded bg-[var(--c-accent)] py-1.5 text-[11.5px] font-medium text-white transition hover:brightness-110"
                    >
                      {t('training.apply')}
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className="relative">
              <button
                onClick={() => setIndicatorMenu((v) => !v)}
                className={clsx(
                  'flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border px-2 py-1 text-[11.5px] transition-colors',
                  indicatorMenu
                    ? 'border-[var(--c-accent)] bg-[var(--c-accent-tint)] text-[var(--c-accent)]'
                    : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                )}
              >
                <SlidersHorizontal size={11} />
                {t('training.indicators')}
              </button>

              {indicatorMenu && (
                <div className="absolute left-0 top-full z-30 mt-1 w-[206px] rounded-md border border-[var(--border-strong)] bg-[var(--surface-1)] p-2 shadow-xl">
                  <div className="mb-1 flex items-center gap-1 text-[9px] uppercase tracking-wider text-[var(--text-faint)]">
                    {t('settings.indicator.overlay')}
                    <span className="ml-auto normal-case tracking-normal text-[9px] opacity-70">
                      {t('training.repeatable')}
                    </span>
                  </div>
                  {OVERLAYS.map((o) => {
                    const count = overlays.filter((x) => x.id === o.id).length
                    return (
                      <button
                        key={o.id}
                        type="button"
                        onClick={() => addIndicator('overlay', o.id)}
                        title={t('training.addOverlay', { name: translateLabel(locale, o.label) })}
                        className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-3)] hover:text-[var(--text-primary)]"
                      >
                        <Plus size={10} className="shrink-0 text-[var(--text-faint)]" />
                        <span className="h-0.5 w-3 shrink-0 rounded" style={{ background: o.color }} />
                        <span className="truncate">{translateLabel(locale, o.label)}</span>
                        {count > 0 && (
                          <span className="ml-auto shrink-0 rounded-full bg-[var(--c-accent-tint)] px-1 font-mono text-[9px] text-[var(--c-accent)]">
                            {count}
                          </span>
                        )}
                      </button>
                    )
                  })}

                  <div className="mb-1 mt-2 flex items-center gap-1 text-[9px] uppercase tracking-wider text-[var(--text-faint)]">
                    {t('settings.indicator.subPane')}
                    <span className="ml-auto font-mono normal-case tracking-normal text-[9px] opacity-70">
                      {subPanes.length}/{MAX_SUB_PANES}
                    </span>
                  </div>
                  {SUB_PANES.map((sp) => {
                    const count = subPanes.filter((x) => x.id === sp.id).length
                    const full = subPanes.length >= MAX_SUB_PANES
                    return (
                      <button
                        key={sp.id}
                        type="button"
                        onClick={() => addIndicator('sub', sp.id)}
                        disabled={full}
                        title={
                          full
                            ? t('training.subPaneLimit', { n: MAX_SUB_PANES })
                            : t('training.addSubPane', { name: translateLabel(locale, sp.label) })
                        }
                        className={clsx(
                          'flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11px] transition-colors',
                          full
                            ? 'cursor-not-allowed text-[var(--text-faint)] opacity-50'
                            : 'text-[var(--text-secondary)] hover:bg-[var(--surface-3)] hover:text-[var(--text-primary)]'
                        )}
                      >
                        <Plus size={10} className="shrink-0 text-[var(--text-faint)]" />
                        <span className="truncate">{translateLabel(locale, sp.label)}</span>
                        {count > 0 && (
                          <span className="ml-auto shrink-0 rounded-full bg-[var(--c-accent-tint)] px-1 font-mono text-[9px] text-[var(--c-accent)]">
                            {count}
                          </span>
                        )}
                      </button>
                    )
                  })}

                  <p className="mt-2 border-t border-[var(--border-subtle)] pt-1.5 text-[9.5px] leading-relaxed text-[var(--text-faint)]">
                    {t('training.indicatorMenuNote')}
                  </p>
                </div>
              )}
            </div>

            <div className="h-4 w-px bg-[var(--border-subtle)]" />

            <div className="flex items-center gap-1">
              <button
                onClick={togglePlay}
                title={playing ? t('training.pauseHotkey') : t('training.playHotkey')}
                className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--c-accent)] text-white transition hover:brightness-110"
              >
                {playing ? <Pause size={14} /> : <Play size={14} />}
              </button>
              <IconButton
                title={t('training.nextBar')}
                onClick={() => advance()}
                disabled={cursor >= bars.length - 1}
              >
                <SkipForward size={14} />
              </IconButton>
            </div>

            <div className="flex shrink-0 items-center gap-0.5 rounded-md bg-[var(--surface-2)] p-0.5">
              {barMid ? (
                // 窄窗口：速度选择器压成一个按钮，点一下循环 1x → 2x → 5x → 10x。
                // 功能不丢，省下 60px 给周期条和右侧按钮。
                <button
                  onClick={() => {
                    const idx = SPEED_OPTIONS.indexOf(barsPerSec)
                    setBarsPerSec(SPEED_OPTIONS[(idx + 1) % SPEED_OPTIONS.length])
                  }}
                  title={t('training.speedHint', { speed: barsPerSec })}
                  className="rounded px-2 py-1 text-[11.5px] font-medium tabular-nums text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
                >
                  {barsPerSec}x
                </button>
              ) : (
                SPEED_OPTIONS.map((sp) => (
                  <button
                    key={sp}
                    onClick={() => setBarsPerSec(sp)}
                    className={clsx(
                      'rounded px-1.5 py-1 text-[11.5px] font-medium transition-colors',
                      barsPerSec === sp
                        ? 'bg-[var(--surface-4)] text-[var(--text-primary)]'
                        : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
                    )}
                  >
                    {sp}x
                  </button>
                ))
              )}
            </div>

            {/* 品种徽标：只是提示作用，下单条里也有，窄窗口直接收起 */}
            {!barTight && (
              <span className="shrink-0 rounded bg-[var(--surface-3)] px-2 py-0.5 font-mono text-[11.5px] text-[var(--text-secondary)]">
                {symbol}
              </span>
            )}

            {completedAt != null && !barTight && (
              <span
                title={t('training.completedHint')}
                className="flex shrink-0 items-center gap-1 rounded bg-[var(--c-pos-tint)] px-1.5 py-0.5 text-[10px] text-[var(--c-pos)]"
              >
                <CheckCircle2 size={9} />
                {t('journal.done')}
              </span>
            )}

            {/* 从日志跳过来的：给一条显眼的回头路（用主色 + 呼吸光环，压过旁边的普通按钮） */}
            {journalReturn && (
              <button
                onClick={backToJournal}
                title={t('training.backToJournalHint')}
                className={clsx(
                  // 实心主色：旁边都是描边按钮，只有它是填实的，一眼就能找到回头路
                  'flex shrink-0 items-center gap-1 rounded-md bg-[var(--c-accent)] px-2 py-1 text-[11.5px] font-medium text-white shadow-sm transition-opacity hover:opacity-90',
                  // 只闪两下就停，别一直晃着眼睛
                  'animate-[trBackPulse_1.1s_ease-in-out_2]',
                  barNarrow && 'px-1.5'
                )}
              >
                <ArrowLeft size={12} />
                {!barNarrow && t('training.backToJournal')}
              </button>
            )}

            <button
              onClick={() => setReportOpen(true)}
              title={t('training.viewReport')}
              className={clsx(
                'flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-[11.5px] transition-colors',
                reportOpen
                  ? 'border-[var(--c-accent)] bg-[var(--c-accent-tint)] text-[var(--c-accent)]'
                  : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
                barNarrow && 'px-1.5'
              )}
            >
              <FileText size={11} />
              {!barNarrow && t('training.report')}
            </button>

            <button
              onClick={() => setConfirmReset(true)}
              disabled={bars.length === 0}
              title={t('training.resetHint')}
              className={clsx(
                'flex shrink-0 items-center gap-1 rounded-md border border-[var(--border-subtle)] px-2 py-1 text-[11.5px] text-[var(--text-secondary)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-40',
                barNarrow && 'px-1.5'
              )}
            >
              <RotateCcw size={11} />
              {!barNarrow && t('training.reset')}
            </button>

            {/* 回放进度：flex-1 吃掉剩余空间，窄了就先缩到 40px 而不是把右边顶出屏幕 */}
            <div className="flex min-w-0 flex-1 items-center gap-2">
              {/* 回放进度：只读展示，不允许拖动（避免回退到已发生的行情） */}
              <div
                title={`${t('training.progressReadonly')} · ${(progress * 100).toFixed(1)}%`}
                className="relative h-1.5 min-w-[40px] flex-1 cursor-default select-none overflow-hidden rounded-full bg-[var(--surface-3)]"
              >
                <div
                  className="h-full rounded-full bg-[var(--c-accent)] transition-[width] duration-200"
                  style={{ width: `${progress * 100}%` }}
                />
              </div>
              {/* 计数才是唯一每根都在变的读数：进度条 1 像素 ≈ 上百根 K 线，
                  窄窗口也尽量留着它，否则整条看着像死的 */}
              {!barNarrow && (
                <span className="shrink-0 font-mono text-[11px] tabular-nums text-[var(--text-muted)]">
                  {formatNumber(Math.max(1, cursor - replayStart + 1))}/{formatNumber(replayBars)}
                </span>
              )}
            </div>

            <IconButton title={t('training.closeSession')} onClick={closeActiveSession}>
              <X size={14} />
            </IconButton>
          </div>

          {/* 图表区：左侧固定画图工具栏 */}
          <div className="flex min-h-0 flex-1">
            <div className="flex w-11 shrink-0 flex-col items-center gap-0.5 border-r border-[var(--border-subtle)] bg-[var(--surface-1)] py-2">
              {DRAWING_TOOLS.map((toolDef, i) => (
                <React.Fragment key={toolDef.type}>
                  {i > 0 && DRAWING_TOOLS[i - 1].group !== toolDef.group && (
                    <div className="my-1 h-px w-6 bg-[var(--border-subtle)]" />
                  )}
                  <button
                    onClick={() => setTool(tool === toolDef.type ? null : toolDef.type)}
                    title={t('training.drawingToolHint', {
                      label: translateLabel(locale, toolDef.label),
                      hint: translateLabel(locale, toolDef.hint),
                      cancel: t(
                        toolDef.multi ? 'training.drawingCancelMulti' : 'training.drawingCancel'
                      )
                    })}
                    className={clsx(
                      'flex h-7 w-7 items-center justify-center rounded transition-colors',
                      tool === toolDef.type
                        ? 'bg-[var(--c-accent)] text-white'
                        : 'text-[var(--text-secondary)] hover:bg-[var(--surface-3)] hover:text-[var(--text-primary)]'
                    )}
                  >
                    {toolDef.type === 'trend' && <PenLine size={14} />}
                    {toolDef.type === 'ray' && <MoveUpRight size={14} />}
                    {toolDef.type === 'extline' && <MoveHorizontal size={14} />}
                    {toolDef.type === 'hline' && <Minus size={14} />}
                    {toolDef.type === 'vline' && <Minus size={14} className="rotate-90" />}
                    {toolDef.type === 'polyline' && <Waypoints size={14} />}
                    {toolDef.type === 'fib' && <Ruler size={14} />}
                    {toolDef.type === 'rect' && <Square size={14} />}
                    {toolDef.type === 'ellipse' && <Circle size={14} />}
                    {toolDef.type === 'arrow' && <ArrowUpRight size={14} />}
                    {toolDef.type === 'text' && <Type size={14} />}
                  </button>
                </React.Fragment>
              ))}

              <div className="my-1.5 h-px w-6 bg-[var(--border-subtle)]" />

              <button
                onClick={() => setDrawings([])}
                title={t('training.clearDrawings')}
                className="flex h-7 w-7 items-center justify-center rounded text-[var(--text-faint)] transition-colors hover:bg-[var(--c-neg-tint)] hover:text-[var(--c-neg)]"
              >
                <Trash2 size={14} />
              </button>
            </div>

            {/*
              图表容器必须加 min-w-0。
              lightweight-charts 会在内部插一个 style="width:1060px" 的 table，
              而 flex 子项默认 min-width:auto = 内容的 min-content 宽度，
              于是窗口一缩小，这个容器就卡在「上一次的图表宽度」不肯收窄，
              多出来的部分被 main 的 overflow-hidden 裁掉 —— 表现就是
              「窗口化之后右侧被遮盖」：右侧价格轴整条跑到屏幕外，
              连图表自己的 autoSize 也因为容器宽度没变而不触发。
            */}
            <div className="relative min-h-0 min-w-0 flex-1">
              {/* 图表浮动工具条（贴在图表左上角，不挡住 K 线主体） */}
              <div className="absolute left-2 top-2 z-20 flex items-center gap-0.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-1)]/92 p-0.5 shadow-lg backdrop-blur">
                <button
                  onClick={() => setTool(null)}
                  title={t('training.cursor')}
                  className={clsx(
                    'flex h-6 w-6 items-center justify-center rounded transition-colors',
                    tool === null
                      ? 'bg-[var(--c-accent)] text-white'
                      : 'text-[var(--text-secondary)] hover:bg-[var(--surface-3)] hover:text-[var(--text-primary)]'
                  )}
                >
                  <MousePointer2 size={12} />
                </button>
                <div className="mx-0.5 h-4 w-px bg-[var(--border-subtle)]" />
                {(['trend', 'polyline', 'rect', 'fib', 'arrow', 'text'] as DrawingType[]).map((id) => {
                  const meta = DRAWING_TOOLS.find((toolDef) => toolDef.type === id)
                  return (
                    <button
                      key={id}
                      onClick={() => setTool(tool === id ? null : id)}
                      title={`${translateLabel(locale, meta?.label ?? id)} · ${translateLabel(locale, meta?.hint ?? '')}`}
                      className={clsx(
                        'flex h-6 w-6 items-center justify-center rounded transition-colors',
                        tool === id
                          ? 'bg-[var(--c-accent)] text-white'
                          : 'text-[var(--text-secondary)] hover:bg-[var(--surface-3)] hover:text-[var(--text-primary)]'
                      )}
                    >
                      {id === 'trend' && <PenLine size={12} />}
                      {id === 'polyline' && <Waypoints size={12} />}
                      {id === 'rect' && <Square size={12} />}
                      {id === 'fib' && <Ruler size={12} />}
                      {id === 'arrow' && <ArrowUpRight size={12} />}
                      {id === 'text' && <Type size={12} />}
                    </button>
                  )
                })}
                <div className="mx-0.5 h-4 w-px bg-[var(--border-subtle)]" />
                <button
                  onClick={() => setDrawings([])}
                  title={t('training.clearDrawings')}
                  className="flex h-6 w-6 items-center justify-center rounded text-[var(--text-faint)] transition-colors hover:bg-[var(--c-neg-tint)] hover:text-[var(--c-neg)]"
                >
                  <Trash2 size={12} />
                </button>
              </div>

              {/* 一闪而过的提示（交易时段外点买入/卖出时用） */}
              {notice && (
                <div className="pointer-events-none absolute left-1/2 top-3 z-30 -translate-x-1/2">
                  <div className="flex items-center gap-2 rounded-full border border-[var(--c-neg)]/40 bg-[var(--surface-1)]/95 px-3 py-1.5 text-[11.5px] text-[var(--text-primary)] shadow-xl backdrop-blur">
                    <AlertTriangle size={13} className="shrink-0 text-[var(--c-neg)]" />
                    {notice}
                  </div>
                </div>
              )}

              {loading ? (
                <div className="flex h-full items-center justify-center text-[12px] text-[var(--text-muted)]">
                  {t('ds.loading')}
                </div>
              ) : bars.length === 0 ? (                <div className="flex h-full items-center justify-center text-[12px] text-[var(--text-muted)]">
                  {t('training.noBarsInRange')}
                </div>
              ) : (
                <ReplayChart
                  bars={bars}
                  cursor={cursor}
                  // 最后一根只画到已揭示的分钟，别把这一格的收盘价提前露出来
                  partialBar={partialBar}
                  revealIndex={revealIndex}
                  positions={positions}
                  activePositionId={activePosition?.id ?? null}
                  onSelectPosition={selectPosition}
                  digits={priceDigits}
                  onSlChange={setSl}
                  onTpChange={setTp}
                  riskPnlLabel={riskPnlLabel}
                  onReducePosition={reducePosition}
                  lotPnlLabel={lotPnlLabel}
                  overlays={overlays}
                  subPanes={subPanes}
                  onIndicatorParams={setIndicatorParams}
                  onIndicatorColor={setIndicatorColor}
                  onIndicatorReset={resetIndicatorParams}
                  onIndicatorRemove={removeIndicator}
                  drawings={drawings}
                  onDrawingsChange={setDrawings}
                  activeTool={tool}
                  onToolChange={setTool}
                  watermark={`${activeSession.dataset_symbol ?? ''} · ${timeframeCode(timeframe)}`}
                  timeframe={timeframe}
                  trades={closedTrades}
                  focusedTrade={focusedTrade}
                  focusSeq={focusSeq}
                  onClearFocus={() => setFocusedTrade(null)}
                  pendingOrder={pendingView}
                  onPendingSlChange={(price) => setPendingRisk('sl', price)}
                  onPendingTpChange={(price) => setPendingRisk('tp', price)}
                  onPendingConfirm={() => {
                    // 票面上的「确认」只是把这张单子交给备注浮窗，
                    // 真正的成交发生在浮窗里点「确认下单」的那一刻
                    if (orderDraft) setOrderSide(orderDraft.side)
                  }}
                  onPendingCancel={() => setOrderDraft(null)}
                />
              )}
            </div>

          </div>


          {/* 下单条：图表下方、平仓记录上方（横向布局，替代原来的右侧面板） */}
          <div className="shrink-0 border-t border-[var(--border-subtle)] bg-[var(--surface-1)]">
            <div className="flex flex-wrap items-stretch gap-2 px-3 py-2">
              {/* 品种 + 账户 */}
              <div className="flex shrink-0 items-center gap-3 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-2)] px-2.5 py-1.5">
                <div className="flex flex-col justify-center">
                  <div className="flex items-center gap-1">
                    <span className="text-[12px] font-semibold text-[var(--text-primary)]">
                      {activeSession.dataset_symbol ?? '--'}
                    </span>
                    {/* 现货 / 杠杆只是标签，窄窗口先收，省下 50px 给真正要看的数字 */}
                    {!barMid && (
                      <>
                        <span className="rounded bg-[var(--surface-3)] px-1 py-px text-[9px] text-[var(--text-muted)]">
                          {t('training.spot')}
                        </span>
                        <span className="rounded bg-[var(--surface-3)] px-1 py-px text-[9px] text-[var(--text-faint)]">
                          1:500
                        </span>
                      </>
                    )}
                  </div>
                  <span className="text-[9.5px] text-[var(--text-faint)]">
                    {t('training.account')}
                  </span>
                </div>
                <div className="h-7 w-px bg-[var(--border-subtle)]" />
                <div className="flex flex-col">
                  <span className="font-mono text-[14px] leading-tight tabular-nums text-[var(--text-primary)]">
                    {money(equity)}
                  </span>
                  <span className="text-[9.5px] text-[var(--text-faint)]">
                    {t('training.equity')}
                  </span>
                </div>
                {/* 余额在窄窗口收起来：权益 = 余额 + 浮动，已经够判断了 */}
                {!barMid && (
                  <div className="flex flex-col">
                    <span className="font-mono text-[11.5px] leading-tight tabular-nums text-[var(--text-secondary)]">
                      {money(balance)}
                    </span>
                    <span className="text-[9.5px] text-[var(--text-faint)]">
                      {t('training.balance')}
                    </span>
                  </div>
                )}
                <div className="flex flex-col">
                  <span
                    className={clsx(
                      'font-mono text-[11.5px] leading-tight tabular-nums',
                      floatingPnl >= 0 ? 'text-[var(--c-neg)]' : 'text-[var(--c-pos)]'
                    )}
                    title={
                      positions.length > 1
                        ? t('training.floatingTotalHint', {
                            n: positions.length,
                            long: exposure.long.toFixed(2),
                            short: exposure.short.toFixed(2)
                          })
                        : undefined
                    }
                  >
                    {positions.length > 0 ? formatSigned(floatingPnl) : '--'}
                  </span>
                  <span className="text-[9.5px] text-[var(--text-faint)]">
                    {t('training.floating')}
                  </span>
                </div>
              </div>

              {/* 手数 */}
              <div className="flex shrink-0 items-center gap-2 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-2)] px-2.5 py-1.5">
                <span className="text-[10.5px] text-[var(--text-muted)]">{t('training.lot')}</span>
                <div className="flex items-center rounded border border-[var(--border-subtle)] bg-[var(--surface-0)]">
                  <button
                    onClick={() => stepLot(-1)}
                    title={t('training.lotDec')}
                    className="px-1.5 py-1 text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
                  >
                    <Minus size={10} />
                  </button>
                  <input
                    value={lot.toFixed(2)}
                    onChange={(e) => setLot(Number(e.target.value))}
                    className="w-11 bg-transparent text-center font-mono text-[12px] text-[var(--text-primary)] outline-none"
                  />
                  <button
                    onClick={() => stepLot(1)}
                    title={t('training.lotInc')}
                    className="px-1.5 py-1 text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
                  >
                    <Plus size={10} />
                  </button>
                </div>
                {/* 快捷键提示行里还有一份，窄窗口这里就不重复占了 */}
                {!barMid && (
                  <>
                    <Kbd>↑</Kbd>
                    <Kbd>↓</Kbd>
                  </>
                )}
              </div>

              {/*
                真实每手价值：1 手到底是多少合约、这个手数下每 1 点波动值多少美元。
                外汇不是「1 手 = 1 个单位」——EURUSD 一手是 10 万欧元，1 点刚好 10 美元；
                USDJPY 一手 10 万美元，1 点却是 1000 日元（还要折美元）。
                不把这个摆出来，用户很难判断自己的手数对应多大风险。
              */}
              {lotValue && (
                <div
                  className="flex shrink-0 items-center gap-3 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-2)] px-2.5 py-1.5"
                  title={[
                    t('training.lotValueTitle', {
                      symbol: symbol ?? '',
                      size: lotValue.desc.sizeText
                    }),
                    t('training.pointMove', { value: lotValue.desc.pointQuoteText }),
                    lotValue.desc.pointUsdText
                      ? t('training.pointUsdApprox', { value: lotValue.desc.pointUsdText })
                      : '',
                    t('training.rateBasis', {
                      value: translateLabel(locale, rateSourceLabel(lotValue.rate.source))
                    }),
                    translateLabel(locale, lotValue.desc.note),
                    t('training.currentLotPoint', {
                      lot: lot.toFixed(2),
                      value: moneySmall(lotValue.perPointAtLot)
                    })
                  ]
                    .filter(Boolean)
                    .join('\n')}
                >
                  <div className="flex flex-col">
                    <span
                      className={clsx(
                        'font-mono text-[12px] leading-tight tabular-nums',
                        // 参考汇率算出来的值不精确，前面加个 ≈，颜色也压暗
                        lotValue.rate.source === 'reference'
                          ? 'text-[var(--text-secondary)]'
                          : 'text-[var(--text-primary)]'
                      )}
                    >
                      {lotValue.rate.source === 'reference' ? '≈ ' : ''}
                      {moneySmall(lotValue.perPointAtLot)}
                    </span>
                    <span className="text-[9.5px] text-[var(--text-faint)]">
                      {t('training.pnlPerPoint')}
                    </span>
                  </div>
                  {/* 合约规模在窄窗口收进 tooltip，每点盈亏本身已经说明问题了 */}
                  {!barMid && (
                    <div className="flex flex-col">
                      <span className="font-mono text-[11px] leading-tight tabular-nums text-[var(--text-secondary)]">
                        {lotValue.desc.sizeText}
                      </span>
                      <span className="text-[9.5px] text-[var(--text-faint)]">
                        {t('training.lotSize')}
                      </span>
                    </div>
                  )}
                </div>
              )}

              {/* 价格 / 止损 / 止盈（止损止盈显示的是「当前选中那笔持仓」的） */}
              <div
                className="flex shrink-0 items-center gap-3 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-2)] px-2.5 py-1.5"
                title={
                  positions.length > 1
                    ? t('training.slTpCardHint', {
                        side:
                          activePosition?.side === 'buy' ? t('training.long') : t('training.short'),
                        lot: activePosition?.lot.toFixed(2) ?? ''
                      })
                    : undefined
                }
              >
                <div className="flex flex-col">
                  <span className="font-mono text-[12px] leading-tight tabular-nums text-[var(--text-primary)]">
                    {currentBar ? formatPrice(currentBar.close, priceDigits) : '--'}
                  </span>
                  <span className="text-[9.5px] text-[var(--text-faint)]">
                    {t('training.price')}
                  </span>
                </div>
                <div className="flex flex-col">
                  <span
                    className="font-mono text-[12px] leading-tight tabular-nums text-[#ef4444]"
                    title={
                      activePosition && activePosition.sl != null
                        ? t('training.slHitHint', {
                            price: formatPrice(activePosition.sl, activePosition.digits),
                            pnl: riskPnlLabel(activePosition, 'sl')
                          })
                        : undefined
                    }
                  >
                    {activePosition ? formatPrice(activePosition.sl, activePosition.digits) : '--'}
                  </span>
                  <span className="text-[9.5px] text-[var(--text-faint)]">
                    {t('training.stopLoss')}
                  </span>
                </div>
                <div className="flex flex-col">
                  <span
                    className="font-mono text-[12px] leading-tight tabular-nums text-[#22c55e]"
                    title={
                      activePosition && activePosition.tp != null
                        ? t('training.tpHitHint', {
                            price: formatPrice(activePosition.tp, activePosition.digits),
                            pnl: riskPnlLabel(activePosition, 'tp')
                          })
                        : undefined
                    }
                  >
                    {activePosition ? formatPrice(activePosition.tp, activePosition.digits) : '--'}
                  </span>
                  <span className="text-[9.5px] text-[var(--text-faint)]">
                    {t('training.takeProfit')}
                  </span>
                </div>
              </div>

              {/* 交易时段（只有设了时段才显示） */}
              {tradeWindow && (
                <div
                  className={clsx(
                    'flex shrink-0 flex-col justify-center rounded-md border px-2.5 py-1.5 transition-colors',
                    inWindowNow
                      ? 'border-[var(--border-subtle)] bg-[var(--surface-2)]'
                      : 'border-[var(--c-neg)]/45 bg-[var(--c-neg-tint)]'
                  )}
                  title={
                    inWindowNow
                      ? t('training.tradeWindowHint', {
                          window: translateLabel(locale, fmtTradeWindow(tradeWindow)),
                          tz: timezone
                        })
                      : `${t('training.windowClosed')} · ${t('training.skipToNextWindowHint')}`
                  }
                >
                  <span className="flex items-center gap-1.5 text-[11px] font-medium leading-tight text-[var(--text-primary)]">
                    <span
                      className={clsx(
                        'h-1.5 w-1.5 shrink-0 rounded-full',
                        inWindowNow ? 'bg-[var(--c-pos)]' : 'bg-[var(--c-neg)]'
                      )}
                    />
                    {t('training.windowLabel', {
                      window: translateLabel(locale, fmtTradeWindow(tradeWindow))
                    })}
                  </span>
                  {inWindowNow ? (
                    <span className="text-[9.5px] leading-tight text-[var(--text-faint)]">
                      {t('training.windowOpen')}
                    </span>
                  ) : (
                    /* 收盘时这一行直接变成「跳到下一时段」的按钮 —— 快捷方式得看得见才会用，
                       只写在文档里等于没有。红点 + 卡片底色已经说明「现在收盘了」。 */
                    <button
                      type="button"
                      onClick={jumpToNextWindow}
                      title={t('training.skipToNextWindowHint')}
                      className="flex items-center gap-1 self-start text-[9.5px] leading-tight text-[var(--c-neg)] transition-opacity hover:opacity-75"
                    >
                      <ChevronsRight size={10} />
                      {t('training.skipToNextWindow')}
                      <kbd className="rounded-[2px] border border-current px-[3px] font-mono text-[9px] leading-[1.35]">
                        T
                      </kbd>
                    </button>
                  )}
                </div>
              )}

              {/* 买入 / 卖出 */}
              <div className="flex min-w-[236px] max-w-[720px] flex-1 items-stretch gap-2">
                <button
                  onClick={() => beginOrder('buy')}
                  disabled={!currentBar}
                  title={
                    tradeWindow && !inWindowNow
                      ? t('training.notInWindow', {
                          window: translateLabel(locale, fmtTradeWindow(tradeWindow))
                        })
                      : undefined
                  }
                  className="flex flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-md bg-[var(--c-neg)] px-3 py-1.5 text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <TrendingUp size={14} />
                  <span className="text-[13px] font-semibold">{t('training.buy')}</span>
                  {/* 价格就在左边的价格卡里，窄窗口不必在按钮上再占一份 */}
                  {!barMid && (
                    <span className="font-mono text-[11.5px] tabular-nums opacity-85">
                      {currentBar ? formatPrice(currentBar.close, priceDigits) : '--'}
                    </span>
                  )}
                  <Kbd tone="light">B</Kbd>
                </button>
                <button
                  onClick={() => beginOrder('sell')}
                  disabled={!currentBar}
                  title={
                    tradeWindow && !inWindowNow
                      ? t('training.notInWindow', {
                          window: translateLabel(locale, fmtTradeWindow(tradeWindow))
                        })
                      : undefined
                  }
                  className="flex flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-md bg-[var(--c-pos)] px-3 py-1.5 text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <TrendingDown size={14} />
                  <span className="text-[13px] font-semibold">{t('training.sell')}</span>
                  {!barMid && (
                    <span className="font-mono text-[11.5px] tabular-nums opacity-85">
                      {currentBar ? formatPrice(currentBar.close, priceDigits) : '--'}
                    </span>
                  )}
                  <Kbd tone="light">S</Kbd>
                </button>
              </div>

              {/* 持仓：可以有多笔，多空并存时按「多 x 手 / 空 y 手」显示净敞口 */}
              <div
                className={clsx(
                  'flex shrink-0 flex-col justify-center gap-1 rounded-md border px-2.5 py-1.5',
                  positions.length > 0
                    ? 'min-w-[236px] max-w-[330px] border-[var(--border-strong)] bg-[var(--surface-2)]'
                    : 'min-w-[150px] border-[var(--border-subtle)] bg-[var(--surface-2)]'
                )}
              >
                {positions.length === 0 ? (
                  <span className="text-[11px] text-[var(--text-faint)]">
                    {t('training.noPositions')}
                  </span>
                ) : (
                  <>
                    <div className="flex items-center gap-2">
                      <span className="shrink-0 text-[9.5px] text-[var(--text-faint)]">
                        {t('training.positionsCount', { n: positions.length })}
                      </span>
                      {/* 净敞口：只做多是「多 0.30」，对冲时两边都写出来 */}
                      <span className="shrink-0 font-mono text-[9.5px] tabular-nums text-[var(--text-muted)]">
                        {exposure.short > 0
                          ? t('training.exposureBoth', {
                              long: exposure.long.toFixed(2),
                              short: exposure.short.toFixed(2)
                            })
                          : t('training.exposureLong', { long: exposure.long.toFixed(2) })}
                      </span>
                      <span
                        title={t('training.floatingSum', { n: positions.length })}
                        className={clsx(
                          'ml-auto shrink-0 font-mono text-[11.5px] font-semibold tabular-nums',
                          floatingPnl >= 0 ? 'text-[var(--c-neg)]' : 'text-[var(--c-pos)]'
                        )}
                      >
                        {formatSigned(floatingPnl)}
                      </span>
                      <button
                        onClick={() => closeAllPositions('manual')}
                        title={t('training.closeAllHint', { n: positions.length })}
                        className="flex shrink-0 items-center gap-1 rounded border border-[var(--border-strong)] px-1.5 py-0.5 text-[10.5px] font-medium text-[var(--text-secondary)] transition-colors hover:border-[var(--text-muted)] hover:text-[var(--text-primary)]"
                      >
                        {t('training.closeAll')}
                        {/* 提示「连按两次 C」而不是单个 C：单击 C 只平最早一笔 */}
                        <span className="flex items-center gap-0.5">
                          <Kbd>C</Kbd>
                          <Kbd>C</Kbd>
                        </span>
                      </button>
                    </div>

                    {/*
                      每一笔一行：点行 = 选中（图表可拖它的 SL/TP、价格卡显示它的止损止盈），
                      ✕ = 只平这一笔。

                      行高固定 20px、容器上限正好 3 行（60px）：
                      这样再多持仓也只会出现滚动条，不会露出半截被切的行。
                    */}
                    <div ref={posListRef} className="max-h-[60px] overflow-y-auto pr-0.5">
                      {positions.map((p) => {
                        const isActive = p.id === activePosition?.id
                        // 一次算出「现在全平」的明细：净额给行内，价差和成本给 tooltip
                        const bd = currentBar ? closeAt(p, p.lot, currentBar.close, true) : null
                        const pnl = bd ? bd.net : 0
                        return (
                          <div
                            key={p.id}
                            data-pos-row={p.id}
                            onClick={() => selectPosition(p.id)}
                            title={t('training.positionRowHint', {
                              side: p.side === 'buy' ? t('training.long') : t('training.short'),
                              lot: p.lot.toFixed(2),
                              entry: formatPrice(p.entryPrice, p.digits),
                              sl: formatPrice(p.sl, p.digits),
                              tp: formatPrice(p.tp, p.digits),
                              pnl: formatSigned(pnl),
                              gross: bd ? formatSigned(bd.gross) : '--',
                              cost: bd ? `$${bd.commission.toFixed(2)}` : '--'
                            })}
                            className={clsx(
                              'group flex h-5 cursor-pointer items-center gap-1.5 rounded px-1 text-[10.5px] transition-colors',
                              isActive
                                ? 'bg-[var(--c-accent-tint)]'
                                : 'hover:bg-[var(--surface-3)]'
                            )}
                          >
                            <span
                              className={clsx(
                                'shrink-0 rounded px-1 py-px font-medium',
                                p.side === 'buy'
                                  ? 'bg-[var(--c-neg-tint)] text-[var(--c-neg)]'
                                  : 'bg-[var(--c-pos-tint)] text-[var(--c-pos)]'
                              )}
                            >
                              {p.side === 'buy' ? t('training.long') : t('training.short')}
                            </span>
                            <span className="shrink-0 font-mono tabular-nums text-[var(--text-secondary)]">
                              {p.lot.toFixed(2)}
                            </span>
                            <span className="shrink-0 font-mono tabular-nums text-[var(--text-faint)]">
                              {formatPrice(p.entryPrice, p.digits)}
                            </span>
                            <span
                              className={clsx(
                                'ml-auto shrink-0 font-mono tabular-nums',
                                pnl >= 0 ? 'text-[var(--c-neg)]' : 'text-[var(--c-pos)]'
                              )}
                            >
                              {formatSigned(pnl)}
                            </span>
                            <button
                              onClick={(e) => {
                                // 别让点「平这一笔」顺带把行选中
                                e.stopPropagation()
                                closePosition(p.id, 'manual')
                              }}
                              title={t('training.closeThisOne')}
                              // 常驻低透明度而不是完全隐藏：多持仓时得让人看得出「单笔平仓」在这儿
                              className="shrink-0 rounded px-0.5 text-[var(--text-faint)] opacity-45 transition-opacity hover:text-[var(--c-neg)] group-hover:opacity-100"
                            >
                              <X size={10} />
                            </button>
                          </div>
                        )
                      })}
                    </div>
                  </>
                )}
              </div>

              {/* 统计 */}
              <div className="ml-auto flex shrink-0 items-center gap-3 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-2)] px-3 py-1.5 text-center">
                <div>
                  <div className="font-mono text-[11.5px] tabular-nums text-[var(--text-secondary)]">
                    {stats.count}
                  </div>
                  <div className="text-[9px] text-[var(--text-faint)]">
                    {t('training.statTrades')}
                  </div>
                </div>
                <div>
                  <div className="font-mono text-[11.5px] tabular-nums text-[var(--text-secondary)]">
                    {stats.count > 0 ? `${stats.winRate.toFixed(0)}%` : '--'}
                  </div>
                  <div className="text-[9px] text-[var(--text-faint)]">
                    {t('training.statWinRate')}
                  </div>
                </div>
                <div>
                  <div
                    className={clsx(
                      'font-mono text-[11.5px] tabular-nums',
                      stats.total > 0
                        ? 'text-[var(--c-neg)]'
                        : stats.total < 0
                          ? 'text-[var(--c-pos)]'
                          : 'text-[var(--text-secondary)]'
                    )}
                  >
                    {formatSigned(stats.total)}
                  </div>
                  <div className="text-[9px] text-[var(--text-faint)]">
                    {t('training.statPnl')}
                  </div>
                </div>
              </div>

              {/* 交易成本：手续费 + 滑点（费率模型可随时开关） */}
              <ExecutionCostCard
                cost={executionCost}
                onChange={setExecutionCost}
                digits={priceDigits}
                contractSize={
                  activePosition?.contractSize ?? (symbol ? getContractSize(symbol) : 100)
                }
                price={currentBar ? currentBar.close : null}
                lot={lot}
                quoteRate={
                  symbol
                    ? quoteUsdRate(symbol, currentBar ? currentBar.close : 0, {
                        quoteToUsd: crossRateAt(crossRate, currentTime)
                      }).rate
                    : 1
                }
              />
            </div>

            {/* 快捷键提示 */}
            <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 border-t border-[var(--border-subtle)] bg-[var(--surface-0)]/50 px-3 py-1.5 text-[10.5px] text-[var(--text-secondary)]">
              <span className="flex items-center gap-1.5">
                <Kbd>B</Kbd>
                <span className="font-medium text-[var(--c-neg)]">{t('training.buy')}</span>
              </span>
              <span className="flex items-center gap-1.5">
                <Kbd>S</Kbd>
                <span className="font-medium text-[var(--c-pos)]">{t('training.sell')}</span>
              </span>
              <span
                className="flex items-center gap-1.5"
                title={t('training.closeSequentialHint')}
              >
                <Kbd>C</Kbd>
                <span className="font-medium text-[var(--c-accent)]">
                  {t('training.closeSequential')}
                </span>
              </span>
              <span
                className="flex items-center gap-1.5"
                title={t('training.closeAllHotkeyHint')}
              >
                <Kbd>C</Kbd>
                <Kbd>C</Kbd>
                <span className="font-medium text-[var(--c-accent)]">
                  {t('training.closeAllShort')}
                </span>
              </span>
              <span className="flex items-center gap-1.5">
                <Kbd>Space</Kbd>
                {t('training.playPause')}
              </span>
              <span className="flex items-center gap-1.5">
                <Kbd>←</Kbd>
                <Kbd>→</Kbd>
                {t('training.switchTfHotkey')}
              </span>
              <span className="flex items-center gap-1.5">
                <Kbd>Shift</Kbd>
                <Kbd>→</Kbd>
                {t('training.nextBarHotkey')}
              </span>
              <span className="flex items-center gap-1.5">
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd>
                {t('training.lotHotkey')}
                <span className="font-mono text-[var(--text-primary)]">±0.01</span>
                <span className="text-[var(--text-faint)]">{t('training.shiftLotsHint')}</span>
              </span>
            </div>
          </div>

          {/* 平仓记录（拖动上边缘可调整高度） */}
          <div
            className="flex shrink-0 flex-col border-t border-[var(--border-subtle)]"
            style={{ height: tradePanelH }}
          >
            <div
              onMouseDown={beginResize}
              onDoubleClick={() => setTradePanelH(DEFAULT_TRADE_PANEL_H)}
              title={t('training.resizeHint')}
              className="group flex h-2 shrink-0 cursor-row-resize items-center justify-center border-b border-[var(--border-subtle)] bg-[var(--surface-1)]"
            >
              <span className="h-[3px] w-9 rounded-full bg-[var(--border-strong)] transition-colors group-hover:bg-[var(--c-accent)]" />
            </div>

            <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--surface-1)] px-3 py-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)]">
                {t('training.closedTradesTitle')}
              </span>
              <span
                className="rounded-full bg-[var(--surface-3)] px-1.5 py-px font-mono text-[10px] text-[var(--text-secondary)]"
                title={
                  tradeTags.filtering
                    ? t('training.filteredBy', { label: tradeTags.label })
                    : undefined
                }
              >
                {tradeTags.filtering
                  ? `${tradeTags.filtered.length} / ${closedTrades.length}`
                  : closedTrades.length}
              </span>
              <span className="ml-auto text-[11px] text-[var(--text-faint)]">
                {t('training.initialCapital', { value: money(initialBalance) })}
              </span>
            </div>

            {/* 定位被拦下来的原因：只在这笔单「还没发生」或「不属于这一集」时出现 */}
            {focusNote && (
              <div className="flex shrink-0 items-start gap-1.5 border-b border-[var(--border-subtle)] bg-[var(--surface-2)] px-3 py-1 text-[11px] leading-tight text-amber-400">
                <AlertTriangle size={12} className="mt-[1px] shrink-0" />
                <span className="flex-1">
                  {t(focusNote === 'future' ? 'training.focusFuture' : 'training.focusForeign')}
                </span>
                <button
                  onClick={clearFocusNote}
                  className="shrink-0 text-[var(--text-faint)] hover:text-[var(--text-primary)]"
                >
                  <X size={11} />
                </button>
              </div>
            )}

            {/* 标签筛选：打过标签才出现，不打标签就完全不占高度 */}
            {tradeTags.tags.length > 0 && (
              <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--surface-1)] px-3 py-1">
                <TagFilter
                  dense
                  tags={tradeTags.tags}
                  counts={tradeTags.counts}
                  value={tradeTags.selected}
                  onChange={tradeTags.select}
                  total={closedTrades.length}
                />
                {tradeTags.filtering && (
                  <button
                    type="button"
                    onClick={tradeTags.clear}
                    className="ml-auto shrink-0 rounded border border-[var(--border-subtle)] px-1.5 py-[1px] text-[10px] text-[var(--text-muted)] transition-colors hover:border-[var(--text-muted)] hover:text-[var(--text-primary)]"
                  >
                    {t('training.clearFilter')}
                  </button>
                )}
              </div>
            )}

            <div className="min-h-0 flex-1 overflow-y-auto overflow-x-auto">
            {closedTrades.length === 0 ? (
              <div className="py-7 text-center text-[12px] text-[var(--text-faint)]">
                {t('training.noClosedTrades')}
              </div>
            ) : tradeTags.filtered.length === 0 ? (
              <div className="py-7 text-center text-[12px] text-[var(--text-faint)]">
                {t('training.noTradesWithTag', { tag: tradeTags.label })}
              </div>
            ) : (
              <table className="w-full min-w-[580px] text-left">
                <thead>
                  <tr className="text-[10.5px] uppercase tracking-wider text-[var(--text-faint)]">
                    <th className="px-3 py-1.5 font-medium">{t('training.col.openTime')}</th>
                    <th className="px-3 py-1.5 font-medium">{t('training.col.side')}</th>
                    <th className="px-3 py-1.5 text-right font-medium">{t('training.col.lot')}</th>
                    <th className="px-3 py-1.5 text-right font-medium">{t('training.col.entry')}</th>
                    <th className="px-3 py-1.5 text-right font-medium">{t('training.col.exit')}</th>
                    <th className="px-3 py-1.5 font-medium">{t('training.col.reason')}</th>
                    <th className="px-3 py-1.5 font-medium">{t('training.col.tags')}</th>
                    <th className="px-3 py-1.5 text-right font-medium">{t('training.col.pnl')}</th>
                    <th className="w-[40px] py-1.5 pl-1 pr-2.5 font-medium">
                      <span className="sr-only">{t('training.col.actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {[...tradeTags.filtered].reverse().map((trade) => {
                    const isFocused = focusedTrade?.id === trade.id
                    return (
                    <tr
                      key={trade.id}
                      onClick={() => focusTrade(trade)}
                      title={
                        isFocused ? t('training.rowFocusedHint') : t('training.rowFocusHint')
                      }
                      className={clsx(
                        'cursor-pointer border-t border-[var(--border-subtle)] text-[12px] transition-colors',
                        isFocused
                          ? 'bg-[var(--c-accent-tint)] shadow-[inset_2px_0_0_0_var(--c-accent)]'
                          : 'hover:bg-[var(--surface-2)]'
                      )}
                    >
                      <td className="px-3 py-1.5 font-mono tabular-nums text-[var(--text-muted)]">
                        {fmtTime(trade.entryTime, timezone)}
                      </td>
                      <td className="px-3 py-1.5">
                        <span
                          className={clsx(
                            'rounded px-1.5 py-px text-[10.5px] font-medium',
                            trade.side === 'buy'
                              ? 'bg-[var(--c-neg-tint)] text-[var(--c-neg)]'
                              : 'bg-[var(--c-pos-tint)] text-[var(--c-pos)]'
                          )}
                        >
                          {trade.side === 'buy' ? t('training.long') : t('training.short')}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono tabular-nums text-[var(--text-secondary)]">
                        {trade.lot.toFixed(2)}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono tabular-nums text-[var(--text-secondary)]">
                        {formatPrice(trade.entryPrice, trade.digits)}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono tabular-nums text-[var(--text-secondary)]">
                        {formatPrice(trade.exitPrice, trade.digits)}
                      </td>
                      <td className="px-3 py-1.5 text-[11px] text-[var(--text-muted)]">
                        {trade.reason === 'sl'
                          ? t('training.stopLoss')
                          : trade.reason === 'tp'
                            ? t('training.takeProfit')
                            : trade.reason === 'trail'
                              ? t('training.reasonTrail')
                              : trade.reason === 'partial'
                                ? t('training.reasonPartial')
                                : t('training.reasonManual')}
                      </td>
                      <td className="px-3 py-1.5">
                        {trade.tags.length > 0 ? (
                          <span className="flex flex-wrap gap-1">
                            {trade.tags.map((tag) => {
                              const active = tradeTags.selected.includes(tag)
                              return (
                                <button
                                  key={tag}
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    // 和筛选条一致：点一下点亮，再点一下取消
                                    tradeTags.toggle(tag)
                                  }}
                                  title={
                                    active
                                      ? t('tagFilter.offHint', { tag })
                                      : t('tagFilter.onHint', { tag })
                                  }
                                  className={clsx(
                                    'rounded border px-1 py-px text-[10px] leading-none transition-colors',
                                    active
                                      ? 'border-[var(--c-accent)] bg-[var(--c-accent-tint)] text-[var(--c-accent)]'
                                      : 'border-[var(--border-subtle)] bg-[var(--surface-2)] text-[var(--text-muted)] hover:border-[var(--c-accent)] hover:text-[var(--c-accent)]'
                                  )}
                                >
                                  {tag}
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
                          'px-3 py-1.5 text-right font-mono text-[12px] font-semibold tabular-nums',
                          trade.pnl >= 0 ? 'text-[var(--c-neg)]' : 'text-[var(--c-pos)]'
                        )}
                      >
                        {formatSigned(trade.pnl)}
                      </td>
                      {/* 编辑备注 / 标签：常显而不是悬停才浮出来 —— 悬停提示等于没提示，
                          找不到的按钮就是没有的按钮。stopPropagation 是因为整行点了会去图上定位 */}
                      <td className="py-1.5 pl-1 pr-2.5">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            setEditingTrade(trade)
                          }}
                          title={t('training.editTradeHint')}
                          aria-label={t('training.editTrade')}
                          className={clsx(
                            'rounded p-1 transition-colors hover:bg-[var(--surface-3)] hover:text-[var(--c-accent)]',
                            // 已经写过备注的那几笔点亮，扫一眼就知道哪些还没补思路
                            trade.note
                              ? 'text-[var(--c-accent)]'
                              : 'text-[var(--text-muted)]'
                          )}
                        >
                          <PenLine size={13} />
                        </button>
                      </td>
                    </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center">
          <div className="max-w-[460px] text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--c-accent-tint)] text-[var(--c-accent)]">
              <Play size={26} />
            </div>
            <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">
              {t('training.emptyTitle')}
            </h2>
            <p className="mt-2 text-[12px] leading-relaxed text-[var(--text-muted)]">
              {t('training.emptyDesc')}
            </p>
            {error && <p className="mt-3 text-[11.5px] text-[var(--c-neg)]">{error}</p>}
          </div>
        </div>
      )}

      {/* 编辑某笔已平仓交易的思路 / 标签：与日志页复用同一个对话框，
          保存走 patchTradeMeta，成功后会一起更新 store 里的 closedTrades */}
      {editingTrade && (
        <TradeMetaDialog
          trade={editingTrade}
          tz={activeSession?.tz ?? timezone}
          onClose={() => setEditingTrade(null)}
          onSave={async (note, tags) => {
            const sid = activeSession?.id
            if (sid == null) return false
            return useTrainingStore.getState().patchTradeMeta(sid, editingTrade.id, { note, tags })
          }}
        />
      )}

      {confirmReset && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onMouseDown={() => setConfirmReset(false)}
        >
          <div
            className="w-[340px] rounded-lg border border-[var(--border-strong)] bg-[var(--surface-1)] p-4 shadow-2xl"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <h3 className="text-[13px] font-semibold text-[var(--text-primary)]">
              {t('training.resetConfirmTitle')}
            </h3>
            <p className="mt-1.5 text-[11.5px] leading-relaxed text-[var(--text-muted)]">
              {t('training.resetConfirmBefore')}
              <span className="text-[var(--text-primary)]"> {closedTrades.length} </span>
              {t('training.resetConfirmMid')}
              <span className="font-mono text-[var(--text-primary)]"> {money(initialBalance)}</span>
              {t('training.resetConfirmAfter')}
            </p>
            <div className="mt-3.5 flex justify-end gap-2">
              <button
                autoFocus
                onClick={() => setConfirmReset(false)}
                className="rounded-md border border-[var(--border-subtle)] px-3 py-1.5 text-[11.5px] text-[var(--text-secondary)] outline-none transition-colors hover:text-[var(--text-primary)] focus:border-[var(--border-strong)]"
              >
                {t('training.cancel')}
              </button>
              <button
                onClick={() => {
                  setConfirmReset(false)
                  void resetSession()
                }}
                className="rounded-md bg-[var(--c-accent)] px-3 py-1.5 text-[11.5px] font-medium text-white transition hover:brightness-110"
              >
                {t('training.reset')}
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onMouseDown={() => setConfirmDeleteId(null)}
        >
          <div
            className="w-[330px] rounded-lg border border-[var(--border-strong)] bg-[var(--surface-1)] p-4 shadow-2xl"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <h3 className="text-[13px] font-semibold text-[var(--text-primary)]">
              {t('training.deleteConfirmTitle')}
            </h3>
            <p className="mt-1.5 text-[11.5px] leading-relaxed text-[var(--text-muted)]">
              <span className="text-[var(--text-primary)]">{pendingDelete.name}</span>
              <br />
              {t('training.deleteConfirmBody')}
            </p>
            <div className="mt-3.5 flex justify-end gap-2">
              <button
                autoFocus
                onClick={() => setConfirmDeleteId(null)}
                className="rounded-md border border-[var(--border-subtle)] px-3 py-1.5 text-[11.5px] text-[var(--text-secondary)] outline-none transition-colors hover:text-[var(--text-primary)] focus:border-[var(--border-strong)]"
              >
                {t('training.cancel')}
              </button>
              <button
                onClick={() => {
                  const id = pendingDelete.id
                  setConfirmDeleteId(null)
                  void deleteSession(id)
                }}
                className="rounded-md bg-[var(--c-neg)] px-3 py-1.5 text-[11.5px] font-medium text-white transition hover:brightness-110"
              >
                {t('training.delete')}
              </button>
            </div>
          </div>
        </div>
      )}

      {orderSide && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onMouseDown={() => setOrderSide(null)}
        >
          <div
            className="w-[400px] rounded-lg border border-[var(--border-strong)] bg-[var(--surface-1)] p-4 shadow-2xl"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-baseline gap-2">
              <h3 className="text-[13px] font-semibold text-[var(--text-primary)]">
                {t('training.orderNoteTitle')}
              </h3>
              <span className="ml-auto text-[10px] text-[var(--text-faint)]">
                {t('training.orderNoteHotkeyHint', { key: orderSide === 'buy' ? 'B' : 'S' })}
              </span>
            </div>
            <p className="mt-1 text-[11px] text-[var(--text-muted)]">
              {t('training.orderSummaryBefore', {
                side: orderSide === 'buy' ? t('training.buy') : t('training.sell'),
                symbol: symbol ?? '',
                lot: lot.toFixed(2)
              })}{' '}
              <span className="font-mono">
                {/* 显示图上那张待确认单定的价：浮窗里写的价必须和用户看到的线一致 */}
                {orderDraft
                  ? formatPrice(orderDraft.entry, priceDigits)
                  : currentBar
                    ? formatPrice(currentBar.close, priceDigits)
                    : '--'}
              </span>
            </p>
            <textarea
              value={orderNote}
              onChange={(e) => setOrderNote(e.target.value)}
              onKeyDown={(e) => {
                /**
                 * 备注框里的 B / S 默认就是普通字符（要写 "B 浪"、"sell" 都行）。
                 *
                 * 唯一的例外：**还没开始写**备注时再按一次同方向键 —— 等同于「跳过备注，
                 * 直接下单」。这是给「点了框又不想写」的人留的退路；一旦写了内容，
                 * 提交用「确认下单」按钮，或者鼠标点一下框外再按 B。
                 *
                 * 中文输入法组字中（isComposing）不抢键，否则拼音首字母会被吃掉。
                 */
                const key = e.key.toLowerCase()
                const hotkey = orderSide === 'buy' ? 'b' : 's'
                if (
                  key === hotkey &&
                  !e.nativeEvent.isComposing &&
                  orderNote.trim() === '' &&
                  !e.ctrlKey &&
                  !e.metaKey &&
                  !e.altKey
                ) {
                  e.preventDefault()
                  submitOrder(false)
                  return
                }
                if (e.key === 'Escape') setOrderSide(null)
              }}
              rows={4}
              placeholder={t('training.orderNotePlaceholder')}
              className="mt-2.5 w-full resize-none rounded-md border border-[var(--border-subtle)] bg-[var(--surface-2)] px-2.5 py-2 text-[12px] leading-relaxed text-[var(--text-primary)] outline-none placeholder:text-[var(--text-faint)] focus:border-[var(--c-accent)]"
            />
            {/* 标签：设置页维护的常用标签可一键点亮，末尾小加号临时加一个（最多 10 个） */}
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="shrink-0 text-[10px] text-[var(--text-faint)]">
                {t('training.tags')}
              </span>

              {tagLibrary.map((tag) => {
                const on = orderTags.includes(tag)
                return (
                  <button
                    key={`lib-${tag}`}
                    onClick={() =>
                      on
                        ? removeTag(tag)
                        : setOrderTags((prev) =>
                            prev.length >= MAX_TRADE_TAGS ? prev : [...prev, tag]
                          )
                    }
                    title={on ? t('training.tagCancelHint') : t('training.tagAddHint')}
                    className={clsx(
                      'inline-flex items-center gap-1 rounded border px-1.5 py-[1px] text-[10.5px] leading-none transition-colors',
                      on
                        ? 'border-[var(--c-accent)] bg-[var(--c-accent-tint)] text-[var(--c-accent)]'
                        : 'border-dashed border-[var(--border-subtle)] text-[var(--text-faint)] hover:border-[var(--border-strong)] hover:text-[var(--text-secondary)]'
                    )}
                  >
                    {tag}
                    {on && <X size={9} />}
                  </button>
                )
              })}

              {/* 临时敲进去、不在标签库里的标签 */}
              {orderTags
                .filter((tagItem) => !tagLibrary.includes(tagItem))
                .map((tag) => (
                  <button
                    key={`own-${tag}`}
                    onClick={() => removeTag(tag)}
                    title={t('training.removeTag')}
                    className="inline-flex items-center gap-1 rounded border border-[var(--c-accent)] bg-[var(--c-accent-tint)] px-1.5 py-[1px] text-[10.5px] leading-none text-[var(--c-accent)]"
                  >
                    {tag}
                    <X size={9} />
                  </button>
                ))}

              {tagEditing ? (
                <input
                  ref={tagInputRef}
                  value={tagDraft}
                  maxLength={MAX_TRADE_TAG_LEN}
                  onChange={(e) => setTagDraft(e.target.value)}
                  onBlur={commitTag}
                  onKeyDown={(e) => {
                    // Enter / Esc 只作用于这个输入框，别冒泡去关弹窗或触发下单热键
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      e.stopPropagation()
                      commitTag()
                    } else if (e.key === 'Escape') {
                      e.stopPropagation()
                      setTagDraft('')
                      setTagEditing(false)
                    }
                  }}
                  placeholder={t('settings.tags.placeholder')}
                  className="w-[72px] rounded border border-[var(--c-accent)] bg-[var(--surface-2)] px-1.5 py-[1px] text-[10.5px] leading-none text-[var(--text-primary)] outline-none placeholder:text-[var(--text-faint)]"
                />
              ) : orderTags.length < MAX_TRADE_TAGS ? (
                <button
                  onClick={() => setTagEditing(true)}
                  title={t('settings.tags.add', { max: MAX_TRADE_TAGS })}
                  className="inline-flex h-[17px] w-[17px] shrink-0 items-center justify-center rounded border border-dashed border-[var(--border-strong)] text-[var(--text-faint)] transition-colors hover:border-[var(--c-accent)] hover:text-[var(--c-accent)]"
                >
                  <Plus size={11} />
                </button>
              ) : null}

              {orderTags.length > 0 && (
                <span className="ml-auto shrink-0 text-[9.5px] leading-none text-[var(--text-faint)]">
                  {orderTags.length}/{MAX_TRADE_TAGS}
                </span>
              )}
            </div>

            {/* 底部：快捷键提示 + 按钮，整体水平居中，行内垂直居中 */}
            <div className="mt-2.5 flex flex-col items-center gap-2">
              <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-center text-[10.5px] leading-none text-[var(--text-faint)]">
                <span
                  className="flex items-center gap-1.5"
                  title={t('training.orderNoteAgainHint')}
                >
                  {t('training.orderNotePressKey')}
                  <Kbd>{orderSide === 'buy' ? 'B' : 'S'}</Kbd>
                  {t('training.orderNoteSubmit')}
                </span>
                <span className="flex items-center gap-1.5">
                  <Kbd>Esc</Kbd>
                  {t('training.escCancel')}
                </span>
              </div>
              <div className="flex items-center justify-center gap-2">
                <button
                  onClick={() => setOrderSide(null)}
                  className="inline-flex h-7 shrink-0 items-center justify-center whitespace-nowrap rounded-md border border-[var(--border-subtle)] px-3 text-[11.5px] leading-none text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                >
                  {t('training.cancel')}
                </button>
                <button
                  onClick={() => submitOrder(false)}
                  title={t('training.orderNoteSkipHint')}
                  className="inline-flex h-7 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-[var(--border-strong)] px-3 text-[11.5px] leading-none text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                >
                  {t('training.orderNoteSkip')}
                </button>
                <button
                  onClick={() => submitOrder(true)}
                  title={t('training.orderNoteConfirmHint')}
                  className={clsx(
                    'inline-flex h-7 shrink-0 items-center justify-center whitespace-nowrap rounded-md px-3 text-[11.5px] font-medium leading-none text-white transition hover:brightness-110',
                    orderSide === 'buy' ? 'bg-[var(--c-neg)]' : 'bg-[var(--c-pos)]'
                  )}
                >
                  {t('training.orderNoteConfirm')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {reportOpen && activeSession && (
        <TrainingReport
          sessionName={activeSession.name}
          symbol={symbol}
          timeframe={timeframe}
          initialBalance={initialBalance}
          finalBalance={balance}
          riskPerTrade={riskPerTrade}
          trades={closedTrades}
          onClose={() => setReportOpen(false)}
          onSelectTrade={(trade) => {
            setReportOpen(false)
            focusTrade(trade)
          }}
        />
      )}

      {dialogOpen && (
        <NewSessionDialog
          datasets={datasets}
          onClose={() => setDialogOpen(false)}
          onCreate={async (payload) => {
            await createSession(payload)
            setDialogOpen(false)
          }}
        />
      )}
    </div>
  )
}

// ---------------- 新建会话弹窗 ----------------

function NewSessionDialog({
  datasets,
  onClose,
  onCreate
}: {
  datasets: any[]
  onClose: () => void
  onCreate: (p: {
    datasetId: number
    startTime: number
    endTime: number
    name?: string
    displayTimeframe?: string
    riskPerTrade?: number
    tradeWindow?: TradeWindow | null
  }) => Promise<void>
}): React.JSX.Element {
  const { t, locale } = useT()
  const [datasetId, setDatasetId] = useState<number | null>(datasets[0]?.id ?? null)
  const ds = datasets.find((d) => d.id === datasetId)

  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [name, setName] = useState('')
  const [tf, setTf] = useState<string>('M5')
  /** 单笔风险（金额），默认初始资金的 1% */
  const [risk, setRisk] = useState('100')
  const [busy, setBusy] = useState(false)

  /** 交易时段：默认不限；打开开关后只允许在起止之间开仓 */
  const [limitWindow, setLimitWindow] = useState(false)
  const [winFrom, setWinFrom] = useState('07:00')
  const [winTo, setWinTo] = useState('23:00')
  /** 建会话时用的是当前全局时区，这里跟着它显示 */
  const tz = useTimezoneStore((s) => s.timezone)

  const tradeWindow = limitWindow ? normalizeTradeWindow({ from: winFrom, to: winTo }) : null
  /** 开了开关但起止相同 → 时段无效 */
  const windowOk = !limitWindow || tradeWindow != null
  const overnight = tradeWindow != null && isOvernight(tradeWindow)

  /** 会话初始资金固定 10000（见 createSession） */
  const INITIAL_BALANCE = 10000
  const riskNum = Number(risk)
  const riskOk = Number.isFinite(riskNum) && riskNum > 0 && riskNum <= INITIAL_BALANCE
  const riskPct = riskOk ? (riskNum / INITIAL_BALANCE) * 100 : 0

  // 切换标的后，把区间重置到该标的最近 30 天（或全部）
  useEffect(() => {
    if (!ds) return
    const toKey = dayKeyUtc(ds.last_time)
    const fromTs = Math.max(ds.first_time, ds.last_time - 29 * 86400)
    setFrom(dayKeyUtc(fromTs))
    setTo(toKey)
    setName('')
  }, [datasetId])

  const minDate = ds ? dayKeyUtc(ds.first_time) : undefined
  const maxDate = ds ? dayKeyUtc(ds.last_time) : undefined

  const rangeOk = Boolean(from && to && dayStartSec(from) <= dayEndSec(to))
  const dayCount = rangeOk ? Math.round((dayEndSec(to) - dayStartSec(from)) / 86400) : 0

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onMouseDown={onClose}
    >
      <div
        className="w-[440px] rounded-lg border border-[var(--border-strong)] bg-[var(--surface-1)] p-4 shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h3 className="mb-3 text-[13px] font-semibold text-[var(--text-primary)]">
          {t('training.new.title')}
        </h3>

        <label className="mb-3 block">
          <span className="mb-1.5 block text-[10.5px] text-[var(--text-muted)]">
            {t('training.new.symbol')}
          </span>
          <select
            value={datasetId ?? ''}
            onChange={(e) => setDatasetId(e.target.value ? Number(e.target.value) : null)}
            className="w-full rounded-md border border-[var(--border-subtle)] bg-[var(--surface-2)] px-2 py-1.5 text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--c-accent)]"
          >
            {datasets.map((d) => (
              <option key={d.id} value={d.id}>
                {t('training.new.datasetOption', {
                  symbol: d.symbol,
                  tf: d.timeframe,
                  bars: formatNumber(d.candle_count)
                })}
              </option>
            ))}
          </select>
          {ds && (
            <p className="mt-1 font-mono text-[9.5px] text-[var(--text-faint)]">
              {t('training.new.available', {
                from: dayKeyUtc(ds.first_time),
                to: dayKeyUtc(ds.last_time)
              })}
            </p>
          )}
        </label>

        <label className="mb-3 block">
          <span className="mb-1.5 block text-[10.5px] text-[var(--text-muted)]">
            {t('training.new.range')}
          </span>
          <DateRangePicker
            from={from}
            to={to}
            minDate={minDate}
            maxDate={maxDate}
            onChange={(f, end) => {
              setFrom(f)
              setTo(end)
            }}
          />
        </label>

        <div className="mb-3 grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1.5 block text-[10.5px] text-[var(--text-muted)]">
              {t('training.new.displayTf')}
            </span>
            <select
              value={tf}
              onChange={(e) => setTf(e.target.value)}
              className="w-full rounded-md border border-[var(--border-subtle)] bg-[var(--surface-2)] px-2 py-1.5 text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--c-accent)]"
            >
              {BASE_TIMEFRAMES.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.code} · {translateLabel(locale, o.name)}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1.5 block text-[10.5px] text-[var(--text-muted)]">
              {t('training.new.name')}
            </span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={ds ? `${ds.symbol} ${from}~${to}` : ''}
              className="w-full rounded-md border border-[var(--border-subtle)] bg-[var(--surface-2)] px-2 py-1.5 text-[12px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-faint)] focus:border-[var(--c-accent)]"
            />
          </label>
        </div>

        <div className="mb-3 grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1.5 flex items-center gap-1 text-[10.5px] text-[var(--text-muted)]">
              {t('training.new.risk')}
              <span className="text-[9.5px] text-[var(--text-faint)]">
                {t('training.new.riskR')}
              </span>
            </span>
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                min={1}
                max={INITIAL_BALANCE}
                step={10}
                value={risk}
                onChange={(e) => setRisk(e.target.value)}
                className="w-full rounded-md border border-[var(--border-subtle)] bg-[var(--surface-2)] px-2 py-1.5 font-mono text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--c-accent)]"
              />
              <span
                className={clsx(
                  'shrink-0 rounded bg-[var(--surface-3)] px-1.5 py-1 font-mono text-[10px] tabular-nums',
                  riskOk ? 'text-[var(--text-muted)]' : 'text-[var(--c-neg)]'
                )}
                title={t('training.new.riskPctHint')}
              >
                {riskOk ? `${riskPct.toFixed(1)}%` : t('training.new.invalid')}
              </span>
            </div>
          </label>

          <div className="flex flex-col justify-end pb-1 text-[10px] leading-relaxed text-[var(--text-faint)]">
            {t('training.new.rNote1')}
            <br />
            {t('training.new.rNote2')}
          </div>
        </div>

        {/* ── 交易时段 ── */}
        <div className="mb-3">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[10.5px] text-[var(--text-muted)]">
              {t('training.new.window')}
            </span>
            <label className="flex cursor-pointer select-none items-center gap-1.5 text-[10px] text-[var(--text-faint)]">
              <input
                type="checkbox"
                checked={limitWindow}
                onChange={(e) => setLimitWindow(e.target.checked)}
                className="h-3 w-3 accent-[var(--c-accent)]"
              />
              {t('training.new.windowOnly')}
            </label>
          </div>

          {limitWindow ? (
            <>
              <div className="flex items-center gap-1.5">
                <input
                  type="time"
                  value={winFrom}
                  onChange={(e) => setWinFrom(e.target.value)}
                  className="w-[104px] rounded-md border border-[var(--border-subtle)] bg-[var(--surface-2)] px-2 py-1 font-mono text-[12px] text-[var(--text-primary)] outline-none [color-scheme:dark] focus:border-[var(--c-accent)]"
                />
                <span className="text-[var(--text-faint)]">→</span>
                <input
                  type="time"
                  value={winTo}
                  onChange={(e) => setWinTo(e.target.value)}
                  className="w-[104px] rounded-md border border-[var(--border-subtle)] bg-[var(--surface-2)] px-2 py-1 font-mono text-[12px] text-[var(--text-primary)] outline-none [color-scheme:dark] focus:border-[var(--c-accent)]"
                />
                <span
                  className={clsx(
                    'ml-auto shrink-0 font-mono text-[10px]',
                    windowOk ? 'text-[var(--text-faint)]' : 'text-[var(--c-neg)]'
                  )}
                >
                  {windowOk
                    ? t('training.new.windowSpan', {
                        overnight: overnight ? t('training.new.overnight') : '',
                        hours: (tradeWindowMinutes(tradeWindow!) / 60).toFixed(1),
                        tz
                      })
                    : t('training.new.windowInvalid')}
                </span>
              </div>

              <div className="mt-1.5 flex flex-wrap items-center gap-1">
                {SESSION_WINDOW_PRESETS.map((p) => (
                  <button
                    key={p.labelKey}
                    type="button"
                    onClick={() => {
                      setWinFrom(p.from)
                      setWinTo(p.to)
                    }}
                    className={clsx(
                      'rounded border px-1.5 py-0.5 text-[10px] transition-colors',
                      winFrom === p.from && winTo === p.to
                        ? 'border-[var(--c-accent)] text-[var(--c-accent)]'
                        : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:border-[var(--c-accent)] hover:text-[var(--c-accent)]'
                    )}
                  >
                    {t(p.labelKey)} {p.from}–{p.to === '04:00' ? t('training.new.nextDay') : ''}
                    {p.to}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <div className="rounded-md border border-dashed border-[var(--border-subtle)] px-2 py-1.5 text-[10px] text-[var(--text-faint)]">
              {t('training.new.allDay')}
            </div>
          )}
        </div>

        <div className="mb-4 flex items-center gap-2 text-[10.5px] text-[var(--text-faint)]">
          <span>{t('training.new.days', { n: dayCount })}</span>
          <span>·</span>
          <span>{t('training.new.aggregateNote')}</span>
        </div>

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-md border border-[var(--border-subtle)] px-3 py-1.5 text-[11.5px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          >
            {t('training.cancel')}
          </button>
          <button
            onClick={async () => {
              if (!datasetId || !rangeOk || !riskOk || !windowOk || busy) return
              setBusy(true)
              await onCreate({
                datasetId,
                startTime: dayStartSec(from),
                endTime: dayEndSec(to),
                name: name.trim() || undefined,
                displayTimeframe: tf,
                riskPerTrade: riskNum,
                tradeWindow
              })
              setBusy(false)
            }}
            disabled={!datasetId || !rangeOk || !riskOk || !windowOk || busy}
            className="rounded-md bg-[var(--c-accent)] px-3 py-1.5 text-[11.5px] font-medium text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? t('training.new.creating') : t('training.new.create')}
          </button>
        </div>
      </div>
    </div>
  )
}

function IconButton({
  children,
  onClick,
  disabled,
  title
}: {
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean
  title?: string
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="flex h-7 w-7 items-center justify-center rounded-md border border-[var(--border-subtle)] text-[var(--text-secondary)] transition hover:border-[var(--border-strong)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-30"
    >
      {children}
    </button>
  )
}

/** 会话回放进度（按回测区间的时间比例，0~100） */
function sessionProgress(s: {
  start_time: number | null
  end_time: number | null
  current_bar_time: number | null
  completed_at?: number | null
}): number {
  const { start_time: start, end_time: end, current_bar_time: cur } = s
  if (start == null || end == null || cur == null || end <= start) {
    return s.completed_at ? 100 : 0
  }
  const pct = ((cur - start) / (end - start)) * 100
  const clamped = Math.max(0, Math.min(100, pct))
  // 小于 10% 时保留一位小数，「0%」对刚开始的回测集太误导
  return clamped >= 10 ? Math.round(clamped) : Math.round(clamped * 10) / 10
}

function money(n: number): string {  if (!Number.isFinite(n)) return '$0.00'
  const sign = n < 0 ? '-' : ''
  return `${sign}$${Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`
}

/** 点值这类小金额：按量级给小数位，$0.07 和 $6.62 都要看得出区别 */
function moneySmall(n: number): string {
  if (!Number.isFinite(n)) return '--'
  const abs = Math.abs(n)
  const digits = abs >= 100 ? 0 : abs >= 1 ? 2 : abs >= 0.1 ? 3 : 4
  const sign = n < 0 ? '-' : ''
  return `${sign}$${abs.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  })}`
}

/** 订单 / 回放时间 MM-DD HH:mm，按传进来的时区渲染（会话自己的时区，默认 UTC+8） */
function fmtTime(ts: number, tz: string): string {
  if (!ts) return '--'
  const parts = tzPartsFromSec(ts, tz)
  return `${pad2(parts.month)}-${pad2(parts.day)} ${pad2(parts.hour)}:${pad2(parts.minute)}`
}

/** 快捷键小标签 */
function Kbd({
  children,
  tone
}: {
  children: React.ReactNode
  tone?: 'light'
}): React.JSX.Element {
  return (
    <kbd
      className={clsx(
        // 键帽：等宽 + 居中 + 最小宽度，← → ↑ ↓ 这类单字符按键也能撑成一样大的方块
        'inline-flex min-w-[18px] items-center justify-center rounded border px-1 pb-[2px] pt-[1px] font-mono text-[10px] font-semibold leading-[1.25]',
        tone === 'light'
          ? 'border-white/50 bg-white/25 text-white shadow-[inset_0_-1px_0_rgba(255,255,255,0.18)]'
          : 'border-[var(--border-strong)] bg-[var(--surface-3)] text-[var(--text-primary)] shadow-[inset_0_-1px_0_rgba(0,0,0,0.45)]'
      )}
    >
      {children}
    </kbd>
  )
}
