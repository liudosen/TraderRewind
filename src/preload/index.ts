// ============================================================
// TraderRewind — Preload (contextBridge API)
// ============================================================

import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/constants/ipc'

const api = {
  // ----- 数据库: 分组 -----
  listGroups: () => ipcRenderer.invoke(IPC.DB_LIST_GROUPS),
  createGroup: (name: string, kind: string) => ipcRenderer.invoke(IPC.DB_CREATE_GROUP, name, kind),
  renameGroup: (id: number, name: string) => ipcRenderer.invoke(IPC.DB_RENAME_GROUP, id, name),
  deleteGroup: (id: number) => ipcRenderer.invoke(IPC.DB_DELETE_GROUP, id),

  // ----- 数据库: 数据集 -----
  listDatasets: (groupId?: number) => ipcRenderer.invoke(IPC.DB_LIST_DATASETS, groupId),
  getDataset: (id: number) => ipcRenderer.invoke(IPC.DB_GET_DATASET, id),
  deleteDataset: (id: number) => ipcRenderer.invoke(IPC.DB_DELETE_DATASET, id),

  // ----- 数据库: 会话 -----
  listSessions: () => ipcRenderer.invoke(IPC.DB_LIST_SESSIONS),
  getSession: (id: number) => ipcRenderer.invoke(IPC.DB_GET_SESSION, id),
  createSession: (params: any) => ipcRenderer.invoke(IPC.DB_CREATE_SESSION, params),
  renameSession: (id: number, name: string) => ipcRenderer.invoke(IPC.DB_RENAME_SESSION, id, name),
  deleteSession: (id: number) => ipcRenderer.invoke(IPC.DB_DELETE_SESSION, id),
  saveSessionState: (id: number, state: any) => ipcRenderer.invoke(IPC.DB_SAVE_SESSION_STATE, id, state),
  completeSession: (id: number) => ipcRenderer.invoke(IPC.DB_COMPLETE_SESSION, id),
  resetSession: (id: number, state: any) => ipcRenderer.invoke(IPC.DB_RESET_SESSION, id, state),
  listCompletedSessions: () => ipcRenderer.invoke(IPC.DB_LIST_COMPLETED_SESSIONS),

  // ----- 数据库: 交易 -----
  appendClosedTrade: (trade: any) => ipcRenderer.invoke(IPC.DB_APPEND_CLOSED_TRADE, trade),
  listAggregatedTrades: (params: any) => ipcRenderer.invoke(IPC.DB_LIST_AGGREGATED_TRADES, params),
  listClosedTrades: (sessionId: number) => ipcRenderer.invoke(IPC.DB_LIST_CLOSED_TRADES, sessionId),
  /** 日志页编辑一笔交易的思路（备注）与标签；返回是否真的改到了行 */
  updateTradeMeta: (sessionId: number, tradeId: string, meta: { note?: string | null; tags?: string[] }) =>
    ipcRenderer.invoke(IPC.DB_UPDATE_CLOSED_TRADE_META, sessionId, tradeId, meta),

  // ----- 数据库: K线 -----
  getCandlesRange: (datasetId: number, fromTime: number, toTime: number) =>
    ipcRenderer.invoke(IPC.DB_GET_CANDLES_RANGE, datasetId, fromTime, toTime),
  fetchBars: (datasetId: number, limit?: number) =>
    ipcRenderer.invoke(IPC.DB_FETCH_BARS, datasetId, limit),

  // ----- 数据库: 账户 -----
  listAccounts: () => ipcRenderer.invoke(IPC.DB_LIST_ACCOUNTS),
  createAccount: (params: any) => ipcRenderer.invoke(IPC.DB_CREATE_ACCOUNT, params),
  deleteAccount: (id: number) => ipcRenderer.invoke(IPC.DB_DELETE_ACCOUNT, id),

  // ----- 数据库: 日志 -----
  listJournalNotes: () => ipcRenderer.invoke(IPC.DB_LIST_JOURNAL_NOTES),
  createJournalNote: (params: any) => ipcRenderer.invoke(IPC.DB_CREATE_JOURNAL_NOTE, params),
  updateJournalNote: (id: number, params: any) => ipcRenderer.invoke(IPC.DB_UPDATE_JOURNAL_NOTE, id, params),
  deleteJournalNote: (id: number) => ipcRenderer.invoke(IPC.DB_DELETE_JOURNAL_NOTE, id),

  // ----- 数据库: 元数据 -----
  getMeta: (key: string) => ipcRenderer.invoke(IPC.DB_GET_META, key),
  setMeta: (key: string, value: string) => ipcRenderer.invoke(IPC.DB_SET_META, key, value),

  // ----- 训练统计（工作台） -----
  /** 累加某个回测集的实际训练用时（秒），前端每秒攒、够一批才发一次 */
  addSessionTrainSeconds: (id: number, seconds: number) =>
    ipcRenderer.invoke(IPC.DB_ADD_TRAIN_SECONDS, id, seconds),
  /** 汇总：总训练用时 / 总交易笔数 / 会话数 */
  getTrainingStats: () => ipcRenderer.invoke(IPC.DB_GET_TRAINING_STATS),

  // ----- 文件操作 -----
  openCsvFile: () => ipcRenderer.invoke(IPC.FILE_OPEN_CSV),
  readCsvFile: (path: string) => ipcRenderer.invoke(IPC.FILE_READ_CSV, path),
  saveCsvFile: (name: string, content: string) => ipcRenderer.invoke(IPC.FILE_SAVE_CSV, name, content),

  // ----- 数据源与下载 -----
  /** `force` 跳过主进程的 60 秒品种缓存（手动「刷新品种」用） */
  listDataCatalog: (opts?: { force?: boolean }) => ipcRenderer.invoke(IPC.DATA_LIST_CATALOG, opts),
  /** cTrader 本地 MCP 探活：只做 TCP 连接，供状态灯轮询 */
  ctraderMcpStatus: () => ipcRenderer.invoke(IPC.DATA_MCP_STATUS),
  startDownload: (request: any) => ipcRenderer.invoke(IPC.DATA_DOWNLOAD, request),
  cancelDownload: (jobId: string) => ipcRenderer.invoke(IPC.DATA_CANCEL, jobId),
  listDownloadedDatasets: () => ipcRenderer.invoke(IPC.DATA_LIST_DATASETS),
  deleteDownloadedDataset: (id: number) => ipcRenderer.invoke(IPC.DATA_DELETE_DATASET, id),
  /** 导出为独立 .db；ids 传 null = 全部 */
  exportDatasetsDb: (ids: number[] | null) => ipcRenderer.invoke(IPC.DATA_EXPORT_DB, { ids }),
  /** 从 .db 导入并合并进本地行情库 */
  importDatasetsDb: () => ipcRenderer.invoke(IPC.DATA_IMPORT_DB),

  // ----- 应用设置（数据目录） -----
  getStorageInfo: () => ipcRenderer.invoke(IPC.SETTINGS_GET),
  chooseStorageDir: (kind: 'kline' | 'training') =>
    ipcRenderer.invoke(IPC.SETTINGS_CHOOSE_DIR, kind),
  setStorageDir: (kind: 'kline' | 'training', dir: string) =>
    ipcRenderer.invoke(IPC.SETTINGS_SET_DIR, kind, dir),
  revealStorageDir: (kind: 'kline' | 'training') =>
    ipcRenderer.invoke(IPC.SETTINGS_REVEAL_DIR, kind),
  getChartTheme: () => ipcRenderer.invoke(IPC.SETTINGS_GET_CHART_THEME),
  setChartTheme: (theme: any) => ipcRenderer.invoke(IPC.SETTINGS_SET_CHART_THEME, theme),
  getTimezone: () => ipcRenderer.invoke(IPC.SETTINGS_GET_TIMEZONE),
  setTimezone: (timezone: string) => ipcRenderer.invoke(IPC.SETTINGS_SET_TIMEZONE, timezone),
  getLocale: () => ipcRenderer.invoke(IPC.SETTINGS_GET_LOCALE),
  setLocale: (locale: string) => ipcRenderer.invoke(IPC.SETTINGS_SET_LOCALE, locale),
  getIndicatorPrefs: () => ipcRenderer.invoke(IPC.SETTINGS_GET_INDICATOR_PREFS),
  setIndicatorPrefs: (prefs: any) =>
    ipcRenderer.invoke(IPC.SETTINGS_SET_INDICATOR_PREFS, prefs),
  getTradeTags: () => ipcRenderer.invoke(IPC.SETTINGS_GET_TRADE_TAGS),
  setTradeTags: (tags: string[]) => ipcRenderer.invoke(IPC.SETTINGS_SET_TRADE_TAGS, tags),
  getExecutionCost: () => ipcRenderer.invoke(IPC.SETTINGS_GET_EXECUTION_COST),
  setExecutionCost: (cost: any) => ipcRenderer.invoke(IPC.SETTINGS_SET_EXECUTION_COST, cost),

  // ----- 窗口 -----
  minimize: () => ipcRenderer.invoke(IPC.WINDOW_MINIMIZE),
  close: () => ipcRenderer.invoke(IPC.WINDOW_CLOSE),
  maximizeToggle: () => ipcRenderer.invoke(IPC.WINDOW_MAXIMIZE_TOGGLE),
  isMaximized: () => ipcRenderer.invoke(IPC.WINDOW_IS_MAXIMIZED),
  refocusAfterDialog: () => ipcRenderer.invoke(IPC.WINDOW_REFOCUS),

  // ----- 更新（GitHub Release） -----
  /** 主动检查；`autoDownload` 为 true 时发现新版立刻开始下载 */
  checkUpdate: (opts?: { autoDownload?: boolean }) =>
    ipcRenderer.invoke(IPC.UPDATE_CHECK, opts),
  getUpdateState: () => ipcRenderer.invoke(IPC.UPDATE_GET_STATE),
  downloadUpdate: () => ipcRenderer.invoke(IPC.UPDATE_DOWNLOAD),
  installUpdate: () => ipcRenderer.invoke(IPC.UPDATE_INSTALL),
  openReleasePage: () => ipcRenderer.invoke(IPC.UPDATE_OPEN_RELEASE_PAGE),

  // ----- cTrader Open API 凭据 -----
  ctraderCred: {
    /** 安全摘要：只含是否配置、尾号、剩余天数，不含任何密文 */
    get: () => ipcRenderer.invoke(IPC.CTRADER_CRED_GET),
    save: (input: {
      clientId: string
      clientSecret: string
      accessToken?: string
      refreshToken?: string
      accountId?: number | null
      environment?: 'live' | 'demo'
    }) => ipcRenderer.invoke(IPC.CTRADER_CRED_SAVE, input),
    clear: () => ipcRenderer.invoke(IPC.CTRADER_CRED_CLEAR),
    /** 手动续期（5036 协议消息，不需要访问被阻断的 443） */
    refresh: () => ipcRenderer.invoke(IPC.CTRADER_CRED_REFRESH),
    authUrl: (redirectUri?: string) => ipcRenderer.invoke(IPC.CTRADER_CRED_AUTH_URL, redirectUri),
    exchange: (params: { code: string; redirectUri?: string }) =>
      ipcRenderer.invoke(IPC.CTRADER_CRED_EXCHANGE, params),
    acceptToken: (text: string) => ipcRenderer.invoke(IPC.CTRADER_CRED_ACCEPT, text)
  },

  // ----- 事件监听 -----
  on: (channel: string, callback: (...args: any[]) => void) => {
    const subscription = (_event: Electron.IpcRendererEvent, ...args: any[]) => callback(...args)
    ipcRenderer.on(channel, subscription)
    return () => ipcRenderer.removeListener(channel, subscription)
  },

  send: (channel: string, ...args: any[]) => {
    ipcRenderer.send(channel, ...args)
  }
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
