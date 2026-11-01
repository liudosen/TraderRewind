// 巡检双周期窗的三件事：
//  1. 主图往右 / 往左拖，两个窗口的时间跨度都不许缩水（「自动放大」回归）
//  2. 副窗 overlay 画布有没有尺寸、有没有把订单线画出来
//  3. 十字线有没有跨图联动（主→副、副→主，以及离开时一起消失）
import { connect } from './cdp.mjs'

const c = await connect()
const log = (k, v) => console.log(String(k).padEnd(22), typeof v === 'string' ? v : JSON.stringify(v))

// ---------- 准备：进训练页、开一集、确保双周期开着 ----------
await c.evalJs(`(() => {
  const b = [...document.querySelectorAll('nav button, aside button')]
    .find((e) => (e.textContent || '').trim().includes('训练'))
  if (b) b.click()
  return true
})()`)
await c.wait(800)

await c.evalJs(`(async () => {
  const st = window.__rw_store.getState()
  if (!st.activeSession) {
    await st.loadSessions()
    const list = window.__rw_store.getState().sessions || []
    const one = list.find((s) => s.completed_at == null) || list[0]
    if (one) window.__rw_store.getState().openSession(one.id)
  }
  return 'ok'
})()`)
await c.wait(3000)

if (!(await c.evalJs(`!!document.querySelector('[data-secondary-chart]')`))) {
  await c.clickContains('双周期')
  await c.wait(1500)
}

// ---------- 1. 来回拖，看跨度会不会缩 ----------
const pans = await c.evalJs(`(async () => {
  const mc = window.__rw_chart.chart
  const sc = window.__rw_chart2.chart
  const m = mc.timeScale(), s = sc.timeScale()
  const sleep = (ms) => new Promise((x) => setTimeout(x, ms))
  const rows = []
  const snap = (tag) => {
    const mr = m.getVisibleRange(), sr = s.getVisibleRange()
    const ml = m.getVisibleLogicalRange(), sl = s.getVisibleLogicalRange()
    rows.push({
      tag,
      mainSpanSec: mr ? Math.round(Number(mr.to) - Number(mr.from)) : null,
      secSpanSec: sr ? Math.round(Number(sr.to) - Number(sr.from)) : null,
      mainBars: ml ? Math.round(ml.to - ml.from) : null,
      secBars: sl ? Math.round(sl.to - sl.from) : null
    })
  }
  // 真实拖拽改的是「逻辑范围」——根数不变、时间跟着走，跟下面这几行等价
  const shift = async (ts, bars, tag) => {
    const l = ts.getVisibleLogicalRange()
    ts.setVisibleLogicalRange({ from: l.from + bars, to: l.to + bars })
    await sleep(320)
    snap(tag)
  }
  snap('起手')
  for (let i = 0; i < 6; i++) await shift(m, (i % 2 ? -1 : 1) * Math.max(2, Math.round((m.getVisibleLogicalRange().to - m.getVisibleLogicalRange().from) / 3)), '主图右拖#' + (i + 1))
  for (let i = 0; i < 6; i++) await shift(m, -Math.max(2, Math.round((m.getVisibleLogicalRange().to - m.getVisibleLogicalRange().from) / 3)), '主图左拖#' + (i + 1))
  for (let i = 0; i < 4; i++) await shift(s, Math.max(1, Math.round((s.getVisibleLogicalRange().to - s.getVisibleLogicalRange().from) / 3)), '副窗右拖#' + (i + 1))
  for (let i = 0; i < 4; i++) await shift(s, -Math.max(1, Math.round((s.getVisibleLogicalRange().to - s.getVisibleLogicalRange().from) / 3)), '副窗左拖#' + (i + 1))
  return JSON.stringify(rows)
})()`)

const rows = JSON.parse(pans)
const base = rows[0]
console.log('=== 1. 时间跨度守恒 ===')
for (const r of rows) console.log(String(r.tag).padEnd(12), 'mainSpan', String(r.mainSpanSec).padStart(7), 'secSpan', String(r.secSpanSec).padStart(7), 'mainBars', String(r.mainBars).padStart(4), 'secBars', String(r.secBars).padStart(3))
const shrunk = rows.filter((r) => r.mainSpanSec < base.mainSpanSec * 0.5 || r.secSpanSec < base.secSpanSec * 0.5)
log('跨度腰斩的步数', shrunk.length === 0 ? '0（通过）' : shrunk.map((r) => r.tag).join(', '))

// ---------- 2. 副窗 overlay 画布 ----------
const overlay = await c.evalJs(`(async () => {
  // 把两边都拉回到「有成交的那一段」再看像素
  const st = window.__rw_store.getState()
  const trades = (st.closedTrades || st.trades || [])
  const cv = document.querySelector('[data-secondary-overlay]')
  if (!cv) return JSON.stringify({ err: '没有 overlay 画布' })
  const host = cv.parentElement
  const px = (() => {
    const ctx = cv.getContext('2d')
    const d = ctx.getImageData(0, 0, cv.width, cv.height).data
    let n = 0
    for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++
    return n
  })()
  return JSON.stringify({
    trades: trades.length,
    canvasW: cv.width,
    canvasH: cv.height,
    styleW: cv.style.width,
    styleH: cv.style.height,
    hostW: host ? host.clientWidth : null,
    hostH: host ? host.clientHeight : null,
    paintedPx: px
  })
})()`)
console.log('=== 2. 副窗订单线画布 ===')
log('overlay', JSON.parse(overlay))

// ---------- 3. 十字线联动 ----------
// 注意：lightweight-charts 只在 mouseenter 之后才绑定 mousemove，
// 所以合成 MouseEvent 是打不进去的 —— 必须走 CDP 的真实输入事件。
console.log('=== 3. 十字线联动 ===')
const rects = JSON.parse(
  await c.evalJs(`(() => {
    const main = window.__rw_chart.chart
    const sec = window.__rw_chart2.chart
    window.__xh = { toSec: [], toMain: [] }
    const rec = (bucket) => (p) =>
      window.__xh[bucket].push({ t: p.time ?? null, x: p.point ? Math.round(p.point.x) : null, y: p.point ? Math.round(p.point.y) : null })
    window.__xh.hSec = rec('toSec')
    window.__xh.hMain = rec('toMain')
    sec.subscribeCrosshairMove(window.__xh.hSec)
    main.subscribeCrosshairMove(window.__xh.hMain)
    const rm = main.chartElement().getBoundingClientRect()
    const rs = sec.chartElement().getBoundingClientRect()
    return JSON.stringify({
      main: { x: Math.round(rm.left + rm.width * 0.45), y: Math.round(rm.top + rm.height * 0.5) },
      sec: { x: Math.round(rs.left + rs.width * 0.55), y: Math.round(rs.top + rs.height * 0.5) }
    })
  })()`)
)

const moveTo = async (p) => {
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, buttons: 0 })
  await c.wait(260)
}

await moveTo(rects.main)
log('鼠标在主图 → 副窗收到', JSON.parse(await c.evalJs(`JSON.stringify({ n: window.__xh.toSec.length, last: window.__xh.toSec.slice(-1)[0] ?? null })`)))

await moveTo(rects.sec)
log('鼠标在副窗 → 主图收到', JSON.parse(await c.evalJs(`JSON.stringify({ n: window.__xh.toMain.length, last: window.__xh.toMain.slice(-1)[0] ?? null })`)))

// 移出图表：两边十字线都该消失（point 变成 null/undefined）
await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5, buttons: 0 })
await c.wait(260)
log('鼠标移开', JSON.parse(await c.evalJs(`JSON.stringify({ secLast: window.__xh.toSec.slice(-1)[0] ?? null, mainLast: window.__xh.toMain.slice(-1)[0] ?? null })`)))

await c.evalJs(`(() => {
  window.__rw_chart2.chart.unsubscribeCrosshairMove(window.__xh.hSec)
  window.__rw_chart.chart.unsubscribeCrosshairMove(window.__xh.hMain)
  return true
})()`)

await c.shot('.workbuddy/shots/dual-fix.png')
console.log('截图:', '.workbuddy/shots/dual-fix.png')

c.close()
process.exit(0)
