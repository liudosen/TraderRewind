// ============================================================
// TraderRewind — 代理地址解析（渲染进程与主进程共用）
//
// 为什么要有这个文件：代理地址是用户手打的，最容易出的错不是「填错端口」，
// 而是肉眼看不出来的字符问题 —— 中文输入法敲出的全角冒号「：」、
// 粘贴时带上的空格（`127.0.0.1: 7890`）、少写一位的 `127.0.0`。
// 这些串一旦被当成主机名丢给 DNS，就会在几千个文件全部失败之后
// 才吐出一句 `getaddrinfo ENOTFOUND 127.0.0.1：7890`，
// 用户完全看不出是自己的输入有问题。
//
// 所以：先把脏字符归一化，再严格校验，校验不过就明确说哪里不对，
// 绝不把解析失败的串继续往网络层传。
// ============================================================

export interface ProxyEndpoint {
  host: string
  port: number
}

/** 校验不通过的原因码，交给渲染进程翻成人话 */
export type ProxyInvalidCode =
  /** 看起来像 IP，但段数不对或某段超过 255（如 127.0.0） */
  | 'ip-short'
  /** 主机名不合法（空、超长、含非法字符） */
  | 'host'
  /** 端口不是 1–65535 的整数 */
  | 'port'

export type ProxyParseResult =
  | { state: 'empty' }
  | ({ state: 'ok' } & ProxyEndpoint)
  | { state: 'invalid'; code: ProxyInvalidCode; value: string }

/**
 * 把全角符号换成半角，并去掉所有空白。
 *
 * 只做「等价字符」的替换，不做任何猜测性修补 —— 端口号写错、地址写错仍然会报错，
 * 只是把「本该是冒号的位置被敲成中文冒号」这种纯粹的手滑救回来。
 */
export function normalizeProxy(raw: string | null | undefined): string {
  if (!raw) return ''
  const map: Record<string, string> = {
    '\uFF1A': ':', // ： 全角冒号
    '\uFE55': ':', // ﹕ 小型冒号
    '\uA789': ':', // ꞉ 修饰字母冒号
    '\uFF0E': '.', // ． 全角句点
    '\u3002': '.', // 。 句号（有人会敲成这个）
    '\uFF0F': '/', // ／ 全角斜杠
    '\uFF20': '@', // ＠ 全角 at
    '\u3000': ' ' // 　 全角空格
  }
  let out = ''
  for (const ch of raw) {
    out += map[ch] ?? ch
  }
  // 代理地址里不可能有空格，粘贴时混进来的空格一律去掉（`127.0.0.1: 7890`）
  return out.replace(/\s+/g, '')
}

function isIpv4(host: string): boolean {
  const parts = host.split('.')
  if (parts.length !== 4) return false
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
}

/** 只由数字和点组成 —— 用户想写 IP，但写残了 */
function looksLikeIp(host: string): boolean {
  return /^[\d.]+$/.test(host)
}

function isIpv6(host: string): boolean {
  // 简化判断：含冒号且只含十六进制字符与点（不做完整 RFC 校验，够挡住明显错误）
  return host.includes(':') && /^[0-9a-fA-F:.]+$/.test(host) && host.split(':').length >= 3
}

function isHostname(host: string): boolean {
  if (host.length === 0 || host.length > 253) return false
  return host.split('.').every((label) => /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))
}

/**
 * 解析代理地址。接受这些写法：
 *   127.0.0.1:7890 / http://127.0.0.1:7890 / 127.0.0.1：7890（全角）
 *   proxy.local:8080 / 127.0.0.1（省略端口，默认 7890）
 *   user:pass@127.0.0.1:7890（认证信息会被忽略，Node 侧暂不支持代理认证）
 */
export function parseProxyEndpoint(raw: string | null | undefined): ProxyParseResult {
  const cleaned = normalizeProxy(raw)
  if (!cleaned) return { state: 'empty' }

  // 去掉协议前缀与路径，只留 authority
  let rest = cleaned.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
  const slash = rest.indexOf('/')
  if (slash >= 0) rest = rest.slice(0, slash)
  // 丢掉 user:pass@ —— 目前不支持代理认证，留着会污染 host 判断
  const at = rest.lastIndexOf('@')
  if (at >= 0) rest = rest.slice(at + 1)

  const colon = rest.lastIndexOf(':')
  let host = colon > 0 ? rest.slice(0, colon) : rest
  const portText = colon > 0 ? rest.slice(colon + 1) : '7890'

  // IPv6 字面量：[::1]:7890
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)

  if (host === '') {
    return { state: 'invalid', code: 'host', value: cleaned }
  }
  if (!isIpv4(host) && !isIpv6(host) && !isHostname(host)) {
    return { state: 'invalid', code: 'host', value: cleaned }
  }
  // 数字加点却不是合法 IPv4，几乎都是少写了一段（127.0.0 / 127.0.0.1.5）
  if (looksLikeIp(host) && !isIpv4(host)) {
    return { state: 'invalid', code: 'ip-short', value: cleaned }
  }

  const port = Number(portText)
  if (!/^\d{1,5}$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) {
    return { state: 'invalid', code: 'port', value: cleaned }
  }

  return { state: 'ok', host, port }
}

/** 只要 endpoint，不合法就返回 null（给不需要解释失败原因的调用方用） */
export function parseProxyOrNull(raw: string | null | undefined): ProxyEndpoint | null {
  const r = parseProxyEndpoint(raw)
  return r.state === 'ok' ? { host: r.host, port: r.port } : null
}
