# 贡献指南

感谢你有兴趣改进 TraderRewind。本文说明本地怎么跑起来、代码怎么组织、
以及提交前需要做哪些检查。请在动手前花五分钟读完，能省掉来回返工。

## 目录

- [行为准则](#行为准则)
- [开发环境](#开发环境)
- [常用的命令](#常用的命令)
- [目录结构导读](#目录结构导读)
- [分支规范](#分支规范)
- [提交信息规范](#提交信息规范)
- [代码风格](#代码风格)
- [提交 PR 之前](#提交-pr-之前)
- [几个容易踩的坑](#几个容易踩的坑)

## 行为准则

参与本项目即表示你同意遵守 [行为准则](CODE_OF_CONDUCT.md)。

## 开发环境

| 项 | 要求 |
|---|---|
| Node.js | **20 或更高**（`package.json` 的 `engines` 字段） |
| 包管理器 | npm（仓库里有 `package-lock.json`，请不要混用 yarn / pnpm ） |
| 操作系统 | Windows 10+ / macOS 12+ / Linux（主开发环境是 Windows） |
| 编译工具 | `better-sqlite3` 是原生模块，需要 C++ 编译链；装 `npm install` 时由 `postinstall` 自动 `electron-rebuild` |

```bash
git clone https://github.com/liudosen/TraderRewind.git
cd TraderRewind
npm install
npm run dev
```

> `npm install` 会顺带执行 `electron-rebuild`，把 `better-sqlite3` 编成 Electron 的 ABI。
> 如果你换了 Electron 版本或升级了 Node，需要重跑 `npm run rebuild`，否则启动时报
> `NODE_MODULE_VERSION` 不匹配。

Electron 二进制走国内镜像（见 `.npmrc`）。若安装后启动报
`@rollup/rollup-win32-x64-msvc` 或 `@esbuild/win32-x64` 缺失，补装即可：

```bash
npm i -D @rollup/rollup-win32-x64-msvc @esbuild/win32-x64
```

## 常用的命令

| 命令 | 作用 |
|---|---|
| `npm run dev` | 启动开发环境（渲染进程热更新） |
| `npm run typecheck` | `tsc --noEmit`，**提交前必跑** |
| `npm run build` | 构建到 `out/` |
| `npm run package:win` | 打 Windows 安装包（NSIS） |
| `npm run package:mac` | 打 macOS dmg |
| `npm run icons` | 由 `build/logo.svg` 生成 ico / icns / png 图标 |
| `npm run rebuild` | 重编 `better-sqlite3` |

## 目录结构导读

```
src/
  shared/      主进程与渲染进程共用的类型、常量、纯函数工具（不含 Electron / React 依赖）
  main/        主进程：窗口、IPC、数据库、下载服务
  preload/     contextBridge，向渲染进程暴露受控 API
  renderer/    React 界面
```

三条硬规矩：

1. **`shared/` 里不要 import Electron 或 React**，它被两边同时引用。
2. **渲染进程不允许直接碰 Node / 数据库**，一切走 `preload` 暴露的 `window.api`。
3. **新增 IPC 通道要同时改三处**：`shared/constants/ipc.ts` 的通道名、
   `preload/index.ts` 的桥接方法、`shared/types` 里的入参/返回类型。

## 分支规范

`main` 是唯一长期分支，始终保持可运行、可构建。

| 类型 | 命名 | 例子 |
|---|---|---|
| 新功能 | `feat/<简短描述>` | `feat/crypto-data-source` |
| 修缺陷 | `fix/<简短描述>` | `fix/sl-tp-drag-jitter` |
| 文档 | `docs/<简短描述>` | `docs/contributing` |
| 重构（不改行为） | `refactor/<简短描述>` | `refactor/candle-adapter` |
| 杂务（构建、依赖） | `chore/<简短描述>` | `chore/bump-electron` |

- 描述用小写短横线连接，别用中文和空格。
- 分支尽量短命，一个分支只做一件事；功能大就拆成多个 PR。
- 合入方式用 **Squash merge**，保持 `main` 的提交历史一条线一个功能。
- 不要直接往 `main` 推。仓库会开启分支保护。

## 提交信息规范

采用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)，
首行英文类型 + 中文描述（本项目的中文语境下，描述用中文更好读）。

```
<type>(<可选范围>): <一句话说清做了什么>

<可选：为什么这么改、有什么取舍、影响面>
```

**type 取值**

| type | 含义 |
|---|---|
| `feat` | 新功能 |
| `fix` | 修缺陷 |
| `docs` | 只改文档 |
| `style` | 只改格式（空格、分号），不改逻辑 |
| `refactor` | 重构，对外行为不变 |
| `perf` | 性能优化 |
| `test` | 增删改测试 |
| `chore` | 构建、依赖、脚手架 |
| `build` | 打包配置 |

**示例**

```
feat(download): 支持 OKX / Binance 加密 K 线数据源

两家翻页方向相反（OKX 的 after 往旧走，Binance 的 startTime 往新走），
把差异收进 CandleAdapter.page()，调度侧只认「给定游标拿下一页」。
```

**不接受的提交**

- `update`、`fix bug`、`修改`、`.` 这类没说清干了什么的标题
- 一个提交里混入无关改动（比如顺手重构了别的文件）
- 提交里带 `console.log`、调试用的临时文件

## 代码风格

没有强制 linter，但请**跟随周围代码的写法**，别在一个文件里混两种风格：

- 2 空格缩进、**不加分号**、字符串用单引号、多行结构留尾逗号
- TypeScript `strict` 已开启，**不要用 `any` 绕过**；确实需要时写 `unknown` 再收窄
- 组件用函数式 + hooks；跨组件状态放 `zustand` store，不要层层传 props
- 注释写**为什么**，不写**是什么**。`// i++` 这种没有信息量的注释不要留
- 中文注释里中英文之间加空格，标点用中文标点
- 提交前跑 `npm run typecheck`，**零错误**是底线

## 提交 PR 之前

自查清单：

- [ ] `npm run typecheck` 通过（0 error）
- [ ] `npm run build` 通过
- [ ] 手动跑过受影响的界面，不是只看编译过没过
- [ ] 改动涉及主进程 / preload / 数据库 schema 的，**重启应用**验证过
      （这几层不热更新，改动后不重启会以为没生效）
- [ ] 新增的界面文案**中英文都加了**（见 `src/renderer/src/i18n/messages.ts`）
- [ ] 没有提交 `out/`、`release*/`、`node_modules/`、本地数据库文件
- [ ] PR 描述里说清「改了什么 / 为什么 / 怎么验证的」，附截图更好

## 几个容易踩的坑

**主进程 / preload / schema 改动不热更新**
只热更新渲染进程。改了 `src/main/**`、`src/preload/**`、`src/main/db/schema.ts`，
必须完全退出应用重新 `npm run dev`，否则你会对着旧代码调试半天。

**Windows 上启动 Electron 前要清 `ELECTRON_RUN_AS_NODE`**
环境里残留这个变量时，Electron 会当成 Node 跑，报
`bad option: --enable-logging` 然后直接退出：

```bash
unset ELECTRON_RUN_AS_NODE && npm run dev
```

**`better-sqlite3` 的 ABI 不匹配**
升级 Electron 后必须 `npm run rebuild`。报错形如
`The module was compiled against a different Node.js version`。

**数据目录与旧库迁移**
数据默认在 `<userData>/data/{kline,training}`。旧版单库 `traderrewind.db`
首次启动会自动拆分并重命名成 `*.migrated`，**不要手动删这个文件**，出问题时要靠它恢复。

**打包时 electron-builder 重复编译原生模块**
`electron-builder.yml` 里设了 `npmRebuild: false`，构建交给 `postinstall` 独家负责。
如果你把它改回 `true`，在 Windows 上重编 `better-sqlite3` 时清理旧 `.node`
会走 trash 操作，某些受限环境下会直接失败。

## 许可证

提交代码即表示你同意以 [Apache License 2.0](LICENSE) 授权你的贡献。
