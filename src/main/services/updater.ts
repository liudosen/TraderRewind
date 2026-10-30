// ============================================================
// TraderRewind — 版本更新（GitHub Release）
//
// 流程：查 `releases/latest` → 比版本号 → 找 `*-setup.exe` 资产
//      → 下载到 userData/updates → 交给 NSIS 静默安装 → 退出应用
//
// 几个刻意的取舍：
//  · 走项目自己的 HTTP 层（带代理 / 跳转跟随 / 重试），不引 electron-updater：
//    本项目是国内用户为主，代理是刚需，而 electron-updater 的代理与我们的
//    配置体系不通用；release 资产也是手工上传的，没有 latest.yml 可供它用。
//  · 主进程持有唯一的更新状态，界面只是订阅者（UPDATE_STATUS 广播），
//    这样「下载中」不会因为切页面、重渲染而丢。
//  · 下载完只到「可以安装」，不自动重启安装：用户手上可能在打单，
//    未经同意直接退出应用是不可接受的。
// ============================================================

import { app, BrowserWindow, shell } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { IPC } from '@shared/constants/ipc'
import { compareVersions } from '@shared/utils/version'
import { getTrainingDb } from '../db/connection'
import { describeProxyProblem, fetchBuffer, FetchError } from '../utils/http'

/** 仓库地址：更新检查、下载、打不开时的跳转都用它 */
const REPO = 'liudosen/TraderRewind'
const RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`
const RELEASE_PAGE = `https://github.com/${REPO}/releases/latest`
/** 代理和下载面板共用同一个键，用户配一次两边都认 */
const PROXY_META_KEY = 'download.proxy.v2'

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'installing'
  | 'uptodate'
  | 'error'

export interface UpdateState {
  phase: UpdatePhase
  /** 当前运行版本（package.json / 已安装程序） */
  currentVersion: string
  latestVersion: string | null
  /** Release 正文（markdown 原文，界面上按纯文本折行显示） */
  notes: string | null
  publishedAt: string | null
  releaseUrl: string
  assetName: string | null
  assetSize: number
  received: number
  total: number
  filePath: string | null
  error: string | null
  checkedAt: number | null
  /** 打包版才允许真的执行安装；开发模式下只用来验证流程 */
  installable: boolean
}

const state: UpdateState = {
  phase: 'idle',
  currentVersion: app.getVersion(),
  latestVersion: null,
  notes: null,
  publishedAt: null,
  releaseUrl: RELEASE_PAGE,
  assetName: null,
  assetSize: 0,
  received: 0,
  total: 0,
  filePath: null,
  error: null,
  checkedAt: null,
  installable: app.isPackaged
}

let checking = false
let downloading = false
/** 安装包下载的中止句柄：切版本 / 重下时用得上 */
let downloadAbort: AbortController | null = null
/**
 * 安装包的真实下载地址（release 资产给的，带资产 id）。
 * 不自己拼 `releases/download/<tag>/<name>` —— tag 可能是 `v0.2.4` 也可能是 `0.2.4`，
 * 拼错了就是 404，而资产 URL 永远是对的。
 */
let assetUrl: string | null = null

export function getUpdateState(): UpdateState {
  return { ...state }
}

function update(patch: Partial<UpdateState>): UpdateState {
  Object.assign(state, patch)
  const snapshot = getUpdateState()
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    try {
      win.webContents.send(IPC.UPDATE_STATUS, snapshot)
    } catch {
      // 窗口正在销毁，忽略
    }
  }
  return snapshot
}

/** 数据下载面板里配的代理；没配就返回空串（走直连） */
function downloadProxy(): string {
  try {
    const row = getTrainingDb()
      .prepare('SELECT value FROM meta WHERE key = ?')
      .get(PROXY_META_KEY) as { value?: string } | undefined
    return String(row?.value ?? '').trim()
  } catch {
    return ''
  }
}

interface ReleaseAsset {
  name?: string
  size?: number
  browser_download_url?: string
}

interface GitHubRelease {
  tag_name?: string
  name?: string
  body?: string
  published_at?: string
  html_url?: string
  assets?: ReleaseAsset[]
}

/**
 * 从资产列表里挑出 Windows 安装包。
 *
 * 优先 `*-setup.exe`（NSIS 安装程序，能静默安装并保留安装位置）；
 * 没有就退回任意 `.exe`；再没有就当这次发布没法自动更新
 * （比如只传了 zip —— zip 得用户自己解包，不适合「自动更新」）。
 */
function pickInstaller(assets: ReleaseAsset[]): ReleaseAsset | null {
  const exes = assets.filter((a) => /\.exe$/i.test(a.name ?? '') && a.browser_download_url)
  const setup = exes.find((a) => /setup/i.test(a.name ?? ''))
  return setup ?? exes[0] ?? null
}

/**
 * 查询最新版本。
 *
 * `autoDownload` 为 true 时（开机自动检查走这条），一旦发现有新版就立刻开始下载，
 * 用户看到的就只是一条进度，不用再点一次。
 */
export async function checkForUpdate(
  opts: { autoDownload?: boolean } = {}
): Promise<UpdateState> {
  if (checking || downloading) return getUpdateState()
  checking = true
  update({ phase: 'checking', error: null })

  const proxy = downloadProxy()
  const proxyProblem = describeProxyProblem(proxy)

  try {
    if (proxyProblem) throw new FetchError(proxyProblem)

    const buf = await fetchBuffer(RELEASE_API, {
      proxy,
      timeoutMs: 15000,
      retries: 1,
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `TraderRewind/${app.getVersion()}`
      }
    })

    const release = JSON.parse(buf.toString('utf8')) as GitHubRelease
    const latest = String(release.tag_name ?? '').replace(/^v/i, '')
    if (!latest) throw new FetchError('发布信息里没有版本号')

    const asset = pickInstaller(release.assets ?? [])
    const base: Partial<UpdateState> = {
      currentVersion: app.getVersion(),
      latestVersion: latest,
      notes: release.body?.trim() || null,
      publishedAt: release.published_at ?? null,
      releaseUrl: release.html_url || RELEASE_PAGE,
      assetName: asset?.name ?? null,
      assetSize: Number(asset?.size) || 0,
      received: 0,
      total: 0,
      filePath: null,
      checkedAt: Date.now(),
      error: null,
      installable: app.isPackaged
    }

    if (compareVersions(latest, app.getVersion()) <= 0) {
      checking = false
      assetUrl = null
      return update({ ...base, phase: 'uptodate', latestVersion: latest })
    }
    if (!asset) {
      checking = false
      assetUrl = null
      return update({
        ...base,
        phase: 'error',
        error: '这个版本没有提供 Windows 安装包（setup.exe），请到发布页手动下载'
      })
    }

    checking = false
    assetUrl = asset.browser_download_url ?? null
    const next = update({ ...base, phase: 'available' })
    if (opts.autoDownload) void downloadUpdate()
    return next
  } catch (e: any) {
    checking = false
    const msg = friendlyError(e)
    return update({ phase: 'error', error: msg, checkedAt: Date.now(), latestVersion: null })
  }
}

/**
 * 把技术性错误翻成人话，用户照着就能改。
 *
 * 注意：HTTP 层把底层错误统一包成了 `FetchError(message)`，`code` 会丢，
 * 所以这里按 message 里的关键字匹配，而不是看 `e.code`。
 */
function friendlyError(e: any): string {
  const status = e instanceof FetchError ? e.statusCode : undefined
  const text = e?.message ? String(e.message) : ''
  if (status === 403) return 'GitHub 接口请求过于频繁（403），过一会儿再试'
  if (status === 404) return '仓库里还没有任何 Release'
  if (text === 'aborted') return '已取消'
  if (/ECONNREFUSED/.test(text)) return '代理拒绝连接：确认代理软件已启动、端口没填错'
  if (/ENOTFOUND|EAI_AGAIN/.test(text)) {
    return '连不上 GitHub：检查网络，或在数据下载页填好代理'
  }
  if (/ETIMEDOUT|timeout/i.test(text)) return '连接 GitHub 超时：多半需要代理'
  if (/证书|CERT|self signed/i.test(text)) return '代理证书有问题：换成 HTTP 代理或关掉 SSL 拦截'
  return text || '检查更新失败'
}

function updatesDir(): string {
  const dir = join(app.getPath('userData'), 'updates')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 下载安装包到 userData/updates，同名文件先删掉，避免残留旧包 */
export async function downloadUpdate(): Promise<UpdateState> {
  if (downloading) return getUpdateState()
  if (state.phase !== 'available' && state.phase !== 'error' && state.phase !== 'ready') {
    return getUpdateState()
  }
  if (!state.assetName) return update({ phase: 'error', error: '没有可下载的安装包' })

  downloading = true
  const proxy = downloadProxy()
  const target = join(updatesDir(), state.assetName)
  const abort = new AbortController()
  downloadAbort = abort
  update({ phase: 'downloading', received: 0, total: state.assetSize, error: null })

  /** 进度广播按 200ms 合并：87 MB 的包会回调几千次，没必要每次都过 IPC */
  let lastEmit = 0
  const emitProgress = (received: number, total: number): void => {
    const now = Date.now()
    if (now - lastEmit < 200 && received !== total) return
    lastEmit = now
    update({ received, total })
  }

  try {
    const url =
      assetUrl ??
      `https://github.com/${REPO}/releases/download/v${state.latestVersion}/${encodeURIComponent(
        state.assetName
      )}`
    const buf = await fetchBuffer(url, {
      proxy,
      signal: abort.signal,
      timeoutMs: 180000,
      retries: 2,
      headers: { 'User-Agent': `TraderRewind/${app.getVersion()}` },
      onProgress: (_delta, received, total) => emitProgress(received, total)
    })

    if (existsSync(target)) {
      try {
        unlinkSync(target)
      } catch {
        // 文件被占用就当写入失败，下面写不进去会报错
      }
    }
    writeFileSync(target, buf)
    const written = statSync(target).size
    if (state.assetSize > 0 && written !== state.assetSize) {
      throw new Error(`安装包大小不符（期望 ${state.assetSize} 字节，实际 ${written} 字节）`)
    }

    downloading = false
    downloadAbort = null
    return update({
      phase: 'ready',
      filePath: target,
      received: written,
      total: written
    })
  } catch (e: any) {
    downloading = false
    downloadAbort = null
    return update({ phase: 'error', error: friendlyError(e) })
  }
}

/** 取消正在进行的下载（暂未在界面上暴露，留给以后的「取消」按钮） */
export function cancelUpdateDownload(): void {
  downloadAbort?.abort()
}

/**
 * 执行安装：把安装包交给系统，然后退出应用。
 *
 * 时机选在 `will-quit`：窗口已关、数据库已关、回测进度已落库，
 * 这时才 CreateProcess 拉起安装程序 —— 早一步会和退出流程抢文件，
 * 晚一步进程已经没了。
 *
 * `detached: true` 是为了让安装程序活过父进程：它新建进程组、脱离控制台，
 * 我们 unref 之后就彻底不管它了。静默安装（`/S`）沿用上一次的安装目录，
 * 不会重新问路径。
 */
export async function installUpdate(): Promise<{ ok: boolean; error?: string }> {
  if (!app.isPackaged) {
    return { ok: false, error: '开发模式不执行安装，请用打包版验证' }
  }
  if (!state.filePath || !existsSync(state.filePath)) {
    return { ok: false, error: '安装包不存在，请重新下载' }
  }

  if (process.platform !== 'win32') {
    // 非 Windows 没有静默安装这条路，直接打开下载页让用户自己装
    void shell.openExternal(state.releaseUrl)
    return { ok: true }
  }

  update({ phase: 'installing' })
  const file = state.filePath

  app.once('will-quit', () => {
    try {
      const child = spawn(file, ['/S'], { detached: true, stdio: 'ignore' })
      // spawn 的失败是异步的，try/catch 抓不到，只能听 error 事件
      child.on('error', (e) => console.error('[update] 安装程序启动失败：', e))
      child.unref()
      console.log('[update] 安装程序已启动 pid =', child.pid)
    } catch (e) {
      console.error('[update] 启动安装程序失败：', e)
    }
  })

  // 稍等一下再退，让渲染进程把「正在安装」的状态画出来
  setTimeout(() => app.quit(), 400)
  return { ok: true }
}

/** 打开发布页（自动更新失败时的兜底） */
export function openReleasePage(): void {
  void shell.openExternal(state.releaseUrl)
}

/** 应用启动后延迟检查一次：不阻塞开窗，也给下载任务让路 */
export function scheduleStartupCheck(delayMs = 8000): void {
  setTimeout(() => {
    // 只在打包版里自动查：开发时版本号就是源码版本，查了也只会打扰
    if (!app.isPackaged) return
    void checkForUpdate({ autoDownload: true })
  }, delayMs)
}
