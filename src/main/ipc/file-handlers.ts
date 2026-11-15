// ============================================================
// TraderRewind — 文件操作 IPC 处理器
// ============================================================

import { ipcMain, dialog, BrowserWindow, app } from 'electron'
import { readFile, writeFile } from 'fs/promises'
import { join } from 'node:path'
import { IPC } from '@shared/constants/ipc'
import { buildXlsx, type XlsxCell } from '../utils/xlsx'

/** Windows 文件名里不能出现的字符，统一换掉 */
function sanitizeFileName(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/[.\s]+$/, '')
    .trim()
    .slice(0, 120)
}

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

  /**
   * 日志页「导出 Excel」。
   *
   * 表格内容由渲染进程按当前时区 / 文案拼好（它拿得到会话和 i18n），
   * 主进程只负责弹保存框、把二维表写成真正的 .xlsx —— 不在两边各算一套格式。
   */
  ipcMain.handle(
    IPC.FILE_EXPORT_XLSX,
    async (
      e,
      payload: {
        fileName?: string
        sheetName?: string
        rows?: XlsxCell[][]
        columnWidths?: number[]
      }
    ) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      if (!win) return { canceled: true as const }
      const rows = Array.isArray(payload?.rows) ? payload.rows : []
      if (rows.length === 0) return { canceled: true as const, error: 'empty' }

      const base = sanitizeFileName(String(payload?.fileName ?? '')) || 'trades'
      const suggested = base.toLowerCase().endsWith('.xlsx') ? base : `${base}.xlsx`
      const result = await dialog.showSaveDialog(win, {
        defaultPath: join(app.getPath('documents'), suggested),
        filters: [{ name: 'Excel', extensions: ['xlsx'] }]
      })
      if (result.canceled || !result.filePath) return { canceled: true as const }

      const target = result.filePath.toLowerCase().endsWith('.xlsx')
        ? result.filePath
        : `${result.filePath}.xlsx`
      const buffer = buildXlsx({
        name: String(payload?.sheetName ?? 'Sheet1'),
        rows,
        columnWidths: Array.isArray(payload?.columnWidths) ? payload.columnWidths : undefined
      })
      await writeFile(target, buffer)
      return { canceled: false as const, path: target }
    }
  )

  console.log('[IPC] File handlers registered')
}
