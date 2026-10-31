// ============================================================
// TraderRewind — 数据源 / 下载状态管理
// ============================================================

import { create } from 'zustand'
import type {
  BarTimeframe,
  DataSourceDescriptor,
  DbExportResult,
  DbImportResult,
  DownloadSnapshot,
  McpStatus
} from '@shared/types/download'
import { dateOffsetISO, todayISO } from '../utils/format'

export interface DatasetRow {
  id: number
  symbol: string
  timeframe: string
  market: string
  source: string
  timezone: string
  first_time: number
  last_time: number
  candle_count: number
  imported_at: number
  group_name?: string | null
  source_filename?: string | null
}

interface DownloadState {
  // 目录
  catalog: DataSourceDescriptor[]
  catalogLoaded: boolean
  /** 正在重新拉取目录（「刷新品种」按钮转圈用） */
  refreshingCatalog: boolean
  sourceId: string

  /** cTrader 本地 MCP 探活结果；null = 还没探过 */
  mcpStatus: McpStatus | null

  // 选择
  selected: string[]
  timeframe: BarTimeframe
  dateFrom: string
  dateTo: string
  concurrency: number
  proxy: string

  // 运行态
  jobId: string | null
  snapshot: DownloadSnapshot | null
  starting: boolean
  error: string | null

  // 已下载
  datasets: DatasetRow[]
  loadingDatasets: boolean

  loadCatalog: () => Promise<void>
  /** 重新拉目录，`force` 跳过主进程 60 秒缓存 */
  refreshCatalog: (opts?: { force?: boolean }) => Promise<void>
  /** 探活 cTrader 本地 MCP，供状态灯轮询；连上时顺手补齐品种表 */
  checkMcpStatus: () => Promise<void>
  toggleSymbol: (symbol: string) => void
  setSelected: (symbols: string[]) => void
  clearSelection: () => void
  /** 切换数据源：顺手清空已选，避免把外汇代码发给加密接口 */
  setSource: (id: string) => void
  patchConfig: (patch: Partial<Pick<DownloadState, 'timeframe' | 'dateFrom' | 'dateTo' | 'concurrency' | 'proxy' | 'sourceId'>>) => void

  startDownload: () => Promise<void>
  cancelDownload: () => Promise<void>
  clearSnapshot: () => void

  bindProgress: () => () => void
  loadDatasets: () => Promise<void>
  removeDataset: (id: number) => Promise<void>
  /** 导出为独立 .db；ids 传 null = 全部 */
  exportDatasetsDb: (ids: number[] | null) => Promise<DbExportResult>
  /** 从 .db 导入，成功后自动刷新已下载列表 */
  importDatasetsDb: () => Promise<DbImportResult>
}

// 代理设置的落库防抖：用户逐字符输入时不要每次都写一遍
let proxySaveTimer: ReturnType<typeof setTimeout> | null = null
function scheduleProxySave(value: string): void {
  if (proxySaveTimer) clearTimeout(proxySaveTimer)
  proxySaveTimer = setTimeout(() => {
    proxySaveTimer = null
    void window.api.setMeta('download.proxy.v2', value).catch(() => undefined)
  }, 500)
}

/**
 * 上一次尝试补拉品种表的时间。
 *
 * 状态灯每 3 秒探一次活，而「连上了但品种表没拉到」是个会持续存在的状态
 * （比如 session 被另一个窗口占着）。不加节流就会每 3 秒打一次 get_symbols，
 * 既刷屏又可能把服务端拖慢，所以同一个状态 20 秒内只重试一次。
 */
let lastCatalogTryAt = 0
const CATALOG_RETRY_MS = 20_000

export const useDownloadStore = create<DownloadState>((set, get) => ({
  catalog: [],
  catalogLoaded: false,
  refreshingCatalog: false,
  sourceId: 'ctrader',
  mcpStatus: null,

  // 不预选任何品种：替用户勾上 EURUSD 会让人误以为「已经选好了」，
  // 或者不知不觉下了一份自己没要的数据。让用户自己选。
  selected: [],
  timeframe: 'M1',
  dateFrom: dateOffsetISO(-7),
  dateTo: todayISO(),
  concurrency: 24,
  // 代理默认留空 = 直连。只有用户自己在设置里填过才走代理，
  // 不能替用户预设一个本地代理端口（没用代理软件的人会直接连不上）。
  proxy: '',

  jobId: null,
  snapshot: null,
  starting: false,
  error: null,

  datasets: [],
  loadingDatasets: false,

  loadCatalog: async () => {
    try {
      const [catalog, savedProxy, savedConcurrency] = await Promise.all([
        window.api.listDataCatalog(),
        // v2：旧版本把 127.0.0.1:7890 当默认值写进了 download.proxy，
        // 换新键避免读到那个「不是用户填的」值。
        window.api.getMeta('download.proxy.v2').catch(() => null),
        // v2：并发上限提升到 500 后使用新的键，避免读到旧版本保存的 24
        window.api.getMeta('download.concurrency.v2').catch(() => null)
      ])
      const parsed = savedConcurrency ? Number(savedConcurrency) : NaN
      set({
        catalog: catalog ?? [],
        catalogLoaded: true,
        // 没存过（null）就沿用当前值 —— 首次进页面时当前值已是空字符串
        proxy: typeof savedProxy === 'string' ? savedProxy : get().proxy,
        concurrency:
          Number.isFinite(parsed) && parsed > 0
            ? Math.max(1, Math.min(64, Math.round(parsed)))
            : get().concurrency
      })
    } catch (e: any) {
      set({ catalogLoaded: true, error: e?.message ?? String(e) })
    }
  },

  /**
   * 只重新拉取目录，不动代理/并发这些用户设置。
   *
   * 存在的理由：目录在应用启动时只加载一次，而 cTrader 的品种表必须
   * 等桌面端跑起来才有。如果用户先开软件、后开 cTrader，界面就会一直
   * 挂着启动时那份 23 个品种的内置清单 —— 看起来像「品种缺失」，
   * 实际只是没人再去拉一次。
   *
   * @param opts.force 跳过主进程的 60 秒缓存。手动点「刷新品种」时用，
   *   否则用户刚把 cTrader 打开、点刷新，拿到的还是 40 秒前的失败结果。
   */
  refreshCatalog: async (opts) => {
    if (get().refreshingCatalog) return
    lastCatalogTryAt = Date.now()
    set({ refreshingCatalog: true })
    try {
      const catalog = await window.api.listDataCatalog({ force: !!opts?.force })
      set({ catalog: catalog ?? [], refreshingCatalog: false, error: null })
    } catch (e: any) {
      set({ refreshingCatalog: false, error: e?.message ?? String(e) })
    }
  },

  /**
   * 探活 + 自动补品种。
   *
   * 两件事绑在一起是有意的：用户开 cTrader 这个动作，同时意味着
   * 「状态灯该变绿」和「品种表该变成 193 个」。如果只更新灯不补表，
   * 用户会看到一个绿色的灯配一份缺斤少两的清单，更让人困惑。
   */
  checkMcpStatus: async () => {
    let status: McpStatus | null = null
    try {
      status = (await window.api.ctraderMcpStatus()) as McpStatus
    } catch {
      status = null
    }
    const prev = get().mcpStatus
    // 只在「连没连上 / 端口」变化时写回。latencyMs 每次探活都不一样，
    // 照写的话整个下载面板每 3 秒重渲染一次（左侧几百行品种），
    // 滚动会明显发涩 —— 而这个数值对用户并没有时效性。
    if (!prev || prev.up !== status?.up || prev.port !== status?.port) {
      set({ mcpStatus: status })
    }

    if (!status?.up) return

    // 首次目录还没回来时先等着：loadCatalog 本身就会带上品种表，
    // 这时候再补拉一次等于对同一个 MCP session 并发发两条 get_symbols。
    if (!get().catalogLoaded) return

    const ct = get().catalog.find((s) => s.id === 'ctrader')
    const needCatalog = !prev?.up || !ct?.live
    if (!needCatalog) return
    if (Date.now() - lastCatalogTryAt < CATALOG_RETRY_MS) return
    await get().refreshCatalog({ force: true })
  },

  toggleSymbol: (symbol) => {
    const current = get().selected
    const next = current.includes(symbol)
      ? current.filter((s) => s !== symbol)
      : [...current, symbol]
    set({ selected: next, error: null })
  },

  setSelected: (symbols) => set({ selected: symbols, error: null }),

  clearSelection: () => set({ selected: [] }),

  /**
   * 换数据源。
   *
   * 必须清空已选：各家的代码格式不一样（EURUSD / BTC-USDT / BTCUSDT），
   * 留着旧的选中项，点「开始下载」就会把外汇代码发给加密接口，报一堆
   * 「未知品种」；用户还以为自己只是换了个数据源。
   */
  setSource: (id) => {
    if (get().sourceId === id) return
    const src = get().catalog.find((s) => s.id === id)
    // 加密接口限速比外汇严得多，并发滑杆上限只有 8；沿用外汇的 24 会让滑杆
    // 停在「超出刻度」的位置，看着像坏了。这里顺手压回 8（主进程还会再按
    // 适配器压到 4~6，那层是真正生效的）。
    const concurrency =
      src?.kind === 'candle' ? Math.min(get().concurrency, 8) : get().concurrency
    set({ sourceId: id, selected: [], error: null, concurrency })
  },

  /**
   * 改代理时顺手落库（防抖）。
   * 以前只在「开始下载」时才保存，用户填了代理但没立刻下载、重启后就丢了，
   * 跟「用户自己设置过就该记住」的预期不符。
   */
  patchConfig: (patch) => {
    set({ ...patch, error: null })
    if (patch.proxy !== undefined) scheduleProxySave(patch.proxy)
  },

  startDownload: async () => {
    const state = get()
    if (state.selected.length === 0) {
      set({ error: '请至少选择一个品种' })
      return
    }
    if (state.starting) return

    set({ starting: true, error: null })

    // 记住代理与并发设置
    void window.api.setMeta('download.proxy.v2', state.proxy).catch(() => undefined)
    void window.api.setMeta('download.concurrency.v2', String(state.concurrency)).catch(() => undefined)

    try {
      const result = await window.api.startDownload({
        source: state.sourceId,
        symbols: state.selected,
        // 固定 1 分钟粒度（更大周期由 1 分钟聚合）
        timeframe: 'M1',
        dateFrom: state.dateFrom,
        dateTo: state.dateTo,
        concurrency: state.concurrency,
        proxy: state.proxy.trim() || undefined
      })

      if (!result?.ok) {
        set({ starting: false, error: result?.error ?? '启动下载失败' })
        return
      }

      set({ starting: false, jobId: result.jobId ?? null })
    } catch (e: any) {
      set({ starting: false, error: e?.message ?? String(e) })
    }
  },

  cancelDownload: async () => {
    const jobId = get().jobId
    if (!jobId) return
    try {
      await window.api.cancelDownload(jobId)
    } catch {
      // 忽略
    }
  },

  clearSnapshot: () => set({ snapshot: null, jobId: null, error: null }),

  bindProgress: () => {
    // 用 rAF 合并高频快照：同一帧内多次进度只触发一次渲染
    let raf: number | null = null
    let pending: DownloadSnapshot | null = null

    const flush = (): void => {
      raf = null
      const snap = pending
      pending = null
      if (!snap) return

      const allFinished = snap.tasks.every(
        (t) => t.phase === 'done' || t.phase === 'error' || t.phase === 'cancelled'
      )

      set({ snapshot: snap, jobId: snap.jobId })

      if (allFinished) {
        void get().loadDatasets()
      }
    }

    const off = window.api.on('data:progress', (snapshot: DownloadSnapshot) => {
      const currentJob = get().jobId
      // 只接收当前作业（或未知作业的首个快照）
      if (currentJob && snapshot.jobId !== currentJob) return
      pending = snapshot
      if (raf == null) raf = requestAnimationFrame(flush)
    })

    return () => {
      off()
      if (raf != null) cancelAnimationFrame(raf)
      raf = null
      pending = null
    }
  },

  loadDatasets: async () => {
    set({ loadingDatasets: true })
    try {
      const rows = await window.api.listDownloadedDatasets()
      set({ datasets: (rows ?? []) as DatasetRow[], loadingDatasets: false })
    } catch {
      set({ loadingDatasets: false })
    }
  },

  removeDataset: async (id) => {
    await window.api.deleteDownloadedDataset(id)
    await get().loadDatasets()
  },

  /**
   * 导出。
   *
   * 不在这里吞掉「用户取消」：取消和失败在界面上是两种完全不同的反馈，
   * 取消不该弹红字。所以原样把结果交回去，由调用方决定怎么显示。
   */
  exportDatasetsDb: async (ids) => {
    try {
      return (await window.api.exportDatasetsDb(ids)) as DbExportResult
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) }
    }
  },

  importDatasetsDb: async () => {
    try {
      const result = (await window.api.importDatasetsDb()) as DbImportResult
      // 导入会新增 / 扩展数据集，列表必须重拉，否则界面还停在导入前的样子
      if (result?.ok || (result?.added ?? 0) > 0 || (result?.merged ?? 0) > 0) {
        await get().loadDatasets()
      }
      return result
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) }
    }
  }
}))
