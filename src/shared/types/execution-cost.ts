// ============================================================
// TraderRewind — 交易成本模型（手续费 + 滑点）
//
// 把真实交易要付的成本做成可配置的模型，而不是让回测结果永远是「零摩擦」
// 的漂亮数字。市面上有两类计费口径，我们两种都保留：
//   · perLot  —— 每手固定金额（零售外汇最常见：$3.5/手/边，往返 $7）
//   · percent —— 按名义价值百分比（加密永续那一类）
//
// 结算口径（和 MT4/MT5 的报表一致）：
//   开仓：按「不利方向滑点后的价格」成交
//   平仓：市价单 / 止损单同样吃滑点；止盈是限价成交，不滑点
//   最终盈亏 = 价差盈亏 − 开仓佣金 − 平仓佣金（平仓时一次性结算进这笔订单）
// ============================================================

import { notionalUsd } from '../utils/pnl'

/** 手续费计费方式 */
export type CommissionMode = 'perLot' | 'percent'

export interface ExecutionCost {
  /** 手续费计费方式：perLot = 每手固定金额；percent = 按名义价值百分比 */
  commissionMode: CommissionMode
  /** perLot: 美元/手/单边；percent: 名义价值的百分比（%）/单边 */
  commissionRate: number
  /**
   * 滑点：多少「点」（品种最小变动单位）。
   * 用点而不是价格，是为了让这套配置跨品种通用：
   * 黄金 3 位小数 1 点 = 0.001，欧元 5 位小数 1 点 = 0.00001。
   */
  slippagePoints: number
}

/** 默认：不计成本（历史回测结果不受影响；要用时一键套预设） */
export const DEFAULT_EXECUTION_COST: ExecutionCost = {
  commissionMode: 'perLot',
  commissionRate: 0,
  slippagePoints: 0
}

/** 常见券商/账户的费率档位，一键套用 */
export interface ExecutionCostPreset {
  key: string
  label: string
  desc: string
  cost: ExecutionCost
}

export const EXECUTION_COST_PRESETS: ExecutionCostPreset[] = [
  {
    key: 'off',
    label: '不计成本',
    desc: '价差即盈亏，方便和裸策略对比',
    cost: { commissionMode: 'perLot', commissionRate: 0, slippagePoints: 0 }
  },
  {
    key: 'retail',
    label: '零售账户',
    desc: '$3.5/手/边 · 20 点滑点',
    cost: { commissionMode: 'perLot', commissionRate: 3.5, slippagePoints: 20 }
  },
  {
    key: 'pro',
    label: '机构账户',
    desc: '$2/手/边 · 10 点滑点',
    cost: { commissionMode: 'perLot', commissionRate: 2, slippagePoints: 10 }
  },
  {
    key: 'harsh',
    label: '恶劣行情',
    desc: '$3.5/手/边 · 100 点滑点',
    cost: { commissionMode: 'perLot', commissionRate: 3.5, slippagePoints: 100 }
  }
]

function clampNum(v: unknown, min: number, max: number, fallback = 0): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** 脏数据一律回默认值，别把 NaN / 负数写进成交价和余额 */
export function normalizeExecutionCost(v: unknown): ExecutionCost {
  const raw = (v ?? {}) as Partial<ExecutionCost>
  const mode: CommissionMode = raw.commissionMode === 'percent' ? 'percent' : 'perLot'
  return {
    commissionMode: mode,
    // 百分比模式上限 5%（再高就不像手续费了），每手模式上限 $1000/手
    commissionRate: mode === 'percent' ? clampNum(raw.commissionRate, 0, 5) : clampNum(raw.commissionRate, 0, 1000),
    slippagePoints: Math.round(clampNum(raw.slippagePoints, 0, 100000))
  }
}

/** 该品种 1 个「点」的价格 */
export function pointOfDigits(digits: number): number {
  return Math.pow(10, -Math.max(0, Math.min(8, digits)))
}

/** 滑点换算成价格偏移（永远是正的，方向由买/卖决定） */
export function slippagePrice(cost: ExecutionCost, digits: number): number {
  const price = cost.slippagePoints * pointOfDigits(digits)
  // 按该品种的精度取整，避免浮点数尾巴让成交价出现 4201.2500000001
  const p = pointOfDigits(digits)
  return Math.round(price / p) * p
}

/**
 * 单边佣金。
 * @param lot 手数
 * @param contractSize 每手合约量（黄金 100 盎司）
 * @param price 成交价（percent 模式用来算名义价值）
 * @param quoteToUsdRate 报价货币→美元汇率（percent 模式把名义价值折成美元用；
 *        不传按 1 处理，即只有美元报价的品种才是准确的）
 */
export function commissionPerSide(
  cost: ExecutionCost,
  lot: number,
  contractSize: number,
  price: number,
  quoteToUsdRate = 1
): number {
  if (!(cost.commissionRate > 0) || !(lot > 0)) return 0
  if (cost.commissionMode === 'percent') {
    // 名义价值要折成账户货币再乘费率，否则 USDJPY 这类品种会算成日元的百分比
    const notional = notionalUsd(lot, contractSize, price, quoteToUsdRate)
    return (notional * cost.commissionRate) / 100
  }
  return lot * cost.commissionRate
}

/** 有没有启用成本（两个都为 0 = 没启用） */
export function hasExecutionCost(cost: ExecutionCost): boolean {
  return cost.commissionRate > 0 || cost.slippagePoints > 0
}

/** 一行字概括当前成本模型，给下单条上的卡片用 */
export function fmtExecutionCost(
  cost: ExecutionCost,
  locale: 'zh' | 'en' = 'zh'
): string {
  const en = locale === 'en'
  const parts: string[] = []
  if (cost.commissionRate > 0) {
    if (cost.commissionMode === 'percent') {
      parts.push(en ? `Comm. ${cost.commissionRate}%` : `佣金 ${cost.commissionRate}%`)
    } else {
      parts.push(
        en
          ? `Comm. $${trimNum(cost.commissionRate)}/lot`
          : `佣金 $${trimNum(cost.commissionRate)}/手`
      )
    }
  }
  if (cost.slippagePoints > 0) {
    parts.push(en ? `Slippage ${cost.slippagePoints} pts` : `滑点 ${cost.slippagePoints} 点`)
  }
  return parts.length ? parts.join(' · ') : en ? 'Off' : '未启用'
}

function trimNum(n: number): string {
  return String(Math.round(n * 1000) / 1000)
}
