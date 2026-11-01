// 重载后把会话重新打开，等图表就绪
import { connect } from './cdp.mjs'
const c = await connect()
await c.evalJs(`(() => {
  const b = [...document.querySelectorAll('nav button, aside button')].find((e) => (e.textContent || '').trim().includes('训练'))
  if (b) b.click(); return true })()`)
await c.wait(1000)
await c.evalJs(`(async () => {
  const st = window.__rw_store.getState()
  if (!st.activeSession) {
    await st.loadSessions()
    const list = window.__rw_store.getState().sessions || []
    const one = list.find((s) => s.completed_at == null) || list[0]
    if (one) window.__rw_store.getState().openSession(one.id)
  }
  return 'ok' })()`)
await c.wait(3500)
if (!(await c.evalJs(`!!document.querySelector('[data-secondary-chart]')`))) {
  await c.clickContains('双周期')
  await c.wait(1800)
}
console.log('ready:', await c.evalJs(`JSON.stringify({ main: !!window.__rw_chart, sec: !!window.__rw_chart2, dual: !!document.querySelector('[data-secondary-chart]') })`))
c.close(); process.exit(0)
