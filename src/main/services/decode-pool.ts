// ============================================================
// TraderRewind — bi5 解码线程池
//
// 为什么需要：
//   单个 bi5 文件纯 JS 解压约 19ms，一次 90 天 × 1 分钟的下载有 6000+ 文件，
//   相当于两分多钟的主线程纯 CPU 占用。主线程被占满时 IPC 进度推送、窗口交互
//   都会被拖慢，表现就是「下载时界面卡」。这里把解压 + 聚合丢到 worker 线程。
//
// 容错：worker 启动失败（打包路径异常等）时自动退化为主线程内联解码，功能不受影响。
// ============================================================

import { Worker } from 'node:worker_threads'
import { cpus } from 'node:os'
import { join } from 'node:path'
import { aggregateBars, unpackBars, type BarAccum } from './bi5'
import { decompressLzma } from '../utils/lzma'

interface PendingTask {
  resolve: (bars: BarAccum[]) => void
  reject: (e: Error) => void
}

interface WorkerSlot {
  worker: Worker
  busy: boolean
}

interface QueuedJob {
  payload: { id: number; data: Uint8Array; scale: number; baseMs: number; tfSec: number }
  transfer: ArrayBuffer[]
  task: PendingTask
}

export class Bi5DecodePool {
  private slots: WorkerSlot[] = []
  private queue: QueuedJob[] = []
  private pending = new Map<number, PendingTask>()
  private seq = 0
  private destroyed = false
  private usable = true

  readonly size: number

  constructor(size?: number) {
    const cpuCount = (() => {
      try {
        return cpus().length || 4
      } catch {
        return 4
      }
    })()
    this.size = Math.max(1, Math.min(8, size ?? cpuCount - 1))

    if (process.env.TR_NO_WORKER === '1') {
      this.usable = false
      return
    }

    try {
      for (let i = 0; i < this.size; i++) this.spawn()
      console.log(`[bi5-pool] 已启动 ${this.size} 个解码线程（主线程只做合并）`)
    } catch (e) {
      console.warn('[bi5-pool] worker 启动失败，退化为主线程解码：', e)
      this.usable = false
      this.slots = []
    }
  }

  private spawn(): void {
    const workerPath = join(__dirname, 'bi5-decode.worker.js')
    const worker = new Worker(workerPath)
    const slot: WorkerSlot = { worker, busy: false }

    worker.on('message', (msg: { id: number; bars?: Float64Array; error?: string }) => {
      slot.busy = false
      const task = this.pending.get(msg.id)
      if (task) {
        this.pending.delete(msg.id)
        if (msg.error) task.reject(new Error(msg.error))
        else task.resolve(msg.bars ? unpackBars(msg.bars) : [])
      }
      this.pump()
    })

    worker.on('error', (e) => {
      console.error('[bi5-pool] worker 运行异常：', e)
      slot.busy = false
      this.pump()
    })

    worker.unref?.()
    this.slots.push(slot)
  }

  private pump(): void {
    if (this.destroyed) return
    for (const slot of this.slots) {
      if (slot.busy) continue
      const job = this.queue.shift()
      if (!job) return
      slot.busy = true
      try {
        slot.worker.postMessage(job.payload, job.transfer)
      } catch (e) {
        slot.busy = false
        job.task.reject(e instanceof Error ? e : new Error(String(e)))
      }
    }
  }

  /** 解码一个 bi5 文件并返回该文件的 K 线 */
  async decode(
    compressed: Buffer,
    scale: number,
    baseMs: number,
    tfSec: number
  ): Promise<BarAccum[]> {
    if (!this.usable || this.destroyed) {
      const raw = await decompressLzma(compressed)
      return aggregateBars(raw, scale, baseMs, tfSec)
    }

    const data = new Uint8Array(compressed)
    return new Promise<BarAccum[]>((resolve, reject) => {
      const id = ++this.seq
      const task: PendingTask = { resolve, reject }
      this.pending.set(id, task)
      this.queue.push({
        payload: { id, data, scale, baseMs, tfSec },
        transfer: [data.buffer as ArrayBuffer],
        task
      })
      this.pump()
    })
  }

  async destroy(): Promise<void> {
    this.destroyed = true
    this.queue = []
    for (const task of this.pending.values()) {
      task.reject(new Error('pool destroyed'))
    }
    this.pending.clear()
    await Promise.all(
      this.slots.map((s) => s.worker.terminate().catch(() => undefined))
    )
    this.slots = []
  }
}
