// ============================================================
// TraderRewind — 图表外观状态（全局，改动即时生效并持久化）
// ============================================================

import { create } from 'zustand'
import {
  DEFAULT_CHART_THEME,
  normalizeTheme,
  type ChartTheme
} from '@shared/types/chart-theme'

interface ChartThemeState {
  theme: ChartTheme
  loaded: boolean
  load: () => Promise<void>
  /** 修改任意字段：立刻生效，稍后落盘 */
  patch: (p: Partial<ChartTheme>) => void
  reset: () => void
}

let saveTimer: ReturnType<typeof setTimeout> | null = null

function scheduleSave(theme: ChartTheme): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    void window.api.setChartTheme(theme)
  }, 350)
}

export const useChartThemeStore = create<ChartThemeState>((set, get) => ({
  theme: { ...DEFAULT_CHART_THEME },
  loaded: false,

  load: async () => {
    try {
      const remote = await window.api.getChartTheme()
      set({ theme: normalizeTheme(remote), loaded: true })
    } catch {
      set({ loaded: true })
    }
  },

  patch: (p) => {
    const next = normalizeTheme({ ...get().theme, ...p })
    set({ theme: next })
    scheduleSave(next)
  },

  reset: () => {
    const next = { ...DEFAULT_CHART_THEME }
    set({ theme: next })
    scheduleSave(next)
  }
}))
