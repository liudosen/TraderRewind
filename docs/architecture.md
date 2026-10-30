# TraderRewind — 技术架构与框架设计

> 历史行情回放与交易训练桌面工具的技术架构说明。

## 1. 项目定位

**TraderRewind** — 历史行情回放与交易训练工具。让你像回放录像一样回看历史 K 线并练习交易。
完全本地运行，无账户限制，免费开源。

## 2. 技术选型

| 层 | 技术 | 理由 |
|---|---|---|
| 桌面框架 | Electron 33+ | 跨平台，Windows / macOS / Linux 一套代码 |
| 构建 | electron-vite 2 + electron-builder | 官方推荐的 Electron Vite 集成 |
| 主进程 | TypeScript (Node.js) | 类型安全，better-sqlite3 兼容 |
| 渲染层 | React 18 + TypeScript | 生态成熟 |
| 状态管理 | Zustand | 轻量，无样板代码，订阅粒度可控 |
| 图表 | TradingView lightweight-charts v5 | 开源 K 线图表 |
| 数据库 | better-sqlite3 | 同步高性能 SQLite |
| 富文本 | TipTap | 日志编辑器 |
| CSV 解析 | papaparse | 支持 CSV/CSV.GZ |
| 指标计算 | trading-signals + 自研公式引擎 | 内置指标走成熟库，自定义公式自己算 |
| 样式 | Tailwind CSS | 快速 UI 开发 |
| 图标 | lucide-react | 轻量图标库 |
| i18n | i18next | 多语言支持 |

## 3. 三层架构

```
src/
  shared/              # 共享类型与常量（主进程 + 渲染进程）
    types/             #   TypeScript 类型定义
    constants/         #   IPC 通道名、枚举、默认值
    utils/             #   纯函数工具库
  main/                # 主进程（Node.js）
    index.ts           #   入口 + 窗口创建 + IPC 注册
    db/                #   数据层
      connection.ts    #     SQLite 连接与迁移
      schema.ts        #     表结构定义
      repositories/    #     各表 Repository
    ipc/               #   IPC handler 注册
    services/          #   业务服务
      importer.ts      #     CSV/Tick 导入
      downloader.ts    #     数据下载
      replay.ts        #     回放引擎
      backtest.ts      #     策略回测
    utils/             #   工具函数
  preload/
    index.ts           # contextBridge API 暴露
  renderer/            # 渲染进程（React）
    index.html
    src/
      App.tsx          #   应用根组件
      main.tsx         #   入口
      stores/          #   Zustand stores
      components/      #   UI 组件
        chart/         #     图表相关
        panels/        #     面板（Hub/Training/Strategies/...）
        dialogs/       #     对话框
        common/        #     通用组件
      hooks/           #   React hooks
      services/        #   渲染进程服务（IPC 封装）
      utils/           #   工具函数
      styles/          #   全局样式
    public/            #   静态资源
```

## 4. 数据库设计

### 4.0 双库拆分

数据按用途拆为两个独立 SQLite 文件，目录可由用户在「设置 → 数据存储」分别指定：

| 库 | 内容 | 默认位置 | 表数 |
|---|---|---|---|
| `market.db` | 分组、数据集、K 线、Tick | `<userData>/data/kline` | 7 |
| `training.db` | 会话、持仓、成交、日志、账户、策略 | `<userData>/data/training` | 24 |

- 跨库外键不生效，`training.db` 中 `sessions.dataset_id` / `session_symbols.dataset_id` 仅作普通列，完整性由应用层保证
- 目录切换：关闭对应库 → 若目标无库文件则复制 → 更新 `settings.json` → 重开；失败自动回滚
- 旧版单库 `traderrewind.db` 首次启动时自动拆分迁移，原文件改名 `*.migrated`

### 4.1 表分组

按功能域分区，分 6 组：

1. **核心数据**：groups, datasets, candles, candles_ladder, ticks, tick_files
2. **回放会话**：sessions, session_symbols, positions, pending_orders, closed_trades, session_cash_flows, session_data_requirements, session_performance_snapshots
3. **真实交易**：accounts, account_events, imported_trades, futures_daily_summary, futures_open_positions, cfmmc_period_end_lots
4. **策略指标**：strategies, strategy_definitions, custom_indicators
5. **日志笔记**：journal_notes, note_images, note_templates
6. **系统其他**：achievements, s3_backup_settings, dataset_download_gaps, persistence_resource_usage, meta

## 5. IPC 设计

按模块组织通道命名空间：

| 命名空间 | 功能 | 通道数(约) |
|---|---|---|
| `db:*` | 数据库 CRUD | 110 |
| `file:*` | 文件操作 | 9 |
| `window:*` | 窗口管理 | 6 |
| `chart:*` | 图表截图 | 2 |
| `ai:*` | AI 导师 | 6 |
| `data:*` | 数据下载管理 | 12 |
| `backup:*` | 备份导入导出 | 2 |
| `update:*` | 自动更新 | 5 |
| `session:*` | 回放控制 | 扩展 |

## 6. 实施路线图

### Phase 1: 基础骨架 ✅
- [x] 项目结构搭建
- [x] 架构文档
- [x] Electron + electron-vite 配置
- [x] SQLite 连接 + schema 迁移（30 表）+ 结构校验
- [x] Preload API 框架
- [x] React 应用骨架 + 面板路由
- [x] 基础 UI 主题（暗色）

### Phase 1.5: 数据源管理 ✅
- [x] Dukascopy 免费外汇数据源接入（23 品种）
- [x] bi5 下载（HTTP + 代理 + HTTPS CONNECT 隧道）
- [x] LZMA 解压 + 大端序 tick 解析
- [x] tick → 多周期 K 线聚合（M1–D1）
- [x] 全局并发池（2–48 路可调）
- [x] 实时进度 / 瞬时与平均网速 / ETA / 文件计数
- [x] 增量落库 + 数据集列表 + 删除
- [x] 任务取消

### Phase 2: 核心回放 + 交易训练 ✅
- [x] K 线图表渲染（lightweight-charts v5，涨红跌绿）
- [x] 回放引擎（播放/暂停 / 1-10 档速度 / 单步进退 / 进度条跳转）
- [x] 训练会话管理（从数据集创建、恢复进度与余额、多会话切换）
- [x] 模拟下单（买入/卖出/手数调节/手动平仓）
- [x] 止损 / 止盈价格线，支持上下拖拽调整
- [x] 逐根回放时自动判定 SL/TP 触发并平仓
- [x] 平仓记录自动落库（`closed_trades`）+ 会话余额/进度持久化
- [x] 实时权益、浮动盈亏、胜率与盈亏统计
- [x] 快捷键（空格播放/暂停、B 买入、S 卖出、C 平仓）
- [ ] CSV 文件导入（除在线下载外的补充数据源）

### Phase 3: 日志与统计
- [ ] 交易日志（TipTap 富文本 + 截图）
- [ ] 统计诊断（PF / 回撤 / 时段分布）
- [ ] 标签系统

### Phase 4: 高级功能
- [ ] AI 复盘导师
- [ ] MT4/MT5 集成
- [ ] 云备份
- [ ] 成就系统
