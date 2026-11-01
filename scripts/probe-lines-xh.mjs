// 1) 把视野挪到有成交的那一段，数副窗 overlay 的着色像素
// 2) 悬停副窗，截主图，看十字线有没有反向联动
import fs from 'node:fs'
import { connect } from './cdp.mjs'
const c = await connect()
const log = (k, v) => console.log(String(k).padEnd(20), typeof v === 'string' ? v : JSON.stringify(v))

const info = JSON.parse(await c.evalJs(`(async () => {
  const st = window.__rw_store.getState()
  const trades = (st.closedTrades || st.trades || []).slice().sort((a, b) => a.entryTime - b.entryTime)
  const mc = window.__rw_chart.chart
  if (trades.length === 0) return JSON.stringify({ err: '没有已平仓订单' })
  const t0 = trades[0].entryTime, t1 = trades[trades.length - 1].exitTime
  const pad = Math.round((t1 - t0) * 0.15) + 600
  // 让主图视野正好盖住全部成交（两边会同步过来）
  mc.timeScale().setVisibleRange({ from: t0 - pad, to: t1 + pad })
  await new Promise((r) => setTimeout(r, 900))
  const cv = document.querySelector('[data-secondary-overlay]')
  const px = (() => {
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data
    let n = 0
    for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++
    return n
  })()
  const mc2 = window.__rw_chart2.chart
  const mr = mc.timeScale().getVisibleRange(), sr = mc2.timeScale().getVisibleRange()
  return JSON.stringify({
    trades: trades.length,
    firstDay: new Date(t0 * 1000).toISOString().slice(0, 16),
    mainSpan: Math.round(Number(mr.to) - Number(mr.from)),
    secSpan: Math.round(Number(sr.to) - Number(sr.from)),
    overlayPaintedPx: px
  })
})()`))
console.log('=== 视野里有订单时，副窗画没画 ===')
log('结果', info)

if (info.overlayPaintedPx > 0) {
  const clip = JSON.parse(await c.evalJs(`(() => {
    const b = window.__rw_chart2.chart.chartElement().getBoundingClientRect()
    return JSON.stringify({ x: b.left, y: b.top, width: b.width, height: b.height, scale: 2 })
  })()`))
  const shot = await c.send('Page.captureScreenshot', { format: 'png', clip }, 30000)
  fs.writeFileSync('.workbuddy/shots/lines-sec.png', Buffer.from(shot.data, 'base64'))
  console.log('副窗截图 .workbuddy/shots/lines-sec.png')
}

// 反向十字线
const g = JSON.parse(await c.evalJs(`(() => {
  const b = window.__rw_chart2.chart.chartElement().getBoundingClientRect()
  const a = window.__rw_chart.chart.chartElement().getBoundingClientRect()
  return JSON.stringify({
    hov: { x: Math.round(b.left + b.width * 0.55), y: Math.round(b.top + b.height * 0.4) },
    mainClip: { x: a.left, y: a.top, width: a.width, height: a.height, scale: 1.4 }
  })
})()`))
await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: g.hov.x, y: g.hov.y, buttons: 0 })
await c.wait(450)
const shot2 = await c.send('Page.captureScreenshot', { format: 'png', clip: g.mainClip }, 30000)
fs.writeFileSync('.workbuddy/shots/xh-main-from-sec.png', Buffer.from(shot2.data, 'base64'))
console.log('悬停副窗后主图截图 .workbuddy/shots/xh-main-from-sec.png')
c.close(); process.exit(0)
