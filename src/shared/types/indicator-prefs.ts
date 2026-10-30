// ============================================================
// TraderRewind — 指标显示偏好（用户级，跨训练集统一）
//
// 规则：
//  · 默认一个指标都不开（overlays / subPanes 都是空数组）
//  · 用户一旦亲手调过指标，customized = true，之后所有回测集都用这一套
//  · customized = false 时允许沿用老会话里保存的指标（兼容历史数据）
//  · 列表里存的是「实例」而不是 id —— 同一个指标可以添加多次（两条 RSI、两组均线…）
// ============================================================

import {
  OVERLAYS,
  SUB_PANES,
  createInstanceUid,
  indicatorColorSlots,
  isHexColor,
  resolveParams,
  type IndicatorId,
  type IndicatorInstance,
  type OverlayId,
  type SubPaneId
} from '../utils/indicators'

/** 合法的主图叠加 id（与 OVERLAYS 保持一致） */
export const OVERLAY_IDS: OverlayId[] = OVERLAYS.map((o) => o.id)

/** 合法的副图 id（与 SUB_PANES 一致） */
export const SUB_PANE_IDS: SubPaneId[] = SUB_PANES.map((s) => s.id)

export interface IndicatorPrefs {
  /** 主图叠加的指标实例 */
  overlays: IndicatorInstance[]
  /** 副图指标实例；空数组 = 不显示副图 */
  subPanes: IndicatorInstance[]
  /** 用户是否亲手改过：true 时这一套配置在所有回测集里通用 */
  customized: boolean
}

/** 出厂默认：什么指标都不显示 */
export const DEFAULT_INDICATOR_PREFS: IndicatorPrefs = {
  overlays: [],
  subPanes: [],
  customized: false
}

/**
 * 老版本的指标配置：overlays 是 'ma5' / 'boll' 这种 id 字符串，副图是单个 'macd'。
 * 这里把它们折算成新结构：所有 maXX / emaXX 合成一条「EMA 均线」，最多带三个周期。
 */
function fromLegacyOverlays(list: unknown): IndicatorInstance[] {
  if (!Array.isArray(list)) return []
  const periods: number[] = []
  let hasBoll = false
  for (const x of list) {
    if (typeof x !== 'string') continue
    if (x === 'boll') {
      hasBoll = true
      continue
    }
    const m = /^(?:ma|ema)(\d+)$/.exec(x)
    if (m) periods.push(Number(m[1]))
  }

  const out: IndicatorInstance[] = []
  if (periods.length > 0) {
    const params = resolveParams('ema')
    params.p1 = periods[0] ?? 12
    params.p2 = periods[1] ?? 0
    params.p3 = periods[2] ?? 0
    out.push({ uid: createInstanceUid(), id: 'ema', params })
  }
  if (hasBoll) {
    out.push({ uid: createInstanceUid(), id: 'boll', params: resolveParams('boll') })
  }
  return out
}

/** 只保留该指标认识的槽位，且必须是合法 hex —— 存盘里的脏颜色直接丢掉回落默认 */
function normalizeColors(id: IndicatorId, raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const allowed = new Set(indicatorColorSlots(id).map((s) => s.slot))
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (allowed.has(k) && isHexColor(v)) out[k] = v
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function normalizeList(raw: unknown, allowed: string[]): IndicatorInstance[] {
  if (!Array.isArray(raw)) return []
  const out: IndicatorInstance[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const id = (item as { id?: unknown }).id
    if (typeof id !== 'string' || !allowed.includes(id)) continue
    const rawUid = (item as { uid?: unknown }).uid
    let uid = typeof rawUid === 'string' && rawUid ? rawUid : createInstanceUid()
    while (seen.has(uid)) uid = createInstanceUid()
    seen.add(uid)
    const rawParams = (item as { params?: Record<string, number> }).params
    const colors = normalizeColors(id as IndicatorId, (item as { colors?: unknown }).colors)
    out.push({
      uid,
      id: id as IndicatorId,
      params: resolveParams(id as IndicatorId, { [id]: rawParams } as never),
      ...(colors ? { colors } : {})
    })
  }
  return out
}

/** 任意输入 → 合法配置，非法字段回退默认 */
export function normalizeIndicatorPrefs(value: unknown): IndicatorPrefs {
  const raw = (value ?? {}) as Record<string, unknown>

  const overlays =
    Array.isArray(raw.overlays) && raw.overlays.some((x) => typeof x === 'string')
      ? fromLegacyOverlays(raw.overlays)
      : normalizeList(raw.overlays, OVERLAY_IDS)

  // 副图：新格式是数组；老格式是单个 'macd' 字符串
  const subPanes = Array.isArray(raw.subPanes)
    ? normalizeList(raw.subPanes, SUB_PANE_IDS)
    : typeof raw.subPane === 'string' && (SUB_PANE_IDS as string[]).includes(raw.subPane)
      ? [
          {
            uid: createInstanceUid(),
            id: raw.subPane as IndicatorId,
            params: resolveParams(raw.subPane as IndicatorId)
          }
        ]
      : []

  return {
    overlays,
    subPanes,
    customized: raw.customized === true
  }
}
