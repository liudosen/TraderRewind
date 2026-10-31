// ============================================================
// TraderRewind — 数据源 / 下载 IPC 处理器
// ============================================================

import { ipcMain, BrowserWindow } from 'electron'
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
import { sharedCtraderClient } from '../services/ctrader-mcp'
import { listDatasetsWithGroup, deleteDatasetById } from '../db/dataset-repo'

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

async function getCtraderInstruments(): Promise<InstrumentInfo[]> {
  const now = Date.now()
  if (ctraderSymbolCache && now - ctraderSymbolCache.at < 60_000) {
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
  } catch {
    // cTrader 没开 / session 被占用：保留上一次的结果或交给调用方回退
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
  ipcMain.handle(IPC.DATA_LIST_CATALOG, async () => {
    const list = DATA_SOURCES.map((s) => ({ ...s, instruments: [...s.instruments] }))
    const ct = list.find((s) => s.id === 'ctrader')
    if (ct) {
      const live = await getCtraderInstruments()
      if (live.length > 0) ct.instruments = live
    }
    return list
  })

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

  console.log('[IPC] Data handlers registered')
}
