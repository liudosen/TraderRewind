// ============================================================
// TraderRewind — 滑动窗口测速器
//
// 原先定义在 dukascopy.ts 里。Dukascopy 数据源下线后，K 线下载
// （candle-api）仍然要它来算进度条上的瞬时速度，所以搬到这里独立维护。
// ============================================================

/** 滑动窗口测速器 */
export class SpeedMeter {
  private samples: { t: number; bytes: number }[] = []
  private total = 0
  private windowMs = 3000

  add(bytes: number): void {
    if (bytes <= 0) return
    this.total += bytes
    const now = Date.now()
    this.samples.push({ t: now, bytes: this.total })
    this.trim(now)
  }

  private trim(now: number): void {
    const cutoff = now - this.windowMs
    while (this.samples.length > 2 && this.samples[0].t < cutoff) {
      this.samples.shift()
    }
  }

  /** 瞬时速度（字节/秒） */
  speed(): number {
    const now = Date.now()
    this.trim(now)
    if (this.samples.length < 2) return 0
    const first = this.samples[0]
    const last = this.samples[this.samples.length - 1]
    const dt = (last.t - first.t) / 1000
    if (dt <= 0.05) return 0
    return Math.max(0, (last.bytes - first.bytes) / dt)
  }

  reset(): void {
    this.samples = []
    this.total = 0
  }
}
