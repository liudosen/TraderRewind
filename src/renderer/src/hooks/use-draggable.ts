// ============================================================
// TraderRewind — 可拖动浮层
//
// 图表左上角那条画图工具条要能拖到别处（挡住 K 线 / 副图的时候尤其需要）。
// 位置按「相对定位父元素的左上角」存，拖动时夹在父元素范围内，松手落 localStorage。
//
// 为什么不直接把 onMouseDown 挂到整条上：条子里几乎全是按钮，用户按下去十有八九
// 是想点按钮。所以按钮 / 输入框上按下直接放行，只有空白处和手柄能起拖。
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react'

export interface DraggablePos {
  x: number
  y: number
}

interface Options {
  /** 存位置的 localStorage 键；不传就不持久化 */
  storageKey?: string
  /** 默认位置（相对父元素左上角，px） */
  defaultPos?: DraggablePos
}

export interface DraggableApi {
  /** 挂到「浮层的定位父元素」上，用来量可拖范围 */
  containerRef: React.RefObject<HTMLDivElement>
  /** 挂到浮层本身，用来量它自己的宽高（贴边夹取要用） */
  panelRef: React.RefObject<HTMLDivElement>
  /** 浮层位置（left / top），直接塞进 style */
  style: React.CSSProperties
  handlers: {
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void
    onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void
    onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void
    onPointerCancel: (e: React.PointerEvent<HTMLDivElement>) => void
  }
  dragging: boolean
  /** 回到默认位置（双击手柄时用） */
  reset: () => void
}

/** 存的是 {x,y}；脏数据 / 旧版本一律当没存过 */
function loadPos(key?: string): DraggablePos | null {
  if (!key) return null
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const v = JSON.parse(raw) as { x?: unknown; y?: unknown }
    if (typeof v?.x !== 'number' || typeof v?.y !== 'number') return null
    if (!Number.isFinite(v.x) || !Number.isFinite(v.y)) return null
    return { x: Math.round(v.x), y: Math.round(v.y) }
  } catch {
    return null
  }
}

function savePos(key: string | undefined, pos: DraggablePos): void {
  if (!key) return
  try {
    localStorage.setItem(key, JSON.stringify(pos))
  } catch {
    // 存不下（隐私模式 / 配额满）就先不管，本次会话内照样能拖
  }
}

export function useDraggable({ storageKey, defaultPos = { x: 8, y: 8 } }: Options = {}): DraggableApi {
  const containerRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<DraggablePos>(() => loadPos(storageKey) ?? defaultPos)
  const [dragging, setDragging] = useState(false)
  /** 开始拖动那一刻：鼠标位置 + 浮层当时的坐标 */
  const dragRef = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null)
  /** 松手要落盘时读它 —— state 在这一帧还没更新 */
  const posRef = useRef(pos)
  posRef.current = pos

  /** 夹进父元素：整块浮层都要能看见，不许被拖到边框外 */
  const clamp = useCallback((p: DraggablePos): DraggablePos => {
    const host = containerRef.current
    if (!host) return p
    const w = panelRef.current?.offsetWidth ?? 0
    const h = panelRef.current?.offsetHeight ?? 0
    const maxX = Math.max(0, host.clientWidth - w)
    const maxY = Math.max(0, host.clientHeight - h)
    return {
      x: Math.min(Math.max(0, Math.round(p.x)), maxX),
      y: Math.min(Math.max(0, Math.round(p.y)), maxY)
    }
  }, [])

  // 首帧量出容器尺寸后校一次：换了窗口大小，上次存的坐标可能已经越界
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      setPos((p) => {
        const next = clamp(p)
        return next.x === p.x && next.y === p.y ? p : next
      })
    })
    return () => cancelAnimationFrame(id)
  }, [clamp])

  // 窗口尺寸变了也要收回来，否则浮层会留在看不见的地方
  useEffect(() => {
    const onResize = (): void => {
      setPos((p) => {
        const next = clamp(p)
        return next.x === p.x && next.y === p.y ? p : next
      })
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [clamp])

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    // 按钮、输入框：用户是要点它，不是要拖
    const target = e.target as HTMLElement
    if (target.closest('button, input, select, textarea, a')) return
    dragRef.current = { px: e.clientX, py: e.clientY, ox: pos.x, oy: pos.y }
    setDragging(true)
    // 捕获指针：鼠标甩得再快，move/up 也还落在这块上，不会拖丢
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current
    if (!d) return
    setPos(clamp({ x: d.ox + (e.clientX - d.px), y: d.oy + (e.clientY - d.py) }))
  }

  const endDrag = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragRef.current) return
    dragRef.current = null
    setDragging(false)
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      // 已经释放过了
    }
    savePos(storageKey, posRef.current)
  }

  const reset = useCallback(() => {
    setPos(defaultPos)
    savePos(storageKey, defaultPos)
  }, [defaultPos, storageKey])

  return {
    containerRef,
    panelRef,
    style: { left: pos.x, top: pos.y, touchAction: 'none' },
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag
    },
    dragging,
    reset
  }
}
