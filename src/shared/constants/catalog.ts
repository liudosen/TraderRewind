// ============================================================
// TraderRewind — 数据源目录（Dukascopy 免费外汇数据）
// 说明：Dukascopy 提供公开历史 tick 数据（bi5 格式），
//       按小时分文件，天然支持高并发并行下载。
// ============================================================

import type { DataSourceDescriptor, InstrumentInfo } from '../types/download'

/** 主要货币对 */
const MAJORS: InstrumentInfo[] = [
  { symbol: 'EURUSD', name: '欧元/美元', category: 'major', digits: 5 },
  { symbol: 'GBPUSD', name: '英镑/美元', category: 'major', digits: 5 },
  { symbol: 'USDJPY', name: '美元/日元', category: 'major', digits: 3 },
  { symbol: 'USDCHF', name: '美元/瑞郎', category: 'major', digits: 5 },
  { symbol: 'AUDUSD', name: '澳元/美元', category: 'major', digits: 5 },
  { symbol: 'USDCAD', name: '美元/加元', category: 'major', digits: 5 },
  { symbol: 'NZDUSD', name: '纽元/美元', category: 'major', digits: 5 }
]

/** 交叉盘 */
const CROSSES: InstrumentInfo[] = [
  { symbol: 'EURGBP', name: '欧元/英镑', category: 'cross', digits: 5 },
  { symbol: 'EURJPY', name: '欧元/日元', category: 'cross', digits: 3 },
  { symbol: 'GBPJPY', name: '英镑/日元', category: 'cross', digits: 3 },
  { symbol: 'AUDJPY', name: '澳元/日元', category: 'cross', digits: 3 },
  { symbol: 'EURCHF', name: '欧元/瑞郎', category: 'cross', digits: 5 },
  { symbol: 'GBPCHF', name: '英镑/瑞郎', category: 'cross', digits: 5 },
  { symbol: 'EURAUD', name: '欧元/澳元', category: 'cross', digits: 5 },
  { symbol: 'EURCAD', name: '欧元/加元', category: 'cross', digits: 5 },
  { symbol: 'GBPAUD', name: '英镑/澳元', category: 'cross', digits: 5 },
  { symbol: 'AUDCAD', name: '澳元/加元', category: 'cross', digits: 5 },
  { symbol: 'AUDNZD', name: '澳元/纽元', category: 'cross', digits: 5 },
  { symbol: 'CADJPY', name: '加元/日元', category: 'cross', digits: 3 },
  { symbol: 'CHFJPY', name: '瑞郎/日元', category: 'cross', digits: 3 },
  { symbol: 'NZDJPY', name: '纽元/日元', category: 'cross', digits: 3 }
]

/** 贵金属 */
const METALS: InstrumentInfo[] = [
  { symbol: 'XAUUSD', name: '黄金/美元', category: 'metal', digits: 3 },
  { symbol: 'XAGUSD', name: '白银/美元', category: 'metal', digits: 3 }
]

/**
 * 加密市场：现货 USDT 交易对。
 *
 * 只列主流币，不追求全量 —— 这里是个交易训练工具，不是行情终端，
 * 列表太长反而挑不出东西。想加就在这张表里加一行。
 *
 * 两个交易所的代码写法不一样（OKX 用 BTC-USDT，Binance 用 BTCUSDT），
 * 所以只维护「币种 + 名称 + 小数位」，符号在下面按交易所拼出来。
 */
const CRYPTO_BASES: { base: string; name: string; digits: number }[] = [
  { base: 'BTC', name: '比特币', digits: 2 },
  { base: 'ETH', name: '以太坊', digits: 2 },
  { base: 'SOL', name: 'Solana', digits: 3 },
  { base: 'XRP', name: '瑞波币', digits: 5 },
  { base: 'DOGE', name: '狗狗币', digits: 6 },
  { base: 'BNB', name: '币安币', digits: 2 },
  { base: 'ADA', name: '艾达币', digits: 5 },
  { base: 'AVAX', name: '雪崩', digits: 4 },
  { base: 'LINK', name: 'Chainlink', digits: 4 },
  { base: 'LTC', name: '莱特币', digits: 3 },
  { base: 'TON', name: 'Toncoin', digits: 4 },
  { base: 'SUI', name: 'Sui', digits: 5 }
]

/** 按给定格式拼出加密品种列表（OKX: BTC-USDT / Binance: BTCUSDT） */
function buildCrypto(quote: string, sep: string): InstrumentInfo[] {
  return CRYPTO_BASES.map((c) => ({
    symbol: `${c.base}${sep}${quote}`,
    name: `${c.name}/${quote}`,
    category: 'crypto' as const,
    digits: c.digits
  }))
}

/** 外汇那一套 */
const FX_INSTRUMENTS: InstrumentInfo[] = [...MAJORS, ...CROSSES, ...METALS]
/** OKX 现货 */
const OKX_INSTRUMENTS: InstrumentInfo[] = buildCrypto('USDT', '-')
/** Binance 现货 */
const BINANCE_INSTRUMENTS: InstrumentInfo[] = buildCrypto('USDT', '')

export const ALL_INSTRUMENTS: InstrumentInfo[] = [
  ...FX_INSTRUMENTS,
  ...OKX_INSTRUMENTS,
  ...BINANCE_INSTRUMENTS
]

const INSTRUMENT_MAP = new Map(ALL_INSTRUMENTS.map((i) => [i.symbol, i]))

/**
 * 运行时注册进来的品种。
 *
 * cTrader 的品种目录来自经纪商，静态表里不可能列全（指数、股票、各种交叉盘）。
 * 主进程拉到目录后调 registerInstruments 注册进来，getInstrument 才能查到；
 * 否则下载时会被 prepare() 判成「未知品种」直接拒掉。
 * 静态表优先，保证 XAUUSD 这类内置品种的 digits 不被经纪商口径覆盖。
 */
const dynamicInstruments = new Map<string, InstrumentInfo>()

export function registerInstruments(list: InstrumentInfo[]): void {
  for (const item of list) {
    if (!INSTRUMENT_MAP.has(item.symbol)) {
      dynamicInstruments.set(item.symbol, item)
    }
  }
}

export function getInstrument(symbol: string): InstrumentInfo | undefined {
  return INSTRUMENT_MAP.get(symbol) ?? dynamicInstruments.get(symbol)
}

/** 是不是加密品种（代码里带 USDT 计价） */
export function isCryptoSymbol(symbol: string): boolean {
  return symbol.includes('USDT')
}

const CONTRACT_SIZE: Record<string, number> = {
  XAUUSD: 100, // 100 盎司/手
  XAGUSD: 5000 // 5000 盎司/手
}

/** 每标准手的合约规模（单位） */
export function getContractSize(symbol: string): number {
  // 加密现货：1 手 = 1 个币。用外汇那套 10 万默认值算出来的盈亏会离谱到没法看。
  if (isCryptoSymbol(symbol)) return 1
  return CONTRACT_SIZE[symbol] ?? 100000
}

/** 品种报价小数位；未知品种按 5 位处理 */
export function getDigits(symbol: string): number {
  return getInstrument(symbol)?.digits ?? 5
}

/**
 * 合约规格：算真实盈亏需要的全部静态信息。
 *
 * 关键点是「结算货币」（quote）：外汇盈亏天生长在报价货币上——
 * 做 EURUSD 赚的是美元，做 EURGBP 赚的是英镑，做 USDJPY 赚的是日元。
 * 所以拿到价差之后必须先按报价货币算出金额，再换成账户货币（美元），
 * 否则交叉盘和小计价货币（日元）会算得离谱。换算见 utils/pnl.ts。
 */
export interface ContractSpec {
  symbol: string
  /** 每标准手的合约规模：外汇是基础货币单位数，贵金属是盎司数 */
  contractSize: number
  /** 合约规模的单位文案 */
  sizeUnit: '单位' | '盎司' | '币'
  /** 基准货币（外汇是符号前三位，加密是基础币） */
  base: string
  /** 结算/报价货币（外汇是符号后三位，加密是计价币如 USDT） */
  quote: string
  /** 价格最后一位代表的变动量（= 10^-digits），也就是界面里说的「1 点」 */
  pointSize: number
  /** 报价小数位 */
  digits: number
}

/**
 * 把代码拆成「基准 / 计价」。
 * 外汇是 6 位定长（EURUSD → EUR + USD），加密带分隔符或直接拼（BTC-USDT / BTCUSDT），
 * 不能一律 slice(0,3)/slice(3) —— 那样 BTC-USDT 会拆成 "BTC" + "-USDT"，
 * 后面算点值、写提示全都会带着那条横杠。
 */
export function splitSymbol(symbol: string): { base: string; quote: string } {
  const dash = symbol.indexOf('-')
  if (dash > 0) return { base: symbol.slice(0, dash), quote: symbol.slice(dash + 1) }
  if (isCryptoSymbol(symbol)) {
    const i = symbol.indexOf('USDT')
    return { base: symbol.slice(0, i), quote: 'USDT' }
  }
  return { base: symbol.slice(0, 3), quote: symbol.slice(3) }
}

export function getContractSpec(symbol: string): ContractSpec {
  const digits = getDigits(symbol)
  const { base, quote } = splitSymbol(symbol)
  return {
    symbol,
    contractSize: getContractSize(symbol),
    sizeUnit: isCryptoSymbol(symbol)
      ? '币'
      : symbol.startsWith('XAU') || symbol.startsWith('XAG')
        ? '盎司'
        : '单位',
    base,
    quote,
    pointSize: Math.pow(10, -digits),
    digits
  }
}

/** 合约规模的可读文案：10 万单位 / 100 盎司 / 1 BTC */
export function fmtContractSize(spec: ContractSpec): string {
  if (spec.sizeUnit === '盎司') {
    return `${spec.contractSize.toLocaleString('en-US')} 盎司`
  }
  if (spec.sizeUnit === '币') {
    return `${spec.contractSize.toLocaleString('en-US')} ${spec.base}`
  }
  if (spec.contractSize >= 1000) {
    return `${spec.contractSize / 10000 >= 1 ? spec.contractSize / 10000 : spec.contractSize} 万单位`
  }
  return `${spec.contractSize.toLocaleString('en-US')} 单位`
}

export const DATA_SOURCES: DataSourceDescriptor[] = [
  {
    id: 'ctrader',
    name: 'cTrader',
    description: '直接向本机 cTrader 桌面端内置的 MCP 服务要历史 K 线，数据来自你自己的经纪商，走本地回环、不需要代理。',
    note: '需 cTrader 正在运行，且在「设置 → 应用程序 → MCP 设置」里勾选「启用 MCP 服务器」（默认端口 9876）',
    kind: 'candle',
    instruments: FX_INSTRUMENTS
  },
  {
    id: 'okx',
    name: 'OKX',
    description: 'OKX 现货公开 K 线接口，直接返回 1 分钟蜡烛，无需本地聚合。',
    note: '国内直连需要代理；1 分钟历史深度有限，越久越容易抓空',
    kind: 'candle',
    instruments: OKX_INSTRUMENTS
  },
  {
    id: 'binance',
    name: 'Binance',
    description: 'Binance 公共行情接口（data-api.binance.vision），同样直接返回 1 分钟蜡烛。',
    note: '国内直连需要代理；OKX 连不上时可以先用这个',
    kind: 'candle',
    instruments: BINANCE_INSTRUMENTS
  }
]

export function getDataSource(id: string): DataSourceDescriptor | undefined {
  return DATA_SOURCES.find((s) => s.id === id)
}

/** 各周期对应的秒数 */
export const TIMEFRAME_SECONDS: Record<string, number> = {
  M1: 60,
  M5: 300,
  M15: 900,
  M30: 1800,
  H1: 3600,
  H4: 14400,
  D1: 86400
}

/** UI 中展示的周期选项 */
export const TIMEFRAME_OPTIONS: { value: string; label: string }[] = [
  { value: 'M1', label: '1 分钟' },
  { value: 'M5', label: '5 分钟' },
  { value: 'M15', label: '15 分钟' },
  { value: 'M30', label: '30 分钟' },
  { value: 'H1', label: '1 小时' },
  { value: 'H4', label: '4 小时' },
  { value: 'D1', label: '日线' }
]
