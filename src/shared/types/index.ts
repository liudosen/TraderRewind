// ============================================================
// TraderRewind — 共享类型定义
// ============================================================

// ---------- 枚举 ----------

export type Market = 'fx' | 'cn_futures' | 'us_futures'
export type DatasetKind = 'bar' | 'tick'
export type DatasetSource = 'imported' | 'system'
export type SessionSource = 'manual' | 'backtest' | 'imported_replay'
export type SymbolRole = 'tradable' | 'reference'
export type OrderType = 'buy' | 'sell' | 'buy_limit' | 'sell_limit' | 'buy_stop' | 'sell_stop' | 'buy_stop_limit' | 'sell_stop_limit'
export type CommissionKind = 'per_lot' | 'per_trade' | 'spread_only'

// ---------- 核心数据 ----------

export interface Group {
  id: number
  name: string
  kind: string
  createdAt: number
}

export interface Dataset {
  id: number
  groupId: number
  symbol: string
  timeframe: string
  timezone: string
  firstTime: number
  lastTime: number
  candleCount: number
  sourceFilename: string | null
  importedAt: number
  kind: DatasetKind
  market: Market
  source: DatasetSource
  cacheKind: string | null
  linkToDatasetId: number | null
  pointSize: number | null
}

export interface Candle {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
  spread?: number | null
  oi?: number | null
}

export interface Tick {
  timeMs: number
  bid: number
  ask: number
  volume: number | null
  flags: number | null
}

// ---------- 回放会话 ----------

export interface Session {
  id: number
  datasetId: number
  name: string
  currentIndex: number
  speed: number
  skipWeekends: boolean
  displayTimeframe: string | null
  initialBalance: number
  balance: number
  lotSize: number
  drawingsJson: string | null
  indicatorsJson: string | null
  chartViewJson: string | null
  createdAt: number
  updatedAt: number
  lastOpenedAt: number
  currentBarTime: number | null
  source: SessionSource
  strategyId: number | null
  // 交易参数
  leverage: number | null
  spreadKind: string | null
  accountCurrency: string | null
  pipSizePoints: number | null
  contractSize: number | null
  minVolume: number | null
  volumeStep: number | null
  swapLongPoints: number | null
  swapShortPoints: number | null
  // 盲测
  blindStatus: number
  rewindingAllowed: number
  ephemeral: number
}

export interface SessionSymbol {
  sessionId: number
  slot: number
  datasetId: number
  symbol: string
  role: SymbolRole
  spreadPoints: number | null
  commissionKind: CommissionKind | null
  commissionValue: number | null
  marginRate: number | null
  contractSize: number | null
  minVolume: number | null
  volumeStep: number | null
  swapLongPoints: number | null
  swapShortPoints: number | null
}

export interface Position {
  sessionId: number
  id: string
  type: OrderType
  openTime: number
  openPrice: number
  lotSize: number
  currentLotSize: number
  stopLoss: number | null
  takeProfit: number | null
  swapAccrued: number
  ticketNumber: number | null
}

export interface PendingOrder {
  sessionId: number
  id: string
  type: OrderType
  price: number
  lotSize: number
  stopLoss: number | null
  takeProfit: number | null
  placedAt: number
  strategyName: string | null
  entryReason: string | null
  symbol: string | null
}

export interface ClosedTrade {
  sessionId: number
  id: string
  positionId: string
  type: OrderType
  action: string
  openTime: number
  closeTime: number
  openPrice: number
  closePrice: number
  lotSize: number
  profit: number
  commission: number
  notes: string | null
  tagsJson: string | null
  screenshot: string | null
  marketContext: string | null
  strategyName: string | null
  entryReason: string | null
  slAtClose: number | null
  tpAtClose: number | null
  rMultiple: number | null
  symbol: string | null
  swapTotal: number
  closeReason: string | null
  slWidened: number
  wasAddOn: number
  mae: number | null
  mfe: number | null
  initialRiskAmount: number | null
  ticketNumber: number | null
}

// ---------- 真实交易 ----------

export interface Account {
  id: number
  label: string
  broker: string | null
  platform: string
  currency: string | null
  createdAt: number
  accountType: string
  serverTimezone: string
  mtLogin: string | null
}

export interface ImportedTrade {
  id: number
  accountId: number
  ticketId: string
  symbol: string
  type: string
  openTime: number
  closeTime: number
  openPrice: number
  closePrice: number
  volume: number
  stopLoss: number | null
  takeProfit: number | null
  commission: number
  swap: number
  taxes: number
  profit: number
  notes: string | null
  tagsJson: string | null
  reflection: string | null
  mae: number | null
  mfe: number | null
  strategyName: string | null
  entryReason: string | null
  screenshot: string | null
}

// ---------- 策略与指标 ----------

export interface Strategy {
  id: number
  name: string
  description: string | null
  jsonAst: string
  dslText: string | null
  status: string
  createdAt: number
  updatedAt: number
  lastRunAt: number | null
  lastRunSessionId: number | null
}

export interface CustomIndicator {
  id: string
  name: string
  sourceCode: string
  updatedAt: number
  error: string | null
}

// ---------- 日志 ----------

export interface JournalNote {
  id: number
  kind: string
  title: string
  body: string
  createdAt: number
  updatedAt: number
  refKind: string | null
  refId: string | null
  tagsJson: string | null
}

export interface NoteTemplate {
  id: number
  name: string
  body: string
  scope: string
  createdAt: number
  updatedAt: number
}

// ---------- 成就 ----------

export interface Achievement {
  code: string
  tier: string
  earnedAt: number
  contextJson: string | null
}

// ---------- IPC 通信 ----------

export interface IpcProgressEvent {
  phase: string
  current: number
  total: number
  message?: string
}

export interface ApiResult<T = unknown> {
  ok: boolean
  data?: T
  error?: string
}
