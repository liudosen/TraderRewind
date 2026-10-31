#!/usr/bin/env node
// ============================================================
// TraderRewind — 一键发版（GitHub Release）
//
// 用法：
//   npm run release:gh            # 建/更新 v<version> 的 release，并上传安装包与免安装包
//   npm run release:gh -- --dry   # 只打印将要做什么，不调接口
//
// 前提：
//   1. package.json 的 version 已经升好，CHANGELOG.md 里有 `## [<version>]` 这一节；
//   2. 已经打出安装包（release-<version>/ 下要能看到 *-setup.exe 与 *-x64.zip）；
//   3. 本机 git 凭据里存了带 `repo` 权限的 GitHub token
//      （`git credential fill` 能读出来就行，脚本不落盘、不打印）。
//
// 为什么不用 gh / electron-builder 的 publish：
//   本仓库是私有令牌 + 手工控制 release 正文（正文直接从 CHANGELOG 抠），
//   走一遍 REST API 比记住一堆 gh 参数省事，也方便把「重发同一版本」做成幂等。
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

/** 从 CHANGELOG 里抠出这一版的小节（`## [0.2.7] - 2026-10-31` 到下一个 `## ` 之前） */
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

/** owner/repo：优先问 git，读不到就退回这个仓库 */
function repoSlug() {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8' }).trim()
    const m = url.match(/github\.com[:/]+([^/]+)\/([^/.]+)/)
    if (m) return `${m[1]}/${m[2]}`
  } catch {
    /* 忽略，走默认 */
  }
  return 'liudosen/TraderRewind'
}

/** 从本机 git 凭据里取 token（不打印、不落盘） */
function githubToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN
  const out = execFileSync('git', ['credential', 'fill'], {
    cwd: root,
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8'
  })
  const line = out.split('\n').find((l) => l.startsWith('password='))
  if (!line) throw new Error('git 凭据里没有 github.com 的 password，先 git push 一次或手动配置令牌')
  return line.slice('password='.length).trim()
}

/** 这一版要上传的文件：安装程序 + 免安装包 */
function assets() {
  if (!fs.existsSync(outDir)) throw new Error(`找不到 ${path.basename(outDir)}/，先跑 npm run package:win（输出目录指到 release-${version}）`)
  const files = fs.readdirSync(outDir)
  const pick = (re) => files.filter((f) => re.test(f))
  const setup = pick(new RegExp(`^TraderRewind-${version.replace(/\./g, '\\.')}-setup\\.exe$`))
  const zip = pick(new RegExp(`^TraderRewind-${version.replace(/\./g, '\\.')}-x64\\.zip$`))
  const list = [...setup, ...zip].map((f) => path.join(outDir, f))
  if (list.length === 0) throw new Error(`${path.basename(outDir)}/ 里没有 ${tag} 的安装包（只找到：${files.join('、')}）`)
  return list
}

async function api(token, method, url, body, init = {}) {
  // 注意顺序：init 里的 headers 只能**叠加**，不能整个盖掉（否则 Authorization 会丢）
  const { headers: extraHeaders, ...rest } = init
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(extraHeaders || {})
    },
    body: body ? JSON.stringify(body) : undefined,
    ...rest
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${text.slice(0, 400)}`)
  return text ? JSON.parse(text) : null
}

const slug = repoSlug()
const body =
  changelogSection(version) +
  '\n\n---\n\n' +
  `**Windows**：\`TraderRewind-${version}-setup.exe\` 双击安装（已装旧版的会静默升级、保留数据）；` +
  `免安装版 \`TraderRewind-${version}-x64.zip\` 解压即用。`

console.log(`仓库   ${slug}\n版本   ${version}（tag ${tag}）\n输出   ${path.relative(root, outDir)}/`)
const files = assets()
for (const f of files) console.log(`资产   ${path.basename(f)}  ${(fs.statSync(f).size / 1048576).toFixed(1)} MB`)

if (dry) {
  console.log('\n--- release 正文 ---\n' + body)
  process.exit(0)
}

const token = githubToken()

// 同一个 tag 已经有 release 就先删掉重建：重发时正文/资产都能干净地覆盖
const existing = await api(token, 'GET', `https://api.github.com/repos/${slug}/releases/tags/${tag}`).catch(() => null)
if (existing) {
  console.log(`已存在 release #${existing.id}，先删除再重建`)
  await api(token, 'DELETE', `https://api.github.com/repos/${slug}/releases/${existing.id}`)
}

const release = await api(token, 'POST', `https://api.github.com/repos/${slug}/releases`, {
  tag_name: tag,
  name: tag,
  body,
  draft: false,
  prerelease: false
})
console.log(`\nrelease 已创建：${release.html_url}`)

for (const file of files) {
  const name = path.basename(file)
  const size = fs.statSync(file).size
  console.log(`\n上传 ${name}（${(size / 1048576).toFixed(1)} MB）…`)
  const asset = await api(
    token,
    'POST',
    `https://uploads.github.com/repos/${slug}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
    null,
    {
      headers: { 'Content-Type': 'application/octet-stream' },
      body: fs.readFileSync(file)
    }
  )
  console.log(`  → ${asset.state}  ${asset.browser_download_url}`)
}

// 收尾自检：最新那版得是刚发的这个
const latest = await api(token, 'GET', `https://api.github.com/repos/${slug}/releases/latest`)
console.log(`\nreleases/latest = ${latest.tag_name}${latest.tag_name === tag ? ' ✅' : ' ❌ 不是刚发的版本'}`)
if (latest.tag_name !== tag) process.exitCode = 1
