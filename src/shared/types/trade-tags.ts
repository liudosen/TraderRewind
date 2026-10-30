// ============================================================
// TraderRewind — 交易标签
//  · 标签库：用户在设置页预先维护的常用标签，下单时一键点亮
//  · 单笔订单最多打 MAX_TRADE_TAGS 个标签，随订单存进回测集
// ============================================================

/** 单笔订单最多打几个标签 */
export const MAX_TRADE_TAGS = 10

/** 单个标签最多几个字符 */
export const MAX_TRADE_TAG_LEN = 12

/** 标签库里最多存几个 */
export const MAX_TAG_LIBRARY = 20

/**
 * 内置默认标签库：打包装好之后开箱就有的那套常用标签。
 *
 * 这套是按「位置 × 力度」组织的看盘语言：
 *  · 位置：左中左 / 左中右 / 右中左 / 右中右（前两个字母是左侧还是右侧，末字是中段还是边缘）
 *  · 力度：震荡 / 弱趋势 / 次强趋势 / 强趋势
 * 用户可以在设置页随便增删，删光了也不会再回来（见 main/settings.ts 的加载逻辑）。
 */
export const DEFAULT_TAG_LIBRARY: string[] = [
  '左中左',
  '左中右',
  '右中左',
  '右中右',
  '震荡',
  '弱趋势',
  '次强趋势',
  '强趋势'
]

/** 把任意输入整成干净的标签：去空白、截断、去重、限量 */
export function normalizeTags(value: unknown, limit = MAX_TRADE_TAGS): string[] {
  let list: unknown[] = []
  if (Array.isArray(value)) list = value
  else if (typeof value === 'string') list = value.split(',')
  else return []

  const out: string[] = []
  for (const v of list) {
    if (typeof v !== 'string') continue
    const t = v.trim().slice(0, MAX_TRADE_TAG_LEN)
    if (!t || out.includes(t)) continue
    out.push(t)
    if (out.length >= limit) break
  }
  return out
}

/** 标签库：比单笔上限宽松一些，最多 MAX_TAG_LIBRARY 个 */
export function normalizeTagLibrary(value: unknown): string[] {
  return normalizeTags(value, MAX_TAG_LIBRARY)
}
