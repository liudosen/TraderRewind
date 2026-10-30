// ============================================================
// TraderRewind — 全应用时区
//  · 全局默认 UTC+8，可在设置页单独修改
//  · 进入某个历史回测集时，切回该会话打单时记录的时区，
//    这样从日志跳回 K 线看到的刻度与当时下单时一致
// ============================================================

import { create } from 'zustand'
import { DEFAULT_TIMEZONE, normalizeTimezone } from '@shared/types/timezone'

interface TimezoneState {
  /** 设置页里的全局时区，例如 'UTC+8' */
  timezone: string
  /** 当前会话打单时记录的时区；为空表示跟随全局 */
  sessionTimezone: string | null
  /** 实际生效的时区 = sessionTimezone ?? timezone */
  effective: string
  loaded: boolean
  load: () => Promise<void>
  setTimezone: (tz: string) => Promise<void>
  /** 打开历史会话时调用；传 null 表示退出会话、回到全局时区 */
  useSessionTimezone: (tz: string | null) => void
}

export const useTimezoneStore = create<TimezoneState>((set, get) => ({
  timezone: DEFAULT_TIMEZONE,
  sessionTimezone: null,
  effective: DEFAULT_TIMEZONE,
  loaded: false,

  load: async () => {
    try {
      const remote = await window.api.getTimezone()
      const tz = normalizeTimezone(remote)
      const session = get().sessionTimezone
      set({ timezone: tz, effective: session ?? tz, loaded: true })
    } catch {
      set({ loaded: true })
    }
  },

  setTimezone: async (tz) => {
    const next = normalizeTimezone(tz)
    set({ timezone: next, effective: get().sessionTimezone ?? next })
    try {
      await window.api.setTimezone(next)
    } catch {
      // 落盘失败也不影响本次会话内的显示
    }
  },

  useSessionTimezone: (tz) => {
    const session = tz ? normalizeTimezone(tz) : null
    set({ sessionTimezone: session, effective: session ?? get().timezone })
  }
}))

/** 给非 React 环境（canvas 绘制、图表 formatter）直接取当前生效时区 */
export function currentTimezone(): string {
  return useTimezoneStore.getState().effective
}

// 开发期调试钩子
if (import.meta.env.DEV) {
  ;(window as any).__tz_store = useTimezoneStore
}
