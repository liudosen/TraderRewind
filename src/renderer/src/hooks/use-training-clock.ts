import { useEffect, useRef } from 'react'

/**
 * 多久没有任何操作就算「人不在」。
 * 挂着过夜不该把回测用时刷成十几个小时，所以静止超过这个时长就停表。
 */
const IDLE_MS = 3 * 60 * 1000

/** 攒够多少秒写一次库。太频繁没意义，程序被强杀最多丢这么多 */
const FLUSH_EVERY = 10

/**
 * 累计「实际回测用时」。
 *
 * 只有满足下面几条才走表：
 *   1. 训练页挂着（会话开着；组件卸载会自动收尾）
 *   2. 窗口可见（最小化 / 被完全遮住不算）
 *   3. 正在播放回放，或者最近 3 分钟有操作
 *      —— 停在某根 K 线上盯着看、或者让行情自己走，都是练习；
 *         但暂停后人离开桌子就该停表，否则挂一晚能刷出十几个小时。
 *
 * 时长按秒攒在内存里，每满 FLUSH_EVERY 秒把这段差量加进 sessions.train_seconds，
 * 卸载、隐藏、关窗口时立刻把剩下的补齐，所以不会出现「练了半小时记成 0」。
 *
 * @param sessionId 当前回测集 id；null 表示没有会话，不计时
 * @param playing   回放是否在自动播放（播放中算在练，不受静止超时限制）
 */
export function useTrainingClock(sessionId: number | null, playing: boolean): void {
  /** 还没写库的秒数 */
  const pendingRef = useRef(0)
  /** tick 每秒跑一次，用 ref 拿最新的播放状态，免得重建定时器 */
  const playingRef = useRef(playing)
  useEffect(() => {
    playingRef.current = playing
  }, [playing])

  useEffect(() => {
    if (sessionId == null) return
    const sid = sessionId

    let lastTick = performance.now()
    let lastAct = performance.now()
    pendingRef.current = 0

    const flush = (force = false): void => {
      const sec = force ? Math.round(pendingRef.current) : Math.floor(pendingRef.current)
      if (sec < 1) return
      pendingRef.current -= sec
      void window.api.addSessionTrainSeconds(sid, sec).catch(() => undefined)
    }

    const tick = (): void => {
      const now = performance.now()
      const dt = (now - lastTick) / 1000
      lastTick = now
      // 窗口看不见就不算
      if (document.visibilityState !== 'visible') return
      // 暂停中人又不在，停表；正在播放则一直算（盯着行情走也是练习）
      if (now - lastAct > IDLE_MS && !playingRef.current) {
        // 刚停表时把攒着的零头写掉：人一走可能就再没机会冲洗了
        flush(true)
        return
      }
      // 睡眠唤醒时 dt 会是一大段，只认最多 2 秒，别把睡觉时间算成训练
      pendingRef.current += Math.min(dt, 2)
      if (pendingRef.current >= FLUSH_EVERY) flush()
    }

    /** 只记「最后一次操作在什么时候」，不要动 lastTick：动鼠标的频率远高于秒表，
     *  跟着它重置会把每秒该记的时间切碎，结果鼠标动得越多记的越少。 */
    const onAct = (): void => {
      lastAct = performance.now()
    }
    const onHide = (): void => flush(true)

    const timer = window.setInterval(tick, 1000)
    window.addEventListener('pointermove', onAct, { passive: true })
    window.addEventListener('pointerdown', onAct, { passive: true })
    window.addEventListener('wheel', onAct, { passive: true })
    window.addEventListener('keydown', onAct)
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('beforeunload', onHide)

    return () => {
      window.clearInterval(timer)
      window.removeEventListener('pointermove', onAct)
      window.removeEventListener('pointerdown', onAct)
      window.removeEventListener('wheel', onAct)
      window.removeEventListener('keydown', onAct)
      document.removeEventListener('visibilitychange', onHide)
      window.removeEventListener('beforeunload', onHide)
      flush(true)
    }
  }, [sessionId])
}
