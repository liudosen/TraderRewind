// ============================================================
// TraderRewind — 图表外观主题
// ============================================================

/** lightweight-charts 的 LineStyle：0 实线 / 1 点线 / 2 虚线 / 3 长虚线 / 4 稀疏点线 */
export type CrosshairStyle = 0 | 1 | 2 | 3 | 4

export interface ChartTheme {
  /** 上涨颜色 */
  upColor: string
  /** 下跌颜色 */
  downColor: string
  /** 图表背景 */
  background: string
  /** 坐标轴文字 */
  textColor: string
  /** 网格线 */
  gridVisible: boolean
  gridColor: string
  /** 十字线 */
  crosshairColor: string
  crosshairStyle: CrosshairStyle
  crosshairWidth: 1 | 2
  crosshairLabels: boolean
  /** 十字线是否吸附到最近 K 线（默认跟随鼠标自由移动） */
  crosshairMagnet: boolean
  /** K 线细节 */
  showWick: boolean
  showBorder: boolean
}

/** 默认主题：白涨灰跌 + 无网格（用户调好的这套作为出厂默认） */
export const DEFAULT_CHART_THEME: ChartTheme = {
  upColor: '#ffffff',
  downColor: '#757575',
  background: '#0b0b0b',
  textColor: '#8b8b8b',
  gridVisible: false,
  gridColor: 'rgba(255,255,255,0.05)',
  crosshairColor: 'rgba(255,255,255,0.25)',
  crosshairStyle: 3,
  crosshairWidth: 1,
  crosshairLabels: true,
  crosshairMagnet: false,
  showWick: true,
  showBorder: true
}

/** 预设配色 */
export const THEME_PRESETS: { id: string; label: string; patch: Partial<ChartTheme> }[] = [
  {
    id: 'mono-default',
    label: '白灰涨跌（默认）',
    patch: { upColor: '#ffffff', downColor: '#757575', gridVisible: false }
  },
  {
    id: 'red-up',
    label: '红涨绿跌（中国习惯）',
    patch: { upColor: '#ef4444', downColor: '#22c55e' }
  },
  {
    id: 'green-up',
    label: '绿涨红跌（欧美习惯）',
    patch: { upColor: '#22c55e', downColor: '#ef4444' }
  },
  {
    id: 'light',
    label: '浅色背景',
    patch: { background: '#ffffff', textColor: '#334155', gridColor: 'rgba(0,0,0,0.06)' }
  },
  {
    id: 'dark',
    label: '深色背景',
    patch: { background: '#0b0b0b', textColor: '#8b8b8b', gridColor: 'rgba(255,255,255,0.05)' }
  }
]

export const CROSSHAIR_STYLES: { value: CrosshairStyle; label: string }[] = [
  { value: 0, label: '实线' },
  { value: 1, label: '点线' },
  { value: 2, label: '虚线' },
  { value: 3, label: '长虚线' },
  { value: 4, label: '稀疏点线' }
]

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i
const RGBA_RE = /^rgba?\([\d\s.,%]+\)$/i

/** 颜色是否合法（#hex 或 rgb(a)） */
export function isValidColor(v: unknown): v is string {
  return typeof v === 'string' && (HEX_RE.test(v) || RGBA_RE.test(v))
}

/** 合并并校验主题，非法字段回退默认值 */
export function normalizeTheme(input: unknown): ChartTheme {
  const base = { ...DEFAULT_CHART_THEME }
  if (!input || typeof input !== 'object') return base
  const raw = input as Record<string, unknown>
  const out = { ...base }

  for (const key of ['upColor', 'downColor', 'background', 'textColor', 'gridColor', 'crosshairColor'] as const) {
    if (isValidColor(raw[key])) out[key] = raw[key] as string
  }
  if (typeof raw.gridVisible === 'boolean') out.gridVisible = raw.gridVisible
  if (typeof raw.crosshairLabels === 'boolean') out.crosshairLabels = raw.crosshairLabels
  if (typeof raw.crosshairMagnet === 'boolean') out.crosshairMagnet = raw.crosshairMagnet
  if (typeof raw.showWick === 'boolean') out.showWick = raw.showWick
  if (typeof raw.showBorder === 'boolean') out.showBorder = raw.showBorder
  if (typeof raw.crosshairWidth === 'number' && (raw.crosshairWidth === 1 || raw.crosshairWidth === 2)) {
    out.crosshairWidth = raw.crosshairWidth
  }
  if (
    typeof raw.crosshairStyle === 'number' &&
    raw.crosshairStyle >= 0 &&
    raw.crosshairStyle <= 4
  ) {
    out.crosshairStyle = raw.crosshairStyle as CrosshairStyle
  }
  return out
}
