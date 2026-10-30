// 截图核对：英文模式下的工作台 + 训练页
import { writeFileSync } from 'node:fs'

const PORT = process.env.TR_DEBUG_PORT || 9333
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find((t) => t.type === 'page')
const ws = await new Promise((resolve, reject) => {
  const s = new WebSocket(page.webSocketDebuggerUrl)
  s.addEventListener('open', () => resolve(s))
  s.addEventListener('error', (e) => reject(new Error(e.message)))
})
let id = 0
const pending = new Map()
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id)
    pending.delete(m.id)
    m.error ? reject(new Error(m.error.message)) : resolve(m.result)
  }
})
function send(method, params = {}) {
  const mid = ++id
  ws.send(JSON.stringify({ id: mid, method, params }))
  return new Promise((res, rej) => {
    pending.set(mid, { resolve: res, reject: rej })
    setTimeout(() => rej(new Error('timeout ' + method)), 20000)
  })
}
const evalJs = async (e) =>
  (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result
    ?.value
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

await send('Runtime.enable')
await send('Page.enable')
await send('Emulation.setFocusEmulationEnabled', { enabled: true })

await evalJs(`document.querySelector('[data-lang-toggle] [data-locale="en"]').click()`)
await wait(700)

const shots = [
  { name: 'en-dashboard', nav: 0 },
  { name: 'en-training', nav: 2 },
  { name: 'en-settings', nav: 4 }
]
for (const s of shots) {
  await evalJs(`[...document.querySelectorAll('aside nav button, nav button')][${s.nav}].click()`)
  await wait(1500)
  const r = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`C:/Users/Administrator/WorkBuddy/a/.tmp-${s.name}.png`, Buffer.from(r.data, 'base64'))
  console.log('saved', s.name)
}

await evalJs(`document.querySelector('[data-lang-toggle] [data-locale="zh"]').click()`)
await evalJs(`[...document.querySelectorAll('aside nav button, nav button')][0].click()`)
ws.close()
