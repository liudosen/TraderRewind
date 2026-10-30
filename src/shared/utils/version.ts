// ============================================================
// TraderRewind — 版本号比较
//
// 只处理本项目会遇到的形态：`0.2.3`、`v0.2.3`、`0.2.3-beta.1`、`0.2.3+build`。
// GitHub 的 tag 带 `v` 前缀，package.json 里不带，两边要能直接比。
// ============================================================

/** 把 `v0.2.3-beta.1+build` 规整成 `[0, 2, 3]`（预发布/构建元数据直接丢掉） */
export function parseVersion(raw: string | null | undefined): number[] {
  if (!raw) return [0]
  const core = String(raw)
    .trim()
    .replace(/^[vV]/, '')
    .split(/[-+]/)[0]
  return core.split('.').map((part) => {
    const n = Number.parseInt(part, 10)
    return Number.isFinite(n) ? n : 0
  })
}

/**
 * 比较两个版本号。
 *
 * 返回 `1` 表示 a 更新、`-1` 表示 a 更旧、`0` 表示一样。
 * 缺的段补 0（`0.3` 与 `0.3.0` 视为同一版），非数字段按 0 处理，
 * 保证脏数据不会把「该不该更新」判反。
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x > y) return 1
    if (x < y) return -1
  }
  return 0
}
