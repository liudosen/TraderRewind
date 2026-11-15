// ============================================================
// TraderRewind — 本地 MCP 服务器类型
//
// 应用内跑一个只读的 MCP（Model Context Protocol）服务，把训练库里的
// 会话 / 订单，以及行情库里的 M1 数据（按需聚合 M5/M30/...）暴露给
// 外部 AI 客户端。默认只监听 127.0.0.1，不提供任何写操作。
// ============================================================

/** 默认端口：选一个不常见的本地端口，避开 cTrader 的 9876 */
export const DEFAULT_MCP_PORT = 47821

export interface McpSettings {
  /** 是否随应用启动 */
  enabled: boolean
  /** 监听端口（仅 127.0.0.1） */
  port: number
}

export const DEFAULT_MCP_SETTINGS: McpSettings = {
  enabled: true,
  port: DEFAULT_MCP_PORT
}

/** 任意输入 → 合法 MCP 配置；非法值回退默认 */
export function normalizeMcpSettings(value: unknown): McpSettings {
  const raw = (value ?? {}) as Partial<McpSettings>
  const port = Number(raw.port)
  return {
    // 没写过这个字段的老 settings.json 视为「新功能默认开启」；
    // 只有用户明确关掉（存了 false）才保持关闭。
    enabled: raw.enabled !== false,
    port:
      Number.isFinite(port) && port >= 1024 && port <= 65535
        ? Math.floor(port)
        : DEFAULT_MCP_PORT
  }
}

/** MCP 工具摘要，设置页展示用 */
export interface McpToolSummary {
  name: string
  title: string
  description: string
}

/** MCP 服务器运行状态 */
export interface McpStatus {
  enabled: boolean
  running: boolean
  port: number
  url: string
  startedAt: number | null
  error: string | null
  /** 当前保持着的 MCP 会话数（每个 AI 客户端一条） */
  sessions: number
  tools: McpToolSummary[]
  version: string
}
