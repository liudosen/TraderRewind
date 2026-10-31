// ============================================================
// TraderRewind — cTrader Open API 凭据的 IPC 接口
//
// 这里处理的是「凭据全生命周期」：初次授权、手动续期、清除。
//
// 一个绕不开的现实：换 token 的 REST 端点（openapi.ctrader.com）
// 在部分网络下会被 SNI 阻断，程序直连会失败。所以换 token 设计成
// 两种走法：
//   · 程序侧先试（用 Electron net，会走系统代理）—— 有代理时一步到位
//   · 失败则把 URL 交给用户在浏览器里打开 —— 浏览器能通就行
// 两条路最终都落到同一份凭据格式，上层无感。
//
// 注意：续期（accessToken 到期）不走这里，走的是 5036 上的协议消息，
// 完全不碰 443，所以那一步永远不会因为域名被阻断而失败。
// ============================================================

import { ipcMain, net } from 'electron'
import { IPC } from '@shared/constants/ipc'
import {
  loadCredentials,
  saveCredentials,
  clearCredentials,
  summarize,
  updateTokens,
  buildAuthorizeUrl,
  buildTokenUrl,
  OPENAPI_REGISTER_URL,
  type CredentialsSummary
} from '../services/ctrader-credentials'
import { CtraderOpenApiClient } from '../services/ctrader-openapi'
import { invalidateCtraderCredentials } from '../services/candle-api'

/** 应用注册时填的 redirect_uri 默认值，用户可改 */
const DEFAULT_REDIRECT_URI = 'https://openapi.ctrader.com/apps'

export interface SaveCredentialInput {
  clientId: string
  clientSecret: string
  accessToken?: string
  refreshToken?: string
  accountId?: number | null
  environment?: 'live' | 'demo'
}

/**
 * 从用户粘贴的文本里抠出 token JSON。
 *
 * 浏览器直接打开换 token 的 URL 时，页面会显示一段 JSON；但用户复制
 * 时很容易把周围的说明文字、甚至整页 HTML 一起带上。所以先按整体解析，
 * 失败再退化成「抓最外层大括号」。
 */
function extractJson(text: string): any | null {
  const trimmed = (text || '').trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    /* 继续尝试宽松匹配 */
  }
  const m = trimmed.match(/\{[\s\S]*\}/)
  if (m) {
    try {
      return JSON.parse(m[0])
    } catch {
      return null
    }
  }
  return null
}

/**
 * 尝试用程序直连换取 token。
 *
 * 这里用 Electron 的 net.fetch 而不是 Node 的 fetch —— 前者会遵守
 * 系统代理设置。用户开着代理时就能自动完成，省掉一次复制粘贴。
 */
async function exchangeViaNet(url: string): Promise<{ data?: any; error?: string }> {
  try {
    const res = await net.fetch(url, { headers: { Accept: 'application/json' } })
    const text = await res.text()
    const json = extractJson(text)
    if (json?.accessToken) return { data: json }
    return { error: json?.description || json?.errorCode || '未返回 accessToken' }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

export function registerCtraderCredentialHandlers(): void {
  ipcMain.handle(IPC.CTRADER_CRED_GET, async (): Promise<CredentialsSummary> => {
    return summarize(await loadCredentials())
  })

  ipcMain.handle(IPC.CTRADER_CRED_SAVE, async (_e, input: SaveCredentialInput) => {
    const clientId = String(input?.clientId ?? '').trim()
    const clientSecret = String(input?.clientSecret ?? '').trim()
    if (!clientId || !clientSecret) throw new Error('clientId 与 clientSecret 都不能为空')

    const prev = await loadCredentials()
    await saveCredentials({
      clientId,
      clientSecret,
      accessToken: String(input.accessToken ?? prev?.accessToken ?? '').trim(),
      refreshToken: String(input.refreshToken ?? prev?.refreshToken ?? '').trim(),
      accountId: input.accountId ?? prev?.accountId ?? null,
      environment: input.environment === 'demo' ? 'demo' : 'live',
      expiresAt: prev?.expiresAt ?? null,
      // 授权参数在代码里固定为只读，不接受外部传入 trading
      scope: 'accounts'
    })
    invalidateCtraderCredentials(true)
    return summarize(await loadCredentials())
  })

  ipcMain.handle(IPC.CTRADER_CRED_CLEAR, async () => {
    await clearCredentials()
    invalidateCtraderCredentials(true)
    return summarize(null)
  })

  /** 生成授权链接。scope 固定 accounts（只读） */
  ipcMain.handle(
    IPC.CTRADER_CRED_AUTH_URL,
    async (_e, redirectUri?: string): Promise<string> => {
      const creds = await loadCredentials()
      if (!creds?.clientId) throw new Error('请先填写 clientId / clientSecret')
      return buildAuthorizeUrl(creds.clientId, redirectUri || DEFAULT_REDIRECT_URI)
    }
  )

  /**
   * 用授权码换 token。
   *
   * 成功时会直接写入凭据；失败则把「需要用户手动打开」的 URL 一并返回，
   * 让前端引导用户去浏览器完成 —— 这是无代理环境下的兜底路径。
   */
  ipcMain.handle(
    IPC.CTRADER_CRED_EXCHANGE,
    async (_e, params: { code: string; redirectUri?: string }) => {
      const creds = await loadCredentials()
      if (!creds?.clientId || !creds.clientSecret) {
        throw new Error('请先填写 clientId / clientSecret')
      }
      const code = String(params?.code ?? '').trim()
      if (!code) throw new Error('授权码不能为空')

      const redirectUri = params.redirectUri || DEFAULT_REDIRECT_URI
      const url = buildTokenUrl(creds.clientId, creds.clientSecret, { code, redirectUri })

      const result = await exchangeViaNet(url)
      if (result.data) {
        const saved = await applyTokenResult(result.data, creds.accountId)
        return { ok: true, summary: saved }
      }

      // 直连失败：把 URL 交给浏览器
      return { ok: false, manualUrl: url, error: result.error }
    }
  )

  /** 接收用户从浏览器复制回来的 token JSON */
  ipcMain.handle(IPC.CTRADER_CRED_ACCEPT, async (_e, text: string) => {
    const json = extractJson(String(text ?? ''))
    if (!json) throw new Error('没识别出 JSON，请复制浏览器页面上完整的内容')
    if (!json.accessToken) {
      throw new Error(json.description || json.errorCode || '内容里没有 accessToken')
    }
    const creds = await loadCredentials()
    const saved = await applyTokenResult(json, creds?.accountId ?? null)
    return { ok: true, summary: saved }
  })

  /** 手动触发续期（正常情况下由下载流程自动完成，这个是给用户一个主动出口） */
  ipcMain.handle(IPC.CTRADER_CRED_REFRESH, async () => {
    const creds = await loadCredentials()
    if (!creds) throw new Error('尚未配置凭据')
    if (!creds.refreshToken) throw new Error('没有 refreshToken，需要重新授权一次')

    const client = new CtraderOpenApiClient()
    try {
      await client.connect({
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
        accessToken: creds.accessToken,
        environment: creds.environment
      })
      const next = await client.refreshToken(creds.refreshToken)
      const saved = await updateTokens(next.accessToken, next.refreshToken, next.expiresIn)
      if (!saved) throw new Error('凭据写入失败')
      invalidateCtraderCredentials()
      return summarize(saved)
    } finally {
      await client.close().catch(() => undefined)
    }
  })

  ipcMain.handle('ctrader:openRegisterPage', async () => OPENAPI_REGISTER_URL)
}

/**
 * 把一次成功的 token 响应落盘。
 *
 * expiresIn 是秒，换算成本地时间戳存下来，供「提前 7 天续期」判断。
 */
async function applyTokenResult(
  json: any,
  accountId: number | null
): Promise<CredentialsSummary> {
  const creds = await loadCredentials()
  if (!creds) throw new Error('凭据文件缺失')

  const expiresIn = Number(json.expiresIn ?? 0)
  const saved = {
    ...creds,
    accessToken: String(json.accessToken),
    refreshToken: String(json.refreshToken ?? creds.refreshToken ?? ''),
    accountId: accountId ?? creds.accountId ?? null,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : null,
    scope: 'accounts' as const
  }
  await saveCredentials(saved)
  invalidateCtraderCredentials(true)
  return summarize(saved)
}
