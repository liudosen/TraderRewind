// ============================================================
// TraderRewind — 日期区间工具
// ============================================================

export interface Ymd {
  y: number
  m: number
  d: number
}

/** 解析 YYYY-MM-DD，返回 UTC 日历分量；非法返回 null */
export function parseYmd(input: string): Ymd | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.trim())
  if (!match) return null
  const y = Number(match[1])
  const m = Number(match[2])
  const d = Number(match[3])
  if (m < 1 || m > 12 || d < 1 || d > 31) return null
  const probe = new Date(Date.UTC(y, m - 1, d))
  if (probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null
  return { y, m, d }
}

/**
 * 估算需要下载的小时文件数量
 * 规则与下载器一致：周一至周五 24 小时，周日 21-23 点，周六跳过
 */
export function estimateHourFiles(from: Ymd, to: Ymd): number {
  const start = Date.UTC(from.y, from.m - 1, from.d)
  const end = Date.UTC(to.y, to.m - 1, to.d)
  if (end < start) return 0
  const DAY = 86400_000
  let count = 0
  for (let ts = start; ts <= end; ts += DAY) {
    const dow = new Date(ts).getUTCDay()
    if (dow === 6) continue
    count += dow === 0 ? 3 : 24
  }
  return count
}

/** 区间内的天数（含首尾） */
export function inclusiveDays(from: Ymd, to: Ymd): number {
  const start = Date.UTC(from.y, from.m - 1, from.d)
  const end = Date.UTC(to.y, to.m - 1, to.d)
  if (end < start) return 0
  return Math.floor((end - start) / 86400_000) + 1
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** 枚举区间内所有日期（YYYY-MM-DD，含首尾），最大 5000 天保护 */
export function eachDayKey(fromKey: string, toKey: string): string[] {
  const a = parseYmd(fromKey)
  const b = parseYmd(toKey)
  if (!a || !b) return []
  const start = Date.UTC(a.y, a.m - 1, a.d)
  const end = Date.UTC(b.y, b.m - 1, b.d)
  if (end < start) return []
  const out: string[] = []
  for (let t = start, guard = 0; t <= end && guard < 5000; t += 86400_000, guard++) {
    const d = new Date(t)
    out.push(`${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`)
  }
  return out
}

/** 时间戳（秒）→ 本地日历日 YYYY-MM-DD */
export function localDayKeyFromTs(ts: number): string {
  const d = new Date(ts * 1000)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}
