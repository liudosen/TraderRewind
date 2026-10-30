// ============================================================
// TraderRewind — 统一时区定义与格式化
// 全应用的「下单时间 / 关单时间 / 坐标轴时间 / 报表时间」都走这里，
// 默认 UTC+8（北京时间），用户可在设置页单独改。
// ============================================================

/** 默认时区：UTC+8 北京时间 */
export const DEFAULT_TIMEZONE = 'UTC+8'

export interface TimezoneOption {
  /** 存盘用的 id */
  id: string
  /** 界面上显示的名字 */
  label: string
  /** 相对 UTC 的分钟偏移 */
  offsetMinutes: number
}

export const TIMEZONE_OPTIONS: TimezoneOption[] = [
  { id: 'UTC+8', label: 'UTC+8 北京时间（默认）', offsetMinutes: 480 },
  { id: 'UTC+0', label: 'UTC+0 格林威治', offsetMinutes: 0 },
  { id: 'UTC+1', label: 'UTC+1 柏林', offsetMinutes: 60 },
  { id: 'UTC+3', label: 'UTC+3 莫斯科', offsetMinutes: 180 },
  { id: 'UTC+4', label: 'UTC+4 迪拜', offsetMinutes: 240 },
  { id: 'UTC-4', label: 'UTC-4 纽约（夏令时）', offsetMinutes: -240 },
  { id: 'UTC-5', label: 'UTC-5 纽约（冬令时）', offsetMinutes: -300 },
  { id: 'UTC-8', label: 'UTC-8 洛杉矶', offsetMinutes: -480 }
]

const OPTION_BY_ID = new Map(TIMEZONE_OPTIONS.map((o) => [o.id, o]))

/** 任意输入 → 合法时区 id，非法时回退 UTC+8 */
export function normalizeTimezone(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_TIMEZONE
  const id = value.trim()
  return OPTION_BY_ID.has(id) ? id : DEFAULT_TIMEZONE
}

/** 时区相对 UTC 的分钟偏移 */
export function timezoneOffsetMinutes(value: unknown): number {
  return OPTION_BY_ID.get(normalizeTimezone(value))?.offsetMinutes ?? 480
}

/** 时区展示名，例如「UTC+8」 */
export function timezoneLabel(value: unknown): string {
  return normalizeTimezone(value)
}

/** 拆好的时间片段（已按目标时区偏移） */
export interface TzParts {
  year: number
  /** 1-12 */
  month: number
  /** 1-31 */
  day: number
  hour: number
  minute: number
  second: number
}

const MINUTE = 60_000

/** 把目标时区的偏移加到时间上，之后用 getUTC* 读出来就是该时区的墙上时间 */
function shifted(ms: number, tz: unknown): Date {
  return new Date(ms + timezoneOffsetMinutes(tz) * MINUTE)
}

/** 秒级时间戳（K 线 / 订单时间）→ 目标时区时间片段 */
export function tzPartsFromSec(sec: number, tz: unknown): TzParts {
  const d = shifted(sec * 1000, tz)
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds()
  }
}

/** 毫秒级时间戳 → 目标时区时间片段 */
export function tzPartsFromMs(ms: number, tz: unknown): TzParts {
  const d = shifted(ms, tz)
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds()
  }
}

function p2(n: number): string {
  return String(n).padStart(2, '0')
}

/** YYYY-MM-DD（秒级） */
export function fmtTzDate(sec: number, tz: unknown): string {
  const t = tzPartsFromSec(sec, tz)
  return `${t.year}-${p2(t.month)}-${p2(t.day)}`
}

/** MM-DD HH:mm（秒级，订单时间默认用它） */
export function fmtTzShort(sec: number, tz: unknown): string {
  const t = tzPartsFromSec(sec, tz)
  return `${p2(t.month)}-${p2(t.day)} ${p2(t.hour)}:${p2(t.minute)}`
}

/** HH:mm（秒级） */
export function fmtTzClock(sec: number, tz: unknown): string {
  const t = tzPartsFromSec(sec, tz)
  return `${p2(t.hour)}:${p2(t.minute)}`
}

/** YYYY-MM-DD HH:mm:ss（毫秒级，会话创建等记录用） */
export function fmtTzDateTimeFromMs(ms: number, tz: unknown): string {
  const t = tzPartsFromMs(ms, tz)
  return `${t.year}-${p2(t.month)}-${p2(t.day)} ${p2(t.hour)}:${p2(t.minute)}:${p2(t.second)}`
}

/** YYYY-MM-DD HH:mm:ss（秒级） */
export function fmtTzDateTime(sec: number, tz: unknown): string {
  const t = tzPartsFromSec(sec, tz)
  return `${t.year}-${p2(t.month)}-${p2(t.day)} ${p2(t.hour)}:${p2(t.minute)}:${p2(t.second)}`
}

/**
 * 目标时区的某一天零点对应的 UTC 秒。
 * 例如 tz=UTC+8、2025-12-03 → 返回 2025-12-02T16:00:00Z 的秒。
 */
export function tzDayStartSec(
  year: number,
  month: number,
  day: number,
  tz: unknown
): number {
  return Math.floor(Date.UTC(year, month - 1, day) / 1000) - timezoneOffsetMinutes(tz) * 60
}

/** 把某个瞬间换算成「目标时区当天 00:00」的 UTC 秒 */
export function tzDayStartOfSec(sec: number, tz: unknown): number {
  const t = tzPartsFromSec(sec, tz)
  return tzDayStartSec(t.year, t.month, t.day, tz)
}
