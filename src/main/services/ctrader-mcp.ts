// ============================================================
// TraderRewind — cTrader 本地 MCP 客户端
//
// cTrader 桌面端（5.9+）内置了一个 MCP 服务，默认监听
//   http://127.0.0.1:<port>/mcp/
// 走 JSON-RPC 2.0 over HTTP（Streamable HTTP）。它暴露的
// get_trendbars 就是官方历史 K 线接口，参数：
//   symbolName / timeframe[m1 m5 m15 m30 h1 h4 d1 w1 month1] / from / to / limit
// 服务端硬上限单次 1000 根，且返回的是「范围内靠近 to 的最后一页」，
// 所以翻页只能从 to 往过去倒退。
//
// 与 OKX / Binance 不同，这里不需要代理：目标是 127.0.0.1，必须直连，
// 绝不能把系统代理套上去（否则会被转发到代理网关而 502）。
// ============================================================

import http from 'node:http'
import net from 'node:net'

export interface CtraderBar {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

/**
 * 经纪商目录里的一个品种。
 *
 * 注意 cTrader 的 get_symbols 实际返回字段是：
 *   name / description / category / assetClass
 * 其中 category 恒为 "Default Category"（没有信息量），真正的资产类别在
 * assetClass（Metals / Forex / Indices ...）。而且**不返回 digits**，
 * 小数位只能由上层按内置表或资产类别推断。
 */
export interface CtraderSymbol {
  symbol: string
  name: string
  /** 资产类别，取自 assetClass */
  assetClass: string
}

interface RpcResponse {
  jsonrpc?: string
  id?: number
  result?: any
  error?: { code?: number; message?: string }
}

/** cTrader 的周期写法 */
const TIMEFRAME_MAP: Record<string, string> = {
  M1: 'm1',
  M5: 'm5',
  M15: 'm15',
  M30: 'm30',
  H1: 'h1',
  H4: 'h4',
  D1: 'd1'
}

/** 默认端口：cTrader 设置页里显示的那个 */
export const DEFAULT_CTRADER_MCP_PORT = 9876

/**
 * 全局共享的客户端。
 *
 * 本地模式下，服务端同一时刻只认一个活跃 session（再 initialize 会被
 * 404 拒掉），所以品种枚举和 K 线下载必须复用同一个实例，各自 new 一个
 * 会互相踢。
 *
 * 远程模式同理复用，但用的是「端点 + token 尾号」做指纹：
 * 用户换 token 后应当重建连接，不能拿旧凭据的会话继续用。
 */
let sharedClient: CtraderMcpClient | null = null
let sharedKey: string | null = null

export function resolveCtraderPort(): number {
  const raw = Number(process.env.CTRADER_MCP_PORT)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_CTRADER_MCP_PORT
}

export function sharedCtraderClient(remote: RemoteMcpOptions | null = null): CtraderMcpClient {
  const key = remote ? `remote|${remote.url}|${remote.token.slice(-6)}` : `local|${resolveCtraderPort()}`
  if (!sharedClient || sharedKey !== key) {
    sharedClient = remote
      ? new CtraderMcpClient(DEFAULT_CTRADER_MCP_PORT, '/mcp/', remote)
      : new CtraderMcpClient(resolveCtraderPort())
    sharedKey = key
  }
  return sharedClient
}

/** 探活结果。up=true 表示端口在监听，也就是 cTrader 正开着且 MCP 已启用。 */
export interface McpProbeResult {
  up: boolean
  port: number
  /** 建立 TCP 连接耗时（毫秒）；失败时是超时/拒绝的耗时，用来区分「拒绝」和「超时」 */
  latencyMs: number
  error?: string
}

/**
 * 轻量探活 —— 只做一次 TCP 连接，不握手、不建会话。
 *
 * 为什么不能用 CtraderMcpClient.ping()：那个方法在已有 session 时直接返回
 * ok，压根不发网络请求。状态灯要反映「用户此刻有没有开着 cTrader」，
 * 用户把软件关掉之后 session 对象还在，灯就会一直绿着 —— 比不显示更糟。
 *
 * 也不用 initialize 探活：cTrader 的 session 表有上限且不会自动过期，
 * 每几秒 initialize 一次会迅速把配额吃光。TCP 连接则完全无副作用，
 * 端口在监听就说明 MCP 服务在跑（没勾选启用时这个端口根本不会开）。
 */
export async function probeLocalMcp(
  port: number = resolveCtraderPort(),
  timeoutMs = 1200
): Promise<McpProbeResult> {
  const started = Date.now()
  return new Promise<McpProbeResult>((resolve) => {
    let settled = false
    const done = (up: boolean, error?: string): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve({ up, port, latencyMs: Date.now() - started, error })
    }
    const socket = net.connect({ host: '127.0.0.1', port })
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false, `连接 127.0.0.1:${port} 超时`))
    socket.once('error', (e: NodeJS.ErrnoException) => {
      done(false, e.code === 'ECONNREFUSED' ? `端口 ${port} 未监听` : e.message)
    })
  })
}

/** 毫秒 → "2024-11-04T23:58:00Z"（cTrader 只认秒级 ISO） */
function toIso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19) + 'Z'
}

/** "2024-11-04T23:58:00Z" → 秒 */
function parseIso(ts: string): number {
  const t = Date.parse(ts)
  return Number.isFinite(t) ? Math.floor(t / 1000) : NaN
}

/**
 * 远程 MCP 端点配置。
 *
 * cTrader 的 Remote MCP 与本地版的区别只在传输层：同样是 JSON-RPC，
 * 只是地址变成 https，并且要多带一个 Bearer token。
 * 另外它按用途拆成多个路径（/trading/mcp、/data/mcp），
 * 我们要的只是行情，所以应当指向 data 那一条 —— 那条不带下单能力。
 */
export interface RemoteMcpOptions {
  url: string
  token: string
}

export class CtraderMcpClient {
  private readonly port: number
  private readonly path: string
  private readonly remote: RemoteMcpOptions | null
  private sessionId: string | null = null
  private protocolVersion: string | null = null
  private rpcId = 0

  constructor(
    port: number = DEFAULT_CTRADER_MCP_PORT,
    path = '/mcp/',
    remote: RemoteMcpOptions | null = null
  ) {
    this.port = port
    this.path = path
    this.remote = remote
  }

  /** 发一个 HTTP POST，返回 { headers, body } */
  private async post(
    payload: unknown,
    timeoutMs: number
  ): Promise<{ headers: http.IncomingHttpHeaders; body: string }> {
    const data = Buffer.from(JSON.stringify(payload), 'utf8')
    const headers: Record<string, string | number> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'Content-Length': data.length
    }
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId
    if (this.protocolVersion) headers['MCP-Protocol-Version'] = this.protocolVersion

    // ---- 远程分支：https + Bearer ----
    if (this.remote) {
      headers['Authorization'] = `Bearer ${this.remote.token}`
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const res = await fetch(this.remote.url, {
          method: 'POST',
          headers: headers as Record<string, string>,
          body: data,
          signal: controller.signal
        })
        const body = await res.text()
        return {
          headers: {
            'mcp-session-id': res.headers.get('mcp-session-id') ?? undefined,
            'content-type': res.headers.get('content-type') ?? undefined
          } as http.IncomingHttpHeaders,
          body
        }
      } catch (e) {
        throw new Error(
          `无法连接 cTrader Remote MCP（${this.remote.url}）：${(e as Error).message}。` +
            `该域名在部分网络下会被阻断，请确认网络可达或改用 Open API 凭据`
        )
      } finally {
        clearTimeout(timer)
      }
    }

    // ---- 本地分支：127.0.0.1，必须直连，不能套代理 ----
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: this.port, path: this.path, method: 'POST', headers },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () =>
            resolve({ headers: res.headers, body: Buffer.concat(chunks).toString('utf8') })
          )
        }
      )
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`cTrader MCP 请求超时（${timeoutMs}ms）`)))
      req.on('error', (e) =>
        reject(
          new Error(
            `无法连接 cTrader MCP（127.0.0.1:${this.port}）：${e.message}。` +
              `请确认 cTrader 正在运行，且 设置 → 应用程序 → MCP 设置 里已勾选「启用 MCP 服务器」`
          )
        )
      )
      req.write(data)
      req.end()
    })
  }

  /** 从响应里取出 JSON-RPC 结果（兼容 application/json 与 text/event-stream） */
  private parseRpc(body: string, contentType: string): RpcResponse | null {
    const text = (body || '').trim()
    if (!text) return null
    if (text.startsWith('event:') || text.startsWith('data:') || contentType.includes('text/event-stream')) {
      let out: RpcResponse | null = null
      for (const line of text.split(/\r?\n/)) {
        const l = line.trim()
        if (!l.startsWith('data:')) continue
        const payload = l.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        try {
          out = JSON.parse(payload) as RpcResponse
        } catch {
          /* 忽略心跳等非 JSON 帧 */
        }
      }
      return out
    }
    return JSON.parse(text) as RpcResponse
  }

  /** 握手：initialize + notifications/initialized */
  async initialize(timeoutMs = 20000): Promise<void> {
    this.rpcId += 1
    const res = await this.post(
      {
        jsonrpc: '2.0',
        id: this.rpcId,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'traderrewind', version: '0.2.9' }
        }
      },
      timeoutMs
    )

    const sid = res.headers['mcp-session-id']
    if (typeof sid === 'string' && sid) this.sessionId = sid

    const rpc = this.parseRpc(res.body, String(res.headers['content-type'] ?? ''))
    if (rpc?.error) throw new Error(`cTrader MCP 握手失败：${rpc.error.message ?? '未知错误'}`)
    const pv = rpc?.result?.protocolVersion
    if (typeof pv === 'string') this.protocolVersion = pv

    // initialized 是通知，无 id，服务端通常回 202 空体
    try {
      await this.post(
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        timeoutMs
      )
    } catch {
      /* 通知失败不影响后续调用 */
    }
  }

  /** 调用某个工具 */
  async callTool(name: string, args: Record<string, unknown>, timeoutMs = 90000): Promise<any> {
    if (!this.sessionId) await this.initialize()

    this.rpcId += 1
    const res = await this.post(
      { jsonrpc: '2.0', id: this.rpcId, method: 'tools/call', params: { name, arguments: args } },
      timeoutMs
    )
    const rpc = this.parseRpc(res.body, String(res.headers['content-type'] ?? ''))
    if (rpc?.error) throw new Error(`${name} 调用失败：${rpc.error.message ?? '未知错误'}`)
    return rpc?.result
  }

  /** MCP 把业务数据塞在 content[0].text 里，内容是 JSON 字符串 */
  private unwrapBars(result: any): { bars: any[]; truncated: boolean } {
    const parts: any[] = Array.isArray(result?.content) ? result.content : []
    for (const p of parts) {
      if (p?.type === 'text' && typeof p.text === 'string') {
        try {
          const parsed = JSON.parse(p.text)
          return { bars: Array.isArray(parsed?.bars) ? parsed.bars : [], truncated: !!parsed?.truncated }
        } catch {
          /* 继续找下一段 */
        }
      }
    }
    return { bars: [], truncated: false }
  }

  /**
   * 取一页 K 线。
   * @param toMs 本页的时间上界（含），返回的是靠近这个上界的最后一页
   */
  async getTrendbarsPage(
    symbol: string,
    timeframe: string,
    fromMs: number,
    toMs: number,
    limit = 1000
  ): Promise<{ bars: CtraderBar[]; nextCursor: number | null }> {
    const tf = TIMEFRAME_MAP[timeframe]
    if (!tf) throw new Error(`cTrader 不支持的周期：${timeframe}`)

    const result = await this.callTool('get_trendbars', {
      symbolName: symbol,
      timeframe: tf,
      from: toIso(fromMs),
      to: toIso(toMs),
      limit
    })

    const { bars: raw } = this.unwrapBars(result)

    const bars: CtraderBar[] = []
    let minSec = Infinity
    for (const b of raw) {
      const t = parseIso(String(b?.timestamp ?? ''))
      if (!Number.isFinite(t)) continue
      const o = Number(b.open)
      const h = Number(b.high)
      const l = Number(b.low)
      const c = Number(b.close)
      if (![o, h, l, c].every(Number.isFinite)) continue
      if (t * 1000 < fromMs) continue
      bars.push({ time: t, open: o, high: h, low: l, close: c, volume: Number(b.volume) || 0 })
      if (t < minSec) minSec = t
    }
    bars.sort((a, b) => a.time - b.time)

    // 往回翻：本页最早那根的前一分钟就是下一页的上界
    const nextCursor = Number.isFinite(minSec) && minSec * 1000 > fromMs ? (minSec - 60) * 1000 : null
    return { bars, nextCursor }
  }

  /** 探活：能不能连上、cTrader 是否开着 MCP */
  async ping(): Promise<{ ok: boolean; error?: string }> {
    try {
      if (!this.sessionId) await this.initialize()
      return { ok: true }
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) }
    }
  }

  /** 当前是否握着一个活跃会话 */
  get hasSession(): boolean {
    return this.sessionId != null
  }

  /**
   * 主动终止会话。
   *
   * 这一步不能省：cTrader 的 session 注册表有数量上限，而且**不会自动过期**
   * （实测 45 秒后依旧拒绝新会话）。如果不发 DELETE 就直接退出，每启动一次
   * 应用就泄漏一个 session，累积到上限后连 initialize 都会返回 404，
   * 只能靠关闭再打开 MCP 开关来重置。所以退出前必须显式清理。
   */
  async close(): Promise<void> {
    const sid = this.sessionId
    if (!sid) return
    this.sessionId = null

    const headers: Record<string, string> = {
      'Mcp-Session-Id': sid,
      'MCP-Protocol-Version': this.protocolVersion ?? ''
    }

    // 远程端点同样要显式收尾，否则远程侧也会累积幽灵会话
    if (this.remote) {
      try {
        headers['Authorization'] = `Bearer ${this.remote.token}`
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 4000)
        await fetch(this.remote.url, { method: 'DELETE', headers, signal: controller.signal })
        clearTimeout(timer)
      } catch {
        /* 收尾失败不影响退出 */
      }
      return
    }

    await new Promise<void>((resolve) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: this.port,
          path: this.path,
          method: 'DELETE',
          headers
        },
        (res) => {
          res.resume()
          res.on('end', () => resolve())
        }
      )
      req.setTimeout(4000, () => req.destroy())
      req.on('error', () => resolve())
      req.end()
    })
  }

  /**
   * 拉经纪商的全部可交易品种。
   *
   * 字段名按 cTrader MCP 的返回宽松解析：不同版本用过 symbolName / symbol、
   * description / name 两套写法，取到哪个算哪个，避免因为一次字段改名就
   * 整个品种列表空掉。
   */
  async listSymbols(filter?: string, timeoutMs = 60000): Promise<CtraderSymbol[]> {
    const args: Record<string, unknown> = {}
    if (filter) args.filter = filter
    const result = await this.callTool('get_symbols', args, timeoutMs)

    const parts: any[] = Array.isArray(result?.content) ? result.content : []
    let payload: any = null
    for (const p of parts) {
      if (p?.type === 'text' && typeof p.text === 'string') {
        try {
          payload = JSON.parse(p.text)
          break
        } catch {
          /* 继续找 */
        }
      }
    }
    if (!payload) return []

    const rows: any[] = Array.isArray(payload)
      ? payload
      : Array.isArray(payload.symbols)
        ? payload.symbols
        : Array.isArray(payload.items)
          ? payload.items
          : []

    const out: CtraderSymbol[] = []
    for (const r of rows) {
      const symbol = String(r?.name ?? r?.symbolName ?? r?.symbol ?? '').trim()
      if (!symbol) continue
      out.push({
        symbol,
        name: String(r?.description ?? r?.displayName ?? symbol),
        assetClass: String(r?.assetClass ?? r?.category ?? '')
      })
    }
    return out
  }
}
