// 临时验证：nextTradeWindowStart 的边界（纯函数，不启应用）
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outdir = mkdtempSync(join(tmpdir(), 'tr-tw-'))
const outfile = join(outdir, 'tw.mjs')

await build({
  entryPoints: [join(root, 'src/shared/types/trade-window.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile
})

const tw = await import(pathToFileURL(outfile).href)
const TZ = 'Asia/Shanghai' // UTC+8，无夏令时，便于手算期望值

/** 上海本地时间 → UTC 秒 */
const at = (d, h, m) => Math.floor(Date.UTC(2026, 9, d, h - 8, m, 0) / 1000)
/** UTC 秒 → 上海本地「日 时:分」 */
const fmt = (sec) => {
  const t = tw ? new Date((sec + 8 * 3600) * 1000) : null
  return `${String(t.getUTCDate()).padStart(2, '0')}日 ${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`
}

const cases = [
  // [说明, 时段, 游标, 期望]
  ['日盘 · 昨夜收盘后（23:30）', { from: '07:00', to: '23:00' }, at(1, 23, 30), '02日 07:00'],
  ['日盘 · 开盘前（05:00）', { from: '07:00', to: '23:00' }, at(1, 5, 0), '01日 07:00'],
  ['日盘 · 时段内（12:00）→ null', { from: '07:00', to: '23:00' }, at(1, 12, 0), null],
  ['日盘 · 恰好收盘（23:00）→ 次日', { from: '07:00', to: '23:00' }, at(1, 23, 0), '02日 07:00'],
  ['夜盘 · 中午（12:00）', { from: '22:00', to: '06:00' }, at(1, 12, 0), '01日 22:00'],
  ['夜盘 · 凌晨收市后（06:30）', { from: '22:00', to: '06:00' }, at(1, 6, 30), '01日 22:00'],
  ['夜盘 · 时段内（23:00）→ null', { from: '22:00', to: '06:00' }, at(1, 23, 0), null],
  ['夜盘 · 时段内（03:00）→ null', { from: '22:00', to: '06:00' }, at(1, 3, 0), null],
  ['没设时段 → null', null, at(1, 12, 0), null],
  ['全天（from=to 当不限）→ null', { from: '08:00', to: '08:00' }, at(1, 12, 0), null]
]

let bad = 0
for (const [name, w, cur, want] of cases) {
  const got = tw.nextTradeWindowStart(cur, TZ, w)
  const gotText = got == null ? null : fmt(got)
  const ok = gotText === want
  if (!ok) bad++
  console.log(`${ok ? '✅' : '❌'} ${name}  期望 ${want ?? 'null'}  实得 ${gotText ?? 'null'}`)
}

console.log(bad === 0 ? '\n全部通过' : `\n${bad} 条不通过`)
process.exitCode = bad === 0 ? 0 : 1
