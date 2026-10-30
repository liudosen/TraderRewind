// ============================================================
// TraderRewind — bi5 解析与聚合（主进程 / Worker 共用）
//
// 记录格式（20 字节，全部大端序）：
//   int32  timeOffsetMs   相对该小时起点的毫秒偏移
//   uint32 ask            价格 × 10^digits
//   uint32 bid
//   float32 askVolume
//   float32 bidVolume
// ============================================================

export const RECORD_SIZE = 20

/** 单根 K 线的累加状态；openTs/closeTs 用于跨文件合并时判断先后 */
export interface BarAccum {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
  openTs: number
  closeTs: number
}

/** Float64 序列化时每条记录的字段数 */
export const BAR_FIELDS = 8

/**
 * 把解压后的 tick 流按周期聚合成 K 线
 * @param raw    解压后的二进制
 * @param scale  价格除数（10^digits）
 * @param baseMs 该小时起点的绝对毫秒时间戳
 * @param tfSec  周期秒数
 */
export function aggregateBars(
  raw: Buffer,
  scale: number,
  baseMs: number,
  tfSec: number
): BarAccum[] {
  if (raw.length < RECORD_SIZE) return []

  const bars = new Map<number, BarAccum>()
  const limit = raw.length - RECORD_SIZE

  for (let off = 0; off <= limit; off += RECORD_SIZE) {
    const timeOffset = raw.readInt32BE(off)
    const ask = raw.readUInt32BE(off + 4)
    const bid = raw.readUInt32BE(off + 8)

    if (bid === 0 && ask === 0) continue

    const bidPrice = bid / scale
    const askPrice = ask / scale
    const askVol = raw.readFloatBE(off + 12)
    const bidVol = raw.readFloatBE(off + 16)
    const volume = (Number.isFinite(askVol) ? askVol : 0) + (Number.isFinite(bidVol) ? bidVol : 0)

    const timeMs = baseMs + timeOffset
    const bucket = Math.floor(timeMs / 1000 / tfSec) * tfSec

    const bar = bars.get(bucket)
    if (!bar) {
      bars.set(bucket, {
        time: bucket,
        open: bidPrice,
        high: Math.max(bidPrice, askPrice),
        low: Math.min(bidPrice, askPrice),
        close: bidPrice,
        volume,
        openTs: timeMs,
        closeTs: timeMs
      })
      continue
    }

    const hi = Math.max(bidPrice, askPrice)
    const lo = Math.min(bidPrice, askPrice)
    if (hi > bar.high) bar.high = hi
    if (lo < bar.low) bar.low = lo
    if (timeMs < bar.openTs) {
      bar.openTs = timeMs
      bar.open = bidPrice
    }
    if (timeMs >= bar.closeTs) {
      bar.closeTs = timeMs
      bar.close = bidPrice
    }
    bar.volume += volume
  }

  return [...bars.values()]
}

/** 合并一批 K 线到目标 Map（跨小时文件合并同一时间桶） */
export function mergeBars(target: Map<number, BarAccum>, incoming: BarAccum[]): void {
  for (const inc of incoming) {
    const exist = target.get(inc.time)
    if (!exist) {
      target.set(inc.time, inc)
      continue
    }
    if (inc.high > exist.high) exist.high = inc.high
    if (inc.low < exist.low) exist.low = inc.low
    if (inc.openTs < exist.openTs) {
      exist.openTs = inc.openTs
      exist.open = inc.open
    }
    if (inc.closeTs >= exist.closeTs) {
      exist.closeTs = inc.closeTs
      exist.close = inc.close
    }
    exist.volume += inc.volume
  }
}

/** 把 K 线数组打包成可转移的 Float64Array */
export function packBars(bars: BarAccum[]): Float64Array {
  const out = new Float64Array(bars.length * BAR_FIELDS)
  bars.forEach((b, i) => {
    const o = i * BAR_FIELDS
    out[o] = b.time
    out[o + 1] = b.open
    out[o + 2] = b.high
    out[o + 3] = b.low
    out[o + 4] = b.close
    out[o + 5] = b.volume
    out[o + 6] = b.openTs
    out[o + 7] = b.closeTs
  })
  return out
}

/** 解包 */
export function unpackBars(packed: Float64Array): BarAccum[] {
  const count = Math.floor(packed.length / BAR_FIELDS)
  const bars: BarAccum[] = new Array(count)
  for (let i = 0; i < count; i++) {
    const o = i * BAR_FIELDS
    bars[i] = {
      time: packed[o],
      open: packed[o + 1],
      high: packed[o + 2],
      low: packed[o + 3],
      close: packed[o + 4],
      volume: packed[o + 5],
      openTs: packed[o + 6],
      closeTs: packed[o + 7]
    }
  }
  return bars
}
