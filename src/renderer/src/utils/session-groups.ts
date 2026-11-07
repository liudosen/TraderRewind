/**
 * 训练会话分组元数据。
 *
 * 训练页和日志页共用同一份 localStorage：在训练页新建/移动/折叠的分组，
 * 日志页打开时能看到同样结构；日志页折叠也会写回，训练页重新进入时保持一致。
 * 只存分组结构和会话 id，不碰数据库。
 */
export interface SessionGroup {
  id: string
  name: string
  collapsed: boolean
  sessionIds: string[]
}

export const UNGROUPED_GROUP_ID = '__ungrouped__'
export const SESSION_GROUPS_KEY = 'tr:sessionGroups'

export function loadSessionGroups(): SessionGroup[] {
  try {
    const raw = localStorage.getItem(SESSION_GROUPS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((g: any) => g && typeof g.id === 'string' && typeof g.name === 'string')
      .map((g: any) => ({
        id: g.id,
        name: g.name,
        collapsed: !!g.collapsed,
        sessionIds: Array.isArray(g.sessionIds)
          ? g.sessionIds.filter((x: any) => typeof x === 'string')
          : []
      }))
  } catch {
    return []
  }
}

export function saveSessionGroups(groups: SessionGroup[]): void {
  localStorage.setItem(SESSION_GROUPS_KEY, JSON.stringify(groups))
}

/**
 * 保证「未分组」存在，并把还没归属会话的 id 追加进去。
 *
 * 只补不删：日志页只有已完成会话，不能因为这里只看见一部分 id，
 * 就把训练页里未完成的会话从分组里清掉。
 */
export function ensureSessionGroups(
  groups: SessionGroup[],
  sessionIds: string[],
  ungroupedName: string
): SessionGroup[] {
  let changed = false
  let next = groups
  if (!next.some((g) => g.id === UNGROUPED_GROUP_ID)) {
    next = [
      { id: UNGROUPED_GROUP_ID, name: ungroupedName, collapsed: false, sessionIds: [] },
      ...next
    ]
    changed = true
  }
  const seen = new Set(next.flatMap((g) => g.sessionIds))
  const missing = sessionIds.filter((id) => !seen.has(id))
  if (missing.length > 0) {
    next = next.map((g) =>
      g.id === UNGROUPED_GROUP_ID ? { ...g, sessionIds: [...g.sessionIds, ...missing] } : g
    )
    changed = true
  }
  return changed ? next : groups
}

export function toggleSessionGroup(
  groups: SessionGroup[],
  groupId: string
): SessionGroup[] {
  return groups.map((g) => (g.id === groupId ? { ...g, collapsed: !g.collapsed } : g))
}
