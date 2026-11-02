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
  /** 时间轴刻度上是否带星期几（日刻度 / 日界刻度后追加「周一」这种） */
  axisWeekday: boolean
  /**
   * 右侧预留的「未来」根数。
   *
   * 图表会为这些位置补上**只有时间、没有 K 线**的点：时间轴照样能往右拖、能看见
   * 未来的日期刻度，但那段里一根蜡烛都不会画 —— 用来把趋势线 / 预测线画到未来。
   * 0 = 不许看到未来时间（旧行为）。
   */
  futureBars: number
  /**
   * 训练开始前额外加载多少个月的历史 K 线（左侧能回看多远）。
   *
   * 打开会话时会把这几个月的 1 分钟数据一起读进来再按显示周期聚合：用户一上来就能
   * 往前翻前高前低、趋势结构，指标也有足够长的预热段。这些 K 线只是背景 ——
   * 回放游标仍然从会话起点开始，前面那截永远不会被推进到，也就不可能在里边下单。
   * 0 = 只留指标预热要用的那两周（旧行为）。
   */
  historyMonths: number
}

/** 未来空白的允许范围（再多拖起来就飘了） */
export const FUTURE_BARS_MIN = 0
export const FUTURE_BARS_MAX = 600

/** 训练前历史的允许范围（月）：再多就是整库扫，打开会话会明显变慢 */
export const HISTORY_MONTHS_MIN = 0
export const HISTORY_MONTHS_MAX = 12

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
  showBorder: true,
  axisWeekday: true,
  futureBars: 60,
  // 两个月：够看清趋势位置，又不至于打开会话要等
  historyMonths: 2
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
  if (typeof raw.axisWeekday === 'boolean') out.axisWeekday = raw.axisWeekday
  if (typeof raw.futureBars === 'number' && Number.isFinite(raw.futureBars)) {
    out.futureBars = Math.min(FUTURE_BARS_MAX, Math.max(FUTURE_BARS_MIN, Math.round(raw.futureBars)))
  }
  if (typeof raw.historyMonths === 'number' && Number.isFinite(raw.historyMonths)) {
    out.historyMonths = Math.min(
      HISTORY_MONTHS_MAX,
      Math.max(HISTORY_MONTHS_MIN, Math.round(raw.historyMonths))
    )
  }
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
