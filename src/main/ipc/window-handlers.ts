// ============================================================
// TraderRewind — 窗口管理 IPC 处理器
// ============================================================

import { ipcMain, BrowserWindow } from 'electron'
import { IPC } from '@shared/constants/ipc'

export function registerWindowHandlers(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle(IPC.WINDOW_MINIMIZE, () => {
    getMainWindow()?.minimize()
  })

  ipcMain.handle(IPC.WINDOW_CLOSE, () => {
    getMainWindow()?.close()
  })

  ipcMain.handle(IPC.WINDOW_MAXIMIZE_TOGGLE, () => {
    const win = getMainWindow()
    if (!win) return
    if (win.isMaximized()) {
      win.unmaximize()
    } else {
      win.maximize()
    }
  })

  ipcMain.handle(IPC.WINDOW_IS_MAXIMIZED, () => {
    return getMainWindow()?.isMaximized() ?? false
  })

  ipcMain.handle(IPC.WINDOW_REFOCUS, () => {
    getMainWindow()?.focus()
  })

  console.log('[IPC] Window handlers registered')
}
