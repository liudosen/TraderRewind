// ============================================================
// TraderRewind — 持仓价格线的共用样式与文案
//
// 主图和每个副周期窗都要画同一套「开仓 / 止损 / 止盈」线。
// 颜色、移动止盈判断、轴标签文案放在这里，三个窗口才不会各画各的。
// ============================================================

import type { Position } from '../../stores/training-store'

/** 多/空开仓线：对冲时两条线并排，用颜色区分方向和持仓卡里的标签对应 */
export const ENTRY_BUY_COLOR = '#f87171'
export const ENTRY_SELL_COLOR = '#4ade80'
export const SL_COLOR = '#ef4444'
export const TP_COLOR = '#22c55e'
/** 止损被拖到盈利侧（移动止盈）：换琥珀色，和「亏损止损」一眼分辨 */
export const TRAIL_COLOR = '#f59e0b'

/**
 * 止损是不是已经被拖到了成本价的盈利侧。
 *
 * 到了盈利侧它就不再是「认亏出局」而是「锁住已有的浮盈」，
 * 所以标签要额外说明、线的颜色也要换掉，否则红线上挂着正数金额看着像算错了。
 */
export function isTrailingStop(p: Position): boolean {
  return p.sl != null && (p.side === 'buy' ? p.sl > p.entryPrice : p.sl < p.entryPrice)
}

/**
 * 止损 / 止盈线轴标签的文案：`SL` / `TP` 前缀 + 金额。
 *
 * 金额由调用方注入（主图和副窗都复用 TrainingPane 的 riskPnlLabel），
 * 这样轴上写的「打到这里亏多少」和持仓卡、图表票面三处永远一致。
 */
export function riskTitle(
  p: Position,
  kind: 'sl' | 'tp',
  label?: (position: Position, kind: 'sl' | 'tp') => string,
  trailingLabel?: string
): string {
  const base = kind === 'sl' ? 'SL' : 'TP'
  const money = label ? label(p, kind) : ''
  const trailing = kind === 'sl' && isTrailingStop(p)
  const title = money ? `${base} ${money}` : base
  return trailing && trailingLabel ? `${title} · ${trailingLabel}` : title
}
