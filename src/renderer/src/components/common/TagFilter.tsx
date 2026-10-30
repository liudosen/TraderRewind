import React, { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { Tag } from 'lucide-react'
import { useT } from '../../i18n'

/**
 * 标签筛选条：日志页的报告明细、训练页的平仓记录共用。
 *
 * 一次点击就是一个开关：没点亮就点上，点亮的再点一下取消。
 * 点多少下就同时亮多少个，不需要按 Ctrl —— 多选是默认能力，不该藏在一个修饰键后面。
 *
 * 多个标签之间是「且」——一笔交易要同时带上所有选中的标签才留下。
 * 标签是按维度分开的（位置「右中右」、趋势强度「次强趋势」、形态「震荡」），
 * 点亮第二个标签的意图是「在当前这批里再筛一层」，也就是求交集。
 * 若走并集，已经筛到 3 笔时再点一个标签反而冒出新的单子、总数变多，
 * 与「缩小范围」的直觉正好相反。
 *
 * 同一维度内的标签（「强趋势」和「震荡」）本就互斥，交集为空是正确结果：
 * 那说明这批单子里没有同时符合两条的。空列表的提示会把标签名念出来，不至于看着像坏了。
 */

export interface TagCounts {
  /** 按出现次数降序、次数相同按字典序 */
  tags: string[]
  counts: Record<string, number>
}

/** 统计一批交易里出现过哪些标签、各多少笔 */
export function countTags(trades: { tags?: string[] }[] | null | undefined): TagCounts {
  const counts: Record<string, number> = {}
  for (const t of trades ?? []) {
    for (const g of t.tags ?? []) {
      if (!g) continue
      counts[g] = (counts[g] ?? 0) + 1
    }
  }
  const tags = Object.keys(counts).sort(
    (a, b) => counts[b] - counts[a] || a.localeCompare(b, 'zh-Hans-CN')
  )
  return { tags, counts }
}

/**
 * 多选过滤：一笔交易要同时带上所有选中标签才保留；空数组原样返回。
 *
 * 用 every 求交集，不是 some 求并集 —— 理由见文件头。
 */
export function filterByTags<T extends { tags?: string[] }>(trades: T[], tags: string[]): T[] {
  if (tags.length === 0) return trades
  return trades.filter((t) => {
    const have = t.tags ?? []
    return tags.every((g) => have.includes(g))
  })
}

/**
 * 「A」「B」这样列举；两个之间用「且」连起来，别让并排放着读成「或」。
 * 超过两个就省成「A」等 3 个，免得标题栏被撑爆。
 * 英文用 "A", "B" / "A" +2 的说法，引号也跟着换。
 */
export function formatTagList(tags: string[], locale: 'zh' | 'en' = 'zh'): string {
  const quote = (s: string): string => (locale === 'en' ? `"${s}"` : `「${s}」`)
  if (tags.length === 0) return locale === 'en' ? 'All' : '全部'
  if (tags.length === 1) return quote(tags[0])
  if (tags.length === 2) {
    return locale === 'en'
      ? `${quote(tags[0])} and ${quote(tags[1])}`
      : `${quote(tags[0])}且${quote(tags[1])}`
  }
  return locale === 'en'
    ? `${quote(tags[0])} +${tags.length - 1}`
    : `${quote(tags[0])}等 ${tags.length} 个`
}

/**
 * 点一下标签之后应该变成哪些选中标签 —— 就是个开关。
 *
 * 已选中就摘掉，没选中就加进来。不需要任何修饰键，点几下就亮几个，
 * 这样「多选」是天然可发现的；藏在 Ctrl 后面很多人根本不会去试。
 */
export function toggleTag(current: string[], tag: string): string[] {
  return current.includes(tag) ? current.filter((t) => t !== tag) : [...current, tag]
}

/**
 * 把「选中标签 + 过滤后列表」这套状态收进一个 hook，
 * 日志页报告和平仓记录都用它，避免两边各写一遍。
 */
export function useTagFilter<T extends { tags?: string[] }>(trades: T[]): {
  /** 已选中的标签（空数组 = 全部） */
  selected: string[]
  /**
   * 点某个标签：没点亮就点亮，已点亮就熄灭。传 null 表示点「全部」（全灭）。
   * 不需要修饰键 —— 点几下就亮几个。
   */
  toggle: (tag: string | null) => void
  /** 直接整体替换选中集合（TagFilter 的 onChange 用它） */
  select: (next: string[]) => void
  clear: () => void
  tags: string[]
  counts: Record<string, number>
  filtered: T[]
  total: number
  filtering: boolean
  /** 「已按 … 筛选」里那串标签名 */
  label: string
} {
  const [selected, setSelected] = useState<string[]>([])
  const { locale } = useT()
  const { tags, counts } = useMemo(() => countTags(trades), [trades])

  // 切会话 / 重置后旧标签可能已不存在，把消失的剪掉，全没了就自然回到「全部」
  useEffect(() => {
    setSelected((prev) => {
      const next = prev.filter((t) => counts[t] != null)
      // 没变化就返回原引用，别触发多余重渲染
      return next.length === prev.length ? prev : next
    })
  }, [counts])

  const filtered = useMemo(() => filterByTags(trades, selected), [trades, selected])

  return {
    selected,
    // 点一下就是点亮 / 熄灭，没有修饰键
    toggle: (tag) => {
      setSelected((prev) => (tag == null ? [] : toggleTag(prev, tag)))
    },
    select: (next) => setSelected(next),
    clear: () => setSelected([]),
    tags,
    counts,
    filtered,
    total: trades.length,
    filtering: selected.length > 0,
    label: formatTagList(selected, locale)
  }
}

interface Props {
  tags: string[]
  counts: Record<string, number>
  /** 当前选中的标签（空数组 = 全部） */
  value: string[]
  onChange: (next: string[]) => void
  /** 全部交易笔数（用于「全部」上的计数） */
  total: number
  /** 紧凑版：给平仓记录那种窄条用 */
  dense?: boolean
}

export function TagFilter({
  tags,
  counts,
  value,
  onChange,
  total,
  dense
}: Props): React.JSX.Element | null {
  const { t } = useT()
  if (tags.length === 0) return null

  const multi = value.length > 1

  const chip = (active: boolean): string =>
    clsx(
      'inline-flex items-center gap-1 rounded border transition-colors',
      dense ? 'px-1.5 py-[1px] text-[10px]' : 'px-2 py-[2px] text-[11px]',
      active
        ? 'border-[var(--c-accent)] bg-[var(--c-accent-tint)] text-[var(--c-accent)]'
        : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:border-[var(--c-accent)] hover:text-[var(--c-accent)]'
    )

  // 点标签 = 点亮 / 熄灭；点「全部」= 全灭
  const click = (tag: string | null) => () => {
    onChange(tag == null ? [] : toggleTag(value, tag))
  }

  return (
    <div
      // 给自动化 / 调试一个稳定锚点：页面里可能同时有筛选条和表格里的标签按钮，
      // 靠 class 或文本定位容易串味
      data-tag-filter="1"
      className={clsx('flex flex-wrap items-center', dense ? 'gap-1' : 'gap-1.5')}
    >
      <Tag size={dense ? 10 : 11} className="shrink-0 text-[var(--text-faint)]" />
      <button
        type="button"
        onClick={click(null)}
        className={chip(value.length === 0)}
        title={t('tagFilter.allHint')}
      >
        {t('tagFilter.all')}
        <span className="font-mono opacity-60">{total}</span>
      </button>
      {tags.map((g) => {
        const active = value.includes(g)
        return (
          <button
            key={g}
            type="button"
            onClick={click(g)}
            className={chip(active)}
            title={
              active
                ? t('tagFilter.offHint', { tag: g })
                : t('tagFilter.onHint', { tag: g })
            }
          >
            {g}
            <span className="font-mono opacity-60">{counts[g] ?? 0}</span>
          </button>
        )
      })}
      {/* 多选时给一句说明，否则用户不清楚「或」还是「且」 */}
      {multi && (
        <span
          className={clsx(
            'shrink-0 text-[var(--text-faint)]',
            dense ? 'text-[10px]' : 'text-[10.5px]'
          )}
          title={t('tagFilter.andHint')}
        >
          {t('tagFilter.multi', { n: value.length })}
        </span>
      )}
    </div>
  )
}
