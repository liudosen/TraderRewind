// ============================================================
// TraderRewind — HTTP 下载工具
// 支持：直连 / HTTP 代理（absolute-URI）/ HTTPS 代理（CONNECT 隧道）
// 提供字节级进度回调与取消能力
// ============================================================

import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { URL } from 'node:url'

export interface FetchOptions {
  /** 代理地址，如 127.0.0.1:7890 或 http://127.0.0.1:7890 */
  proxy?: string
  /** 取消信号 */
  signal?: AbortSignal
  /** 超时（毫秒），覆盖建连 + 响应整体 */
  timeoutMs?: number
  /** 进度回调：本次新增字节数 / 累计已接收 / 总字节（未知为 0） */
  onProgress?: (deltaBytes: number, received: number, total: number) => void
  /** 额外请求头 */
  headers?: Record<string, string>
  /** 单次请求最大重试次数（网络错误时） */
  retries?: number
}

export class FetchError extends Error {
  statusCode?: number
  /** 429 时服务端建议的等待毫秒 */
  retryAfterMs?: number
  constructor(message: string, statusCode?: number) {
    super(message)
    this.name = 'FetchError'
    this.statusCode = statusCode
  }
}

/** 3xx 跳转：由 fetchBuffer 负责跟随 */
export class RedirectError extends FetchError {
  location: string
  constructor(location: string) {
    super('redirect', 302)
    this.name = 'RedirectError'
    this.location = location
  }
}

interface ProxyConfig {
  host: string
  port: number
}

/**
 * 共享连接池。
 * 高并发（数百路）下载时若每请求新建 TCP，会迅速耗尽本地临时端口并产生大量
 * TIME_WAIT；开启 keep-alive 复用同一到代理/源站的连接。
 */
const sharedHttpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 15000,
  maxSockets: 512,
  maxFreeSockets: 128,
  scheduling: 'lifo'
})

const sharedHttpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 15000,
  maxSockets: 256,
  maxFreeSockets: 64,
  scheduling: 'lifo'
})

export function parseProxy(proxy?: string): ProxyConfig | null {
  if (!proxy) return null
  let p = proxy.trim()
  if (!p) return null
  p = p.replace(/^[a-z]+:\/\//i, '')
  p = p.split('/')[0]
  const idx = p.lastIndexOf(':')
  if (idx <= 0) return { host: p, port: 7890 }
  const host = p.slice(0, idx)
  const port = Number(p.slice(idx + 1))
  if (!host || !Number.isFinite(port) || port <= 0) return null
  return { host, port }
}

/**
 * 通过 HTTP 代理建立到目标主机的 CONNECT 隧道，返回裸 TCP socket
 */
function connectTunnel(
  proxy: ProxyConfig,
  targetHost: string,
  targetPort: number,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (err: Error | null, socket?: net.Socket) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (err) {
        socket?.destroy()
        reject(err)
      } else {
        resolve(socket!)
      }
    }

    const socket = net.connect(proxy.port, proxy.host)
    socket.setNoDelay(true)

    const timer = setTimeout(() => finish(new Error('proxy-connect-timeout')), timeoutMs)
    const onAbort = () => finish(new Error('aborted'))
    signal?.addEventListener('abort', onAbort, { once: true })

    socket.on('error', (e) => finish(e))
    socket.on('connect', () => {
      socket.write(
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
          `Host: ${targetHost}:${targetPort}\r\n` +
          `Proxy-Connection: keep-alive\r\n\r\n`
      )
    })

    let buffer = ''
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('latin1')
      const headerEnd = buffer.indexOf('\r\n\r\n')
      if (headerEnd === -1) {
        if (buffer.length > 16384) finish(new Error('proxy-bad-response'))
        return
      }
      socket.removeListener('data', onData)
      const statusLine = buffer.slice(0, buffer.indexOf('\r\n'))
      const match = statusLine.match(/^HTTP\/\d\.\d\s+(\d{3})/)
      const status = match ? Number(match[1]) : 0
      if (status !== 200) {
        finish(new Error(`proxy CONNECT failed: ${statusLine}`))
        return
      }
      // 若代理在响应头后附带残留字节，回填给后续读取
      const rest = buffer.slice(headerEnd + 4)
      if (rest.length > 0) socket.unshift(Buffer.from(rest, 'latin1'))
      finish(null, socket)
    }
    socket.on('data', onData)
  })
}

/**
 * 自定义 https.Agent：通过代理隧道建立 TLS 连接
 */
function createProxyTlsAgent(proxy: ProxyConfig, timeoutMs: number): https.Agent {
  const agent = new https.Agent({ keepAlive: false, maxSockets: 64 })
  ;(agent as any).createConnection = (
    options: any,
    callback: (err: Error | null, socket?: tls.TLSSocket) => void
  ) => {
    const targetHost = options.host
    const targetPort = Number(options.port || 443)
    connectTunnel(proxy, targetHost, targetPort, timeoutMs)
      .then((socket) => {
        const tlsSocket = tls.connect(
          {
            socket,
            servername: targetHost,
            rejectUnauthorized: false
          },
          () => callback(null, tlsSocket)
        )
        tlsSocket.on('error', (e) => callback(e))
      })
      .catch((e) => callback(e))
    return undefined as any
  }
  return agent
}

/**
 * 下载 URL 为 Buffer
 */
async function fetchOnce(urlStr: string, opts: FetchOptions): Promise<Buffer> {
  const url = new URL(urlStr)
  const isHttps = url.protocol === 'https:'
  const proxy = parseProxy(opts.proxy)
  const timeoutMs = opts.timeoutMs ?? 30000
  const signal = opts.signal

  if (signal?.aborted) throw new FetchError('aborted')

  const baseHeaders: Record<string, string> = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) TraderRewind/0.1',
    Accept: '*/*',
    'Accept-Encoding': 'identity',
    ...opts.headers
  }

  let options: https.RequestOptions

  if (proxy && !isHttps) {
    // 纯 HTTP：向代理发送 absolute-URI 请求
    options = {
      host: proxy.host,
      port: proxy.port,
      method: 'GET',
      path: urlStr,
      headers: { ...baseHeaders, Host: url.host },
      agent: sharedHttpAgent
    }
  } else if (proxy && isHttps) {
    options = {
      host: url.hostname,
      port: Number(url.port || 443),
      method: 'GET',
      path: url.pathname + url.search,
      headers: { ...baseHeaders, Host: url.host },
      agent: createProxyTlsAgent(proxy, timeoutMs)
    }
  } else {
    options = {
      host: url.hostname,
      port: Number(url.port || (isHttps ? 443 : 80)),
      method: 'GET',
      path: url.pathname + url.search,
      headers: { ...baseHeaders, Host: url.host },
      agent: isHttps ? sharedHttpsAgent : sharedHttpAgent
    }
  }

  const requestFn = isHttps ? https.request : http.request

  return await new Promise<Buffer>((resolve, reject) => {
    let settled = false
    const done = (err: Error | null, data?: Buffer) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (err) reject(err)
      else resolve(data!)
    }

    const req = requestFn(options, (res) => {
      const status = res.statusCode ?? 0
      const total = Number(res.headers['content-length'] || 0)

      // 3xx：交给上层跟随跳转（Dukascopy 会把 http 301 到 https）
      if (status >= 300 && status < 400) {
        const loc = res.headers['location']
        res.resume()
        if (!loc) {
          done(new FetchError(`HTTP ${status}`, status))
          return
        }
        try {
          done(new RedirectError(new URL(String(loc), urlStr).toString()))
        } catch {
          done(new FetchError(`bad redirect: ${loc}`, status))
        }
        return
      }

      if (status < 200 || status >= 300) {
        res.resume()
        const err = new FetchError(`HTTP ${status}`, status)
        if (status === 429) {
          const ra = Number(res.headers['retry-after'])
          if (Number.isFinite(ra) && ra > 0) err.retryAfterMs = ra * 1000
        }
        done(err)
        return
      }

      const chunks: Buffer[] = []
      let received = 0
      opts.onProgress?.(0, 0, total)

      res.on('data', (chunk: Buffer) => {
        if (signal?.aborted) {
          req.destroy()
          return
        }
        chunks.push(chunk)
        received += chunk.length
        opts.onProgress?.(chunk.length, received, total)
      })
      res.on('end', () => done(null, Buffer.concat(chunks)))
      res.on('error', (e) => done(e))
    })

    const timer = setTimeout(() => {
      req.destroy()
      done(new FetchError('timeout'))
    }, timeoutMs)

    const onAbort = () => {
      req.destroy()
      done(new FetchError('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    req.on('error', (e: NodeJS.ErrnoException) => {
      if (signal?.aborted) done(new FetchError('aborted'))
      else done(new FetchError(e.message))
    })
    req.end()
  })
}

/**
 * 带重试与跳转跟随的下载
 * - 3xx：最多跟随 5 次（Dukascopy 会把 http 301 到 https）
 * - 429：按 Retry-After 或指数退避后重试，避免把限流越打越死
 */
export async function fetchBuffer(urlStr: string, opts: FetchOptions = {}): Promise<Buffer> {
  const retries = opts.retries ?? 2
  let currentUrl = urlStr
  let redirects = 0
  let lastError: Error | null = null

  while (true) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (opts.signal?.aborted) throw new FetchError('aborted')
      try {
        return await fetchOnce(currentUrl, opts)
      } catch (e: any) {
        lastError = e
        if (e?.message === 'aborted') throw e

        // 跳转：跳出重试循环，由外层跟随
        if (e instanceof RedirectError) break

        // 限流：退避后重试
        if (e instanceof FetchError && e.statusCode === 429) {
          if (attempt >= retries) break
          const base = e.retryAfterMs ?? 900 * Math.pow(2, attempt)
          const wait = Math.min(15000, base + Math.random() * 400)
          await new Promise((r) => setTimeout(r, wait))
          continue
        }

        // 4xx（非 429）不重试
        if (e instanceof FetchError && e.statusCode && e.statusCode < 500) throw e

        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, 300 * (attempt + 1)))
        }
      }
    }

    if (lastError instanceof RedirectError && redirects < 5) {
      currentUrl = lastError.location
      redirects++
      continue
    }

    throw lastError ?? new FetchError('unknown')
  }
}
