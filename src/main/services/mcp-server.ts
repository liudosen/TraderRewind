// ============================================================
// TraderRewind — 内置只读 MCP 服务器（Streamable HTTP）
//
// 传输：JSON-RPC 2.0 over HTTP，端点 http://127.0.0.1:<port>/mcp
// 兼容 MCP 2025-06-18 / 2025-03-26 / 2024-11-05 的 tools + resources。
//
// 为什么不用 stdio：MCP 客户端（Claude Desktop / Cursor / DeepSeek
// Harness）更常见的是 Streamable HTTP；而且应用本身已经是一个长驻
// 进程，HTTP 不需要为每次会话再拉起一个 Electron 子进程。
//
// 安全边界：只 bind 127.0.0.1；只读；拒绝非本机 Origin；不提供任何
// 下单 / 改单 / 删库工具。
// ============================================================

import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import type { McpStatus, McpToolSummary } from '@shared/types/mcp'
import { loadSettings } from '../settings'
import {
  callMcpTool,
  mcpServerInfo,
  mcpToolDefinitions,
  mcpToolSummaries
} from './mcp-tools'
import { listSessionSummaries, listTrades } from './trade-analytics'

const MCP_PATH = '/mcp'
const MAX_BODY_BYTES = 8 * 1024 * 1024
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const
const LATEST_PROTOCOL = SUPPORTED_PROTOCOLS[0]

interface McpSession {
  id: string
  protocolVersion: string
  createdAt: number
  lastSeenAt: number
}

interface JsonRpcRequest {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: any
}

class McpHttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

function json(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  })
  res.end(body)
}

function rpcError(
  res: http.ServerResponse,
  status: number,
  id: string | number | null | undefined,
  code: number,
  message: string
): void {
  json(res, status, {
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code, message }
  })
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new McpHttpError(413, '请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function allowedOrigin(origin: string | undefined): boolean {
  // 非浏览器客户端（Node / Python / curl）通常不带 Origin
  if (!origin) return true
  try {
    const u = new URL(origin)
    return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1'
  } catch {
    return false
  }
}

export class TraderRewindMcpServer {
  private server: http.Server | null = null
  private readonly sessions = new Map<string, McpSession>()
  private startedAt: number | null = null
  private lastError: string | null = null
  private port: number

  constructor(port: number) {
    this.port = port
  }

  get running(): boolean {
    return this.server != null
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}${MCP_PATH}`
  }

  status(): McpStatus {
    const settings = loadSettings()
    return {
      enabled: settings.mcp.enabled,
      running: this.running,
      port: this.port,
      url: this.url,
      startedAt: this.startedAt,
      error: this.lastError,
      sessions: this.activeSessionCount(),
      tools: mcpToolSummaries(),
      version: this.safeVersion()
    }
  }

  /** 只统计最近 5 分钟还有请求的会话，避免后台客户端断开后数字一直涨 */
  private activeSessionCount(): number {
    const cutoff = Date.now() - 5 * 60 * 1000
    let n = 0
    for (const s of this.sessions.values()) {
      if (s.lastSeenAt >= cutoff) n++
    }
    return n
  }

  private safeVersion(): string {
    try {
      // 开发态 app.getVersion() 返回 Electron 自己的版本，必须优先用构建注入的 package 版本
      if (typeof __APP_VERSION__ === 'string' && __APP_VERSION__) return __APP_VERSION__
      return app.getVersion()
    } catch {
      return '0.0.0'
    }
  }

  async start(): Promise<McpStatus> {
    if (this.server) return this.status()
    this.lastError = null
    const server = http.createServer((req, res) => {
      void this.handle(req, res).catch((e) => {
        const err = e instanceof McpHttpError ? e : new McpHttpError(500, String(e))
        if (!res.headersSent) {
          json(res, err.status, {
            jsonrpc: '2.0',
            id: null,
            error: { code: -32603, message: err.message }
          })
        } else {
          res.end()
        }
      })
    })
    server.on('clientError', (_err, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    })

    await new Promise<void>((resolve, reject) => {
      const onError = (e: NodeJS.ErrnoException): void => {
        server.off('listening', onListening)
        reject(e)
      }
      const onListening = (): void => {
        server.off('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(this.port, '127.0.0.1')
    }).catch((e: NodeJS.ErrnoException) => {
      this.lastError =
        e.code === 'EADDRINUSE'
          ? `端口 ${this.port} 已被占用，请换一个端口`
          : `MCP 服务启动失败：${e.message}`
      throw new Error(this.lastError)
    })

    this.server = server
    this.startedAt = Date.now()
    console.log(`[MCP] 只读服务已启动: ${this.url}`)
    return this.status()
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    this.startedAt = null
    this.sessions.clear()
    if (!server) return
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      // 连接可能被 keep-alive 挂住，最多等 1.5 秒
      setTimeout(resolve, 1500)
    })
    console.log('[MCP] 服务已停止')
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined
    if (!allowedOrigin(origin)) {
      json(res, 403, { error: '只允许本机 Origin 访问' })
      return
    }
    // 本机浏览器客户端（例如自己写的调试页）走 CORS
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID'
    )
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, MCP-Protocol-Version')

    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`)
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }
    if (url.pathname === '/health') {
      json(res, 200, {
        ok: true,
        name: mcpServerInfo().name,
        version: this.safeVersion(),
        port: this.port,
        sessions: this.sessions.size,
        tools: mcpToolSummaries().map((t) => t.name)
      })
      return
    }
    if (url.pathname !== MCP_PATH && url.pathname !== `${MCP_PATH}/`) {
      json(res, 404, { error: 'Not found. MCP endpoint is /mcp' })
      return
    }

    if (req.method === 'GET') {
      // 不提供服务端主动推送；按 MCP Streamable HTTP 规范回 405 是允许的
      res.setHeader('Allow', 'POST, DELETE, OPTIONS')
      json(res, 405, { error: '此 MCP 服务不使用 SSE GET，请用 POST /mcp' })
      return
    }
    if (req.method === 'DELETE') {
      const sid = String(req.headers['mcp-session-id'] ?? '')
      if (sid) this.sessions.delete(sid)
      res.writeHead(204)
      res.end()
      return
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST, DELETE, OPTIONS')
      json(res, 405, { error: 'Method not allowed' })
      return
    }

    let parsed: unknown
    try {
      const text = await readBody(req)
      if (!text.trim()) throw new McpHttpError(400, '空请求体')
      parsed = JSON.parse(text)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      json(res, e instanceof McpHttpError ? e.status : 400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: `JSON 解析失败：${msg}` }
      })
      return
    }

    const session = this.resolveSession(req, res)
    const isBatch = Array.isArray(parsed)
    const requests: JsonRpcRequest[] = isBatch ? (parsed as JsonRpcRequest[]) : [parsed as JsonRpcRequest]
    const responses: unknown[] = []

    for (const rpc of requests) {
      if (!rpc || typeof rpc !== 'object') {
        responses.push({ jsonrpc: '2.0', id: null, error: { code: -32600, message: '无效请求' } })
        continue
      }
      const response = await this.dispatch(rpc, session, res)
      if (response !== undefined) responses.push(response)
    }

    if (responses.length === 0) {
      res.writeHead(202)
      res.end()
      return
    }
    json(res, 200, isBatch ? responses : responses[0])
  }

  private resolveSession(req: http.IncomingMessage, res: http.ServerResponse): McpSession {
    const sidHeader = req.headers['mcp-session-id']
    const sid = typeof sidHeader === 'string' ? sidHeader.trim() : ''
    if (sid) {
      const existing = this.sessions.get(sid)
      if (existing) {
        existing.lastSeenAt = Date.now()
        return existing
      }
    }
    // 无会话时也允许（stateless 客户端）；initialize 会把它登记进 Map
    const session: McpSession = {
      id: sid || randomUUID(),
      protocolVersion: String(req.headers['mcp-protocol-version'] ?? LATEST_PROTOCOL),
      createdAt: Date.now(),
      lastSeenAt: Date.now()
    }
    res.setHeader('Mcp-Session-Id', session.id)
    return session
  }

  private registerSession(session: McpSession, protocolVersion: string): void {
    session.protocolVersion = protocolVersion
    this.sessions.set(session.id, session)
    // 顺手清掉 1 小时没动的会话，避免 Map 无限增长
    const cutoff = Date.now() - 3600 * 1000
    for (const [id, s] of this.sessions) {
      if (s.lastSeenAt < cutoff) this.sessions.delete(id)
    }
  }

  private async dispatch(
    rpc: JsonRpcRequest,
    session: McpSession,
    res: http.ServerResponse
  ): Promise<unknown> {
    const id = rpc.id
    const method = String(rpc.method ?? '')
    const isNotification = id == null

    if (method === 'initialize') {
      const requested = String(rpc.params?.protocolVersion ?? '')
      const protocol = (SUPPORTED_PROTOCOLS as readonly string[]).includes(requested)
        ? requested
        : LATEST_PROTOCOL
      this.registerSession(session, protocol)
      res.setHeader('Mcp-Session-Id', session.id)
      res.setHeader('MCP-Protocol-Version', protocol)
      const info = mcpServerInfo()
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: protocol,
          capabilities: {
            tools: { listChanged: false },
            resources: { subscribe: false, listChanged: false }
          },
          serverInfo: {
            name: info.name,
            title: info.title,
            version: this.safeVersion(),
            description: info.description
          },
          instructions: info.instructions
        }
      }
    }

    if (method.startsWith('notifications/')) {
      // initialized / cancelled / progress … 都是通知，不需要回包
      return undefined
    }

    if (isNotification) return undefined

    if (method === 'ping') {
      return { jsonrpc: '2.0', id, result: {} }
    }

    if (method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id,
        result: { tools: mcpToolDefinitions() }
      }
    }

    if (method === 'tools/call') {
      const name = String(rpc.params?.name ?? '')
      if (!name) {
        return { jsonrpc: '2.0', id, error: { code: -32602, message: '缺少工具名' } }
      }
      const { payload, isError } = await callMcpTool(name, rpc.params?.arguments ?? {})
      const text =
        typeof payload === 'string' ? payload : JSON.stringify(payload)
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text }],
          structuredContent: payload,
          ...(isError ? { isError: true } : {})
        }
      }
    }

    if (method === 'resources/list') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          resources: [
            {
              uri: 'traderrewind://sessions',
              name: 'TraderRewind 回测集汇总',
              title: '全部回测集',
              description: '每个回测集的品种、区间、盈亏、胜率、盈亏比、最大回撤。',
              mimeType: 'application/json'
            },
            {
              uri: 'traderrewind://trades',
              name: 'TraderRewind 全部订单',
              title: '全部交易日志',
              description: '最多 1000 笔平仓订单的完整字段。',
              mimeType: 'application/json'
            },
            {
              uri: 'traderrewind://guide',
              name: 'TraderRewind MCP 使用说明',
              title: '数据口径与工具说明',
              description: '字段口径、R 的定义、推荐分析流程。',
              mimeType: 'text/markdown'
            }
          ]
        }
      }
    }

    if (method === 'resources/templates/list') {
      return { jsonrpc: '2.0', id, result: { resourceTemplates: [] } }
    }

    if (method === 'resources/read') {
      const uri = String(rpc.params?.uri ?? '')
      let text = ''
      let mimeType = 'application/json'
      if (uri === 'traderrewind://sessions') {
        text = JSON.stringify(listSessionSummaries(true))
      } else if (uri === 'traderrewind://trades') {
        text = JSON.stringify(listTrades({ limit: 1000, order: 'asc' }))
      } else if (uri === 'traderrewind://guide') {
        mimeType = 'text/markdown'
        text = guideMarkdown()
      } else {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32602, message: `未知资源：${uri}` }
        }
      }
      return {
        jsonrpc: '2.0',
        id,
        result: { contents: [{ uri, mimeType, text }] }
      }
    }

    if (method === 'prompts/list') {
      return { jsonrpc: '2.0', id, result: { prompts: [] } }
    }

    if (method === 'logging/setLevel') {
      return { jsonrpc: '2.0', id, result: {} }
    }

    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `不支持的方法：${method}` }
    }
  }
}

function guideMarkdown(): string {
  const tools = mcpToolSummaries()
  return [
    '# TraderRewind MCP',
    '',
    '本地只读的 MCP 服务。数据来自当前用户的 `training.db`（会话 / 订单）和 `market.db`（M1 行情）。',
    '',
    '## 时间口径',
    '',
    '- 订单时间：epoch **毫秒**，同时给 `*Iso` 和 `*Local`（会话时区，默认 UTC+8）。',
    '- K 线时间：epoch **秒**（TradingView 口径），同时给 `timeIso`。',
    '- M5/M15/M30/H1/H4/D1 都由 M1 聚合，桶起点按 UTC 自然日对齐。',
    '',
    '## R 的口径（重要）',
    '',
    '- `rOnRiskTarget = profit / 会话 risk_per_trade`：跨单可比的「风险预算 R」。',
    '- `rMultiple`：应用原始字段 = 盈亏 / 平仓时止损距离。移动过止损（trail、部分 tp/manual）时，',
    '  分母不是初始风险，R 会失真。',
    '- `initialRiskUsd` / `initialSlPrice`：只在 sl/tp 且止损仍在开仓价亏损侧时可靠。',
    '- `riskBasis`：`initial_stop` / `moved_stop` / `unknown`，用它决定是否采信 R。',
    '',
    '## 工具',
    '',
    ...tools.map((t) => `- \`${t.name}\` — ${t.description}`),
    ''
  ].join('\n')
}

// ---------- 进程级单例 ----------

let sharedServer: TraderRewindMcpServer | null = null

export function sharedMcpServer(): TraderRewindMcpServer {
  const port = loadSettings().mcp.port
  if (!sharedServer || sharedServer.status().port !== port) {
    sharedServer = new TraderRewindMcpServer(port)
  }
  return sharedServer
}

export async function startMcpServer(): Promise<McpStatus> {
  const settings = loadSettings()
  const server = sharedMcpServer()
  if (!settings.mcp.enabled) {
    return server.status()
  }
  try {
    return await server.start()
  } catch (e) {
    console.error('[MCP]', e instanceof Error ? e.message : e)
    return server.status()
  }
}

export async function stopMcpServer(): Promise<void> {
  if (!sharedServer) return
  await sharedServer.stop()
}

export async function restartMcpServer(): Promise<McpStatus> {
  if (sharedServer) await sharedServer.stop()
  sharedServer = null
  return startMcpServer()
}

export function getMcpStatus(): McpStatus {
  const settings = loadSettings()
  if (!sharedServer) {
    return {
      enabled: settings.mcp.enabled,
      running: false,
      port: settings.mcp.port,
      url: `http://127.0.0.1:${settings.mcp.port}${MCP_PATH}`,
      startedAt: null,
      error: null,
      sessions: 0,
      tools: mcpToolSummaries() as McpToolSummary[],
      version: (() => {
        try {
          if (typeof __APP_VERSION__ === 'string' && __APP_VERSION__) return __APP_VERSION__
          return app.getVersion()
        } catch {
          return '0.0.0'
        }
      })()
    }
  }
  const status = sharedServer.status()
  // 停用 / 未运行时端口以 settings 为准：改了端口但还没重启时，UI 不能显示旧端口
  if (!settings.mcp.enabled || !status.running) {
    return {
      ...status,
      enabled: settings.mcp.enabled,
      port: settings.mcp.port,
      url: `http://127.0.0.1:${settings.mcp.port}${MCP_PATH}`
    }
  }
  return status
}
