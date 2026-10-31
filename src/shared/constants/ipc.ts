// ============================================================
// TraderRewind — IPC 通道常量
// 命名空间划分：db / file / window / chart / ai / data / backup / update
// ============================================================

export const IPC = {
  // ----- 数据库: 数据集 -----
  DB_LIST_GROUPS: 'db:listGroups',
  DB_CREATE_GROUP: 'db:createGroup',
  DB_RENAME_GROUP: 'db:renameGroup',
  DB_DELETE_GROUP: 'db:deleteGroup',
  DB_LIST_DATASETS: 'db:listDatasets',
  DB_GET_DATASET: 'db:getDataset',
  DB_IMPORT_DATASET: 'db:importDataset',
  DB_DELETE_DATASET: 'db:deleteDataset',
  DB_DELETE_DATASET_PROGRESS: 'db:deleteDataset:progress',
  DB_CLEAR_DATASET_DATA: 'db:clearDatasetData',
  DB_CHECK_DATASET_CONFLICT: 'db:checkDatasetConflict',
  DB_CREATE_CACHE_LINK: 'db:createCacheLink',

  // ----- 数据库: K线/Tick -----
  DB_FETCH_BARS: 'db:fetchBars',
  DB_GET_CANDLES_BEFORE: 'db:getDatasetCandlesBeforeChunkBuf',
  DB_GET_CANDLES_AFTER: 'db:getDatasetCandlesAfterChunkBuf',
  DB_GET_CANDLES_RANGE: 'db:getDatasetCandlesRangeBuf',
  DB_GET_BAR_INDEX_AT_TIME: 'db:getDatasetBarIndexAtTime',
  DB_GET_TICKS_RANGE: 'db:getDatasetTicksBufferRange',
  DB_IMPORT_TICK_FILE: 'db:importTickFile',
  DB_OPTIMIZE_TICK: 'db:optimizeTickDataset',
  DB_TICK_IMPORT_PROGRESS: 'db:tickImport:progress',
  DB_TICK_OPTIMIZE_PROGRESS: 'db:tickOptimize:progress',

  // ----- 数据库: 会话 -----
  DB_LIST_SESSIONS: 'db:listSessions',
  DB_LIST_SESSIONS_WITH_TRADES: 'db:listSessionsWithTrades',
  DB_LIST_SESSIONS_FOR_DATASET: 'db:listSessionsForDataset',
  DB_GET_SESSION: 'db:getSession',
  DB_CREATE_SESSION: 'db:createSession',
  DB_RENAME_SESSION: 'db:renameSession',
  DB_DELETE_SESSION: 'db:deleteSession',
  DB_SAVE_SESSION_STATE: 'db:saveSessionState',
  DB_SAVE_SESSION_STATE_SYNC: 'db:saveSessionStateSync',
  /** 标记回测集已完成（游标走到区间最后一根 K 线） */
  DB_COMPLETE_SESSION: 'db:completeSession',
  /** 重置回测集：清空该会话全部订单 + 游标回到起点 + 余额复位 */
  DB_RESET_SESSION: 'db:resetSession',
  /** 日志页：已完成的回测集 + 交易统计 */
  DB_LIST_COMPLETED_SESSIONS: 'db:listCompletedSessions',
  DB_TOUCH_SESSION: 'db:touchSession',
  DB_UPDATE_TRAINING_SETTINGS: 'db:updateTrainingSessionSettings',
  DB_SET_SESSION_SYMBOLS: 'db:setSessionSymbols',
  DB_LIST_SESSION_SYMBOLS: 'db:listSessionSymbols',
  DB_GET_SESSION_PERF_SNAPSHOT: 'db:getSessionPerformanceSnapshot',
  DB_REVEAL_BLIND_SESSION: 'db:revealBlindSession',

  // ----- 数据库: 交易 -----
  DB_APPEND_CLOSED_TRADE: 'db:appendClosedTrade',
  DB_LIST_CLOSED_TRADES: 'db:listClosedTrades',
  DB_LIST_AGGREGATED_TRADES: 'db:listAggregatedTrades',
  DB_UPDATE_CLOSED_TRADE_SCREENSHOT: 'db:updateClosedTradeScreenshot',
  /** 日志里编辑一笔交易的「思路（备注）+ 标签」，两个一起改，避免半截状态 */
  DB_UPDATE_CLOSED_TRADE_META: 'db:updateClosedTradeMeta',
  DB_UPDATE_CLOSED_TRADE_TAGS: 'db:updateClosedTradeTags',
  DB_UPDATE_CLOSED_TRADE_ENTRY_REASON: 'db:updateClosedTradeEntryReason',
  DB_UPDATE_CLOSED_TRADE_STRATEGY: 'db:updateClosedTradeStrategyName',
  DB_UPDATE_IMPORTED_TRADE_ENTRY_REASON: 'db:updateImportedTradeEntryReason',
  DB_UPDATE_IMPORTED_TRADE_STRATEGY: 'db:updateImportedTradeStrategyName',
  DB_RENAME_TRADE_STRATEGY: 'db:renameTradeStrategyName',
  DB_CLEAR_TRADE_STRATEGY: 'db:clearTradeStrategyName',
  DB_GET_CLOSED_TRADE_SCREENSHOT: 'db:getClosedTradeScreenshot',
  DB_GET_IMPORTED_TRADE_SCREENSHOT: 'db:getImportedTradeScreenshot',
  DB_COMPUTE_MAE_MFE: 'db:computeMaeMfeForAccount',
  DB_UPDATE_TRADE_REFLECTION: 'db:updateTradeReflection',

  // ----- 数据库: 账户 -----
  DB_LIST_ACCOUNTS: 'db:listAccounts',
  DB_CREATE_ACCOUNT: 'db:createAccount',
  DB_DELETE_ACCOUNT: 'db:deleteAccount',
  DB_RENAME_ACCOUNT: 'db:renameAccount',
  DB_UPDATE_ACCOUNT_TZ: 'db:updateAccountServerTimezone',
  DB_LIST_ACCOUNT_EVENTS: 'db:listAccountEvents',
  DB_INSERT_ACCOUNT_EVENT: 'db:insertAccountEvent',
  DB_DELETE_ACCOUNT_EVENT: 'db:deleteAccountEvent',

  // ----- 数据库: 导入 -----
  DB_PARSE_JOURNAL_FILE: 'db:parseJournalFile',
  DB_IMPORT_JOURNAL_TRADES: 'db:importJournalTrades',
  DB_PARSE_IMPORTED_FILES: 'db:parseImportedFiles',
  DB_DELETE_IMPORTED_TRADES_BY_SOURCE: 'db:deleteImportedTradesBySource',
  DB_DELETE_IMPORTED_TRADE: 'db:deleteImportedTrade',

  // ----- 数据库: 日志 -----
  DB_LIST_JOURNAL_NOTES: 'db:listJournalNotes',
  DB_CREATE_JOURNAL_NOTE: 'db:createJournalNote',
  DB_UPDATE_JOURNAL_NOTE: 'db:updateJournalNote',
  DB_DELETE_JOURNAL_NOTE: 'db:deleteJournalNote',
  DB_LIST_NOTE_TEMPLATES: 'db:listNoteTemplates',
  DB_CREATE_NOTE_TEMPLATE: 'db:createNoteTemplate',
  DB_DELETE_NOTE_TEMPLATE: 'db:deleteNoteTemplate',
  DB_INSERT_NOTE_IMAGE: 'db:insertNoteImage',
  DB_GET_NOTE_IMAGE: 'db:getNoteImage',
  DB_DELETE_NOTE_IMAGE: 'db:deleteNoteImage',
  DB_COPY_NOTE_IMAGES: 'db:copyNoteImagesForTrade',
  DB_REASSIGN_NOTE_IMAGES: 'db:reassignNoteImagesForTrade',
  DB_GET_NOTE_IMAGE_USAGE: 'db:getNoteImageUsage',
  DB_LIST_NOTE_IMAGE_IDS_FOR_TRADE: 'db:listNoteImageIdsForTrade',
  DB_LIST_NOTE_IMAGE_IDS_FOR_NOTE: 'db:listNoteImageIdsForNote',

  // ----- 数据库: 指标 -----
  DB_LIST_CUSTOM_INDICATORS: 'db:listCustomIndicators',
  DB_UPSERT_CUSTOM_INDICATOR: 'db:upsertCustomIndicator',
  DB_DELETE_CUSTOM_INDICATOR: 'db:deleteCustomIndicator',

  // ----- 数据库: 标签 -----
  DB_LIST_TAG_USAGE: 'db:listTagUsage',
  DB_RENAME_TAG_EVERYWHERE: 'db:renameTagEverywhere',
  DB_REMOVE_TAG_EVERYWHERE: 'db:removeTagEverywhere',
  DB_UNDO_TAG_CHANGE: 'db:undoTagLibraryChange',

  // ----- 数据库: 期货 -----
  DB_IMPORT_CFMMC: 'db:importCfmmcStatements',
  DB_PARSE_CFMMC: 'db:parseCfmmcStatements',
  DB_LIST_FUTURES_POSITIONS: 'db:listFuturesOpenPositions',
  DB_LIST_FUTURES_SUMMARY: 'db:listFuturesDailySummary',

  // ----- 数据库: 元数据 -----
  DB_GET_META: 'db:getMeta',
  DB_SET_META: 'db:setMeta',

  // ----- 数据库: 训练统计 -----
  /** 累加某个回测集的实际训练用时（秒） */
  DB_ADD_TRAIN_SECONDS: 'db:addTrainSeconds',
  /** 工作台用的汇总：总用时 / 总交易笔数 / 会话数 */
  DB_GET_TRAINING_STATS: 'db:getTrainingStats',

  // ----- 文件操作 -----
  FILE_OPEN_CSV: 'file:openCsvFile',
  FILE_PEEK_CSV: 'file:peekCsvFile',
  FILE_READ_CSV: 'file:readCsvFile',
  FILE_SAVE_CSV: 'file:saveCsvFile',
  FILE_OPEN_JOURNAL: 'file:openJournalFile',
  FILE_SAVE_HTML: 'file:saveHtmlFile',

  // ----- 窗口 -----
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_CLOSE: 'window:close',
  WINDOW_MAXIMIZE_TOGGLE: 'window:maximizeToggle',
  WINDOW_IS_MAXIMIZED: 'window:isMaximized',
  WINDOW_MAXIMIZED_CHANGED: 'window:maximizedChanged',
  WINDOW_REFOCUS: 'window:refocusAfterDialog',

  // ----- 图表 -----
  CHART_CAPTURE_COPY: 'chart:capture-copy',
  CHART_CAPTURE_SAVE: 'chart:capture-save',

  // ----- AI -----
  AI_CHAT: 'ai:chat',
  AI_HAS_KEY: 'ai:hasKey',
  AI_SET_KEY: 'ai:setKey',
  AI_DELETE_KEY: 'ai:deleteKey',
  AI_TEST_CONNECTION: 'ai:testConnection',
  AI_ENCRYPTION_AVAILABLE: 'ai:encryptionAvailable',

  // ----- 数据下载 -----
  DATA_LIST_CATALOG: 'data:listCatalog',
  DATA_DOWNLOAD: 'data:download',
  DATA_CANCEL: 'data:cancel',
  DATA_PROGRESS: 'data:progress',
  DATA_SCAN_LOCAL: 'data:scanLocal',
  DATA_BUNDLED_CATALOG: 'data:bundledCatalog',
  DATA_FETCH_ROLLOVERS: 'data:fetchRollovers',
  DATA_LIST_DATASETS: 'data:listDatasets',
  DATA_DELETE_DATASET: 'data:deleteDataset',

  // ----- 应用设置（数据目录等） -----
  SETTINGS_GET: 'settings:get',
  SETTINGS_CHOOSE_DIR: 'settings:chooseDir',
  SETTINGS_SET_DIR: 'settings:setDir',
  SETTINGS_REVEAL_DIR: 'settings:revealDir',
  SETTINGS_GET_CHART_THEME: 'settings:getChartTheme',
  SETTINGS_SET_CHART_THEME: 'settings:setChartTheme',
  SETTINGS_GET_TIMEZONE: 'settings:getTimezone',
  SETTINGS_SET_TIMEZONE: 'settings:setTimezone',
  // 界面语言（中文 / English）
  SETTINGS_GET_LOCALE: 'settings:getLocale',
  SETTINGS_SET_LOCALE: 'settings:setLocale',
  SETTINGS_GET_INDICATOR_PREFS: 'settings:getIndicatorPrefs',
  SETTINGS_SET_INDICATOR_PREFS: 'settings:setIndicatorPrefs',
  SETTINGS_GET_TRADE_TAGS: 'settings:getTradeTags',
  SETTINGS_SET_TRADE_TAGS: 'settings:setTradeTags',
  // 交易成本模型（手续费 + 滑点）
  SETTINGS_GET_EXECUTION_COST: 'settings:getExecutionCost',
  SETTINGS_SET_EXECUTION_COST: 'settings:setExecutionCost',

  // ----- 备份 -----
  BACKUP_EXPORT: 'backup:export',
  BACKUP_IMPORT: 'backup:import',

  // ----- 更新 -----
  UPDATE_CHECK: 'update:check',
  UPDATE_GET_STATE: 'update:getState',
  UPDATE_STATUS: 'update:status',
  UPDATE_DOWNLOAD: 'update:download',
  UPDATE_INSTALL: 'update:install',
  /** 打不开自动更新时的兜底：直接跳到 GitHub 发布页 */
  UPDATE_OPEN_RELEASE_PAGE: 'update:openReleasePage',

  // ----- 数据库: 存储 -----
  DB_PERSISTENCE_RELEASE: 'db:persistenceRead:release'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
