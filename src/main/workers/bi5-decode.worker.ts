// ============================================================
// TraderRewind — bi5 解码 Worker
// 把 LZMA 解压与 tick 聚合从主线程挪到独立线程，避免主进程事件循环被占满
// ============================================================

import { parentPort } from 'node:worker_threads'
import { decompressLzma } from '../utils/lzma'
import { aggregateBars, packBars } from '../services/bi5'

interface DecodeRequest {
  id: number
  data: Uint8Array
  scale: number
  baseMs: number
  tfSec: number
}

interface DecodeResponse {
  id: number
  bars?: Float64Array
  error?: string
}

if (!parentPort) {
  throw new Error('bi5-decode.worker 必须在 worker 线程中运行')
}

const port = parentPort

port.on('message', (msg: DecodeRequest) => {
  void (async () => {
    try {
      const buffer = Buffer.from(msg.data.buffer, msg.data.byteOffset, msg.data.byteLength)
      const raw = await decompressLzma(buffer)
      const bars = aggregateBars(raw, msg.scale, msg.baseMs, msg.tfSec)
      const packed = packBars(bars)
      const response: DecodeResponse = { id: msg.id, bars: packed }
      port.postMessage(response, [packed.buffer as ArrayBuffer])
    } catch (e: any) {
      const response: DecodeResponse = { id: msg.id, error: e?.message ?? String(e) }
      port.postMessage(response)
    }
  })()
})
