// ============================================================
// TraderRewind — 设置 IPC（数据目录管理）
// ============================================================

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { join, normalize } from 'node:path'
import { IPC } from '@shared/constants/ipc'
import {
  dbFileName,
  dbPathFor,
  dirFor,
  loadSettings,
  updateChartTheme,
  updateExecutionCost,
  updateIndicatorPrefs,
  updateStorageDir,
  updateTimezone,
  updateLocale,
  updateTradeTags,
  type StorageKind
} from '../settings'
import { closeDatabaseKind, openDatabaseKind } from '../db/connection'

function fileSize(path: string): number {
  try {
    return existsSync(path) ? statSync(path).size : 0
  } catch {
    return 0
  }
}

function storageInfo(): {
  klineDir: string
  trainingDir: string
  klineDbPath: string
  trainingDbPath: string
  klineDbSize: number
  trainingDbSize: number
  userDataDir: string
} {
  const s = loadSettings()
  const klineDbPath = dbPathFor('kline')
  const trainingDbPath = dbPathFor('training')
  return {
    klineDir: s.klineDir,
    trainingDir: s.trainingDir,
    klineDbPath,
    trainingDbPath,
    klineDbSize: fileSize(klineDbPath),
    trainingDbSize: fileSize(trainingDbPath),
    userDataDir: app.getPath('userData')
  }
}

export function registerSettingsHandlers(): void {
  ipcMain.handle(IPC.SETTINGS_GET, () => storageInfo())

  // 弹出系统目录选择框
  ipcMain.handle(IPC.SETTINGS_CHOOSE_DIR, async (e, kind: StorageKind) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const options = {
      title: kind === 'kline' ? '选择 K 线数据目录' : '选择训练/回测数据目录',
      buttonLabel: '选择此文件夹',
      properties: ['openDirectory', 'createDirectory'] as const
    }
    const result = win
      ? await dialog.showOpenDialog(win, options as any)
      : await dialog.showOpenDialog(options as any)
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // 切换数据目录：把当前库文件复制到新目录后切换
  ipcMain.handle(IPC.SETTINGS_SET_DIR, (_e, kind: StorageKind, dir: string) => {
    if (kind !== 'kline' && kind !== 'training') {
      return { ok: false, error: '未知的存储类型' }
    }
    if (!dir || typeof dir !== 'string' || !dir.trim()) {
      return { ok: false, error: '目录无效' }
    }

    const previous = loadSettings()
    // 规范化：折叠重复分隔符、统一为当前平台分隔符
    const targetDir = normalize(dir.trim())
    const oldPath = dbPathFor(kind)
    const newPath = join(targetDir, dbFileName(kind))

    try {
      mkdirSync(targetDir, { recursive: true })
    } catch (e: any) {
      return { ok: false, error: `无法创建目录：${e?.message ?? e}` }
    }

    if (oldPath === newPath) {
      return { ok: true, ...storageInfo() }
    }

    closeDatabaseKind(kind)
    let copied = false
    try {
      if (existsSync(oldPath) && !existsSync(newPath)) {
        copyFileSync(oldPath, newPath)
        copied = true
      }
      updateStorageDir(kind, targetDir)
      openDatabaseKind(kind)
      return { ok: true, copied, ...storageInfo() }
    } catch (e: any) {
      // 回滚到原目录，保证程序仍可用
      updateStorageDir(kind, kind === 'kline' ? previous.klineDir : previous.trainingDir)
      try {
        openDatabaseKind(kind)
      } catch {
        // 忽略
      }
      return { ok: false, error: e?.message ?? String(e) }
    }
  })

  // 在文件管理器中打开目录
  ipcMain.handle(IPC.SETTINGS_REVEAL_DIR, async (_e, kind: StorageKind) => {
    const dir = dirFor(kind)
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      // 忽略
    }
    await shell.openPath(dir)
    return true
  })

  // 图表外观
  ipcMain.handle(IPC.SETTINGS_GET_CHART_THEME, () => loadSettings().chartTheme)

  ipcMain.handle(IPC.SETTINGS_SET_CHART_THEME, (_e, theme: unknown) => {
    try {
      return { ok: true, theme: updateChartTheme(theme).chartTheme }
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) }
    }
  })

  // 全应用时区（默认 UTC+8）
  ipcMain.handle(IPC.SETTINGS_GET_TIMEZONE, () => loadSettings().timezone)

  ipcMain.handle(IPC.SETTINGS_SET_TIMEZONE, (_e, timezone: unknown) => {
    try {
      return { ok: true, timezone: updateTimezone(timezone).timezone }
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) }
    }
  })

  // 界面语言（中文 / English）
  ipcMain.handle(IPC.SETTINGS_GET_LOCALE, () => loadSettings().locale)

  ipcMain.handle(IPC.SETTINGS_SET_LOCALE, (_e, locale: unknown) => {
    try {
      return { ok: true, locale: updateLocale(locale).locale }
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) }
    }
  })

  // 指标显示偏好（默认全关，用户改过之后所有回测集通用）
  ipcMain.handle(IPC.SETTINGS_GET_INDICATOR_PREFS, () => loadSettings().indicatorPrefs)

  ipcMain.handle(IPC.SETTINGS_SET_INDICATOR_PREFS, (_e, prefs: unknown) => {
    try {
      return { ok: true, prefs: updateIndicatorPrefs(prefs).indicatorPrefs }
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) }
    }
  })

  // 标签库（下单备注浮窗里可一键点亮）
  ipcMain.handle(IPC.SETTINGS_GET_TRADE_TAGS, () => loadSettings().tradeTags)

  ipcMain.handle(IPC.SETTINGS_SET_TRADE_TAGS, (_e, tags: unknown) => {
    try {
      return { ok: true, tags: updateTradeTags(tags).tradeTags }
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) }
    }
  })

  // 交易成本模型（手续费 + 滑点）：用户级，所有回测集共用
  ipcMain.handle(IPC.SETTINGS_GET_EXECUTION_COST, () => loadSettings().executionCost)

  ipcMain.handle(IPC.SETTINGS_SET_EXECUTION_COST, (_e, cost: unknown) => {
    try {
      return { ok: true, cost: updateExecutionCost(cost).executionCost }
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) }
    }
  })

  console.log('[IPC] Settings handlers registered')
}
