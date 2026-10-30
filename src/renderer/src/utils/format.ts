// ============================================================
// TraderRewind — 展示格式化工具
// ============================================================

/** 字节数 → 人类可读 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(digits)} ${units[i]}`
}

/** 字节/秒 → 人类可读速度 */
export function formatSpeed(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '0 B/s'
  return `${formatBytes(bytesPerSec)}/s`
}

/** 毫秒 → 时长文案（带语言：英文用短单位 m/s/h，中文用「分/秒/时」） */
export function formatDuration(
  ms: number | null | undefined,
  locale: 'zh' | 'en' = 'zh'
): string {
  const en = locale === 'en'
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return '--'
  if (ms < 1000) return en ? '<1s' : '<1 秒'
  const totalSec = Math.round(ms / 1000)
  if (totalSec < 60) return en ? `${totalSec}s` : `${totalSec} 秒`
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  if (min < 60) return en
    ? sec > 0
      ? `${min}m ${sec}s`
      : `${min}m`
    : sec > 0
      ? `${min} 分 ${sec} 秒`
      : `${min} 分`
  const hour = Math.floor(min / 60)
  const restMin = min % 60
  if (en) return restMin > 0 ? `${hour}h ${restMin}m` : `${hour}h`
  return restMin > 0 ? `${hour} 时 ${restMin} 分` : `${hour} 时`
}

/**
 * 秒 → 「用时」文案：只给一个数 + 一个单位，按实际大小换算，最大只到「小时」（不出「天」）。
 *
 *   不到 1 分钟 → 不到 1 分钟
 *   < 60 分钟   → X 分钟（凑满 60 分进位成小时，不出现「60 分钟」）
 *   ≥ 1 小时    → X.X 小时（整数去掉小数）
 *
 * 没有记录（0 / null）返回「未记录」：历史回测集没统计过用时，显示 0 分钟会像是坏了。
 */
export function formatSpentTime(
  seconds: number | null | undefined,
  locale: 'zh' | 'en' = 'zh'
): string {
  const en = locale === 'en'
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0)
    return en ? 'Not recorded' : '未记录'
  const s = Math.floor(seconds)
  if (s < 60) return en ? 'Less than a minute' : '不到 1 分钟'
  const mins = Math.round(s / 60)
  if (mins < 60) return en ? `${mins} min` : `${mins} 分钟`
  const h = s / 3600
  const text = h >= 100 ? String(Math.round(h)) : h.toFixed(1).replace(/\.0$/, '')
  return en ? `${text} h` : `${text} 小时`
}

/** 时间戳（秒）→ YYYY-MM-DD */
export function formatDate(ts: number): string {
  const d = new Date(ts * 1000)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 时间戳（秒）→ YYYY-MM-DD HH:mm */
export function formatDateTime(ts: number): string {
  const d = new Date(ts * 1000)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${formatDate(ts)} ${hh}:${mm}`
}

/** 数字千分位 */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '0'
  return n.toLocaleString('en-US')
}

/** 按品种小数位格式化价格 */
export function formatPrice(price: number | null | undefined, digits: number): string {
  if (price == null || !Number.isFinite(price)) return '--'
  return price.toFixed(digits)
}

/** 带正负号的金额 */
export function formatSigned(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '--'
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toFixed(digits)}`
}

/** 今天（本地）YYYY-MM-DD */
export function todayISO(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 相对今天偏移若干天（本地）YYYY-MM-DD */
export function dateOffsetISO(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
