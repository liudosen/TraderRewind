#!/usr/bin/env node
// ============================================================
// TraderRewind — 发布到码云（Gitee Release）
//
// 用法：
//   GITEE_TOKEN=xxx npm run release:gitee            # 建/更新 v<version> 的 release 并上传安装包
//   GITEE_TOKEN=xxx npm run release:gitee -- --dry   # 只打印将要做什么，不调接口
//
// 前提：
//   1. package.json 的 version 已经升好，CHANGELOG.md 里有 `## [<version>]` 这一节；
//   2. 已经打出安装包（release-<version>/ 下要能看到 *-setup.exe 与 *-x64.zip）；
//   3. 准备好 Gitee 私人令牌（设置 → 私人令牌），勾选 projects 权限。
//      令牌只从环境变量读，不落盘、不打印。
//
// 为什么单独写一个脚本而不是复用 release-gh：
//   两家 API 的差异不小 —— 鉴权（Bearer vs access_token 查询参数）、
//   建 release 的路径、上传附件是 multipart 而不是裸流，硬凑在一起会更难读。
//   正文与资产筛选的逻辑保持一致，改动时两边一起看。
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dry = process.argv.includes('--dry')

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const version = pkg.version
const tag = `v${version}`
const outDir = path.join(root, `release-${version}`)

/** 从 CHANGELOG 里抠出这一版的小节（`## [0.5.0] - ...` 到下一个 `## ` 之前） */
function changelogSection(ver) {
  const text = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').replace(/\r\n/g, '\n')
  const lines = text.split('\n')
  const start = lines.findIndex((l) => l.startsWith(`## [${ver}]`))
  if (start < 0) throw new Error(`CHANGELOG.md 里找不到 ## [${ver}] 这一节`)
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) {
      end = i
      break
    }
  }
  return lines.slice(start + 1, end).join('\n').trim()
}

/** owner/repo：优先问 gitee remote，读不到就退回这个仓库 */
function repoSlug() {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'gitee'], {
      cwd: root,
      encoding: 'utf8'
    }).trim()
    const m = url.match(/gitee\.com[:/]+([^/]+)\/([^/.]+)/)
    if (m) return `${m[1]}/${m[2]}`
  } catch {
    /* 没有 gitee remote，走默认 */
  }
  return 'DS_IT/TraderRewind'
}

/** 这一版要上传的文件：安装程序 + 免安装包 */
function assets() {
  if (!fs.existsSync(outDir)) {
    throw new Error(
      `找不到 ${path.basename(outDir)}/，先跑 npm run package:win（输出目录指到 release-${version}）`
    )
  }
  const files = fs.readdirSync(outDir)
  const esc = version.replace(/\./g, '\\.')
  const pick = (re) => files.filter((f) => re.test(f))
  const setup = pick(new RegExp(`^TraderRewind-${esc}-setup\\.exe$`))
  const zip = pick(new RegExp(`^TraderRewind-${esc}-x64\\.zip$`))
  const list = [...setup, ...zip].map((f) => path.join(outDir, f))
  if (list.length === 0) {
    throw new Error(`${path.basename(outDir)}/ 里没有 ${tag} 的安装包（只找到：${files.join('、')}）`)
  }
  return list
}

const slug = repoSlug()
const token = process.env.GITEE_TOKEN || ''
const body =
  changelogSection(version) +
  '\n\n---\n\n' +
  `**Windows**：\`TraderRewind-${version}-setup.exe\` 双击安装（已装旧版的会静默升级、保留数据）；` +
  `免安装版 \`TraderRewind-${version}-x64.zip\` 解压即用。\n\n` +
  '> 应用内更新会自动比较 GitHub 与码云两条线路的速度，谁快从谁那儿下。'

console.log(`仓库   ${slug}\n版本   ${version}（tag ${tag}）\n输出   ${path.relative(root, outDir)}/`)
const files = assets()
for (const f of files) console.log(`资产   ${path.basename(f)}  ${(fs.statSync(f).size / 1048576).toFixed(1)} MB`)

if (dry) {
  console.log('\n--- release 正文 ---\n' + body)
  process.exit(0)
}

if (!token) {
  throw new Error('缺少 GITEE_TOKEN 环境变量（Gitee → 设置 → 私人令牌，勾选 projects 权限）')
}

const API = 'https://gitee.com/api/v5'
/** 令牌走查询参数：Gitee 的 v5 接口两种都支持，查询参数在 multipart 上传时最省事 */
function withToken(url) {
  return url + (url.includes('?') ? '&' : '?') + `access_token=${encodeURIComponent(token)}`
}

async function api(method, url, body, init = {}) {
  const { headers: extra, ...rest } = init
  const res = await fetch(withToken(url), {
    method,
    headers: {
      Accept: 'application/json',
      ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...(extra || {})
    },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
    ...rest
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${text.slice(0, 400)}`)
  return text ? JSON.parse(text) : null
}

// 仓库不存在就直接建：全新项目第一次发版不该卡在「你还得先去网页点一下」
try {
  await api('GET', `${API}/repos/${slug}`)
  console.log('仓库已存在')
} catch (e) {
  if (!/404/.test(String(e.message))) throw e
  console.log('仓库不存在，创建中…')
  const [owner, repo] = slug.split('/')
  await api('POST', `${API}/user/repos`, {
    name: repo,
    path: repo,
    private: false,
    description: 'TraderRewind — 历史行情回放与交易训练工具',
    has_issues: true,
    has_wiki: false
  })
  console.log(`仓库已创建：https://gitee.com/${owner}/${repo}`)
}

// 同 tag 已有 release 就先删再建，保证正文和资产都是这次的内容
const releases = await api('GET', `${API}/repos/${slug}/releases?per_page=100`)
const existing = (releases || []).find((r) => r.tag_name === tag)
if (existing) {
  console.log(`已存在 release #${existing.id}，先删除再重建`)
  await api('DELETE', `${API}/repos/${slug}/releases/${existing.id}`)
}

const release = await api('POST', `${API}/repos/${slug}/releases`, {
  tag_name: tag,
  name: tag,
  body,
  target_commitish: 'main',
  prerelease: false
})
console.log(`\nrelease 已创建：https://gitee.com/${slug}/releases/tag/${tag}`)

// 附件逐个传；超过码云单文件上限的跳过并说明（更新只需要 setup.exe）
for (const file of files) {
  const name = path.basename(file)
  const size = fs.statSync(file).size
  console.log(`\n上传 ${name}（${(size / 1048576).toFixed(1)} MB）…`)
  try {
    const form = new FormData()
    form.append('file', new Blob([fs.readFileSync(file)]), name)
    const info = await api(
      'POST',
      `${API}/repos/${slug}/releases/${release.id}/attach_files`,
      form
    )
    console.log(`  → ${info?.browser_download_url ?? '已上传'}`)
  } catch (e) {
    console.warn(`  ! 上传失败：${e.message}`)
    console.warn('    （码云对单个附件有大小限制，超限的文件请留在 GitHub 侧）')
    process.exitCode = 1
  }
}

// 收尾自检：最新那版得是刚发的这个
const latest = await api('GET', `${API}/repos/${slug}/releases/latest`)
console.log(`\nreleases/latest = ${latest.tag_name}${latest.tag_name === tag ? ' ✅' : ' ❌ 不是刚发的版本'}`)
if (latest.tag_name !== tag) process.exitCode = 1
