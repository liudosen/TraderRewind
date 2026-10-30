// 验证加密数据源：切源 → 分组折叠 → 选中 → 下载 → 落库
const PORT = process.env.TR_DEBUG_PORT || 9333
const SYMBOL = process.env.TR_SYMBOL || 'BTCUSDT'
const SOURCE_NAME = process.env.TR_SOURCE || 'Binance'
const WAIT_DOWNLOAD_MS = Number(process.env.TR_WAIT || 90000)

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

// ── 1. 进数据源页 ─────────────────────────────
await evalJs(`(() => {
  const btns = [...document.querySelectorAll('aside nav button, nav button')]
  if (btns[1]) btns[1].click()
})()`)
await wait(1500)

// ── 2. 数据源切换条 ───────────────────────────
const tabs = await evalJs(`(() => {
  const bar = document.querySelectorAll('aside div')[0]
  const all = [...document.querySelectorAll('button')].filter((b) => {
    const t = (b.textContent || '').trim()
    return t === 'Dukascopy' || t === 'OKX' || t === 'Binance'
  })
  return all.map((b) => ({
    name: (b.textContent || '').trim(),
    active: b.className.includes('bg-[var(--c-accent-tint)]'),
    title: b.getAttribute('title') || ''
  }))
})()`)
console.log('=== 数据源切换条 ===')
for (const t of tabs) console.log(`  ${t.active ? '●' : '○'} ${t.name}  「${t.title}」`)

// ── 3. 切到 Binance ───────────────────────────
const clicked = await evalJs(`(() => {
  const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === ${JSON.stringify(SOURCE_NAME)})
  if (b) b.click()
  return !!b
})()`)
if (!clicked) throw new Error(`没找到数据源按钮 ${SOURCE_NAME}`)
await wait(1200)

const header = await evalJs(`(() => {
  const els = [...document.querySelectorAll('aside p')]
  return els.map((e) => (e.textContent || '').trim()).filter(Boolean)
})()`)
console.log('\n=== 当前数据源说明 ===')
for (const h of header) console.log('  ' + h)

// ── 4. 分组表头 ───────────────────────────────
async function dumpGroups(tag) {
  const groups = await evalJs(`(() => {
    const toggles = [...document.querySelectorAll('button')].filter((b) => {
      const t = b.getAttribute('title') || ''
      return t === '折叠' || t === '展开' || t === 'Collapse' || t === 'Expand'
    })
    return toggles.map((b) => {
      const spans = [...b.querySelectorAll('span')]
      const name = spans.find((s) => s.className.includes('uppercase'))
      const count = spans.find((s) => s.className.includes('font-mono'))
      const chev = b.querySelector('svg')
      const rotated = chev && chev.className.baseVal && chev.className.baseVal.includes('rotate-90')
      return {
        label: (name?.textContent || '').trim(),
        count: (count?.textContent || '').trim(),
        expanded: !!rotated
      }
    })
  })()`)
  console.log(`\n=== 分组（${tag}）===`)
  for (const g of groups) console.log(`  ${g.expanded ? '▾' : '▸'} ${g.label.padEnd(16)} ${g.count}`)
  return groups
}

const g0 = await dumpGroups('切源后默认状态')

// ── 5. 展开加密组 ─────────────────────────────
const gExpanded = await evalJs(`(() => {
  const toggles = [...document.querySelectorAll('button')].filter((b) => {
    const t = b.getAttribute('title') || ''
    return t === '折叠' || t === '展开' || t === 'Collapse' || t === 'Expand'
  })
  const target = toggles.find((b) => {
    const name = [...b.querySelectorAll('span')].find((s) => s.className.includes('uppercase'))
    const txt = (name?.textContent || '').trim().toLowerCase()
    return txt === 'crypto' || txt === '加密市场'
  })
  if (!target) return 'not-found'
  const chev = target.querySelector('svg')
  const open = chev && chev.className.baseVal.includes('rotate-90')
  if (!open) target.click()
  return open ? 'already-open' : 'clicked'
})()`)
console.log('\n展开加密组: ' + gExpanded)
await wait(700)

const rows = await evalJs(`(() => {
  const out = []
  for (const b of document.querySelectorAll('button')) {
    const mono = b.querySelector('span.font-mono')
    if (!mono) continue
    const sym = (mono.textContent || '').trim()
    if (!/^[A-Z]{2,6}(-?USDT)$/.test(sym)) continue
    const nameEl = [...b.querySelectorAll('span')].find((s) => s.className.includes('text-\\[10.5px\\]'))
    out.push(sym + '  ' + (nameEl?.textContent || '').trim())
  }
  return out
})()`)
console.log(`\n=== 加密品种（${rows.length} 个）===`)
console.log('  ' + rows.join('\n  '))

// ── 6. 选中一个品种 ───────────────────────────
const sel = await evalJs(`(() => {
  for (const b of document.querySelectorAll('button')) {
    const mono = b.querySelector('span.font-mono')
    if (mono && (mono.textContent || '').trim() === ${JSON.stringify(SYMBOL)}) { b.click(); return 'ok' }
  }
  return 'not-found'
})()`)
console.log(`\n选中 ${SYMBOL}: ${sel}`)
await wait(900)

const estimate = await evalJs(`(() => {
  const el = [...document.querySelectorAll('div')].find((d) => d.className.includes('ml-auto') && d.className.includes('text-[10.5px]'))
  return (el?.textContent || '').trim()
})()`)
console.log('预估: ' + estimate)

// ── 7. 下载 ───────────────────────────────────
const started = await evalJs(`(() => {
  const b = [...document.querySelectorAll('button')].find((x) => /开始下载|Start download/.test(x.textContent || ''))
  if (!b) return 'no-button'
  if (b.disabled) return 'disabled'
  b.click()
  return 'clicked'
})()`)
console.log('开始下载: ' + started)

// ── 8. 轮询进度 ───────────────────────────────
const t0 = Date.now()
let last = ''
while (Date.now() - t0 < WAIT_DOWNLOAD_MS) {
  await wait(3000)
  const snap = await evalJs(`(() => {
    const rows = [...document.querySelectorAll('div')].filter((d) => d.className.includes('rounded-lg') && d.className.includes('border') && d.querySelector('.font-mono'))
    const line = rows.map((r) => (r.textContent || '').replace(/\\s+/g, ' ').trim()).find((s) => s.includes(${JSON.stringify(SYMBOL)}))
    return line || ''
  })()`)
  if (snap && snap !== last) {
    console.log(`  [${((Date.now() - t0) / 1000).toFixed(0)}s] ${snap.slice(0, 200)}`)
    last = snap
  }
  if (snap && /完成|Done|失败|Failed|已取消|Cancelled/.test(snap)) break
}

// ── 9. 已下载数据 ─────────────────────────────
const datasets = await evalJs(`(() => {
  const trs = [...document.querySelectorAll('tbody tr')]
  return trs.map((tr) => [...tr.querySelectorAll('td')].map((td) => (td.textContent || '').trim()).join(' | '))
})()`)
console.log(`\n=== 已下载数据（${datasets.length} 行）===`)
for (const d of datasets) console.log('  ' + d)

const err = await evalJs(`(() => {
  const el = [...document.querySelectorAll('div')].find((d) => d.className.includes('c-neg-tint'))
  return (el?.textContent || '').trim()
})()`)
if (err) console.log('\n⚠ 界面报错: ' + err)

ws.close()
