// ============================================================
// TraderRewind — 内置 DoH 解析器（DNS over HTTPS）
//
// 为什么需要这个：
//   在部分网络环境下，cTrader 的域名会被投毒到伪造 IP。实测
//   mcp.ctrader.com 曾被不同 DNS 服务器分别解析到 Facebook /
//   SoftLayer / Oracle 的无关地址段，而系统 DNS 同样给出假结果。
//   如果直接依赖系统 DNS，就会出现「今天能连、明天不能连」，
//   或者「开了 VPN 能连、关了就废」这类无法向用户解释的故障。
//
// 做法：
//   绕过系统 DNS，直接向多个加密 DNS 服务并发查询（HTTPS 通道，
//   中间人无法投毒），再对返回结果做交叉投票。只有拿到多数一致
//   的地址才采信；同时缓存结果，避免每次连接都重新查询。
//
// 选源原则：
//   Cloudflare / Google 的 DoH 本身在境内可能被阻断（实测
//   cloudflare-dns.com 直接 ECONNRESET、dns.google 超时），
//   所以主力是阿里 DNS 与腾讯 DoH —— 这两家境内可达，且实测
//   对 cTrader 域名返回的是真实地址。境外源保留在列表里作为
//   加分项：能连上就多一票，连不上不影响主流程。
// ============================================================

import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import dns from 'node:dns/promises'

interface DohProvider {
  name: string
  buildUrl: (hostname: string) => string
}

/**
 * DoH 服务商。
 *
 * 这里的顺序不代表优先级 —— 查询是并发进行的，顺序只影响日志可读性。
 */
const PROVIDERS: DohProvider[] = [
  {
    name: 'alidns',
    buildUrl: (h) => `https://dns.alidns.com/resolve?name=${encodeURIComponent(h)}&type=A`
  },
  {
    name: 'dnspod',
    buildUrl: (h) => `https://doh.pub/dns-query?name=${encodeURIComponent(h)}&type=A`
  },
  {
    name: 'cloudflare',
    buildUrl: (h) => `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(h)}&type=A`
  },
  {
    name: 'google',
    buildUrl: (h) => `https://dns.google/resolve?name=${encodeURIComponent(h)}&type=A`
  }
]

/** 单次 DoH 查询的超时。境外源经常是超时而不是拒绝，给短一点免得拖慢整体 */
const DOH_TIMEOUT_MS = 3500

/** 整体解析的超时上限（包含所有 provider 并发） */
const RESOLVE_TIMEOUT_MS = 5000

/**
 * 提前收敛阈值：某个 IP 拿到这么多票就不再等剩下的源。
 *
 * 这一条对体验影响很大 —— 实测四个源里境外两个必然超时，如果死等
 * 最慢的那个，一次解析要 4 秒；而阿里 + 腾讯通常 150ms 内就一致了，
 * 凑够两票直接返回，握手总耗时能压到 200ms 级别。
 */
const EARLY_VOTE_THRESHOLD = 2

/** 缓存保底 TTL：cTrader 的记录 TTL 只有 60 秒，取小一点更安全 */
const CACHE_MIN_TTL_MS = 60_000
const CACHE_MAX_TTL_MS = 300_000

interface CacheEntry {
  ips: string[]
  expiresAt: number
}

const cache = new Map<string, CacheEntry>()

/** 私有 / 保留地址段：任何一个“公网域名”解析到这些地址，必然是投毒或劫持 */
function isBogusAddress(ip: string): boolean {
  if (!net.isIPv4(ip)) return true
  const parts = ip.split('.').map((n) => Number(n))
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const [a, b] = parts
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a >= 224) return true
  return false
}

/** 发一个 DoH JSON 查询，返回该 provider 给出的 A 记录 */
function queryOne(provider: DohProvider, hostname: string): Promise<{ provider: string; ips: string[] }> {
  return new Promise((resolve) => {
    const done = (ips: string[]): void => resolve({ provider: provider.name, ips })

    const req = https.get(
      provider.buildUrl(hostname),
      {
        headers: { accept: 'application/dns-json', 'user-agent': 'TraderRewind-DoH' },
        timeout: DOH_TIMEOUT_MS
        // 注意：这里刻意不套代理。目标是公共 DNS，直连最稳；
        // 若用户开了系统级 VPN（TUN），流量自然也会被接管。
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          if (res.statusCode !== 200) return done([])
          try {
            const json = JSON.parse(text) as { Answer?: { type?: number; data?: string }[] }
            const ips = (json.Answer ?? [])
              .filter((a) => a.type === 1 && typeof a.data === 'string')
              .map((a) => String(a.data).trim())
              .filter((ip) => !isBogusAddress(ip))
            done(ips)
          } catch {
            done([])
          }
        })
      }
    )

    req.on('error', () => done([]))
    req.on('timeout', () => {
      req.destroy()
      done([])
    })
  })
}

/**
 * 对多源结果投票。
 *
 * 规则：统计每个 IP 被多少个 provider 命中，取出票数最高的一组。
 * 这样在两个境内源一致、境外源返回不同结果时，仍然采信票数高的；
 * 若所有源各说各话（票数都是 1），则全部保留交给上层竞速连接去试。
 */
function vote(results: string[][]): { ips: string[]; maxVotes: number } {
  const tally = new Map<string, number>()
  for (const ips of results) {
    for (const ip of new Set(ips)) {
      tally.set(ip, (tally.get(ip) ?? 0) + 1)
    }
  }
  if (tally.size === 0) return { ips: [], maxVotes: 0 }
  const maxVotes = Math.max(...tally.values())
  const ips = [...tally.entries()]
    .filter(([, votes]) => votes === maxVotes)
    .map(([ip]) => ip)
  return { ips, maxVotes }
}

/**
 * 解析域名的真实 IPv4 地址。
 *
 * @param hostname 目标域名
 * @param force 忽略缓存强制重新解析
 * @returns 经过交叉校验的 IP 列表（可能为空数组）
 */
export async function resolveIPv4(hostname: string, force = false): Promise<string[]> {
  const key = hostname.toLowerCase()

  if (!force) {
    const hit = cache.get(key)
    if (hit && hit.expiresAt > Date.now()) return hit.ips
  }

  const answers: string[][] = []

  // 并发查询，但不等最慢的那个：一旦某个地址凑够 EARLY_VOTE_THRESHOLD 票
  // 就立即收敛；全部源都返回后自然结束；都不返回则整体超时。
  let ips = await new Promise<string[]>((resolve) => {
    let settled = 0
    let done = false
    const finish = (value: string[]): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(value)
    }

    const timer = setTimeout(() => finish(vote(answers).ips), RESOLVE_TIMEOUT_MS)

    for (const provider of PROVIDERS) {
      void queryOne(provider, hostname).then((r) => {
        if (done) return
        settled += 1
        if (r.ips.length > 0) answers.push(r.ips)

        const { ips: voted, maxVotes } = vote(answers)
        if (maxVotes >= EARLY_VOTE_THRESHOLD) {
          finish(voted)
          return
        }
        if (settled === PROVIDERS.length) finish(voted)
      })
    }
  })

  // DoH 全线失败时的兜底：退回系统 DNS。
  // 这条路径可能拿到被污染的地址，但总好过直接抛错 —— 上层还有
  // TCP 竞速与 TLS 校验两道防线，真连不上会继续尝试下一个 IP。
  if (ips.length === 0) {
    try {
      const looked = await dns.lookup(hostname, { all: true, family: 4 })
      ips = looked.map((l) => l.address).filter((ip) => !isBogusAddress(ip))
    } catch {
      ips = []
    }
  }

  if (ips.length > 0) {
    cache.set(key, { ips, expiresAt: Date.now() + CACHE_MIN_TTL_MS })
  }

  return ips
}

/** 清空解析缓存（切换网络环境后可调用） */
export function clearDohCache(): void {
  cache.clear()
}

/**
 * 在候选 IP 里竞速，返回第一个 TCP 能连上的地址。
 *
 * 多源投票之后仍可能有多个地址（负载均衡），逐个试太慢，
 * 所以并发连接、谁先成功用谁。
 */
export function raceTcp(ips: string[], port: number, timeoutMs = 4000): Promise<string> {
  return new Promise((resolve, reject) => {
    if (ips.length === 0) {
      reject(new Error('没有可用 IP'))
      return
    }
    let pending = ips.length
    let done = false
    for (const ip of ips) {
      const sock = net.createConnection({ host: ip, port })
      const settle = (ok: boolean): void => {
        if (done) return
        if (ok) {
          done = true
          sock.destroy()
          resolve(ip)
          return
        }
        pending -= 1
        if (pending === 0) {
          done = true
          reject(new Error(`全部候选 IP 均无法连接 ${port}`))
        }
      }
      sock.setTimeout(timeoutMs, () => {
        sock.destroy()
        settle(false)
      })
      sock.once('connect', () => settle(true))
      sock.once('error', () => settle(false))
    }
  })
}

export interface ConnectOptions {
  /** 跳过证书校验（仅调试用） */
  insecure?: boolean
  timeoutMs?: number
}

/**
 * 解析并建立一条 TLS 连接。
 *
 * 关键点：连接用 IP，但 servername 必须填回域名 —— 这样证书校验
 * 与 SNI 都是对的，中间人也无法用伪造证书冒充。
 *
 * 多个候选 IP 时依次尝试：前一个握手失败就换下一个，而不是整体放弃。
 */
export async function connectTls(
  hostname: string,
  port: number,
  opts: ConnectOptions = {}
): Promise<tls.TLSSocket> {
  const ips = await resolveIPv4(hostname)
  if (ips.length === 0) {
    throw new Error(`无法解析 ${hostname} 的 IP（DoH 与系统 DNS 均失败）`)
  }

  const timeoutMs = opts.timeoutMs ?? 12000
  let lastError: Error | null = null

  for (const ip of ips) {
    try {
      return await new Promise<tls.TLSSocket>((resolve, reject) => {
        const sock = tls.connect(
          {
            host: ip,
            port,
            servername: hostname,
            rejectUnauthorized: !opts.insecure,
            timeout: timeoutMs
          },
          () => resolve(sock)
        )
        sock.once('error', (e: Error) => {
          sock.destroy()
          reject(e)
        })
        sock.once('timeout', () => {
          sock.destroy()
          reject(new Error('TLS 握手超时'))
        })
      })
    } catch (e) {
      lastError = e as Error
    }
  }

  throw new Error(
    `连接 ${hostname}:${port} 失败（已尝试 ${ips.length} 个地址）：${lastError?.message ?? '未知错误'}`
  )
}
