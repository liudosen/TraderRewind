# 项目记忆（MEMORY）

> 本文是给「未来会再次打开这个项目的人 / AI」看的长期记忆。
> 记录的是「这个项目是谁的、仓库在哪、怎么发版」这类不会随代码改动而变的上下文，
> 而不是某次提交的细节。改动细节请看 [CHANGELOG.md](CHANGELOG.md)。

## 一句话定位

**TraderRewind** —— 历史行情回放与交易训练工具。把行情当录像看，在上面反复练手。
完全本地运行，不连交易服务器，数据都存在用户自己磁盘上。

- 桌面应用：Electron 33 + React 18 + TypeScript + better-sqlite3 + lightweight-charts
- 许可证：Apache-2.0
- 作者 / 维护者：**liudosen**（本项目就是开发者本人维护的，没有外部团队）

## 仓库（双仓库，同时维护）

本项目在**两个平台各有一份仓库，代码同步、一起发版**：

| 平台 | 仓库地址 | 本地 remote | 备注 |
| --- | --- | --- | --- |
| GitHub | https://github.com/liudosen/TraderRewind | 默认 `liudosen/TraderRewind` | 海外用户 / 国际发布主站 |
| 码云 Gitee | https://gitee.com/DS_IT/TraderRewind | `origin`（`git@gitee.com:DS_IT/TraderRewind.git`） | 国内用户下载主站 |

关键点：

- **本地仓库的 `origin` 指向码云**（SSH 地址），不是 GitHub。
- GitHub 是 `liudosen/TraderRewind`，码云是 `DS_IT/TraderRewind`，**owner 名不一样**，别搞混。
- 两边的 `README.md` / `CHANGELOG.md` / 功能代码保持一致（README 里明确写了两个 Releases 下载地址）。

## 发版流程（核心记忆）

每次升级开发出新功能，标准发版动作是：

1. **升版本号**：改 `package.json` 的 `version`，并遵循语义化版本。
2. **写更新日志**：在 `CHANGELOG.md` 顶部加一节 `## [<版本>] - <日期>`（Keep a Changelog 格式）。
   发版脚本会直接从 CHANGELOG 里抠这一节作为 Release 正文。
3. **打安装包**：`npm run package:win`，产物落在 `release-<version>/` 下：
   - `TraderRewind-<版本>-setup.exe` —— 安装程序（NSIS）
   - `TraderRewind-<版本>-x64.zip` —— 免安装包
4. **双平台发版**（两个脚本，都要跑）：
   - `npm run release:gh` —— 发布到 GitHub Release（脚本 `scripts/release-gh.mjs`）
   - `npm run release:gitee` —— 发布到码云 Release（脚本 `scripts/release-gitee.mjs`）
   - 两个脚本都会：建 / 更新对应 `v<版本>` tag 的 Release，并上传安装包 + 免安装包。
   - 都支持 `-- --dry` 先预览。

**发布用本机的 SSH key**：

- 代码推送到远端（`git push`）走 SSH：码云是 `git@gitee.com:...`，GitHub 也是 `git@github.com:...`。
- Release 接口本身走 token，但 token 的来源是「本机已配好的凭据」：
  - GitHub：脚本用 `git credential fill` 从本机 git 凭据里读带 `repo` 权限的 token（或环境变量 `GITHUB_TOKEN`），**不落盘、不打印**。
  - 码云：脚本读环境变量 `GITEE_TOKEN`（码云 → 设置 → 私人令牌，勾选 `projects` 权限）。

> 一句话：**代码推送靠本机 SSH key，Release 发布靠本机已配好的 GitHub 凭据 + `GITEE_TOKEN` 环境变量。**

## 双仓库同步的约定

- 应用内自动更新会**同时查 GitHub 与码云两边的 Release**，各测一段速度，哪边快从哪边下，
  断了自动切另一条（见 `src/main/services/updater.ts`）。国内直连 GitHub 慢，基本落到码云。
- 所以两边 Release **必须同时发、版本号对齐**，否则国内 / 海外用户会拿到不同版本。

## 常用命令速查

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 开发环境（渲染进程热更新；主进程/preload/schema 改动要完全重启） |
| `npm run typecheck` | 类型检查，提交前必跑 |
| `npm run build` | 构建到 `out/` |
| `npm run package:win` | 打 Windows 安装包（setup.exe + x64.zip） |
| `npm run release:gh` | 发布 GitHub Release |
| `npm run release:gitee` | 发布码云 Release |
| `npm run icons` | 由 `build/logo.svg` 重生成各尺寸图标 |

## 需要记住的硬约束

- **主进程 / preload / 数据库 schema 改动不热更新**，必须完全退出应用重开。
- `better-sqlite3` 是原生模块，升级 Electron 后要 `npm run rebuild`；构建时 `npmRebuild: false`，
  ABI 编译交给 `postinstall` 独家负责，别改回 `true`（Windows 上会失败）。
- 数据默认在 `<userData>/data/{kline,training}`；旧版单库 `traderrewind.db` 首次启动自动拆分，
  改名 `*.migrated`，**不要手动删**。
- 提交信息走 Conventional Commits（英文 type + 中文描述），合并用 Squash merge，只维护 `main` 分支。
- 新增 IPC 通道要同步改三处：`shared/constants/ipc.ts`、`preload/index.ts`、`shared/types`。
