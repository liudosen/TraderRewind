// ============================================================
// TraderRewind — 数据源与下载相关类型
// ============================================================

/** 支持的数据源 ID */
export type DataSourceId = 'dukascopy' | 'okx' | 'binance'

/**
 * 品种分类。
 *
 * 早期只有外汇三类（主要货币对 / 交叉盘 / 贵金属），界面上直接平铺。
 * 加了加密市场之后品种数量翻倍，平铺就看不过来了，所以分类同时是
 * 界面上的「折叠分组」标识 —— 一个分类对应列表里一个可折叠的段落。
 */
export type InstrumentCategory = 'major' | 'cross' | 'metal' | 'crypto'

/** 下载用的时间周期 */
export type BarTimeframe = 'M1' | 'M5' | 'M15' | 'M30' | 'H1' | 'H4' | 'D1'

/** 品种元数据 */
export interface InstrumentInfo {
  /** 交易代码，如 EURUSD / BTC-USDT */
  symbol: string
  /** 中文名，如 欧元/美元 / 比特币 */
  name: string
  /** 分类，同时也是界面上的折叠分组 */
  category: InstrumentCategory
  /** 价格小数位数（决定 Dukascopy 定点缩放的除数 10^digits） */
  digits: number
}

/** 下载任务阶段 */
export type DownloadPhase =
  | 'queued'
  | 'downloading'
  | 'aggregating'
  | 'saving'
  | 'done'
  | 'cancelled'
  | 'error'

/** 单个品种（一个任务）的进度快照 */
export interface DownloadTaskProgress {
  taskId: string
  symbol: string
  name: string
  digits: number
  timeframe: BarTimeframe
  phase: DownloadPhase
  /** 已完成的下载单元（小时文件）数 */
  done: number
  /** 总下载单元数 */
  total: number
  /** 0-100，含在途字节折算 */
  percent: number
  /** 已下载压缩字节数 */
  bytesDone: number
  /** 瞬时速度（字节/秒） */
  bytesPerSec: number
  /** 平均速度（字节/秒） */
  avgBytesPerSec: number
  /** 已聚合出的 K 线根数 */
  bars: number
  /** 已用时（毫秒） */
  elapsedMs: number
  /** 预计剩余时间（毫秒），无法估算时为 null */
  etaMs: number | null
  /** 当前并行中请求数 */
  activeWorkers: number
  message: string
  error?: string
  /** 落库后的数据集 ID */
  datasetId?: number
}

/** 一次下载会话的汇总快照（通过 IPC 事件推送） */
export interface DownloadSnapshot {
  jobId: string
  tasks: DownloadTaskProgress[]
  /** 所有任务合计瞬时速度 */
  totalBytesPerSec: number
  /** 并行中的任务数（品种数） */
  activeTasks: number
  /** 当前在途的 HTTP 请求数 */
  activeRequests: number
  /** 进度单位说明 */
  unitCount: number
}

/** 下载请求 */
export interface DownloadRequest {
  source: DataSourceId
  symbols: string[]
  timeframe: BarTimeframe
  /** 起始日期，YYYY-MM-DD（本地日历日） */
  dateFrom: string
  /** 结束日期，YYYY-MM-DD（含当天） */
  dateTo: string
  /** 每个品种的并行请求数 */
  concurrency: number
  /** HTTP 代理，如 127.0.0.1:7890；留空则直连 */
  proxy?: string
}

/** 启动下载的返回 */
export interface DownloadStartResult {
  ok: boolean
  jobId?: string
  unitCount?: number
  error?: string
}

/** 目录项（供 UI 选择） */
export interface DataSourceDescriptor {
  id: DataSourceId
  name: string
  description: string
  /** 是否需要代理（用于 UI 提示） */
  note?: string
  /**
   * 数据形态：
   *  · tick   —— 逐笔数据，本地聚合成 K 线（Dukascopy）
   *  · candle —— 直接给 K 线（OKX / Binance）
   * 界面上的「预计文件数 / 根数」估法不一样，所以要让 UI 知道。
   */
  kind: 'tick' | 'candle'
  instruments: InstrumentInfo[]
}
