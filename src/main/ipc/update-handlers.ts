// ============================================================
// TraderRewind — 更新 IPC
//
// 通道常量早就留好了（IPC.UPDATE_*），这里把它们接到 updater 服务上。
// 状态由主进程广播（UPDATE_STATUS），渲染进程只负责显示与回传动作。
// ============================================================

import { ipcMain } from 'electron'
import { IPC } from '@shared/constants/ipc'
import {
  checkForUpdate,
  downloadUpdate,
  getUpdateState,
  installUpdate,
  openReleasePage
} from '../services/updater'

export function registerUpdateHandlers(): void {
  ipcMain.handle(IPC.UPDATE_GET_STATE, () => getUpdateState())

  ipcMain.handle(IPC.UPDATE_CHECK, async (_e, opts?: { autoDownload?: boolean }) => {
    return checkForUpdate({ autoDownload: Boolean(opts?.autoDownload) })
  })

  ipcMain.handle(IPC.UPDATE_DOWNLOAD, async () => downloadUpdate())

  ipcMain.handle(IPC.UPDATE_INSTALL, async () => installUpdate())

  // 自动更新失败时的兜底出口：直接打开发布页
  ipcMain.handle(IPC.UPDATE_OPEN_RELEASE_PAGE, () => {
    openReleasePage()
    return true
  })
}
