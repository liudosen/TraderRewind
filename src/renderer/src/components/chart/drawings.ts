// ============================================================
// TraderRewind — 画线渲染与命中测试
// 坐标映射由 lightweight-charts 提供，这里只做纯绘制/几何判断
// ============================================================

import { FIB_LEVELS, type Drawing, type DrawingPoint } from '@shared/types/drawing'

export interface ChartMapping {
  timeToX: (time: number) => number | null
  xToTime: (x: number) => number | null
  priceToY: (price: number) => number | null
  yToPrice: (y: number) => number | null
}

export interface Viewport {
  width: number
  height: number
}

const HANDLE_R = 3.5
const HIT_TOLERANCE = 6
/** 横向裁剪留的边距：手柄半径 + 文字高度的一点余量 */
const CULL_MARGIN = 24

/** 文字绘制的字号，编辑框与命中盒都按它换算 */
export const TEXT_FONT_PX = 11.5

/**
 * 文字宽度估算（没有 canvas ctx 时用）。
 *
 * 中日韩字符按全角 12px 算，空格 4px，其余 7px —— 和 11.5px Inter 的实际
 * 渲染宽度基本吻合。命中盒与编辑输入框共用这一套，否则中文备注的右半边
 * 会「看得见、点不着」。
 */
export function estimateTextWidth(text: string): number {
  let w = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    w += code >= 0x2e80 ? 12 : code === 0x20 ? 4 : 7
  }
  return w
}

/**
 * 颜色 → rgba 字符串缓存。
 *
 * 每次重绘每个图形都要拼一次颜色串（上百条画线 × 每帧），而颜色一共就那么几个 ——
 * parseInt 三次 + 模板串的分配在这儿纯属浪费，还会给 GC 添压力。
 */
const rgbaCache = new Map<string, string>()

function hexToRgba(hex: string, alpha: number): string {
  const key = `${hex}|${alpha}`
  const hit = rgbaCache.get(key)
  if (hit !== undefined) return hit
  const h = hex.replace('#', '')
  let out = hex
  if (/^[0-9a-f]{6}$/i.test(h)) {
    const r = parseInt(h.slice(0, 2), 16)
    const g = parseInt(h.slice(2, 4), 16)
    const b = parseInt(h.slice(4, 6), 16)
    out = `rgba(${r}, ${g}, ${b}, ${alpha})`
  }
  // 上限兜一下：正常会话里颜色种类是个位数，只有用户疯狂改色才会长到几百
  if (rgbaCache.size < 512) rgbaCache.set(key, out)
  return out
}

function isNum(v: number | null): v is number {
  return v != null && Number.isFinite(v)
}

/**
 * 折线的锚点序列。
 *
 * `points` 是折线的真身，但 p1 / p2 也同步存了首尾两个点 —— 这样「整体拖动」
 * 「包围盒夹取」「选中手柄」这些按 p1/p2 写的通用逻辑可以原样复用。
 * 老数据里万一只有 p1/p2 也能兜住。
 */
export function polyPoints(d: Drawing): DrawingPoint[] {
  if (d.points && d.points.length >= 2) return d.points
  return d.p2 ? [d.p1, d.p2] : [d.p1]
}

/** 一个图形所有锚点（折线是全部点，其余是 p1/p2） */
export function shapePoints(d: Drawing): DrawingPoint[] {
  return d.type === 'polyline' ? polyPoints(d) : d.p2 ? [d.p1, d.p2] : [d.p1]
}

/**
 * 图形在**时间轴上**覆盖的范围。
 *
 * 回放一场里画线会攒到几百条，而屏幕上同一时刻只看得到其中几条。判断
 * 「这条在不在视野里」如果先去算屏幕坐标，就得为每条各跑两次二分 +
 * 两次 timeToCoordinate —— 剩下的全白算。时间范围是纯数字比较，O(1) 就能筛掉绝大多数。
 *
 * 三种特例：水平线横跨整个屏幕（不看时间）；延长线两端都无限延伸；
 * 射线只往 p1→p2 的方向延伸，另一侧才是有限的。
 */
export function drawingTimeBounds(d: Drawing): { min: number; max: number } {
  // 水平线横跨整个屏幕、延长线两端都无限延伸：这两种不受时间范围限制
  if (d.type === 'hline' || d.type === 'extline') {
    return { min: Number.NEGATIVE_INFINITY, max: Number.POSITIVE_INFINITY }
  }

  let min = d.p1.time
  let max = d.p1.time
  // 折线看全部锚点：中间那些点可能比首尾都更靠外（来回折的线）
  for (const p of shapePoints(d)) {
    if (p.time < min) min = p.time
    if (p.time > max) max = p.time
  }

  if (d.type === 'ray') {
    const forward = !d.p2 || d.p2.time >= d.p1.time
    return forward
      ? { min, max: Number.POSITIVE_INFINITY }
      : { min: Number.NEGATIVE_INFINITY, max }
  }
  return { min, max }
}

/** 这条图形的时间范围和 [lo, hi] 有没有交集（false = 整条都在视野外，可以跳过） */
export function inTimeWindow(d: Drawing, lo: number, hi: number): boolean {
  const b = drawingTimeBounds(d)
  return !(b.max < lo || b.min > hi)
}

/** 绘制单个图形 */
export function drawShape(
  ctx: CanvasRenderingContext2D,
  d: Drawing,
  map: ChartMapping,
  view: Viewport,
  selected: boolean
): void {
  const x1 = map.timeToX(d.p1.time)
  const y1 = map.priceToY(d.p1.price)
  if (!isNum(x1) || !isNum(y1)) return

  const x2 = d.p2 ? map.timeToX(d.p2.time) : null
  const y2 = d.p2 ? map.priceToY(d.p2.price) : null

  /**
   * 横向裁剪：整条都落在画布左右之外就直接不做。
   * 射线 / 延长线 / 水平线会从视野外伸进来，不能按端点裁。
   * 留一点边距，手柄和文字不会被切在半路上。
   */
  if (d.type !== 'ray' && d.type !== 'extline' && d.type !== 'hline') {
    const lo = Math.min(x1, x2 ?? x1)
    const hi = Math.max(x1, x2 ?? x1)
    if (hi < -CULL_MARGIN || lo > view.width + CULL_MARGIN) return
  }

  ctx.save()
  ctx.lineWidth = selected ? 2.5 : 1.5
  ctx.strokeStyle = d.color
  ctx.fillStyle = hexToRgba(d.color, 0.08)

  if (selected) {
    ctx.shadowColor = d.color
    ctx.shadowBlur = 6
  }

  switch (d.type) {
    case 'trend': {
      if (!isNum(x2) || !isNum(y2)) break
      ctx.beginPath()
      ctx.moveTo(x1, y1)
      ctx.lineTo(x2, y2)
      ctx.stroke()
      drawHandle(ctx, x1, y1, d.color)
      drawHandle(ctx, x2, y2, d.color)
      break
    }
    case 'ray':
    case 'extline': {
      if (!isNum(x2) || !isNum(y2)) break
      const seg = extendSegment(
        x1,
        y1,
        x2,
        y2,
        d.type === 'extline',
        view.width,
        view.height
      )
      ctx.beginPath()
      ctx.moveTo(seg[0], seg[1])
      ctx.lineTo(seg[2], seg[3])
      ctx.stroke()
      drawHandle(ctx, x1, y1, d.color)
      drawHandle(ctx, x2, y2, d.color)
      break
    }
    case 'hline': {
      ctx.beginPath()
      ctx.moveTo(0, y1)
      ctx.lineTo(view.width, y1)
      ctx.stroke()
      ctx.shadowBlur = 0
      ctx.fillStyle = hexToRgba(d.color, 0.9)
      ctx.font = '10px ui-monospace, monospace'
      ctx.fillText(d.p1.price.toFixed(5), 4, y1 - 3)
      drawHandle(ctx, x1, y1, d.color)
      break
    }
    case 'vline': {
      ctx.beginPath()
      ctx.moveTo(x1, 0)
      ctx.lineTo(x1, view.height)
      ctx.stroke()
      drawHandle(ctx, x1, y1, d.color)
      break
    }
    case 'arrow': {
      if (!isNum(x2) || !isNum(y2)) break
      ctx.beginPath()
      ctx.moveTo(x1, y1)
      ctx.lineTo(x2, y2)
      ctx.stroke()
      const ang = Math.atan2(y2 - y1, x2 - x1)
      const head = 10
      ctx.beginPath()
      ctx.moveTo(x2, y2)
      ctx.lineTo(x2 - head * Math.cos(ang - Math.PI / 7), y2 - head * Math.sin(ang - Math.PI / 7))
      ctx.moveTo(x2, y2)
      ctx.lineTo(x2 - head * Math.cos(ang + Math.PI / 7), y2 - head * Math.sin(ang + Math.PI / 7))
      ctx.stroke()
      drawHandle(ctx, x1, y1, d.color)
      break
    }
    case 'ellipse': {
      if (!isNum(x2) || !isNum(y2)) break
      const cx = (x1 + x2) / 2
      const cy = (y1 + y2) / 2
      const rx = Math.abs(x2 - x1) / 2
      const ry = Math.abs(y2 - y1) / 2
      ctx.beginPath()
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
      drawHandle(ctx, x1, y1, d.color)
      drawHandle(ctx, x2, y2, d.color)
      break
    }
    case 'rect': {
      if (!isNum(x2) || !isNum(y2)) break
      const left = Math.min(x1, x2)
      const top = Math.min(y1, y2)
      const w = Math.abs(x2 - x1)
      const h = Math.abs(y2 - y1)
      ctx.fillRect(left, top, w, h)
      ctx.strokeRect(left, top, w, h)
      drawHandle(ctx, x1, y1, d.color)
      drawHandle(ctx, x2, y2, d.color)
      break
    }
    case 'text': {
      ctx.shadowBlur = 0
      ctx.font = '600 11.5px Inter, ui-sans-serif, system-ui, sans-serif'
      ctx.fillStyle = d.color
      const label = d.text ?? ''
      // 描边做底色，避免压在 K 线上看不清
      ctx.lineWidth = 3
      ctx.strokeStyle = 'rgba(0,0,0,0.75)'
      ctx.strokeText(label, x1, y1)
      ctx.fillText(label, x1, y1)
      if (selected) {
        const w = ctx.measureText(label).width
        ctx.strokeStyle = hexToRgba(d.color, 0.9)
        ctx.lineWidth = 1
        ctx.setLineDash([3, 3])
        ctx.strokeRect(x1 - 3, y1 - 13, w + 6, 18)
        ctx.setLineDash([])
      }
      break
    }
    case 'fib': {
      if (!isNum(x2) || !isNum(y2)) break
      const fibP2 = d.p2!
      const left = Math.min(x1, x2)
      const right = Math.max(x1, x2)
      ctx.shadowBlur = 0
      ctx.font = '9px ui-monospace, monospace'
      for (const level of FIB_LEVELS) {
        const price = d.p1.price + (fibP2.price - d.p1.price) * level
        const y = map.priceToY(price)
        if (y == null) continue
        ctx.strokeStyle = hexToRgba(d.color, level === 0 || level === 1 ? 0.95 : 0.55)
        ctx.lineWidth = level === 0 || level === 1 ? 1.5 : 1
        ctx.beginPath()
        ctx.moveTo(left, y)
        ctx.lineTo(right, y)
        ctx.stroke()
        ctx.fillStyle = hexToRgba(d.color, 0.85)
        ctx.fillText(`${(level * 100).toFixed(1)}%  ${price.toFixed(5)}`, left + 3, y - 2)
      }
      ctx.strokeStyle = hexToRgba(d.color, 0.35)
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(x1, y1)
      ctx.lineTo(x2, y2)
      ctx.stroke()
      drawHandle(ctx, x1, y1, d.color)
      drawHandle(ctx, x2, y2, d.color)
      break
    }
    case 'polyline': {
      const pts = polyPoints(d)
        .map((pt) => {
          const px = map.timeToX(pt.time)
          const py = map.priceToY(pt.price)
          return isNum(px) && isNum(py) ? { x: px, y: py } : null
        })
        // 映射不到坐标的点直接丢掉，别在画布边缘拉出一条假线段
        .filter((pt): pt is { x: number; y: number } => pt != null)
      if (pts.length < 2) break
      ctx.beginPath()
      ctx.moveTo(pts[0].x, pts[0].y)
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
      ctx.stroke()
      // 每个锚点都给个小圆点：折线的拐点在哪一眼就看得到，选中时手柄才明显
      for (const pt of pts) drawHandle(ctx, pt.x, pt.y, d.color)
      break
    }
  }
  ctx.restore()
}

/** 射线 / 延长线：把线段向两端延伸，超出画布的部分由画布自己裁掉 */
export function extendSegment(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  both: boolean,
  viewW: number,
  viewH: number
): [number, number, number, number] {
  const dx = x2 - x1
  const dy = y2 - y1
  const len = Math.hypot(dx, dy) || 1
  const far = Math.hypot(viewW, viewH) * 3 + 2000
  const ux = dx / len
  const uy = dy / len
  return [both ? x1 - ux * far : x1, both ? y1 - uy * far : y1, x1 + ux * far, y1 + uy * far]
}

/**
 * 锚点小圆点。
 *
 * 不再包 save / restore：一条画线 2 个手柄、几百条画线就是几百对状态栈操作，
 * 每帧都做一遍。这里改成直接覆盖状态（圆点本身就是一条图形里最后画的东西，
 * 外层 drawShape 的 save / restore 会兜住），少掉的这对调用在拖拽时能明显感觉到。
 */
function drawHandle(ctx: CanvasRenderingContext2D, x: number, y: number, color: string): void {
  ctx.shadowBlur = 0
  ctx.beginPath()
  ctx.arc(x, y, HANDLE_R, 0, Math.PI * 2)
  ctx.fillStyle = '#0b0b0b'
  ctx.fill()
  ctx.lineWidth = 1.5
  ctx.strokeStyle = color
  ctx.stroke()
}

/**
 * 绘制进行中的临时图形。
 *
 * `via` 是折线已经落下的锚点（屏幕坐标，按顺序）—— 它们和「跟着鼠标走的最后一段」
 * 用同样的虚线画出来，用户才能看清这一笔连到哪。其它工具不用传。
 */
export function drawPreview(
  ctx: CanvasRenderingContext2D,
  type: Drawing['type'],
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  via?: { x: number; y: number }[]
): void {
  ctx.save()
  ctx.setLineDash([4, 3])
  ctx.strokeStyle = 'rgba(255,255,255,0.65)'
  ctx.lineWidth = 1.2

  if (type === 'polyline') {
    const pts = via && via.length > 0 ? [...via, p2] : [p1, p2]
    ctx.beginPath()
    ctx.moveTo(pts[0].x, pts[0].y)
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
    ctx.stroke()
    // 已落下的锚点画成实心小点，和还没确定的那一段区分开
    for (const pt of pts.slice(0, -1)) {
      ctx.save()
      ctx.setLineDash([])
      ctx.beginPath()
      ctx.arc(pt.x, pt.y, 2.5, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(255,255,255,0.85)'
      ctx.fill()
      ctx.restore()
    }
  } else if (type === 'rect') {
    ctx.strokeRect(Math.min(p1.x, p2.x), Math.min(p1.y, p2.y), Math.abs(p2.x - p1.x), Math.abs(p2.y - p1.y))
  } else if (type === 'ellipse') {
    ctx.beginPath()
    ctx.ellipse(
      (p1.x + p2.x) / 2,
      (p1.y + p2.y) / 2,
      Math.abs(p2.x - p1.x) / 2,
      Math.abs(p2.y - p1.y) / 2,
      0,
      0,
      Math.PI * 2
    )
    ctx.stroke()
  } else if (type === 'hline') {
    ctx.beginPath()
    ctx.moveTo(0, p1.y)
    ctx.lineTo(4096, p1.y)
    ctx.stroke()
  } else if (type === 'vline') {
    ctx.beginPath()
    ctx.moveTo(p1.x, 0)
    ctx.lineTo(p1.x, 4096)
    ctx.stroke()
  } else if (type === 'ray' || type === 'extline') {
    const seg = extendSegment(p1.x, p1.y, p2.x, p2.y, type === 'extline', 4000, 4000)
    ctx.beginPath()
    ctx.moveTo(seg[0], seg[1])
    ctx.lineTo(seg[2], seg[3])
    ctx.stroke()
  } else {
    ctx.beginPath()
    ctx.moveTo(p1.x, p1.y)
    ctx.lineTo(p2.x, p2.y)
    ctx.stroke()
  }
  ctx.restore()
}

function distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1
  const dy = y2 - y1
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return Math.hypot(px - x1, py - y1)
  let t = ((px - x1) * dx + (py - y1) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}

/**
 * 命中的是哪个手柄。
 * `p1` / `p2` 是两端，`body` 是图形本体，`ptN` 是折线第 N 个锚点（从 0 数）。
 */
export type DrawingHit = 'p1' | 'p2' | 'body' | `pt${number}`

/**
 * 命中测试
 * @returns 手柄标识，null 表示没命中
 */
export function hitTest(
  d: Drawing,
  x: number,
  y: number,
  map: ChartMapping
): DrawingHit | null {
  const x1 = map.timeToX(d.p1.time)
  const y1 = map.priceToY(d.p1.price)
  if (!isNum(x1) || !isNum(y1)) return null

  const x2 = d.p2 ? map.timeToX(d.p2.time) : null
  const y2 = d.p2 ? map.priceToY(d.p2.price) : null

  /**
   * 包围盒粗筛：光标离这一条很远就直接跳过，别再去算点到线段距离。
   *
   * 鼠标在图上移动时每条画线都会被问一遍「点到我了吗」。绝大多数情况下答案是
   * 「没有」，而「没有」也该尽量便宜 —— 一次四则运算远比 hypot 便宜。
   *
   * 不能按包围盒裁的：折线（中间锚点可能比首尾更外）、射线 / 延长线（会伸进视野）、
   * 水平线（横跨整幅）；竖线**纵向**上也是贯通的，只按 x 粗筛。
   */
  if (d.type !== 'polyline' && d.type !== 'ray' && d.type !== 'extline' && d.type !== 'hline') {
    const lo = Math.min(x1, isNum(x2) ? x2 : x1) - CULL_MARGIN
    const hi = Math.max(x1, isNum(x2) ? x2 : x1) + CULL_MARGIN
    if (x < lo || x > hi) return null
    if (d.type !== 'vline') {
      const top = Math.min(y1, isNum(y2) ? y2 : y1) - CULL_MARGIN
      const bottom = Math.max(y1, isNum(y2) ? y2 : y1) + CULL_MARGIN
      if (y < top || y > bottom) return null
    }
  }

  // 折线：先看有没有点在某个锚点上（中间那些点也能单独拖）
  if (d.type === 'polyline') {
    const pts = polyPoints(d)
    /**
     * 一次遍历同时做两件事：判手柄、留下屏幕坐标给线段判定。
     * 原来这里对每个锚点映射了两遍（先判手柄，再重建一次数组），
     * 锚点多的折线在鼠标移动时等于白算一半。
     */
    const screen: { x: number; y: number }[] = []
    for (let i = 0; i < pts.length; i++) {
      const px = map.timeToX(pts[i].time)
      const py = map.priceToY(pts[i].price)
      if (!isNum(px) || !isNum(py)) continue
      // 下标必须是**原始**锚点序号：拖动时按 'pt3' 这种标识回写到 polyPoints
      if (Math.hypot(x - px, y - py) <= HANDLE_R + 3) return `pt${i}`
      screen.push({ x: px, y: py })
    }
    // 本体：任意一段折线上都算命中
    for (let i = 1; i < screen.length; i++) {
      if (distToSegment(x, y, screen[i - 1].x, screen[i - 1].y, screen[i].x, screen[i].y) <= HIT_TOLERANCE) {
        return 'body'
      }
    }
    return null
  }

  if (Math.hypot(x - x1, y - y1) <= HANDLE_R + 3) return 'p1'

  if (isNum(x2) && isNum(y2) && Math.hypot(x - x2, y - y2) <= HANDLE_R + 3) return 'p2'

  switch (d.type) {
    case 'trend':
    case 'arrow':
      if (isNum(x2) && isNum(y2) && distToSegment(x, y, x1, y1, x2, y2) <= HIT_TOLERANCE) return 'body'
      return null
    case 'ray':
    case 'extline': {
      if (!isNum(x2) || !isNum(y2)) return null
      const seg = extendSegment(x1, y1, x2, y2, d.type === 'extline', 4000, 4000)
      return distToSegment(x, y, seg[0], seg[1], seg[2], seg[3]) <= HIT_TOLERANCE ? 'body' : null
    }
    case 'hline':
      return Math.abs(y - y1) <= HIT_TOLERANCE ? 'body' : null
    case 'vline':
      return Math.abs(x - x1) <= HIT_TOLERANCE ? 'body' : null
    case 'rect': {
      if (!isNum(x2) || !isNum(y2)) return null
      const left = Math.min(x1, x2)
      const right = Math.max(x1, x2)
      const top = Math.min(y1, y2)
      const bottom = Math.max(y1, y2)
      const inside = x >= left && x <= right && y >= top && y <= bottom
      return inside ? 'body' : null
    }
    case 'ellipse': {
      if (!isNum(x2) || !isNum(y2)) return null
      const cx = (x1 + x2) / 2
      const cy = (y1 + y2) / 2
      const rx = Math.abs(x2 - x1) / 2
      const ry = Math.abs(y2 - y1) / 2
      if (rx < 1 || ry < 1) return null
      const inside =
        ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1
      return inside ? 'body' : null
    }
    case 'text': {
      // 按估算宽度做包围盒（全角字符 12px，比一律 7px 贴合中文备注）
      const w = Math.max(24, estimateTextWidth(d.text ?? ''))
      const inside = x >= x1 - 4 && x <= x1 + w && y >= y1 - 13 && y <= y1 + 5
      return inside ? 'body' : null
    }
    case 'fib': {
      if (!isNum(x2) || !isNum(y2)) return null
      const fibP2 = d.p2!
      const left = Math.min(x1, x2)
      const right = Math.max(x1, x2)
      if (x < left - HIT_TOLERANCE || x > right + HIT_TOLERANCE) return null
      for (const level of FIB_LEVELS) {
        const price = d.p1.price + (fibP2.price - d.p1.price) * level
        const ly = map.priceToY(price)
        if (isNum(ly) && Math.abs(y - ly) <= HIT_TOLERANCE) return 'body'
      }
      return null
    }
  }
  return null
}
