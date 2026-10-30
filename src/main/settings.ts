// ============================================================
// TraderRewind — 应用设置（JSON，独立于数据库）
// K 线数据目录 与 训练/回测数据目录 分开存放
// ============================================================

import { app } from 'electron'
import {
  DEFAULT_CHART_THEME,
  normalizeTheme,
  type ChartTheme
} from '@shared/types/chart-theme'
import { DEFAULT_TIMEZONE, normalizeTimezone } from '@shared/types/timezone'
import { DEFAULT_LOCALE, normalizeLocale, type Locale } from '@shared/types/locale'
import {
  DEFAULT_INDICATOR_PREFS,
  normalizeIndicatorPrefs,
  type IndicatorPrefs
} from '@shared/types/indicator-prefs'
import { DEFAULT_TAG_LIBRARY, normalizeTagLibrary } from '@shared/types/trade-tags'
import {
  DEFAULT_EXECUTION_COST,
  normalizeExecutionCost,
  type ExecutionCost
} from '@shared/types/execution-cost'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'

export interface AppSettings {
  /** K 线行情数据目录（market.db） */
  klineDir: string
  /** 训练 / 回测数据目录（training.db） */
  trainingDir: string
  /** 图表外观 */
  chartTheme: ChartTheme
  /** 全应用统一时区，默认 UTC+8；订单下单/关单时间、坐标轴、报表都按它渲染 */
  timezone: string
  /** 界面语言：只影响界面文案，数据/文件/用户输入不动 */
  locale: Locale
  /** 指标显示偏好（用户级，跨回测集统一）；默认一个都不开 */
  indicatorPrefs: IndicatorPrefs
  /** 标签库：下单备注浮窗里可一键点亮的常用标签；默认见 DEFAULT_TAG_LIBRARY */
  tradeTags: string[]
  /** 交易成本模型（手续费 + 滑点）：用户级，所有回测集共用；默认不计成本 */
  executionCost: ExecutionCost
}

export type StorageKind = 'kline' | 'training'

const FILE_NAME = 'settings.json'

function settingsFile(): string {
  return join(app.getPath('userData'), FILE_NAME)
}

function defaults(): AppSettings {
  const base = app.getPath('userData')
  return {
    klineDir: join(base, 'data', 'kline'),
    trainingDir: join(base, 'data', 'training'),
    chartTheme: { ...DEFAULT_CHART_THEME },
    timezone: DEFAULT_TIMEZONE,
    locale: DEFAULT_LOCALE,
    indicatorPrefs: { ...DEFAULT_INDICATOR_PREFS },
    tradeTags: [...DEFAULT_TAG_LIBRARY],
    executionCost: { ...DEFAULT_EXECUTION_COST }
  }
}

let cache: AppSettings | null = null

/** 规范化目录字符串，非法时回退默认值 */
function sanitizeDir(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || !value.trim()) return fallback
  try {
    return normalize(value.trim())
  } catch {
    return fallback
  }
}

export function loadSettings(): AppSettings {
  if (cache) return cache
  const file = settingsFile()
  const def = defaults()
  try {
    if (existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, 'utf-8')) as Partial<AppSettings>
      /**
       * 老版本的 settings.json 里没有 tradeTags 这个字段。
       * 那种情况要给新装的默认标签库，不能当成「用户主动清空过」——
       * 否则老用户升级上来标签栏永远是空的，还得手填一遍。
       * 只有明确存了值（哪怕是空数组，说明是点了「清空」）才照抄。
       */
      const rawTags = (raw as any).tradeTags
      cache = {
        klineDir: sanitizeDir(raw.klineDir, def.klineDir),
        trainingDir: sanitizeDir(raw.trainingDir, def.trainingDir),
        chartTheme: normalizeTheme((raw as any).chartTheme),
        timezone: normalizeTimezone((raw as any).timezone),
        locale: normalizeLocale((raw as any).locale),
        indicatorPrefs: normalizeIndicatorPrefs((raw as any).indicatorPrefs),
        tradeTags: rawTags === undefined ? [...def.tradeTags] : normalizeTagLibrary(rawTags),
        executionCost: normalizeExecutionCost((raw as any).executionCost)
      }
      return cache
    }
  } catch {
    // 损坏则回退默认
  }
  cache = def
  saveSettings(cache)
  return cache
}

export function saveSettings(next: AppSettings): void {
  cache = next
  const file = settingsFile()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(next, null, 2), 'utf-8')
}

export function updateChartTheme(theme: unknown): AppSettings {
  const current = loadSettings()
  const next: AppSettings = { ...current, chartTheme: normalizeTheme(theme) }
  saveSettings(next)
  return next
}

/** 切换全应用时区（默认 UTC+8） */
export function updateTimezone(timezone: unknown): AppSettings {
  const current = loadSettings()
  const next: AppSettings = { ...current, timezone: normalizeTimezone(timezone) }
  saveSettings(next)
  return next
}

/** 切换界面语言 */
export function updateLocale(locale: unknown): AppSettings {
  const current = loadSettings()
  const next: AppSettings = { ...current, locale: normalizeLocale(locale) }
  saveSettings(next)
  return next
}

/** 保存标签库（下单时可一键点亮的常用标签） */
export function updateTradeTags(tags: unknown): AppSettings {
  const current = loadSettings()
  const next: AppSettings = { ...current, tradeTags: normalizeTagLibrary(tags) }
  saveSettings(next)
  return next
}

/** 保存指标显示偏好（用户级，跨回测集统一） */
export function updateIndicatorPrefs(prefs: unknown): AppSettings {
  const current = loadSettings()
  const next: AppSettings = { ...current, indicatorPrefs: normalizeIndicatorPrefs(prefs) }
  saveSettings(next)
  return next
}

/** 保存交易成本模型（手续费 + 滑点），同样跨回测集统一 */
export function updateExecutionCost(cost: unknown): AppSettings {
  const current = loadSettings()
  const next: AppSettings = { ...current, executionCost: normalizeExecutionCost(cost) }
  saveSettings(next)
  return next
}

export function updateStorageDir(kind: StorageKind, dir: string): AppSettings {  const current = loadSettings()
  const next: AppSettings = {
    ...current,
    ...(kind === 'kline' ? { klineDir: dir } : { trainingDir: dir })
  }
  saveSettings(next)
  return next
}

/** 数据库文件名 */
export function dbFileName(kind: StorageKind): string {
  return kind === 'kline' ? 'market.db' : 'training.db'
}

/** 某个存储类型的完整数据库路径 */
export function dbPathFor(kind: StorageKind): string {
  const s = loadSettings()
  return join(kind === 'kline' ? s.klineDir : s.trainingDir, dbFileName(kind))
}

/** 某个存储类型对应的目录 */
export function dirFor(kind: StorageKind): string {
  const s = loadSettings()
  return kind === 'kline' ? s.klineDir : s.trainingDir
}
