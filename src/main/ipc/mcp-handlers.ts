// ============================================================
// TraderRewind — 本地 MCP 服务 IPC
// ============================================================

import { ipcMain } from 'electron'
import { IPC } from '@shared/constants/ipc'
import { loadSettings, updateMcpSettings } from '../settings'
import {
  getMcpStatus,
  restartMcpServer,
  stopMcpServer
} from '../services/mcp-server'

export function registerMcpHandlers(): void {
  ipcMain.handle(IPC.MCP_GET_STATUS, () => getMcpStatus())

  ipcMain.handle(IPC.MCP_SET_SETTINGS, async (_e, patch: unknown) => {
    const before = loadSettings().mcp
    const next = updateMcpSettings({ ...before, ...(patch as object) })
    const changed = before.enabled !== next.mcp.enabled || before.port !== next.mcp.port
    if (!changed) return getMcpStatus()
    if (!next.mcp.enabled) {
      await stopMcpServer()
      return getMcpStatus()
    }
    return restartMcpServer()
  })

  ipcMain.handle(IPC.MCP_RESTART, async () => {
    const settings = loadSettings()
    if (!settings.mcp.enabled) return getMcpStatus()
    return restartMcpServer()
  })
}
