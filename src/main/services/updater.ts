// ============================================================
// TraderRewind — 版本更新（GitHub + 码云双通道）
//
// 流程：同时查两边的 `releases/latest` → 取版本较新的那份
//      → 对两边的 setup.exe 各抓一小段实测速度 → 谁快从谁那儿下
//      → 下载到 userData/updates → 交给 NSIS 静默安装 → 退出应用
//
// 为什么要两个通道：本项目用户以国内为主，GitHub 直连经常只有几十 KB/s
// 甚至超时，而码云在国内通常能跑满带宽。两个都查、都测，比「写死一个
// 更快的源」靠谱 —— 网络状况因地区/运营商而异，写死的判断迟早会错。
//
// 几个刻意的取舍：
//  · 走项目自己的 HTTP 层（带代理 / 跳转跟随 / 重试），不引 electron-updater：
//    代理是刚需，而 electron-updater 的代理与我们的配置体系不通用；
//    release 资产也是手工上传的，没有 latest.yml 可供它用。
//  · 测速只抓 768 KB 就掐断，代价小到用户感知不到；即使服务端不认 Range
//    也照样掐断，不会把 84 MB 的包拖下来两遍。
//  · 主进程持有唯一的更新状态，界面只是订阅者（UPDATE_STATUS 广播），
//    这样「下载中」不会因为切页面、重渲染而丢。
//  · 选中的通道会记进 meta，下次测速失败时优先用它 —— 别让偶发抖动
//    把用户重新扔回慢的那条线。
//  · 下载完只到「可以安装」，不自动重启安装：用户手上可能在打单，
//    未经同意直接退出应用是不可接受的。
// ============================================================

import { app, BrowserWindow, shell } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { IPC } from '@shared/constants/ipc'
import { compareVersions } from '@shared/utils/version'
import { getTrainingDb } from '../db/connection'
import { describeProxyProblem, fetchBuffer, FetchError } from '../utils/http'

/**
 * 仓库坐标。
 * 两个平台的账号路径**不一样**，不能共用一个 owner：
 * GitHub 是 `liudosen`，码云的个性地址是 `DS_IT`（登录名 DS_IT、昵称 liudosen）。
 * 曾经按同一个 owner 写过，结果码云那条线永远 404、静默退回 GitHub —— 排查了半天。
 */
const REPO_NAME = 'TraderRewind'
const GITHUB_OWNER = 'liudosen'
const GITEE_OWNER = 'DS_IT'
const GITHUB_REPO = `https://github.com/${GITHUB_OWNER}/${REPO_NAME}`
const GITEE_REPO = `https://gitee.com/${GITEE_OWNER}/${REPO_NAME}`

/** 代理和下载面板共用同一个键，用户配一次两边都认 */
const PROXY_META_KEY = 'download.proxy.v2'
/** 上次选中的更新通道，测速失败时用它兜底 */
const CHANNEL_META_KEY = 'update.channel.v1'

export type UpdateChannelId = 'github' | 'gitee'

interface UpdateChannel {
  id: UpdateChannelId
  /** 界面与日志里显示的名字 */
  label: string
  releaseApi: string
  /** 发布页：自动更新失败时跳这里 */
  releasePage: string
  /** 资产直链前缀：release JSON 没给下载地址时用它拼 */
  downloadBase: string
}

const CHANNELS: UpdateChannel[] = [
  {
    id: 'github',
    label: 'GitHub',
    releaseApi: `https://api.github.com/repos/${GITHUB_OWNER}/${REPO_NAME}/releases/latest`,
    releasePage: `${GITHUB_REPO}/releases/latest`,
    downloadBase: `${GITHUB_REPO}/releases/download`
  },
  {
    id: 'gitee',
    label: '码云',
    releaseApi: `https://gitee.com/api/v5/repos/${GITEE_OWNER}/${REPO_NAME}/releases/latest`,
    releasePage: `${GITEE_REPO}/releases`,
    downloadBase: `${GITEE_REPO}/releases/download`
  }
]

function channelById(id: UpdateChannelId | null): UpdateChannel {
  return CHANNELS.find((c) => c.id === id) ?? CHANNELS[0]
}

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
  /** 这次走的是哪条线 */
  channel: UpdateChannelId | null
  channelLabel: string | null
  /** 两条线的实测结果，如「码云 8.4 MB/s · GitHub 120 KB/s」 */
  channelSummary: string | null
}

const state: UpdateState = {
  phase: 'idle',
  currentVersion: app.getVersion(),
  latestVersion: null,
  notes: null,
  publishedAt: null,
  releaseUrl: GITHUB_REPO + '/releases/latest',
  assetName: null,
  assetSize: 0,
  received: 0,
  total: 0,
  filePath: null,
  error: null,
  checkedAt: null,
  installable: app.isPackaged,
  channel: null,
  channelLabel: null,
  channelSummary: null
}

let checking = false
let downloading = false
/** 安装包下载的中止句柄：切版本 / 重下时用得上 */
let downloadAbort: AbortController | null = null

/** 一条通道上的候选安装包 */
interface DownloadCandidate {
  channel: UpdateChannel
  name: string
  size: number
  url: string
}

/**
 * 本次可用的下载候选，按「快的在前」排好。
 * 第一个失败了自动换下一个 —— 某个源临时抽风时用户不用重新点一次检查更新。
 */
let candidates: DownloadCandidate[] = []

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

function readMeta(key: string): string {
  try {
    const row = getTrainingDb().prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value?: string }
      | undefined
    return String(row?.value ?? '')
  } catch {
    return ''
  }
}

function writeMeta(key: string, value: string): void {
  try {
    getTrainingDb()
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value)
  } catch {
    // 记不住偏好不影响本次更新
  }
}

function preferredChannel(): UpdateChannelId | null {
  const v = readMeta(CHANNEL_META_KEY)
  return v === 'github' || v === 'gitee' ? v : null
}

/** 归一化后的发布信息：两家的 JSON 字段名不一样，到这里就一样了 */
interface ReleaseInfo {
  channel: UpdateChannel
  version: string
  notes: string | null
  publishedAt: string | null
  pageUrl: string
  asset: DownloadCandidate | null
  /** 查询接口本身的耗时，测速失败时退而用它排序 */
  apiMs: number
}

interface RawAsset {
  name?: string
  size?: number
  browser_download_url?: string
  download_url?: string
}

interface RawRelease {
  tag_name?: string
  name?: string
  body?: string
  published_at?: string
  created_at?: string
  html_url?: string
  assets?: RawAsset[] | null
}

/**
 * 从资产列表里挑出 Windows 安装包。
 *
 * 优先 `*-setup.exe`（NSIS 安装程序，能静默安装并保留安装位置）；
 * 没有就退回任意 `.exe`；再没有就当这次发布没法自动更新
 * （比如只传了 zip —— zip 得用户自己解包，不适合「自动更新」）。
 */
function pickInstaller(
  assets: RawAsset[],
  channel: UpdateChannel,
  version: string
): DownloadCandidate | null {
  const exes = assets.filter((a) => /\.exe$/i.test(a.name ?? ''))
  const setup = exes.find((a) => /setup/i.test(a.name ?? '')) ?? exes[0]
  if (!setup?.name) return null
  // 资产 URL 永远是对的（tag 可能是 v0.4.0 也可能是 0.4.0，自己拼容易 404）；
  // 只有缺 URL 时才退回拼接，并同时试带 v 和不带 v 两种 tag
  const url =
    setup.browser_download_url ||
    setup.download_url ||
    `${channel.downloadBase}/v${version}/${encodeURIComponent(setup.name)}`
  return {
    channel,
    name: setup.name,
    size: Number(setup.size) || 0,
    url
  }
}

/** 查一个通道的最新发布 */
async function fetchChannelRelease(ch: UpdateChannel, proxy: string): Promise<ReleaseInfo> {
  const started = Date.now()
  const buf = await fetchBuffer(ch.releaseApi, {
    proxy,
    timeoutMs: 8000,
    retries: 0,
    headers: {
      Accept: ch.id === 'github' ? 'application/vnd.github+json' : 'application/json',
      'User-Agent': `TraderRewind/${app.getVersion()}`
    }
  })
  const apiMs = Date.now() - started

  const raw = JSON.parse(buf.toString('utf8')) as RawRelease
  const version = String(raw.tag_name ?? raw.name ?? '')
    .trim()
    .replace(/^v/i, '')
  if (!version) throw new FetchError(`${ch.label} 的发布信息里没有版本号`)

  const asset = pickInstaller(Array.isArray(raw.assets) ? raw.assets : [], ch, version)

  return {
    channel: ch,
    version,
    notes: raw.body?.trim() || null,
    publishedAt: raw.published_at ?? raw.created_at ?? null,
    pageUrl:
      raw.html_url ||
      (ch.id === 'github' ? `${GITHUB_REPO}/releases/tag/v${version}` : ch.releasePage),
    asset,
    apiMs
  }
}

/** 测速只抓这么多就掐断：够判断快慢，又不至于为了测速先下几 MB */
const PROBE_BYTES = 768 * 1024
/**
 * 测速窗口。给 4.5 秒而不是十几秒 —— 慢线本来也跑不出什么速度，
 * 让它拖满超时只会把「检查更新」拖成一次长等待。
 */
const PROBE_WINDOW_MS = 4500
/** 窗口内至少得收到这么多字节，样本才够算速度；低于这个数视为这条线不可用 */
const PROBE_MIN_BYTES = 64 * 1024

/**
 * 抓一小段安装包，实测这条线的速度。
 *
 * 用 Range 只取前 768 KB；万一服务端不认 Range（返回 200 整包），
 * onProgress 里到量就 abort —— 无论如何都不会真的把整包拖下来。
 * 结果换算成 KB/s，用它排序。
 */
export async function probeSpeed(
  url: string,
  proxy: string
): Promise<{ kbps: number; ms: number } | null> {
  const abort = new AbortController()
  const started = Date.now()
  let received = 0

  // 总截止时间必须自己掐：http 层的 timeoutMs 是「每跳一次重定向重新计时」，
  // GitHub 的资产要先 302 到 release-assets，两跳就变成两倍时长。
  const deadline = setTimeout(() => abort.abort(), PROBE_WINDOW_MS)

  try {
    await fetchBuffer(url, {
      proxy,
      signal: abort.signal,
      timeoutMs: PROBE_WINDOW_MS * 2,
      retries: 0,
      headers: { Range: `bytes=0-${PROBE_BYTES - 1}` },
      onProgress: (_delta, got) => {
        received = got
        if (got >= PROBE_BYTES) abort.abort()
      }
    })
  } catch {
    // 超时 / 主动掐断都会走到这里：只要样本够，就照样算速度
  } finally {
    clearTimeout(deadline)
  }

  const ms = Math.max(1, Date.now() - started)
  if (received < PROBE_MIN_BYTES) return null
  return { kbps: received / 1024 / (ms / 1000), ms }
}

function fmtSpeed(kbps: number): string {
  if (kbps >= 1024) return `${(kbps / 1024).toFixed(1)} MB/s`
  return `${Math.max(1, Math.round(kbps))} KB/s`
}

/**
 * 决定这次从哪儿下。
 *
 * 步骤：两边并发查（谁失败都不影响另一边）→ 取版本较新的那份当目标
 *      → 版本落后的一方直接淘汰（镜像还没同步时就该走另一边）
 *      → 剩下的各测一段速度，快的排前面。
 */
export async function resolveUpdateSource(proxy: string): Promise<{
  best: ReleaseInfo
  ranked: ReleaseInfo[]
  summary: string
}> {
  const settled = await Promise.allSettled(CHANNELS.map((ch) => fetchChannelRelease(ch, proxy)))
  const ok: ReleaseInfo[] = []
  const failures: string[] = []
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') ok.push(r.value)
    else failures.push(`${CHANNELS[i].label}：${(r.reason as Error)?.message ?? '未知错误'}`)
  })

  if (ok.length === 0) {
    throw new FetchError(failures.join('；') || '两个更新源都连不上')
  }

  // 版本较新的那份就是目标：码云有时候比 GitHub 早/晚几分钟，不能只看顺序
  const target = ok.reduce((a, b) => (compareVersions(b.version, a.version) > 0 ? b : a))
  const same = ok.filter((r) => compareVersions(r.version, target.version) === 0)

  // 有安装包的才算可用通道；没有的只作信息展示
  const withAsset = same.filter((r) => r.asset)
  if (withAsset.length === 0) {
    return { best: target, ranked: [], summary: '' }
  }

  let ranked = withAsset
  const speeds: string[] = []

  if (withAsset.length > 1) {
    const probes = await Promise.all(
      withAsset.map((r) => probeSpeed(r.asset!.url, proxy).catch(() => null))
    )
    const withSpeed = withAsset.map((r, i) => ({ r, p: probes[i] }))
    withSpeed.sort((a, b) => {
      // 有测速结果的优先，按速度降序；都测不出来时按接口耗时升序
      if (a.p && b.p) return b.p.kbps - a.p.kbps
      if (a.p) return -1
      if (b.p) return 1
      return a.r.apiMs - b.r.apiMs
    })
    ranked = withSpeed.map((x) => x.r)
    for (const { r, p } of withSpeed) {
      speeds.push(p ? `${r.channel.label} ${fmtSpeed(p.kbps)}` : `${r.channel.label} 测速失败`)
    }
  } else {
    speeds.push(`${ranked[0].channel.label}（唯一可用源）`)
  }

  // 测速全失败时，用上次记住的通道兜底，别让偶发抖动把用户扔回慢线
  if (!ranked.length) ranked = withAsset
  if (speeds.every((s) => s.includes('测速失败'))) {
    const pref = preferredChannel()
    if (pref) {
      ranked = [...ranked].sort(
        (a, b) => (b.channel.id === pref ? 1 : 0) - (a.channel.id === pref ? 1 : 0)
      )
    }
  }

  return { best: ranked[0], ranked, summary: speeds.join(' · ') }
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
  update({ phase: 'checking', error: null, channelSummary: null })

  const proxy = downloadProxy()
  const proxyProblem = describeProxyProblem(proxy)

  try {
    if (proxyProblem) throw new FetchError(proxyProblem)

    const { best, ranked, summary } = await resolveUpdateSource(proxy)
    const latest = best.version
    const asset = best.asset

    const base: Partial<UpdateState> = {
      currentVersion: app.getVersion(),
      latestVersion: latest,
      notes: best.notes,
      publishedAt: best.publishedAt,
      releaseUrl: best.pageUrl,
      assetName: asset?.name ?? null,
      assetSize: asset?.size ?? 0,
      received: 0,
      total: 0,
      filePath: null,
      checkedAt: Date.now(),
      error: null,
      installable: app.isPackaged,
      channel: best.channel.id,
      channelLabel: best.channel.label,
      channelSummary: summary || null
    }

    if (compareVersions(latest, app.getVersion()) <= 0) {
      checking = false
      candidates = []
      return update({ ...base, phase: 'uptodate', latestVersion: latest })
    }
    if (!asset) {
      checking = false
      candidates = []
      return update({
        ...base,
        phase: 'error',
        error: '这个版本没有提供 Windows 安装包（setup.exe），请到发布页手动下载'
      })
    }

    checking = false
    // 排好序的候选列表：第一个失败自动换下一个
    candidates = ranked.map((r) => r.asset!).filter(Boolean)
    const next = update({ ...base, phase: 'available' })
    if (opts.autoDownload) void downloadUpdate()
    return next
  } catch (e: any) {
    checking = false
    candidates = []
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
  if (status === 403) return '更新接口请求过于频繁（403），过一会儿再试'
  if (status === 404) return '仓库里还没有任何 Release'
  if (text === 'aborted') return '已取消'
  if (/ECONNREFUSED/.test(text)) return '代理拒绝连接：确认代理软件已启动、端口没填错'
  if (/ENOTFOUND|EAI_AGAIN/.test(text)) {
    return '连不上更新服务器：检查网络，或在数据下载页填好代理'
  }
  if (/ETIMEDOUT|timeout|超时/i.test(text)) return '连接更新服务器超时：多半需要代理'
  if (/证书|CERT|self signed/i.test(text)) return '代理证书有问题：换成 HTTP 代理或关掉 SSL 拦截'
  return text || '检查更新失败'
}

function updatesDir(): string {
  const dir = join(app.getPath('userData'), 'updates')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 目录里还躺着的安装包（下载完 → 安装完 → 就再没人管了，几十 MB 一直占着） */
function pendingInstallers(): string[] {
  try {
    return readdirSync(updatesDir())
      .filter((n) => /\.(exe|blockmap)$/i.test(n))
      .map((n) => join(updatesDir(), n))
  } catch {
    return []
  }
}

/**
 * 清掉下载目录里残留的安装包。
 *
 * 装完就没有用了 —— 安装程序自己不会删自己，应用退出后就没人回来善后。
 * `keep` 是正在使用的那个文件（下载中/待安装），不能动。
 * 删不掉的（安装程序进程可能还攥着句柄）直接跳过，下次启动再清。
 */
function cleanupInstallers(keep: string | null = null): number {
  let removed = 0
  for (const full of pendingInstallers()) {
    if (keep && full === keep) continue
    try {
      unlinkSync(full)
      removed++
    } catch {
      // 被占用：交给下一次启动
    }
  }
  if (removed > 0) console.log(`[update] 清理了 ${removed} 个残留安装包`)
  return removed
}

/**
 * 启动后清一次残留安装包。
 *
 * 不能只清一次：安装程序拉起新版后可能还没完全退出，句柄一时半会儿不放，
 * 此刻删会失败。所以隔几秒重试几轮，直到目录干净或放弃。
 */
export function scheduleInstallerCleanup(delayMs = 5000): void {
  let tries = 0
  const tick = (): void => {
    cleanupInstallers()
    if (pendingInstallers().length > 0 && ++tries < 5) setTimeout(tick, 4000)
  }
  setTimeout(tick, delayMs)
}

/**
 * 下载安装包到 userData/updates，同名文件先删掉，避免残留旧包。
 *
 * 依次尝试候选源：某条线中途断了就立刻换另一条重下，而不是把错误甩给用户；
 * 只有全部失败才汇报，并把每条线的失败原因都带上，方便判断是网络还是别的。
 */
export async function downloadUpdate(): Promise<UpdateState> {
  if (downloading) return getUpdateState()
  if (state.phase !== 'available' && state.phase !== 'error' && state.phase !== 'ready') {
    return getUpdateState()
  }
  if (candidates.length === 0) {
    // 没有候选（比如重启后直接点下载）：退回按已知信息拼一个
    if (!state.assetName || !state.latestVersion) {
      return update({ phase: 'error', error: '没有可下载的安装包' })
    }
    const ch = channelById(state.channel)
    candidates = [
      {
        channel: ch,
        name: state.assetName,
        size: state.assetSize,
        url: `${ch.downloadBase}/v${state.latestVersion}/${encodeURIComponent(state.assetName)}`
      }
    ]
  }

  downloading = true
  const proxy = downloadProxy()
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

  const errors: string[] = []

  for (const cand of candidates) {
    if (abort.signal.aborted) break
    update({
      channel: cand.channel.id,
      channelLabel: cand.channel.label,
      assetName: cand.name,
      assetSize: cand.size,
      received: 0,
      total: cand.size
    })

    const target = join(updatesDir(), cand.name)
    // 换源重试可能留下上一条线的半成品；除了即将写入的这个，其余都清掉
    cleanupInstallers(target)
    try {
      console.log(`[update] 从 ${cand.channel.label} 下载 ${cand.name}`)
      const buf = await fetchBuffer(cand.url, {
        proxy,
        signal: abort.signal,
        timeoutMs: 300000,
        retries: 1,
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
      if (cand.size > 0 && written !== cand.size) {
        throw new Error(`安装包大小不符（期望 ${cand.size} 字节，实际 ${written} 字节）`)
      }

      // 记住这次成功的通道，下次测速抖动时优先用它
      writeMeta(CHANNEL_META_KEY, cand.channel.id)

      downloading = false
      downloadAbort = null
      return update({
        phase: 'ready',
        filePath: target,
        received: written,
        total: written
      })
    } catch (e: any) {
      if (abort.signal.aborted) {
        downloading = false
        downloadAbort = null
        return update({ phase: 'error', error: '已取消' })
      }
      console.warn(`[update] ${cand.channel.label} 下载失败：`, e?.message ?? e)
      errors.push(`${cand.channel.label}：${e?.message ?? e}`)
    }
  }

  downloading = false
  downloadAbort = null
  return update({
    phase: 'error',
    error: errors.length > 1 ? `两条下载线路都失败了 —— ${errors.join('；')}` : friendlyError(
      new Error(errors[0] ?? '下载失败')
    )
  })
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
 * 不会重新问路径；装完由 `--force-run` 把新版拉起来（见下面的参数说明）。
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
      // 这三个参数缺一不可，都是 NSIS 模板（installSection.nsh）里写死的判定：
      //  · `/S`        静默安装，不弹任何页面
      //  · `--updated` 标记为「由更新触发」，让安装程序把 `--updated` 传给新进程
      //  · `--force-run` 装完立刻启动新版本
      // 本项目是 `oneClick: false`（辅助式安装包），模板里那条分支是：
      //     ${if} ${isForceRun} ${andIf} ${Silent}  → 才 StartApp
      // 也就是说静默安装**必须**带 --force-run 才会重启；只给 /S 的话，
      // 装完悄无声息地结束，用户看到的就是「更新完自己没了」。
      const child = spawn(file, ['--updated', '/S', '--force-run'], {
        detached: true,
        stdio: 'ignore'
      })
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

/** 打开发布页（自动更新失败时的兜底）：优先打开这次选中的通道 */
export function openReleasePage(): void {
  void shell.openExternal(state.releaseUrl || channelById(state.channel).releasePage)
}

/** 应用启动后延迟检查一次：不阻塞开窗，也给下载任务让路 */
export function scheduleStartupCheck(delayMs = 8000): void {
  setTimeout(() => {
    // 只在打包版里自动查：开发时版本号就是源码版本，查了也只会打扰
    if (!app.isPackaged) return
    void checkForUpdate({ autoDownload: true })
  }, delayMs)
}
