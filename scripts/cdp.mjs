// ============================================================
// TraderRewind — CDP 自动化小工具（仅开发期使用）
//
// 用途：驱动开发中的 Electron 窗口做界面巡检、造演示数据、截图。
// 前提：以 `TR_DEBUG_PORT=9333 npm run dev` 启动。
//
// 注意：主进程里关掉了 CalculateNativeWinOcclusion，
// 否则窗口被挡住时 Chromium 停绘，Page.captureScreenshot 会一直超时。
// ============================================================

import fs from 'node:fs'
import path from 'node:path'

const PORT = process.env.TR_DEBUG_PORT || 9333

export async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = list.find((t) => t.type === 'page')
  if (!page) throw new Error('找不到页面，应用没启动？')

  const ws = await new Promise((resolve, reject) => {
    const s = new WebSocket(page.webSocketDebuggerUrl)
    s.addEventListener('open', () => resolve(s))
    s.addEventListener('error', (e) => reject(new Error('ws error: ' + e.message)))
  })

  let seq = 0
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject, timer } = pending.get(msg.id)
      pending.delete(msg.id)
      clearTimeout(timer)
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
    }
  })

  function send(method, params = {}, timeout = 20000) {
    const id = ++seq
    ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`timeout: ${method}`))
      }, timeout)
      pending.set(id, { resolve, reject, timer })
    })
  }

  async function evalJs(expression) {
    const r = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    })
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed')
    }
    return r.result.value
  }

  await send('Runtime.enable')
  await send('Page.enable')
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })

  return {
    send,
    evalJs,
    wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    close: () => ws.close(),

    /** 截图到文件；返回字节数 */
    async shot(file) {
      const r = await send('Page.captureScreenshot', { format: 'png' }, 30000)
      const buf = Buffer.from(r.data, 'base64')
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, buf)
      return buf.length
    },

    /** 按可见文字点击元素（默认按钮） */
    async clickText(text, selector = 'button') {
      const ok = await evalJs(`(() => {
        const t = ${JSON.stringify(text)}
        const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
          .find((e) => (e.textContent || '').trim() === t)
        if (!el) return false
        el.click()
        return true
      })()`)
      return ok
    },

    /** 按可见文字包含匹配点击 */
    async clickContains(text, selector = 'button') {
      const ok = await evalJs(`(() => {
        const t = ${JSON.stringify(text)}
        const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
          .filter((e) => (e.textContent || '').includes(t))
          .sort((a, b) => (a.textContent || '').length - (b.textContent || '').length)[0]
        if (!el) return false
        el.click()
        return true
      })()`)
      return ok
    },

    /** 切到某个主页面（0 工作台 / 1 数据源 / 2 训练 / 3 日志 / 4 设置） */
    async gotoPane(index) {
      await evalJs(`(() => {
        const btns = [...document.querySelectorAll('aside nav button, nav button')]
        if (btns[${index}]) btns[${index}].click()
      })()`)
      await new Promise((r) => setTimeout(r, 900))
    },

    /** 当前可见文本快照，便于定位问题 */
    async visibleText(limit = 4000) {
      return evalJs(`(() => {
        const out = []
        const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
        let n
        while ((n = w.nextNode())) {
          const s = (n.nodeValue || '').trim()
          if (!s) continue
          const el = n.parentElement
          if (!el) continue
          const st = getComputedStyle(el)
          if (st.display === 'none' || st.visibility === 'hidden' || el.offsetParent === null) continue
          out.push(s)
        }
        return out.join('\\n').slice(0, ${limit})
      })()`)
    }
  }
}
