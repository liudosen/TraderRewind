// ============================================================
// TraderRewind — 数据源 / 下载 IPC 处理器
// ============================================================

import { ipcMain, dialog, app, BrowserWindow } from 'electron'
import { statSync } from 'node:fs'
import { basename } from 'node:path'
import { IPC } from '@shared/constants/ipc'
import { DATA_SOURCES, ALL_INSTRUMENTS, registerInstruments } from '@shared/constants/catalog'
import type {
  DownloadRequest,
  DownloadSnapshot,
  DownloadStartResult,
  InstrumentCategory,
  InstrumentInfo
} from '@shared/types/download'
import { CandleJob, isCandleSource } from '../services/candle-api'
import { sharedCtraderClient, probeLocalMcp } from '../services/ctrader-mcp'
import { listDatasetsWithGroup, deleteDatasetById } from '../db/dataset-repo'
import { exportKlineDb, importKlineDb } from '../db/kline-export'

/** 从路径里取文件名，导入失败时用来指认是哪个文件 */
function fileNameOf(p: string): string {
  return basename(p)
}

/**
 * 运行中的作业。两个下载器接口一致（jobId / prepare / run / cancel），
 * 但内部完全不同（tick 文件 vs K 线分页），所以这里按数据源分派。
 */
interface RunningJob {
  jobId: string
  prepare: () => { ok: boolean; unitCount: number; error?: string }
  run: () => Promise<void>
  cancel: () => void
}

const activeJobs = new Map<string, RunningJob>()

// ------------------------------------------------------------
// cTrader 品种目录
// ------------------------------------------------------------

/** 七大直盘，用来把经纪商的 Forex 大类再切成「主要」和「交叉」 */
const MAJOR_FX = new Set([
  'EURUSD',
  'GBPUSD',
  'USDJPY',
  'USDCHF',
  'AUDUSD',
  'USDCAD',
  'NZDUSD'
])

/** 经纪商的分类字符串五花八门，统一映射到 UI 的折叠分组 */
function mapCtraderCategory(raw: string, symbol: string): InstrumentCategory {
  const s = (raw || '').toLowerCase()
  if (s.includes('metal') || /^X(AU|AG|PT|PD)/.test(symbol)) return 'metal'
  if (s.includes('indice') || s.includes('index')) return 'index'
  // Oil 必须排在 forex 兜底之前：XBRUSD/XNGUSD 也是 6 个字母，
  // 否则会被下面的「6 位纯字母 = 货币对」规则误判成交叉盘
  if (s.includes('oil') || s.includes('commodit') || s.includes('energy') || s.includes('agricultur')) {
    return 'commodity'
  }
  if (s.includes('stock') || s.includes('share') || s.includes('equit')) return 'stock'
  if (s.includes('crypto') || s.includes('digital')) return 'crypto'
  if (s.includes('forex') || s.includes('currency') || /\bfx\b/.test(s)) {
    return MAJOR_FX.has(symbol) ? 'major' : 'cross'
  }
  // 没给分类时按代码形状猜：6 位纯字母基本都是货币对
  if (/^[A-Z]{6}$/.test(symbol)) return MAJOR_FX.has(symbol) ? 'major' : 'cross'
  return 'other'
}

/** 内置品种表：优先用它的 digits，避免被推断值覆盖 */
const STATIC_INSTRUMENTS = new Map(ALL_INSTRUMENTS.map((i) => [i.symbol, i]))

/**
 * cTrader 的品种接口不返回小数位，只能推断。
 * 规则按资产类别 + 报价货币走：日元报价的外汇是 3 位，指数 1 位，
 * 其余外汇 5 位。内置表里有的品种（XAUUSD 等）不会被这里覆盖。
 */
function inferDigits(assetClass: string, symbol: string): number {
  const s = (assetClass || '').toLowerCase()
  if (s.includes('metal')) return 3
  if (s.includes('indice')) return 1
  if (s.includes('oil')) return 2
  if (s.includes('commodit')) return 2
  if (s.includes('stock')) return 2
  if (s.includes('crypto')) return 2
  if (/JPY$/.test(symbol)) return 3
  return 5
}

/** 品种表缓存：60 秒内重复打开下载页不再打服务端 */
let ctraderSymbolCache: { at: number; list: InstrumentInfo[] } | null = null

/**
 * 拉 cTrader 品种表。
 *
 * @param force 跳过 60 秒缓存。用户手动点「刷新品种」时必须走这条 ——
 * 他很可能刚把 cTrader 打开，正要验证是否生效；给一份 40 秒前的旧结果
 * 等于告诉他「刷新没用」。
 */
async function getCtraderInstruments(force = false): Promise<InstrumentInfo[]> {
  const now = Date.now()
  if (!force && ctraderSymbolCache && now - ctraderSymbolCache.at < 60_000) {
    return ctraderSymbolCache.list
  }
  try {
    const rows = await sharedCtraderClient().listSymbols()
    const list: InstrumentInfo[] = rows.map((r) => {
      const base = STATIC_INSTRUMENTS.get(r.symbol)
      return {
        symbol: r.symbol,
        name: r.name,
        category: mapCtraderCategory(r.assetClass, r.symbol),
        digits: base?.digits ?? inferDigits(r.assetClass, r.symbol)
      }
    })
    if (list.length > 0) {
      // 注册进全局品种表，否则下载时 getInstrument() 查不到会被判成「未知品种」
      registerInstruments(list)
      ctraderSymbolCache = { at: now, list }
      return list
    }
    return ctraderSymbolCache?.list ?? []
  } catch (e) {
    // cTrader 没开 / session 被占用：保留上一次的结果或交给调用方回退。
    // 这里必须留日志 —— 否则界面会悄悄退回内置的 23 个外汇品种，
    // 用户只看到「品种不全」，完全无从判断是客户端没开还是代码出错。
    console.warn('[cTrader] 拉取品种失败，回退内置清单:', (e as Error)?.message ?? e)
    return ctraderSymbolCache?.list ?? []
  }
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload)
    }
  }
}

export function registerDataHandlers(): void {
  // 目录：可用数据源与品种
  // cTrader 的品种表来自经纪商，必须运行时拉取；拉不到就退回内置的外汇清单，
  // 保证 cTrader 没开的时候页面依然能渲染、只是挑不到冷门品种。
  // 目录项上的 live 标记告诉界面这一次拿到的是实时表还是兜底表。
  ipcMain.handle(IPC.DATA_LIST_CATALOG, async (_e, opts?: { force?: boolean }) => {
    const list = DATA_SOURCES.map((s) => ({ ...s, instruments: [...s.instruments] }))
    const ct = list.find((s) => s.id === 'ctrader')
    if (ct) {
      const live = await getCtraderInstruments(!!opts?.force)
      ct.live = live.length > 0
      if (ct.live) ct.instruments = live
    }
    return list
  })

  // cTrader 本地 MCP 探活：状态灯每几秒问一次，必须很轻
  ipcMain.handle(IPC.DATA_MCP_STATUS, () => probeLocalMcp())

  // 启动下载
  ipcMain.handle(
    IPC.DATA_DOWNLOAD,
    async (_e, request: DownloadRequest): Promise<DownloadStartResult> => {
      try {
        if (!request || !Array.isArray(request.symbols) || request.symbols.length === 0) {
          return { ok: false, error: '请至少选择一个品种' }
        }

        // 兜底：确保经纪商品种已写进全局品种表。正常路径是下载页先拉目录，
        // 但这里再确认一次，免得绕过 UI 直接下载时被 prepare() 判成「未知品种」。
        if (request.source === 'ctrader') {
          await getCtraderInstruments()
        }

        // 只产出 1 分钟粒度数据，避免不同周期口径不一致
        const normalized: DownloadRequest = { ...request, timeframe: 'M1' }

        const onSnapshot = (snapshot: DownloadSnapshot): void => {
          broadcast(IPC.DATA_PROGRESS, snapshot)
        }
        const onFinished = (snapshot: DownloadSnapshot): void => {
          broadcast(IPC.DATA_PROGRESS, snapshot)
          activeJobs.delete(snapshot.jobId)
        }

        // Dukascopy（tick 聚合）已下线，现在所有数据源都走 K 线分页接口
        if (!isCandleSource(request.source)) {
          return { ok: false, error: `不支持的数据源：${request.source}` }
        }
        const job: RunningJob = new CandleJob(normalized, { onSnapshot, onFinished })

        const prepared = job.prepare()
        if (!prepared.ok) {
          return { ok: false, error: prepared.error }
        }

        activeJobs.set(job.jobId, job)

        // 异步执行，立即返回 jobId
        void job.run().catch((err) => {
          broadcast(IPC.DATA_PROGRESS, {
            jobId: job.jobId,
            tasks: [],
            totalBytesPerSec: 0,
            activeTasks: 0,
            activeRequests: 0,
            unitCount: prepared.unitCount,
            error: err?.message ?? String(err)
          })
          activeJobs.delete(job.jobId)
        })

        return { ok: true, jobId: job.jobId, unitCount: prepared.unitCount }
      } catch (e: any) {
        return { ok: false, error: e?.message ?? String(e) }
      }
    }
  )

  // 取消下载
  ipcMain.handle(IPC.DATA_CANCEL, (_e, jobId: string) => {
    const job = activeJobs.get(jobId)
    if (!job) return { ok: false, error: '任务不存在或已结束' }
    job.cancel()
    return { ok: true }
  })

  // 已下载的数据集列表
  ipcMain.handle(IPC.DATA_LIST_DATASETS, () => {
    return listDatasetsWithGroup()
  })

  // 删除数据集
  ipcMain.handle(IPC.DATA_DELETE_DATASET, (_e, id: number) => {
    deleteDatasetById(id)
    return { ok: true }
  })

  /**
   * 导出成独立 .db。
   * @param ids 传 null 表示导出全部；UI 的「导出全部」与「导出这一行」共用本接口
   */
  ipcMain.handle(IPC.DATA_EXPORT_DB, async (e, args?: { ids?: number[] | null }) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return { ok: false, error: '窗口不可用' }

    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    const many = !args?.ids || args.ids.length === 0
    const saved = await dialog.showSaveDialog(win, {
      title: '导出 K 线数据',
      defaultPath: many ? `traderrewind-kline-${stamp}.db` : `traderrewind-kline-${stamp}.db`,
      filters: [{ name: 'SQLite 数据库', extensions: ['db'] }]
    })
    if (saved.canceled || !saved.filePath) return { ok: false, canceled: true }

    try {
      const result = exportKlineDb(args?.ids ?? null, saved.filePath, app.getVersion())
      const bytes = statSync(saved.filePath).size
      console.log(
        `[导出] ${result.datasets} 个数据集 / ${result.bars} 根 K 线 → ${saved.filePath}（${bytes} 字节）`
      )
      // bytes 以磁盘上的实际文件大小为准（result.bytes 只是占位）
      return { ...result, ok: true, path: saved.filePath, bytes }
    } catch (err: any) {
      console.error('[导出] 失败:', err)
      return { ok: false, error: err?.message ?? String(err) }
    }
  })

  // 从 .db 导入（支持一次选多个文件）
  ipcMain.handle(IPC.DATA_IMPORT_DB, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return { ok: false, error: '窗口不可用' }

    const picked = await dialog.showOpenDialog(win, {
      title: '导入 K 线数据',
      filters: [{ name: 'SQLite 数据库', extensions: ['db', 'sqlite', 'sqlite3'] }],
      properties: ['openFile', 'multiSelections']
    })
    if (picked.canceled || picked.filePaths.length === 0) return { ok: false, canceled: true }

    const added: string[] = []
    const failures: string[] = []
    let merged = 0
    let bars = 0

    for (const file of picked.filePaths) {
      try {
        const r = importKlineDb(file)
        merged += r.merged
        bars += r.bars
        if (r.added > 0) added.push(...Array(r.added).fill(fileNameOf(file)))
        if (r.skipped.length > 0) failures.push(...r.skipped)
        console.log(`[导入] ${file}: 新增 ${r.added} / 合并 ${r.merged} / ${r.bars} 根 K 线`)
      } catch (err: any) {
        console.error('[导入] 失败:', file, err)
        failures.push(`${fileNameOf(file)}：${err?.message ?? err}`)
      }
    }

    return {
      ok: failures.length === 0,
      files: picked.filePaths.length,
      added: added.length,
      merged,
      bars,
      error: failures.length > 0 ? failures.join('；') : undefined
    }
  })

  console.log('[IPC] Data handlers registered')
}
