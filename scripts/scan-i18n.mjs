// 切到英文后逐页扫描 DOM，列出仍然含中文的可见文本 —— 用来找漏翻
const PORT = process.env.TR_DEBUG_PORT || 9333

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find((t) => t.type === 'page')
if (!page) throw new Error('找不到页面')

const ws = await new Promise((resolve, reject) => {
  const s = new WebSocket(page.webSocketDebuggerUrl)
  s.addEventListener('open', () => resolve(s))
  s.addEventListener('error', (e) => reject(new Error('ws error: ' + e.message)))
})

let id = 0
const pending = new Map()
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
  }
})

function send(method, params = {}) {
  const msgId = ++id
  ws.send(JSON.stringify({ id: msgId, method, params }))
  return new Promise((resolve, reject) => {
    pending.set(msgId, { resolve, reject })
    setTimeout(() => reject(new Error('timeout: ' + method)), 20000)
  })
}

async function evalJs(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed')
  return r.result.value
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

await send('Runtime.enable')
await send('Emulation.setFocusEmulationEnabled', { enabled: true })

// 切到英文
await evalJs(`(() => {
  const b = document.querySelector('[data-lang-toggle] [data-locale="en"]')
  if (b) b.click()
  return !!b
})()`)
await wait(800)

const SCAN = `(() => {
  const CJK = /[\\u4e00-\\u9fa5]/
  const out = []
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  let n
  while ((n = walk.nextNode())) {
    const s = (n.nodeValue || '').trim()
    if (!s || !CJK.test(s)) continue
    const el = n.parentElement
    if (!el) continue
    const st = getComputedStyle(el)
    if (st.display === 'none' || st.visibility === 'hidden' || el.offsetParent === null) continue
    // 用户数据（标签名、备注）不算法漏翻，但先一并列出来人工判断
    out.push({ text: s.slice(0, 60), tag: el.tagName.toLowerCase() })
  }
  return out
})()`

const PANES = ['工作台/Dashboard', '数据源/Data', '训练/Training', '日志/Journal', '设置/Settings']
const results = {}

for (let i = 0; i < 5; i++) {
  await evalJs(`(() => {
    const btns = [...document.querySelectorAll('aside nav button, nav button')]
    if (btns[${i}]) btns[${i}].click()
  })()`)
  await wait(1200)
  results[PANES[i]] = await evalJs(SCAN)
}

console.log('=== 英文模式下仍显示中文的文本 ===')
for (const [pane, items] of Object.entries(results)) {
  console.log(`\n--- ${pane}: ${items.length} 条 ---`)
  for (const it of items.slice(0, 40)) console.log(`  [${it.tag}] ${it.text}`)
}

// 切回中文，保持界面停在中文
await evalJs(`(() => {
  const b = document.querySelector('[data-lang-toggle] [data-locale="zh"]')
  if (b) b.click()
})()`)
ws.close()
