// ============================================================
// TraderRewind — 更新状态（渲染进程）
//
// 状态本体在主进程（它能拿到 app.getVersion()、能下载、能拉起安装程序），
// 这里只做两件事：订阅广播 + 把用户动作转发回去。
// 这样切页面、组件重渲染都不会让「下载中 42%」这个事实丢掉。
// ============================================================

import { create } from 'zustand'

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'installing'
  | 'uptodate'
  | 'error'

export interface UpdateState {
  phase: UpdatePhase
  currentVersion: string
  latestVersion: string | null
  notes: string | null
  publishedAt: string | null
  releaseUrl: string
  assetName: string | null
  assetSize: number
  received: number
  total: number
  filePath: string | null
  error: string | null
  checkedAt: number | null
  installable: boolean
}

const EMPTY: UpdateState = {
  phase: 'idle',
  currentVersion: '',
  latestVersion: null,
  notes: null,
  publishedAt: null,
  releaseUrl: 'https://github.com/liudosen/TraderRewind/releases/latest',
  assetName: null,
  assetSize: 0,
  received: 0,
  total: 0,
  filePath: null,
  error: null,
  checkedAt: null,
  installable: false
}

interface UpdateStore extends UpdateState {
  /** 用户把这次提示收起来了（按版本号记，换新版会再弹一次） */
  dismissedVersion: string | null
  bind: () => () => void
  load: () => Promise<void>
  check: () => Promise<void>
  download: () => Promise<void>
  install: () => Promise<void>
  dismiss: (version: string) => void
  openReleasePage: () => Promise<void>
}

export const useUpdateStore = create<UpdateStore>((set, get) => ({
  ...EMPTY,
  dismissedVersion: null,

  /** 订阅主进程广播；返回退订函数 */
  bind: () => {
    const off = window.api.on('update:status', (next: UpdateState) => {
      set({ ...next })
    })
    return () => off()
  },

  /** 首次挂载时把主进程已有的状态拉回来（自动检查可能已经跑过了） */
  load: async () => {
    try {
      const state = (await window.api.getUpdateState()) as UpdateState
      if (state) set({ ...state })
    } catch {
      // 拿不到就保持 idle，下次点「检查更新」还能再试
    }
  },

  check: async () => {
    set({ phase: 'checking', error: null })
    try {
      const state = (await window.api.checkUpdate({})) as UpdateState
      set({ ...state, dismissedVersion: null })
    } catch (e: any) {
      set({ phase: 'error', error: e?.message ?? '检查更新失败' })
    }
  },

  download: async () => {
    // 进度靠广播回来，这里只把按钮切到「下载中」避免重复点击
    set({ phase: 'downloading', received: 0, error: null })
    try {
      const state = (await window.api.downloadUpdate()) as UpdateState
      set({ ...state })
    } catch (e: any) {
      set({ phase: 'error', error: e?.message ?? '下载失败' })
    }
  },

  install: async () => {
    set({ phase: 'installing' })
    const res = (await window.api.installUpdate()) as { ok: boolean; error?: string }
    if (!res?.ok) set({ phase: 'ready', error: res?.error ?? '无法启动安装程序' })
    // 成功的话应用马上就会退出，不用再改状态
  },

  dismiss: (version) => set({ dismissedVersion: version }),

  openReleasePage: async () => {
    await window.api.openReleasePage()
  }
}))

/** 进度百分比（0~100）；总大小未知时返回 null，界面上显示「已下载 x MB」 */
export function updatePercent(s: Pick<UpdateState, 'received' | 'total'>): number | null {
  if (!s.total || s.total <= 0) return null
  return Math.max(0, Math.min(100, Math.round((s.received / s.total) * 100)))
}

/** 有没有「值得提醒」的东西：有新版 / 在下载 / 下载好了 / 检查失败 */
export function needsAttention(s: UpdateState): boolean {
  return (
    s.phase === 'available' ||
    s.phase === 'downloading' ||
    s.phase === 'ready' ||
    s.phase === 'error'
  )
}
