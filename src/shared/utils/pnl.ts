// ============================================================
// TraderRewind — 真实盈亏换算
//
// 外汇/贵金属的盈亏天然长在**结算货币**（报价货币）上：
//   · EURUSD 赚美元      · EURGBP 赚英镑      · USDJPY 赚日元
// 而账户（以及界面上所有的钱）是美元，所以必须先把价差换成报价货币金额，
// 再换成美元，才算「真实的每手价值」。
//
// 换算分三种情况，三种用的汇率来源不同：
//   1) 美元报价（EURUSD/GBPUSD/AUDUSD/NZDUSD/XAUUSD/XAGUSD）→ 报价货币就是美元，汇率 1；
//   2) 美元基准（USDJPY/USDCHF/USDCAD）→ 价格的倒数就是「1 单位报价货币值多少美元」，
//      用的是这笔交易自己的价格，永远是最新的、也是准确的；
//   3) 交叉盘（EURGBP/EURJPY/…）→ 报价货币既不是美元也不是基准货币，
//      需要「报价货币 → 美元」的汇率。本机有对应美元直盘数据时可以给准确值（seriesRate），
//      没有时退回内置参考汇率，界面会标注来源。
//
// 以前只有一句 `symbol.endsWith('JPY') ? pnl / exitPrice : pnl`：
// USDJPY 碰巧对，EURJPY 除错了（应该除 USDJPY 而不是自己），
// 而 EURGBP 这类交叉盘干脆没换，把英镑当美元用（直接高估 ~1.27 倍）。
// ============================================================

import { getContractSpec, type ContractSpec } from '../constants/catalog'

/** 账户货币（本应用统一按美元结算） */
export const ACCOUNT_CURRENCY = 'USD'

/**
 * 内置参考汇率：1 单位该货币值多少美元。
 * 只在「交叉盘且本机没有对应美元直盘数据」时兜底，界面上会标明「参考汇率」。
 */
const QUOTE_TO_USD_REF: Record<string, number> = {
  USD: 1,
  EUR: 1.08,
  GBP: 1.27,
  JPY: 0.0067, // ≈ 1 / 149
  CHF: 1.13, // ≈ 1 / 0.885
  CAD: 0.72, // ≈ 1 / 1.39
  AUD: 0.66, // ≈ 1 / 1.52
  NZD: 0.6 // ≈ 1 / 1.67
}

/** 汇率是怎么来的，界面用来说明精度 */
export type RateSource = 'usd' | 'inverse' | 'series' | 'reference'

export interface QuoteRate {
  /** 1 单位报价货币 = 多少美元 */
  rate: number
  source: RateSource
}

export interface PnlOptions {
  /**
   * 报价货币→美元的汇率（本机下载了对应美元直盘时传进来）。
   * 只有交叉盘会用到；美元报价/美元基准的品种会忽略它。
   */
  quoteToUsd?: number | null
}

/** 计算盈亏所需的最小持仓信息 */
export interface PnlPosition {
  symbol: string
  side: 'buy' | 'sell'
  lot: number
  contractSize: number
  entryPrice: number
}

/**
 * 报价货币 → 美元的汇率。
 * @param price 该品种当下的价格（美元基准的品种要靠它取倒数）
 */
export function quoteUsdRate(symbol: string, price: number, opts?: PnlOptions): QuoteRate {
  const spec = getContractSpec(symbol)

  // 1) 美元报价：价差本来就是美元
  if (spec.quote === 'USD') return { rate: 1, source: 'usd' }

  // 2) 美元基准：价格 = 1 美元能换多少报价货币 → 倒数就是报价货币的美元价
  if (spec.base === 'USD') {
    if (Number.isFinite(price) && price > 0) return { rate: 1 / price, source: 'inverse' }
    return { rate: 1, source: 'usd' }
  }

  // 3) 交叉盘：优先用外部给的实时汇率，没有就退回参考表
  if (opts?.quoteToUsd != null && Number.isFinite(opts.quoteToUsd) && opts.quoteToUsd > 0) {
    return { rate: opts.quoteToUsd, source: 'series' }
  }
  return { rate: QUOTE_TO_USD_REF[spec.quote] ?? 1, source: 'reference' }
}

/**
 * 一笔持仓按平仓价算出来的**美元**盈亏（不含手续费）。
 * 内部先算报价货币金额，再换成美元。
 */
export function calcPnl(pos: PnlPosition, exitPrice: number, opts?: PnlOptions): number {
  const dir = pos.side === 'buy' ? 1 : -1
  const units = pos.lot * pos.contractSize
  const quotePnl = (exitPrice - pos.entryPrice) * dir * units
  if (!Number.isFinite(quotePnl) || quotePnl === 0) return 0
  return quotePnl * quoteUsdRate(pos.symbol, exitPrice, opts).rate
}

/** 价差盈亏（报价货币口径），报表里想拆分展示时用 */
export function calcQuotePnl(pos: PnlPosition, exitPrice: number): number {
  const dir = pos.side === 'buy' ? 1 : -1
  return (exitPrice - pos.entryPrice) * dir * pos.lot * pos.contractSize
}

/**
 * 每标准手、每「1 点」（价格最后一位）值多少钱。
 * 返回报价货币口径和美元口径两个数——外汇牌价上说的「点值」就是这两个。
 */
export function pointValuePerLot(
  symbol: string,
  price: number,
  opts?: PnlOptions
): { spec: ContractSpec; quote: number; usd: number; rate: QuoteRate } {
  const spec = getContractSpec(symbol)
  const quote = spec.pointSize * spec.contractSize
  const rate = quoteUsdRate(symbol, price, opts)
  return { spec, quote, usd: quote * rate.rate, rate }
}

/**
 * 名义价值（折美元）。
 *
 * 百分比佣金、保证金都按它算。以前用 `lot × contractSize × price`，
 * 对美元基准（USDJPY）会放大一个汇率倍数（10 万美元算成 1500 万），
 * 交叉盘也偏。乘上报价货币汇率之后三种品种都统一了：
 *   美元报价：price × 1              → 10 万 × 1.08 = 10.8 万美元
 *   美元基准：price × (1/price)      → 恒等于 10 万美元
 *   交叉盘　：price × (报价→美元)    → 10 万 × 0.85 × 1.27 ≈ 10.8 万美元
 */
export function notionalUsd(
  lot: number,
  contractSize: number,
  price: number,
  quoteToUsdRate: number
): number {
  return lot * contractSize * Math.max(0, price) * quoteToUsdRate
}

/** 汇率来源的中文说明（展示用） */
export function rateSourceLabel(source: RateSource): string {
  switch (source) {
    case 'usd':
      return '美元报价，无需换算'
    case 'inverse':
      return '按该品种自身价格取倒数换算'
    case 'series':
      return '按本机美元直盘数据换算'
    default:
      return '按内置参考汇率换算（未下载对应美元直盘）'
  }
}

/**
 * 品种清单里用的「一手值多少」说明。
 *
 * 合约规模是固定的；而「1 点值多少钱」在美元基准盘（USDJPY）上要跟着汇率变，
 * 没有实时价就只能给报价货币口径（100 日元/点）。交叉盘用参考汇率折个大概，
 * 并标明是参考值，别当成精确报价。
 */
export function describeContract(
  symbol: string,
  locale: 'zh' | 'en' = 'zh'
): {
  /** 10 万单位 / 100 盎司 */
  sizeText: string
  /** 1 点值多少报价货币：1.00 美元 / 100 日元 / 10 英镑 */
  pointQuoteText: string
  /** 折成美元的估算（美元报价的品种是精确值）；算不出来时为 null */
  pointUsdText: string | null
  /** 估算依据说明 */
  note: string
} {
  const en = locale === 'en'
  const spec = getContractSpec(symbol)
  const perPoint = spec.pointSize * spec.contractSize
  const quoteName = spec.quote
  const sizeText =
    spec.sizeUnit === '盎司'
      ? en
        ? `${spec.contractSize.toLocaleString('en-US')} oz`
        : `${spec.contractSize.toLocaleString('en-US')} 盎司`
      : spec.contractSize >= 10000
        ? en
          ? `${spec.contractSize / 10000}0k ${spec.base}`
          : `${spec.contractSize / 10000} 万 ${spec.base}`
        : `${spec.contractSize.toLocaleString('en-US')} ${spec.base}`

  const pointQuoteText = `${trimNum(perPoint)} ${quoteName}`

  if (spec.quote === 'USD') {
    return {
      sizeText,
      pointQuoteText,
      pointUsdText: `$${trimNum(perPoint)}`,
      note: en
        ? 'Standard lot size is fixed, so 1 pip is a flat dollar amount'
        : '标准手规模固定，1 点价值即美元金额'
    }
  }
  if (spec.base === 'USD') {
    return {
      sizeText,
      pointQuoteText,
      pointUsdText: null,
      note: en
        ? `Converting to USD uses the current ${spec.base}/${spec.quote} rate, so pip value floats`
        : `折美元要按当时 ${spec.base}/${spec.quote} 的汇率算，点值随汇率浮动`
    }
  }
  const ref = QUOTE_TO_USD_REF[spec.quote] ?? 1
  return {
    sizeText,
    pointQuoteText,
    pointUsdText: `≈ $${trimNum(perPoint * ref)}`,
    note: en
      ? `Cross: 1 pip = ${trimNum(perPoint)} ${quoteName}, converted at the reference rate 1 ${quoteName} ≈ $${trimNum(ref)}`
      : `交叉盘：1 点 = ${trimNum(perPoint)} ${quoteName}，按参考汇率 1 ${quoteName} ≈ $${trimNum(ref)} 折算`
  }
}

function trimNum(n: number): string {
  const digits = n >= 100 ? 0 : n >= 1 ? 2 : n >= 0.01 ? 4 : 6
  return String(Number(n.toFixed(digits)))
}
