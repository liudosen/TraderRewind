// 真实鼠标拖拽：按住 K 线图往左 / 往右拖，看根数和跨度会不会自己缩
import { connect } from './cdp.mjs'
const c = await connect()
const log = (k, v) => console.log(String(k).padEnd(10), JSON.stringify(v))

const geo = JSON.parse(await c.evalJs(`(() => {
  const b = window.__rw_chart.chart.chartElement().getBoundingClientRect()
  return JSON.stringify({ cx: Math.round(b.left + b.width / 2), cy: Math.round(b.top + b.height / 2), w: Math.round(b.width) })
})()`))

const snap = async (tag) => JSON.parse(await c.evalJs(`(() => {
  const m = window.__rw_chart.chart.timeScale(), s = window.__rw_chart2.chart.timeScale()
  const mr = m.getVisibleRange(), sr = s.getVisibleRange()
  const ml = m.getVisibleLogicalRange(), sl = s.getVisibleLogicalRange()
  return JSON.stringify({
    tag: ${JSON.stringify(tag)},
    mainSpan: mr ? Math.round(Number(mr.to) - Number(mr.from)) : null,
    secSpan: sr ? Math.round(Number(sr.to) - Number(sr.from)) : null,
    mainBars: ml ? Math.round(ml.to - ml.from) : null,
    secBars: sl ? Math.round(sl.to - sl.from) : null
  })
})()`))

const drag = async (dx) => {
  const steps = 8
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: geo.cx, y: geo.cy, button: 'left', clickCount: 1, buttons: 1 })
  for (let i = 1; i <= steps; i++) {
    await c.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: Math.round(geo.cx + (dx * i) / steps), y: geo.cy, button: 'left', buttons: 1
    })
    await c.wait(24)
  }
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(geo.cx + dx), y: geo.cy, button: 'left', clickCount: 1, buttons: 0 })
  await c.wait(260)
}

// 先复位到「最后一屏附近」的常规视野：上一轮测试可能把视野顶到了 1 根
await c.evalJs(`(async () => {
  const m = window.__rw_chart.chart.timeScale()
  const bars = window.__rw_chart.series
  m.setVisibleLogicalRange({ from: -150, to: 0 })
  await new Promise((r) => setTimeout(r, 600))
  return true
})()`)
await c.wait(700)
// 再往前拖一屏，让左边有足够历史可拖
await drag(-geo.w * 0.5)
const base = await snap('起手')
log('起手', base)
async function run(dir, dx, n, prefix) {
  const rows = [await snap(prefix + '起点')]
  for (let i = 0; i < n; i++) {
    await drag(dir * dx)
    rows.push(await snap(prefix + '#' + (i + 1)))
  }
  return rows
}
const left = await run(-1, Math.round(geo.w * 0.55), 8, '左拖')
const right = await run(1, Math.round(geo.w * 0.55), 8, '右拖')

for (const r of [...left, ...right]) log('', r)

const all = [...left, ...right].slice(1)
const bars = all.map((r) => r.mainBars)
const spanDrift = all.filter((r) => r.mainSpan < 0.6 * Math.max(...all.map((x) => x.mainSpan)))
log('根数范围', { min: Math.min(...bars), max: Math.max(...bars) })
log('两窗偏差', all.map((r) => Math.abs(r.mainSpan - r.secSpan)))
log('明显缩水次数', spanDrift.length)
c.close(); process.exit(0)
