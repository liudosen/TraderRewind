// ============================================================
// TraderRewind — 自动截图设置
//
// 用户选定几个周期，订单完全平仓后按这些周期各截一张图，存进这笔交易。
// 最多 5 个；空数组 = 关闭。
// ============================================================

import { isChartTimeframe } from '../utils/timeframe'

/** 设置页里可选的周期（和训练工具栏一致） */
export const AUTO_SHOT_TIMEFRAMES = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'] as const

export const MAX_AUTO_SHOT_TIMEFRAMES = 5

/** 任意输入 → 合法周期数组：去重、只留合法周期、最多 5 个 */
export function normalizeAutoShotTimeframes(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || !isChartTimeframe(item) || out.includes(item)) continue
    out.push(item)
    if (out.length >= MAX_AUTO_SHOT_TIMEFRAMES) break
  }
  return out
}
