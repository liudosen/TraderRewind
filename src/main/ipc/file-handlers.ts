// ============================================================
// TraderRewind — 文件操作 IPC 处理器
// ============================================================

import { ipcMain, dialog, BrowserWindow } from 'electron'
import { readFile, writeFile } from 'fs/promises'
import { IPC } from '@shared/constants/ipc'

export function registerFileHandlers(): void {
  ipcMain.handle(IPC.FILE_OPEN_CSV, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      filters: [
        { name: 'CSV Files', extensions: ['csv', 'csv.gz', 'gz'] },
        { name: 'All Files', extensions: ['*'] }
      ],
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle(IPC.FILE_READ_CSV, async (_e, filePath: string) => {
    try {
      const content = await readFile(filePath, 'utf-8')
      return { ok: true, data: content }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.FILE_SAVE_CSV, async (e, defaultName: string, content: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return null
    const result = await dialog.showSaveDialog(win, {
      defaultPath: defaultName,
      filters: [{ name: 'CSV Files', extensions: ['csv'] }]
    })
    if (result.canceled || !result.filePath) return null
    await writeFile(result.filePath, content, 'utf-8')
    return result.filePath
  })

  console.log('[IPC] File handlers registered')
}
