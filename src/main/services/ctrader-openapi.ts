// ============================================================
// TraderRewind — cTrader Open API 客户端（JSON over TLS）
//
// 为什么不用 MCP 而走 Open API：
//   桌面端 MCP 依赖 cTrader 进程运行；Remote MCP 的域名
//   (mcp.ctrader.com) 在部分网络下会在 TLS 握手阶段被重置，
//   客户端无法绕过。而 Open API 的 live.ctraderapi.com:**5036**
//   是非标准端口，实测可稳定握手，且不需要用户挂 VPN。
//
// 为什么是 JSON 而不是 Protobuf：
//   同一份服务在 5035 说 Protobuf、在 5036 说 JSON。选 5036 可以
//   完全省掉 protobuf 运行时依赖，帧格式就是：
//     {"clientMsgId":"1","payloadType":2100,"payload":{...}}
//
// 三个容易踩的坑（已按 proto 定义核对）：
//   1. ProtoOATrendbarPeriod 是枚举序号，不是分钟数 ——
//      例如 M10 = 6、H1 = 9、D1 = 12，不能拿分钟数当 period 传。
//   2. 价格是增量编码：low 为绝对价，开高低收分别用
//      low + deltaOpen / deltaHigh / deltaClose 还原，单位 1e-5。
//   3. 历史数据限流 5 req/s（按连接），且必须维持心跳，
//      否则连接会被服务端断开。
// ============================================================

import type tls from 'node:tls'
import { connectTls } from './doh'

/** 消息类型。数值取自 spotware/openapi-proto-messages 的枚举定义 */
export const CTRADER_PAYLOAD = {
  ERROR_RES: 50,
  HEARTBEAT_EVENT: 51,
  APP_AUTH_REQ: 2100,
  APP_AUTH_RES: 2101,
  ACCOUNT_AUTH_REQ: 2102,
  ACCOUNT_AUTH_RES: 2103,
  SYMBOLS_LIST_REQ: 2114,
  SYMBOLS_LIST_RES: 2115,
  GET_TRENDBARS_REQ: 2137,
  GET_TRENDBARS_RES: 2138,
  OA_ERROR_RES: 2142,
  GET_ACCOUNTS_BY_TOKEN_REQ: 2149,
  GET_ACCOUNTS_BY_TOKEN_RES: 2150,
  REFRESH_TOKEN_REQ: 2173,
  REFRESH_TOKEN_RES: 2174
} as const

/**
 * K 线周期枚举。
 *
 * 注意这不是分钟数：M10 是 6、H1 是 9、D1 是 12。
 */
export const CTRADER_PERIOD: Record<string, number> = {
  M1: 1,
  M2: 2,
  M3: 3,
  M4: 4,
  M5: 5,
  M10: 6,
  M15: 7,
  M30: 8,
  H1: 9,
  H4: 10,
  H12: 11,
  D1: 12,
  W1: 13,
  MN1: 14
}

/** cTrader 价格按 5 位小数定点存储 */
const PRICE_SCALE = 100_000

/** 历史数据限流 5 req/s，留一点余量 */
const HISTORY_MIN_INTERVAL_MS = 220

export interface OpenApiBar {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface OpenApiSymbol {
  symbolId: number
  symbolName: string
  description: string
}

export interface OpenApiCredentials {
  clientId: string
  clientSecret: string
  accessToken: string
  /** 可省略：省略时只做应用认证，之后用 listAccounts 自动枚举账户 */
  accountId?: number
  /** live 或 demo */
  environment?: 'live' | 'demo'
}

export interface OpenApiAccount {
  accountId: number
  isLive: boolean
  traderLogin: number
  broker: string
}

interface RpcFrame {
  clientMsgId?: string
  payloadType?: number
  payload?: any
}

/**
 * 从字节流里切出第一个完整的 JSON 对象。
 *
 * TCP 是流式的，一个 chunk 里可能有半条消息，也可能粘着好几条。
 * 必须自己按大括号深度切分（不能用 split('}{')，字符串里也可能出现括号）。
 */
function sliceJson(text: string): { json: string; rest: string } | null {
  const start = text.indexOf('{')
  if (start < 0) return null

  let depth = 0
  let inString = false
  let escaped = false

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        return { json: text.slice(start, i + 1), rest: text.slice(i + 1) }
      }
    }
  }
  return null
}

interface Pending {
  resolve: (payload: any) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

export class CtraderOpenApiClient {
  private sock: tls.TLSSocket | null = null
  private buffer = ''
  private seq = 0
  private pending = new Map<string, Pending>()
  private heartbeatTimer: NodeJS.Timeout | null = null
  private lastHistoryAt = 0
  private closed = false

  get connected(): boolean {
    return this.sock != null && !this.closed
  }

  /** 底层收发一条帧 */
  private send(payloadType: number, payload: Record<string, unknown>, clientMsgId?: string): void {
    if (!this.sock) throw new Error('尚未连接 cTrader Open API')
    const frame: RpcFrame = { payloadType, payload }
    if (clientMsgId) frame.clientMsgId = clientMsgId
    this.sock.write(JSON.stringify(frame))
  }

  /** 收流并派发，直到攒不出完整 JSON 为止 */
  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8')
    for (;;) {
      const piece = sliceJson(this.buffer)
      if (!piece) break
      this.buffer = piece.rest
      let frame: RpcFrame
      try {
        frame = JSON.parse(piece.json) as RpcFrame
      } catch {
        continue
      }
      this.dispatch(frame)
    }
  }

  private dispatch(frame: RpcFrame): void {
    const type = frame.payloadType

    // 心跳不需要处理，也不该占用 pending
    if (type === CTRADER_PAYLOAD.HEARTBEAT_EVENT) return

    const id = frame.clientMsgId
    if (type === CTRADER_PAYLOAD.ERROR_RES || type === CTRADER_PAYLOAD.OA_ERROR_RES) {
      const message =
        frame.payload?.description || frame.payload?.errorCode || frame.payload?.message || '未知错误'
      const code = frame.payload?.errorCode ? `（${frame.payload.errorCode}）` : ''
      if (id && this.pending.has(id)) {
        const p = this.pending.get(id)!
        clearTimeout(p.timer)
        this.pending.delete(id)
        p.reject(new Error(`${message}${code}`))
      }
      return
    }

    if (id && this.pending.has(id)) {
      const p = this.pending.get(id)!
      clearTimeout(p.timer)
      this.pending.delete(id)
      p.resolve(frame.payload)
    }
  }

  /** 发一条请求并等待对应响应 */
  private request(
    payloadType: number,
    payload: Record<string, unknown>,
    timeoutMs = 30_000
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = String(++this.seq)
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`cTrader Open API 请求超时（payloadType=${payloadType}）`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.send(payloadType, payload, id)
      } catch (e) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(e as Error)
      }
    })
  }

  /**
   * 建立连接并完成两级认证。
   *
   * 握手顺序是固定的：先应用认证（clientId/secret 证明「是谁在调」），
   * 再账户认证（accessToken 证明「被授权访问哪个账户」），两步都通过
   * 才能拉数据。
   */
  async connect(creds: OpenApiCredentials): Promise<void> {
    const env = creds.environment ?? 'live'
    const host = env === 'demo' ? 'demo.ctraderapi.com' : 'live.ctraderapi.com'

    await this.close()

    const sock = await connectTls(host, 5036, { timeoutMs: 15_000 })
    this.sock = sock
    this.closed = false
    this.buffer = ''

    sock.on('data', (c: Buffer) => this.onData(c))
    sock.on('error', () => this.failAll(new Error('cTrader Open API 连接已断开')))
    sock.on('close', () => this.failAll(new Error('cTrader Open API 连接已关闭')))

    // 心跳：官方要求 10 秒内必须有消息，否则连接会被回收
    this.heartbeatTimer = setInterval(() => {
      try {
        this.send(CTRADER_PAYLOAD.HEARTBEAT_EVENT, {})
      } catch {
        /* 连接已断，交给 error 回调处理 */
      }
    }, 5_000)

    await this.request(CTRADER_PAYLOAD.APP_AUTH_REQ, {
      clientId: creds.clientId,
      clientSecret: creds.clientSecret
    })

    if (creds.accountId) {
      await this.authAccount(creds.accountId, creds.accessToken)
    }
  }

  /** 账户级认证（第二步）。应用认证通过后才能调 */
  async authAccount(accountId: number, accessToken: string): Promise<void> {
    await this.request(CTRADER_PAYLOAD.ACCOUNT_AUTH_REQ, {
      ctidTraderAccountId: accountId,
      accessToken
    })
  }

  /**
   * 用 accessToken 列出该授权下的所有交易账户。
   *
   * 这一步在账户认证之前调用，用来免掉「让用户自己去客户端里抄账户 ID」
   * 这种容易出错的环节。返回项里 isLive 决定该连 live 还是 demo 环境。
   */
  async listAccounts(accessToken: string, timeoutMs = 30_000): Promise<OpenApiAccount[]> {
    const res = await this.request(
      CTRADER_PAYLOAD.GET_ACCOUNTS_BY_TOKEN_REQ,
      { accessToken },
      timeoutMs
    )
    const rows: any[] = Array.isArray(res?.ctidTraderAccount) ? res.ctidTraderAccount : []
    return rows.map((r) => ({
      accountId: Number(r?.ctidTraderAccountId ?? 0),
      isLive: r?.isLive !== false,
      traderLogin: Number(r?.traderLogin ?? 0),
      broker: String(r?.brokerTitleShort ?? '')
    }))
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
  }

  /**
   * 拉品种列表。
   *
   * 注意 ProtoOALightSymbol 不含 digits，小数位需要上层自己推断
   * （和桌面端 MCP 的行为一致）。
   */
  async listSymbols(accountId: number, timeoutMs = 60_000): Promise<OpenApiSymbol[]> {
    const res = await this.request(
      CTRADER_PAYLOAD.SYMBOLS_LIST_REQ,
      { ctidTraderAccountId: accountId, includeArchivedSymbols: false },
      timeoutMs
    )
    const rows: any[] = Array.isArray(res?.symbol) ? res.symbol : []
    const out: OpenApiSymbol[] = []
    for (const r of rows) {
      const name = String(r?.symbolName ?? '').trim()
      if (!name) continue
      if (r?.enabled === false) continue
      out.push({
        symbolId: Number(r.symbolId),
        symbolName: name,
        description: String(r?.description ?? name)
      })
    }
    return out
  }

  /**
   * 历史数据请求串行化。
   *
   * 服务端按「单连接 5 req/s」限流，而下载器为了吞吐会并发开多个窗口。
   * 如果让并发直接打到 socket 上，会出现一批请求同时通过节流判断、
   * 然后集体被限流 —— 表现为随机失败重试，比串行还慢。
   * 这里用一个队列把历史请求压成串行，每次间隔 HISTORY_MIN_INTERVAL_MS，
   * 上层并发多少都不会越限。
   */
  private historyQueue: Promise<unknown> = Promise.resolve()

  private enqueueHistory<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.historyQueue.then(async () => {
      const wait = this.lastHistoryAt + HISTORY_MIN_INTERVAL_MS - Date.now()
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      this.lastHistoryAt = Date.now()
      return fn()
    })
    // 队列本身不能因为某一页失败而断掉，所以吞掉异常
    this.historyQueue = run.catch(() => undefined)
    return run
  }

  /**
   * 取一段历史 K 线。
   *
   * @param count 期望根数。服务端单次有上限，返回不足且 hasMore 为真时
   *              需要继续往更早的时间翻页。
   */
  async getTrendbars(
    accountId: number,
    symbolId: number,
    timeframe: string,
    fromMs: number,
    toMs: number,
    count = 1000
  ): Promise<{ bars: OpenApiBar[]; hasMore: boolean }> {
    const period = CTRADER_PERIOD[timeframe]
    if (!period) throw new Error(`cTrader Open API 不支持的周期：${timeframe}`)

    return this.enqueueHistory(async () => {
      const res = await this.request(
        CTRADER_PAYLOAD.GET_TRENDBARS_REQ,
        {
          ctidTraderAccountId: accountId,
          symbolId,
          period,
          fromTimestamp: Math.floor(fromMs),
          toTimestamp: Math.floor(toMs),
          count
        },
        60_000
      )

      const rows: any[] = Array.isArray(res?.trendbar) ? res.trendbar : []
      const bars: OpenApiBar[] = []
      for (const b of rows) {
        const low = Number(b?.low)
        const minutes = Number(b?.utcTimestampInMinutes)
        if (!Number.isFinite(low) || !Number.isFinite(minutes)) continue
        const open = low + Number(b?.deltaOpen ?? 0)
        const high = low + Number(b?.deltaHigh ?? 0)
        const close = low + Number(b?.deltaClose ?? 0)
        bars.push({
          time: minutes * 60,
          open: open / PRICE_SCALE,
          high: high / PRICE_SCALE,
          low: low / PRICE_SCALE,
          close: close / PRICE_SCALE,
          volume: Number(b?.volume ?? 0)
        })
      }
      bars.sort((a, b) => a.time - b.time)
      return { bars, hasMore: !!res?.hasMore }
    })
  }

  /**
   * 用 refreshToken 换一套新凭据。
   *
   * 这是「token 永不过期」的实现基础，有两个关键点值得记住：
   *
   *   1. 这条消息走的是 5036 连接本身，**不经过 openapi.ctrader.com**。
   *      那个域名的 443 在部分网络下会被重置，如果续期依赖它，用户每
   *      30 天就得手动折腾一次；走协议内消息则完全没有这个问题。
   *
   *   2. 响应里的 refreshToken 是**新的**，旧的随即作废。所以调用方拿到
   *      结果后必须在同一时刻落盘 —— 一旦进程在「已换到新 token、还没
   *      写文件」之间崩溃，续期能力就永久丢失，只能重新走浏览器授权。
   *
   * 调用前需要已完成应用认证（connect 时 accountId 可以传空，那样不会
   * 触发账户认证）。
   */
  async refreshToken(refreshToken: string): Promise<{
    accessToken: string
    refreshToken: string
    expiresIn: number
  }> {
    const res = await this.request(CTRADER_PAYLOAD.REFRESH_TOKEN_REQ, { refreshToken }, 30_000)
    const accessToken = String(res?.accessToken ?? '')
    if (!accessToken) throw new Error('cTrader 未返回新的 accessToken')

    const nextRefresh = String(res?.refreshToken ?? '')
    const rawExpires = Number(res?.expiresIn ?? 0)

    return {
      accessToken,
      // 服务端没回传时沿用旧的（理论上不会发生，防御性处理）
      refreshToken: nextRefresh || refreshToken,
      expiresIn: Number.isFinite(rawExpires) && rawExpires > 0 ? rawExpires : 2_628_000
    }
  }

  /** 断开连接并停掉心跳 */
  async close(): Promise<void> {
    this.closed = true
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    this.failAll(new Error('连接已主动关闭'))
    const sock = this.sock
    this.sock = null
    if (sock) {
      await new Promise<void>((resolve) => {
        sock.once('close', () => resolve())
        sock.destroy()
        setTimeout(resolve, 1000)
      })
    }
  }
}
