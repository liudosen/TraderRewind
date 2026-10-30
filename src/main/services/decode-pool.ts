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
  /** 该线程正在处理的任务 id —— 线程挂掉时靠它把对应的 await reject 掉 */
  taskId?: number
  /** 单任务看门狗：线程既不报错也不返回（卡死）时兜底 */
  watchdog?: ReturnType<typeof setTimeout>
  /**
   * 已经宣布报废。
   * failSlot 里会 terminate()，而 terminate 又会触发一次 'exit'，
   * 没有这个标记就会「exit → failSlot → terminate → exit …」无限重建线程。
   */
  dead?: boolean
}

interface QueuedJob {
  payload: { id: number; data: Uint8Array; scale: number; baseMs: number; tfSec: number }
  transfer: ArrayBuffer[]
  task: PendingTask
}

/**
 * 单个文件的解码上限。
 * 正常一小时 tick 数据解压只要几十毫秒，给到 60 秒只可能是线程卡死或内存打满。
 * 没有这个上限的话，一个卡住的任务会让整个下载停在中途的百分比上再也不动。
 */
const DECODE_TIMEOUT_MS = 60_000

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
      slot.taskId = undefined
      this.clearWatchdog(slot)
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
      this.failSlot(slot, e instanceof Error ? e : new Error(String(e)))
    })

    /**
     * 线程退出必须单独处理。
     * 只挂 'error' 是不够的：worker 被 OOM 杀掉、或 LZMA 解压把栈打穿时，
     * 走到的是 'exit' 而不是 'error'。以前这里没人管，那个 slot 的 busy 永远是 true，
     * 它手上那个 await 也永远不返回 —— 于是整个下载停在 93% 一动不动，
     * CPU 归零、一条连接都没有，看着像「卡住」，其实是永远不会结束。
     */
    worker.on('exit', (code) => {
      if (this.destroyed) return
      this.failSlot(slot, new Error(`解码线程退出（code ${code}）`))
    })

    worker.unref?.()
    this.slots.push(slot)
  }

  private clearWatchdog(slot: WorkerSlot): void {
    if (slot.watchdog) {
      clearTimeout(slot.watchdog)
      slot.watchdog = undefined
    }
  }

  /**
   * 一个线程不可用了（报错 / 退出 / 超时）：把它手上的任务 reject 掉，
   * 然后把线程换掉，别让池子容量越跑越小。
   */
  private failSlot(slot: WorkerSlot, err: Error): void {
    // 一个线程可能先报 error 再报 exit，也可能被自己的 terminate 再触发一次 exit
    if (slot.dead) return
    slot.dead = true

    const id = slot.taskId
    slot.busy = false
    slot.taskId = undefined
    this.clearWatchdog(slot)

    if (id != null) {
      const task = this.pending.get(id)
      if (task) {
        this.pending.delete(id)
        task.reject(err)
      }
    }

    if (this.destroyed) return
    this.slots = this.slots.filter((s) => s !== slot)
    void slot.worker.terminate().catch(() => undefined)

    try {
      this.spawn()
    } catch (e) {
      // 连线程都重建不出来：只能退回主线程解码，保住功能
      console.warn('[bi5-pool] 重建解码线程失败，退化为主线程解码：', e)
      this.usable = false
      this.drainInline()
      return
    }
    this.pump()
  }

  /** 池子彻底不可用时，把排队的任务搬到主线程做完 */
  private drainInline(): void {
    const queued = this.queue
    this.queue = []
    for (const job of queued) {
      const { data, scale, baseMs, tfSec } = job.payload
      decompressLzma(Buffer.from(data))
        .then((raw) => {
          job.task.resolve(aggregateBars(raw, scale, baseMs, tfSec))
        })
        .catch((e) => job.task.reject(e instanceof Error ? e : new Error(String(e))))
    }
  }

  private pump(): void {
    if (this.destroyed) return
    for (const slot of this.slots) {
      if (slot.busy) continue
      const job = this.queue.shift()
      if (!job) return
      slot.busy = true
      slot.taskId = job.payload.id
      // 看门狗只管「已经派给线程」的任务：排队等待是池子吞吐问题，不该算超时
      slot.watchdog = setTimeout(() => {
        this.failSlot(slot, new Error('解码超时（60 秒）'))
      }, DECODE_TIMEOUT_MS)
      try {
        slot.worker.postMessage(job.payload, job.transfer)
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e))
        slot.busy = false
        slot.taskId = undefined
        this.clearWatchdog(slot)
        job.task.reject(err)
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
    for (const slot of this.slots) this.clearWatchdog(slot)
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
