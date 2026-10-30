// ============================================================
// TraderRewind — 数据源 / 下载 IPC 处理器
// ============================================================

import { ipcMain, BrowserWindow } from 'electron'
import { IPC } from '@shared/constants/ipc'
import { DATA_SOURCES } from '@shared/constants/catalog'
import type { DownloadRequest, DownloadSnapshot, DownloadStartResult } from '@shared/types/download'
import { DukascopyJob } from '../services/dukascopy'
import { CandleJob, isCandleSource } from '../services/candle-api'
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

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload)
    }
  }
}

export function registerDataHandlers(): void {
  // 目录：可用数据源与品种
  ipcMain.handle(IPC.DATA_LIST_CATALOG, () => {
    return DATA_SOURCES
  })

  // 启动下载
  ipcMain.handle(
    IPC.DATA_DOWNLOAD,
    (_e, request: DownloadRequest): DownloadStartResult => {
      try {
        if (!request || !Array.isArray(request.symbols) || request.symbols.length === 0) {
          return { ok: false, error: '请至少选择一个品种' }
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

        const job: RunningJob = isCandleSource(request.source)
          ? new CandleJob(normalized, { onSnapshot, onFinished })
          : new DukascopyJob(normalized, { onSnapshot, onFinished })

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
