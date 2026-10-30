import { create } from 'zustand'

export type PaneId = 'hub' | 'data' | 'training' | 'journal' | 'settings'

interface AppState {
  activePane: PaneId
  setActivePane: (pane: PaneId) => void

  // 侧边栏折叠
  sidebarCollapsed: boolean
  toggleSidebar: () => void
}

export const useAppStore = create<AppState>((set) => ({
  activePane: 'hub',
  setActivePane: (pane) => set({ activePane: pane }),

  sidebarCollapsed: false,
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed }))
}))
