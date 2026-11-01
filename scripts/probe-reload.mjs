import { connect } from './cdp.mjs'
const c = await connect()
await c.send('Page.reload', { ignoreCache: true })
await c.wait(1500)
// 等渲染进程重新挂载完
for (let i = 0; i < 30; i++) {
  const ok = await c.evalJs(`!!window.__rw_store`).catch(() => false)
  if (ok) break
  await c.wait(500)
}
await c.wait(1500)
console.log('reloaded, chart hooks:', await c.evalJs(`JSON.stringify({ main: !!window.__rw_chart, sec: !!window.__rw_chart2 })`))
c.close(); process.exit(0)
