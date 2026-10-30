// ============================================================
// TraderRewind — 周期定义与 K 线聚合
// 统一以 1 分钟数据为源，向上聚合出更大周期，保证各周期口径一致
// 支持标准周期 + 自定义分钟周期（C{n}）
// ============================================================

export interface Bar {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface TimeframeOption {
  /** 周期标识，如 M5 / D1 / C7 */
  id: string
  /** 工具栏展示的短代码 */
  code: string
  /** 可读名称 */
  name: string
  /** 周期秒数；日历类周期（W1/MN1/Q1/Y1）为 0 */
  seconds: number
}

export const BASE_TIMEFRAMES: TimeframeOption[] = [
  { id: 'M1', code: 'M1', name: '1 分钟', seconds: 60 },
  { id: 'M5', code: 'M5', name: '5 分钟', seconds: 300 },
  { id: 'M15', code: 'M15', name: '15 分钟', seconds: 900 },
  { id: 'M30', code: 'M30', name: '30 分钟', seconds: 1800 },
  { id: 'H1', code: 'H1', name: '1 小时', seconds: 3600 },
  { id: 'H4', code: 'H4', name: '4 小时', seconds: 14400 },
  { id: 'D1', code: 'D1', name: '日线', seconds: 86400 },
  { id: 'W1', code: 'W1', name: '周线', seconds: 0 },
  { id: 'MN1', code: 'MN1', name: '月线', seconds: 0 },
  { id: 'Q1', code: 'Q1', name: '季线', seconds: 0 },
  { id: 'Y1', code: 'Y1', name: '年线', seconds: 0 }
]

/** 工具栏默认显示的周期 */
export const DEFAULT_TOOLBAR_TIMEFRAMES = ['M1', 'M5', 'M15', 'H1', 'H4', 'D1']

const BASE_MAP = new Map(BASE_TIMEFRAMES.map((t) => [t.id, t]))

/** 自定义周期：C7 表示 7 分钟（上限一周 = C10080） */
const CUSTOM_RE = /^C(\d{1,5})$/

/** 是否为合法周期标识 */
export function isChartTimeframe(id: unknown): id is string {
  if (typeof id !== 'string') return false
  if (BASE_MAP.has(id)) return true
  const m = CUSTOM_RE.exec(id)
  return m != null && Number(m[1]) > 0
}

/** 周期的秒数；非法返回 0 */
export function timeframeSeconds(id: string): number {
  const base = BASE_MAP.get(id)
  if (base) return base.seconds
  const m = CUSTOM_RE.exec(id)
  if (m) return Number(m[1]) * 60
  return 0
}

/**
 * 自定义周期的展示单位，按「从大到小」排列
 * 取第一个能整除用户输入的分钟数的单位，除不尽就退回分钟
 */
const CUSTOM_UNITS: ReadonlyArray<{ minutes: number; code: string; name: string }> = [
  { minutes: 10080, code: 'W', name: '周' },
  { minutes: 1440, code: 'D', name: '天' },
  { minutes: 60, code: 'H', name: '小时' },
  { minutes: 1, code: 'M', name: '分钟' }
]

/**
 * 把自定义分钟数换算成展示标签：单位大写字母在前的短代码 + 可读名称。
 * 规则（优先大单位，且必须整除）：
 *   10080 → W1（1 周）、1440 → D1（1 天）、2880 → D2（2 天）
 *   120 → H2（2 小时）、90 → M90（除不尽 60，退回分钟）、7 → M7
 */
export function customTimeframeLabel(minutes: number): { code: string; name: string } {
  const n = Math.floor(minutes)
  if (!Number.isFinite(n) || n <= 0) return { code: '', name: '' }
  for (const u of CUSTOM_UNITS) {
    if (n % u.minutes === 0) {
      const count = n / u.minutes
      return { code: `${u.code}${count}`, name: `${count} ${u.name}` }
    }
  }
  return { code: `M${n}`, name: `${n} 分钟` }
}

/** 周期的展示代码 */
export function timeframeCode(id: string): string {
  const base = BASE_MAP.get(id)
  if (base) return base.code
  const m = CUSTOM_RE.exec(id)
  if (m) return customTimeframeLabel(Number(m[1])).code || id
  return id
}

/** 周期的可读名称 */
export function timeframeName(id: string): string {
  const base = BASE_MAP.get(id)
  if (base) return base.name
  const m = CUSTOM_RE.exec(id)
  if (m) return customTimeframeLabel(Number(m[1])).name || id
  return id
}

// ---------- 公历换算（避免逐条 new Date，30 万根也很快） ----------

function daysFromCivil(y: number, m: number, d: number): number {
  const yy = y - (m <= 2 ? 1 : 0)
  const era = Math.floor(yy / 400)
  const yoe = yy - era * 400
  const mp = m + (m > 2 ? -3 : 9)
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy
  return era * 146097 + doe - 719468
}

function civilFromDays(z: number): { y: number; m: number; d: number } {
  const zz = z + 719468
  const era = Math.floor(zz / 146097)
  const doe = zz - era * 146097
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365
  )
  const y = yoe + era * 400
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100))
  const mp = Math.floor((5 * doy + 2) / 153)
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1
  const m = mp + (mp < 10 ? 3 : -9)
  return { y: y + (m <= 2 ? 1 : 0), m, d }
}

/** 计算某时刻所属周期的起点（秒） */
export function bucketStart(timeSec: number, id: string): number {
  const secs = timeframeSeconds(id)
  if (secs > 0) {
    // 日内周期以 UTC 自然日为锚点，保证自定义间隔（如 7 分钟）不会跨日漂移
    if (secs < 86400) {
      const dayStart = Math.floor(timeSec / 86400) * 86400
      return dayStart + Math.floor((timeSec - dayStart) / secs) * secs
    }
    if (secs % 604800 === 0) {
      // 整周倍数（自定义 10080 分钟等）：与标准周线同口径，按周一起点对齐
      const day = Math.floor(timeSec / 86400)
      const dowMon = ((((day % 7) + 7) % 7) + 3) % 7
      const weeks = secs / 604800
      // 1970-01-05 是周一（day 4），以它为基准按整周分组
      const k = Math.floor((day - dowMon - 4) / (7 * weeks))
      return (4 + k * 7 * weeks) * 86400
    }
    return Math.floor(timeSec / secs) * secs
  }

  const days = Math.floor(timeSec / 86400)
  const { y, m } = civilFromDays(days)

  if (id === 'W1') {
    // 1970-01-01 是周四，+3 后使周一为 0
    const dowMon = ((((days % 7) + 7) % 7) + 3) % 7
    return (days - dowMon) * 86400
  }
  if (id === 'MN1') return daysFromCivil(y, m, 1) * 86400
  if (id === 'Q1') {
    const qStartMonth = Math.floor((m - 1) / 3) * 3 + 1
    return daysFromCivil(y, qStartMonth, 1) * 86400
  }
  return daysFromCivil(y, 1, 1) * 86400
}

/**
 * 把 1 分钟 K 线聚合为目标周期
 * 入参需按时间升序
 */
export function aggregateBars(bars: Bar[], id: string): Bar[] {
  if (bars.length === 0) return []
  if (id === 'M1') return bars
  if (!isChartTimeframe(id)) return bars

  const out: Bar[] = []
  let cur: Bar | null = null

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]
    const bucket = bucketStart(b.time, id)

    if (!cur || cur.time !== bucket) {
      if (cur) out.push(cur)
      cur = {
        time: bucket,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume
      }
      continue
    }

    if (b.high > cur.high) cur.high = b.high
    if (b.low < cur.low) cur.low = b.low
    cur.close = b.close
    cur.volume += b.volume
  }

  if (cur) out.push(cur)
  return out
}

/**
 * 某一根「还没走完」的 K 线。
 *
 * 回放停在 13:45、显示周期是 H1 时，13:00 那根 H1 只能算到 13:45 ——
 * 收盘价是 13:45 的价格，最高/最低也只统计已揭示的那几分钟。
 * 拿整根 H1（含 13:46–13:59）去画，等于把还没走到的行情提前摊在图上。
 *
 * @param raw     源数据（始终是 1 分钟 K 线，按时间升序）
 * @param id      显示周期
 * @param cutTime 已揭示到的时刻（含）= 最后一根已揭示的 1 分钟 K 线时间
 * @returns 截断后的 K 线；桶已经走完（或该周期没有「未完成」概念）时返回 null
 */
export function partialBucketBar(raw: Bar[], id: string, cutTime: number): Bar | null {
  if (raw.length === 0 || id === 'M1' || !isChartTimeframe(id)) return null
  const bucket = bucketStart(cutTime, id)

  // 二分找这个桶里的第一根原始 K 线
  let lo = 0
  let hi = raw.length - 1
  let first = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (raw[mid].time >= bucket) {
      first = mid
      hi = mid - 1
    } else {
      lo = mid + 1
    }
  }
  if (first < 0 || bucketStart(raw[first].time, id) !== bucket) return null

  let out: Bar | null = null
  let i = first
  for (; i < raw.length; i++) {
    const b = raw[i]
    // 出了这个桶、或者已经越过回放位置，就停
    if (b.time > cutTime || bucketStart(b.time, id) !== bucket) break
    if (!out) out = { ...b }
    else {
      if (b.high > out.high) out.high = b.high
      if (b.low < out.low) out.low = b.low
      out.close = b.close
      out.volume += b.volume
    }
  }
  if (!out) return null

  // 桶里还有没揭示的 K 线 → 这根确实没走完，必须用截断版；否则就是完整的，别动它
  const next = raw[i]
  return next && bucketStart(next.time, id) === bucket ? out : null
}

/** 找到时间 <= target 的最后一根 K 线下标；找不到返回 0 */
export function indexAtTime(bars: Bar[], target: number): number {
  if (bars.length === 0) return 0
  let lo = 0
  let hi = bars.length - 1
  let ans = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (bars[mid].time <= target) {
      ans = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return ans
}
