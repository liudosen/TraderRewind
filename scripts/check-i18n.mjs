// 通过 CDP 验证中英文切换：读关键文案 → 点 EN → 再读一遍 → 切回中文
// 用 Node 22+ 内置的 WebSocket，不额外装依赖
const PORT = process.env.TR_DEBUG_PORT || 9333

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
  return res.json()
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.addEventListener('open', () => resolve(ws))
    ws.addEventListener('error', (e) => reject(new Error('ws error: ' + e.message)))
  })
}

let id = 0
const pending = new Map()

function send(ws, method, params = {}) {
  const msgId = ++id
  ws.send(JSON.stringify({ id: msgId, method, params }))
  return new Promise((resolve, reject) => {
    pending.set(msgId, { resolve, reject })
    setTimeout(() => reject(new Error(`timeout: ${method}`)), 15000)
  })
}

async function evalJs(ws, expression) {
  const r = await send(ws, 'Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed')
  }
  return r.result.value
}

const SNAPSHOT = `(() => {
  const txt = (sel) => [...document.querySelectorAll(sel)].map((n) => (n.textContent || '').trim())
  const nav = txt('nav button span, aside button span').filter(Boolean)
  const h1 = txt('main h1')
  const h2 = txt('main h2')
  const lang = [...document.querySelectorAll('[data-lang-toggle] button')].map((b) => ({
    text: b.textContent.trim(),
    on: !b.className.replace(/hover:[^\\s]+/g, '').includes('border-[var(--border-subtle)]')
  }))
  return { nav, h1, h2, lang, htmlLang: document.documentElement.lang }
})()`

function clickLang(locale) {
  return `(() => {
    const wrap = document.querySelector('[data-lang-toggle]')
    if (!wrap) return 'no-toggle'
    const b = [...wrap.querySelectorAll('button')].find((x) => x.dataset.locale === '${locale}')
    if (!b) return 'no-button'
    b.click()
    return 'ok'
  })()`
}

function clickNav(index) {
  return `(() => {
    const btns = [...document.querySelectorAll('aside nav button, nav button')]
    if (!btns[${index}]) return 'no-nav'
    btns[${index}].click()
    return 'ok'
  })()`
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const list = await targets()
const page = list.find((t) => t.type === 'page')
if (!page) throw new Error('找不到页面')

const ws = await connect(page.webSocketDebuggerUrl)
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(msg.error.message))
    else resolve(msg.result)
  }
})

await send(ws, 'Runtime.enable')
await send(ws, 'Emulation.setFocusEmulationEnabled', { enabled: true })

// 回到工作台，保证从同一屏对比
await evalJs(ws, clickNav(0))
await wait(400)

const before = await evalJs(ws, SNAPSHOT)
console.log('--- 切换前（中文）---')
console.log(JSON.stringify(before, null, 2))

console.log('\n点击 EN:', await evalJs(ws, clickLang('en')))
await wait(700)

const after = await evalJs(ws, SNAPSHOT)
console.log('\n--- 切换后（英文）---')
console.log(JSON.stringify(after, null, 2))

// 设置页也看一眼
await evalJs(ws, clickNav(4))
await wait(500)
const settings = await evalJs(
  ws,
  `(() => ({
    h1: [...document.querySelectorAll('main h1')].map(n => n.textContent.trim()),
    tabs: [...document.querySelectorAll('main button')].slice(0, 6).map(b => b.textContent.trim()),
    sectionHeads: [...document.querySelectorAll('main h2')].map(n => n.textContent.trim())
  }))()`
)
console.log('\n--- 设置页（英文）---')
console.log(JSON.stringify(settings, null, 2))

// 切回中文
console.log('\n点击 中:', await evalJs(ws, clickLang('zh')))
await wait(600)
const back = await evalJs(ws, SNAPSHOT)
console.log('\n--- 切回中文 ---')
console.log(JSON.stringify(back, null, 2))

await evalJs(ws, clickNav(0))
ws.close()
