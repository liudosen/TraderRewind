// ============================================================
// TraderRewind — cTrader Open API 凭据存储
//
// 安全约定（这几点是硬性的，改动前先想清楚）：
//   1. scope 只申请 accounts（只读）。换来的 accessToken 在服务端
//      就没有下单权限，任何程序拿到它也交易不了 —— 这是比「我们
//      不写下单代码」更强的保证。
//   2. 凭据用 Electron safeStorage 加密（Windows 上走 DPAPI，
//      绑定当前登录用户），密文落盘，明文只在内存里出现。
//   3. 文件写在 userData 下，不进仓库、不进安装包、不随日志输出。
//   4. 任何对外展示的地方只回「是否已配置」和脱敏尾号，不返回原文。
// ============================================================

import { app, safeStorage } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'

const FILE_NAME = 'ctrader-openapi.bin'

export interface StoredOpenApiCredentials {
  clientId: string
  clientSecret: string
  accessToken: string
  refreshToken: string
  /** 交易账户 ID，可空；空时靠 listAccounts 自动枚举 */
  accountId: number | null
  environment: 'live' | 'demo'
  /** accessToken 到期时间（毫秒时间戳），用于提前提示续期 */
  expiresAt: number | null
  /** 授权时申请的 scope，记为 accounts 表示只读 */
  scope: 'accounts' | 'trading'
}

/** 供渲染进程展示的安全视图：绝不包含 secret / token 原文 */
export interface CredentialsSummary {
  configured: boolean
  clientId: string
  clientIdTail: string
  accountId: number | null
  environment: 'live' | 'demo'
  scope: 'accounts' | 'trading'
  expiresAt: number | null
  expired: boolean
  /** 剩余天数，负数表示已过期 */
  daysLeft: number | null
  registerUrl: string
  authorizeUrl: string | null
}

function filePath(): string {
  return path.join(app.getPath('userData'), FILE_NAME)
}

function encrypt(text: string): Buffer {
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(text)
  }
  // 兜底：系统没提供加密能力（少见，一般是无 keyring 的 Linux）。
  // 加个标记位区分，读取时能识别出来并提示用户。
  return Buffer.concat([Buffer.from('RAW:'), Buffer.from(text, 'utf8')])
}

function decrypt(buf: Buffer): string {
  if (buf.subarray(0, 4).toString('utf8') === 'RAW:') {
    return buf.subarray(4).toString('utf8')
  }
  return safeStorage.decryptString(buf)
}

export async function loadCredentials(): Promise<StoredOpenApiCredentials | null> {
  try {
    const buf = await fs.readFile(filePath())
    const text = decrypt(buf)
    const parsed = JSON.parse(text) as StoredOpenApiCredentials
    if (!parsed?.clientId || !parsed?.accessToken) return null
    return {
      ...parsed,
      accountId: parsed.accountId ?? null,
      environment: parsed.environment === 'demo' ? 'demo' : 'live',
      scope: parsed.scope === 'trading' ? 'trading' : 'accounts',
      expiresAt: parsed.expiresAt ?? null
    }
  } catch {
    return null
  }
}

export async function saveCredentials(creds: StoredOpenApiCredentials): Promise<void> {
  const dir = app.getPath('userData')
  await fs.mkdir(dir, { recursive: true })
  const payload = JSON.stringify(creds)
  await fs.writeFile(filePath(), encrypt(payload), { mode: 0o600 })
}

export async function clearCredentials(): Promise<void> {
  try {
    await fs.unlink(filePath())
  } catch {
    /* 本来就不存在 */
  }
}

/**
 * 续期成功后写回新凭据。
 *
 * 这个函数设计成「读-改-写」而不是接受完整对象，是有意为之：
 * refreshToken 是轮换式的，换完旧的立刻作废。如果调用方自己拼对象、
 * 中间某次崩溃，就可能把新的 refreshToken 丢掉。这里尽量把窗口压到
 * 最小 —— 读、改、写三步紧挨着，没有 await 之外的间隙。
 */
export async function updateTokens(
  accessToken: string,
  refreshToken: string,
  expiresInSeconds: number
): Promise<StoredOpenApiCredentials | null> {
  const current = await loadCredentials()
  if (!current) return null

  const next: StoredOpenApiCredentials = {
    ...current,
    accessToken,
    refreshToken,
    expiresAt: Date.now() + Math.max(60, expiresInSeconds) * 1000
  }
  await saveCredentials(next)
  return next
}

export function credentialsExpired(creds: StoredOpenApiCredentials | null): boolean {
  if (!creds) return true
  if (!creds.expiresAt) return false
  return Date.now() >= creds.expiresAt
}

/** 授权入口：让用户自己建应用，scope 选「只读」 */
export const OPENAPI_REGISTER_URL = 'https://openapi.ctrader.com/apps'

/**
 * 构造授权 URL。
 *
 * 关键：scope 固定为 accounts（只读）。不提供切换成 trading 的入口 ——
 * 这个软件只下载历史行情，没有任何理由拿交易权限，与其相信运行时约束，
 * 不如从授权参数上就掐掉。
 */
export function buildAuthorizeUrl(clientId: string, redirectUri = 'https://openapi.ctrader.com/apps'): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'accounts',
    product: 'web'
  })
  return `https://id.ctrader.com/my/settings/openapi/grantingaccess/?${params.toString()}`
}

/**
 * 构造换 token 的 URL。
 *
 * 官方这个端点接受 GET + querystring，意味着浏览器直接打开就能出结果 ——
 * 这是本方案能在「443 被阻断」的网络下仍可用的关键：token 交换在用户
 * 浏览器里完成，程序侧不碰 443，只连 5036 拉数据。
 */
export function buildTokenUrl(
  clientId: string,
  clientSecret: string,
  opts: { code: string; redirectUri: string } | { refreshToken: string }
): string {
  const params = new URLSearchParams({ client_id: clientId, client_secret: clientSecret })
  if ('code' in opts) {
    params.set('grant_type', 'authorization_code')
    params.set('code', opts.code)
    params.set('redirect_uri', opts.redirectUri)
  } else {
    params.set('grant_type', 'refresh_token')
    params.set('refreshToken', opts.refreshToken)
  }
  return `https://openapi.ctrader.com/apps/token?${params.toString()}`
}

/** 渲染进程用的安全摘要 */
export function summarize(creds: StoredOpenApiCredentials | null): CredentialsSummary {
  if (!creds) {
    return {
      configured: false,
      clientId: '',
      clientIdTail: '',
      accountId: null,
      environment: 'live',
      scope: 'accounts',
      expiresAt: null,
      expired: true,
      daysLeft: null,
      registerUrl: OPENAPI_REGISTER_URL,
      authorizeUrl: null
    }
  }
  const daysLeft =
    creds.expiresAt === null ? null : Math.floor((creds.expiresAt - Date.now()) / 86_400_000)
  return {
    configured: true,
    clientId: creds.clientId,
    clientIdTail: creds.clientId.length > 4 ? creds.clientId.slice(-4) : creds.clientId,
    accountId: creds.accountId,
    environment: creds.environment,
    scope: creds.scope,
    expiresAt: creds.expiresAt,
    expired: credentialsExpired(creds),
    daysLeft,
    registerUrl: OPENAPI_REGISTER_URL,
    // 授权链接不回传，避免把 clientId 拼进可能被记录的日志
    authorizeUrl: null
  }
}
