// ============================================================
// TraderRewind — 图表画线：类型定义
// 工具集与操作习惯对齐 TradingView 官方左侧「绘图工具」栏
// ============================================================

export type DrawingType =
  | 'trend'
  | 'ray'
  | 'extline'
  | 'hline'
  | 'vline'
  | 'fib'
  | 'rect'
  | 'ellipse'
  | 'arrow'
  | 'text'
  | 'polyline'

/** 工具栏分组（用于在按钮之间画分隔线） */
export type DrawingGroup = 'line' | 'fib' | 'shape' | 'note'

export interface DrawingPoint {
  time: number
  price: number
}

export interface Drawing {
  id: string
  type: DrawingType
  p1: DrawingPoint
  /** hline / vline / text 只有一个锚点 */
  p2?: DrawingPoint
  color: string
  /** text 工具的文字内容 */
  text?: string
  /**
   * polyline 的锚点序列，按顺序连成折线（至少 2 个）。
   *
   * 首尾同时写进 p1 / p2，这样「整体拖动」「包围盒」「命中测试」这些
   * 按 p1/p2 写的通用逻辑不用再为折线单开一套 —— 折线只是中间多了几个点。
   */
  points?: DrawingPoint[]
}

/**
 * 与 TradingView 一致：两点工具「左键点起点 → 移动预览 → 左键点终点」，
 * 单点工具一次左键即完成；绘制中右键 / Esc 取消。
 * 折线（polyline）是多点工具：左键每次落一个锚点，右键结束成形。
 */
export const DRAWING_TOOLS: {
  type: DrawingType
  label: string
  hint: string
  group: DrawingGroup
  /** 单点完成 */
  single?: boolean
  /** 多点工具：左键逐点落锚点，右键收尾 */
  multi?: boolean
}[] = [
  { type: 'trend', label: '趋势线', hint: '两次左键确定起点与终点', group: 'line' },
  { type: 'ray', label: '射线', hint: '从起点出发并向右延伸', group: 'line' },
  { type: 'extline', label: '延长线', hint: '两端无限延伸', group: 'line' },
  { type: 'hline', label: '水平线', hint: '一次左键放置', group: 'line', single: true },
  { type: 'vline', label: '垂直线', hint: '一次左键放置', group: 'line', single: true },
  {
    type: 'polyline',
    label: '折线',
    hint: '左键每点一次落一个锚点，右键结束',
    group: 'line',
    multi: true
  },
  { type: 'fib', label: '斐波那契回撤', hint: '两次左键确定高点和低点', group: 'fib' },
  { type: 'rect', label: '矩形', hint: '两次左键确定对角', group: 'shape' },
  { type: 'ellipse', label: '椭圆', hint: '两次左键确定包围框', group: 'shape' },
  { type: 'arrow', label: '箭头', hint: '两次左键确定起点与指向', group: 'shape' },
  { type: 'text', label: '文本', hint: '一次左键落点后输入文字', group: 'note', single: true }
]

export const DRAWING_COLORS: Record<DrawingType, string> = {
  trend: '#eab308',
  ray: '#eab308',
  extline: '#eab308',
  hline: '#38bdf8',
  vline: '#38bdf8',
  fib: '#a78bfa',
  rect: '#22d3ee',
  ellipse: '#22d3ee',
  arrow: '#f97316',
  text: '#e5e7eb',
  polyline: '#eab308'
}

export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]
