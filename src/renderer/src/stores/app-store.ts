import { create } from 'zustand'

export type PaneId = 'hub' | 'data' | 'training' | 'journal' | 'settings'

interface AppState {
  activePane: PaneId
  setActivePane: (pane: PaneId) => void

  /**
   * 「从日志点进来的」标记：日志里点某笔交易会跳到 K 线图，
   * 这时候训练页要显示一个高亮的「返回日志」按钮，让用户一键回到刚才看的报告。
   *
   * 只有从日志跳转时才为 true；用户自己点侧边栏切走、或点了返回按钮就清掉，
   * 免得下次正常进训练页还挂着一个莫名其妙的返回按钮。
   */
  journalReturn: boolean
  setJournalReturn: (v: boolean) => void

  // 侧边栏折叠
  sidebarCollapsed: boolean
  toggleSidebar: () => void
}

export const useAppStore = create<AppState>((set, get) => ({
  activePane: 'hub',
  setActivePane: (pane) =>
    set({
      activePane: pane,
      // 只要不是停在训练页，「返回日志」这条线索就断了
      journalReturn: pane === 'training' ? get().journalReturn : false
    }),

  journalReturn: false,
  setJournalReturn: (v) => set({ journalReturn: v }),

  sidebarCollapsed: false,
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed }))
}))
