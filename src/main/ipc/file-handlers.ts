// ============================================================
// TraderRewind — 文件操作 IPC 处理器
// ============================================================

import { ipcMain, dialog, BrowserWindow, app } from 'electron'
import { readFile, writeFile } from 'fs/promises'
import { join } from 'node:path'
import { IPC } from '@shared/constants/ipc'
import {
  buildXlsx,
  type XlsxCell,
  type XlsxCellImage
} from '../utils/xlsx'
import { getTrainingDb } from '../db/connection'
import { isChartTimeframe, timeframeCode, timeframeSeconds } from '@shared/utils/timeframe'

/** Windows 文件名里不能出现的字符，统一换掉 */
function sanitizeFileName(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/[.\s]+$/, '')
    .trim()
    .slice(0, 120)
}

interface TradeShotRow {
  id: string
  trade_id: string
  bytes: Buffer
  width: number | null
  height: number | null
  /** M5 / C7 …；老数据没有记录则为 null */
  timeframe: string | null
}

const STANDARD_TF_ORDER = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1']

/** 截图列按周期排序：标准周期在前，自定义周期按分钟数升序，没有周期信息的排最后 */
function timeframeRank(tf: string): number {
  if (!tf) return 1e9
  const i = STANDARD_TF_ORDER.indexOf(tf)
  if (i >= 0) return i
  return 100 + (timeframeSeconds(tf) || 1e8)
}

/**
 * 一次导出里所有交易的截图，按 trade_id 分组。
 *
 * 只查导出范围内的交易；分块拼 IN，避免几百个占位符一次把 SQLite 参数上限顶爆。
 */
function loadTradeShots(sessionId: number, tradeIds: string[]): Map<string, TradeShotRow[]> {
  const grouped = new Map<string, TradeShotRow[]>()
  if (!Number.isFinite(sessionId) || tradeIds.length === 0) return grouped
  try {
    const db = getTrainingDb()
    const CHUNK = 400
    for (let i = 0; i < tradeIds.length; i += CHUNK) {
      const chunk = tradeIds.slice(i, i + CHUNK)
      const placeholders = chunk.map(() => '?').join(',')
      const rows = db
        .prepare(
          `SELECT id, trade_id, bytes, width, height, timeframe
             FROM trade_screenshots
            WHERE session_id = ? AND trade_id IN (${placeholders})
            ORDER BY created_at ASC`
        )
        .all(sessionId, ...chunk) as any[]
      for (const row of rows) {
        if (!row?.bytes) continue
        const bytes = Buffer.isBuffer(row.bytes) ? row.bytes : Buffer.from(row.bytes)
        if (bytes.length === 0) continue
        const key = String(row.trade_id)
        const list = grouped.get(key) ?? []
        const timeframe =
          typeof row.timeframe === 'string' && isChartTimeframe(row.timeframe)
            ? row.timeframe
            : null
        list.push({
          id: String(row.id),
          trade_id: key,
          bytes,
          width: Number(row.width) || null,
          height: Number(row.height) || null,
          timeframe
        })
        grouped.set(key, list)
      }
    }
  } catch (e) {
    // 截图表还不存在 / 读取失败时，导出仍然要成功，只是没有图片列
    console.warn('[export] 读取交易截图失败', e)
  }
  return grouped
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
        /** 导出哪本账：有截图就按交易追加图片列 */
        sessionId?: number
        /** 与 rows 的数据行一一对应的交易 id */
        tradeIds?: string[]
      }
    ) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      if (!win) return { canceled: true as const }
      const sourceRows = Array.isArray(payload?.rows) ? payload.rows : []
      if (sourceRows.length === 0) return { canceled: true as const, error: 'empty' }

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

      const rows: XlsxCell[][] = sourceRows.map((row) => [...row])
      let baseCols = 1
      for (const row of rows) baseCols = Math.max(baseCols, row.length)
      const widths = Array.isArray(payload?.columnWidths) ? [...payload.columnWidths] : []
      while (widths.length < baseCols) widths.push(14)

      const tradeIds = Array.isArray(payload?.tradeIds)
        ? payload.tradeIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
        : []
      const sessionId = Number(payload?.sessionId)
      const shotsByTrade =
        Number.isFinite(sessionId) && tradeIds.length > 0
          ? loadTradeShots(sessionId, Array.from(new Set(tradeIds)))
          : new Map<string, TradeShotRow[]>()
      /**
       * 截图按周期分列，而不是按「第几张」。
       *
       * M5 的截图就放 M5 列、M15 放 M15 列，表头自然就是周期；不同交易截了
       * 不同周期也能各归各位。同一周期有多张时才用 M5 / M5 (2) 区分。
       * 老版本没有记录周期的截图统一放到最后的「—」列。
       */
      const maxByTf = new Map<string, number>()
      for (const list of shotsByTrade.values()) {
        const counts = new Map<string, number>()
        for (const shot of list) {
          const key = shot.timeframe ?? ''
          counts.set(key, (counts.get(key) ?? 0) + 1)
        }
        for (const [key, n] of counts) {
          maxByTf.set(key, Math.max(maxByTf.get(key) ?? 0, n))
        }
      }
      const tfGroups: { tf: string; count: number; start: number }[] = Array.from(maxByTf.keys())
        .sort((a, b) => timeframeRank(a) - timeframeRank(b))
        .map((tf) => ({ tf, count: maxByTf.get(tf) ?? 0, start: 0 }))
      let totalImageCols = 0
      for (const g of tfGroups) {
        g.start = totalImageCols
        totalImageCols += g.count
      }
      const imageGroupByTf = new Map(tfGroups.map((g) => [g.tf, g]))

      const cellImages: XlsxCellImage[] = []
      if (totalImageCols > 0) {
        // 图片列表头 + 每行补齐，保证空单元格也有边框、表头能筛选
        const header = rows[0] ?? []
        for (const g of tfGroups) {
          const baseLabel = g.tf ? timeframeCode(g.tf) : '—'
          for (let k = 0; k < g.count; k++) {
            header[baseCols + g.start + k] = k === 0 ? baseLabel : `${baseLabel} (${k + 1})`
            widths.push(30)
          }
        }
        for (let r = 1; r < rows.length; r++) {
          while (rows[r].length < baseCols + totalImageCols) rows[r].push('')
        }

        for (let r = 1; r < rows.length; r++) {
          const tradeId = tradeIds[r - 1]
          if (!tradeId) continue
          const shots = shotsByTrade.get(tradeId)
          if (!shots || shots.length === 0) continue

          const byTf = new Map<string, TradeShotRow[]>()
          for (const shot of shots) {
            const key = shot.timeframe ?? ''
            const list = byTf.get(key) ?? []
            list.push(shot)
            byTf.set(key, list)
          }

          for (const [tf, list] of byTf) {
            const group = imageGroupByTf.get(tf)
            if (!group) continue
            for (let k = 0; k < list.length; k++) {
              cellImages.push({
                data: list[k].bytes,
                col: baseCols + group.start + k,
                row: r
              })
            }
          }
        }
      }

      const buffer = buildXlsx({
        name: String(payload?.sheetName ?? 'Sheet1'),
        rows,
        columnWidths: widths.length > 0 ? widths : undefined,
        cellImages
      })
      await writeFile(target, buffer)
      return {
        canceled: false as const,
        path: target,
        imageCount: cellImages.length
      }
    }
  )

  console.log('[IPC] File handlers registered')
}
