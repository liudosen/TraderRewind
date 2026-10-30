// 临时探针：观察设置页「版本更新」卡片
import { connect } from './cdp.mjs'

const c = await connect()

const card = () =>
  c.evalJs(`(() => {
    const lines = document.body.innerText.split('\\n')
    const i = lines.findIndex((l) => l.trim() === '版本更新' || l.trim() === 'App updates')
    if (i < 0) return 'not-found'
    return lines.slice(i, i + 9).map((s) => s.trim()).filter(Boolean).join(' | ')
  })()`)

const click = (label) =>
  c.evalJs(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === ${JSON.stringify(label)})
    if (!b) return 'no-btn'
    if (b.disabled) return 'disabled'
    b.click()
    return 'ok'
  })()`)

const mode = process.argv[2] || 'check'

if (mode === 'check') {
  console.log('点击检查更新:', await click('检查更新'))
  for (const ms of [1200, 2500, 4000]) {
    await c.wait(ms)
    console.log(`[+${ms}]`, await card())
  }
} else if (mode === 'download') {
  console.log('点击开始下载:', await click('开始下载'))
  for (let i = 0; i < 40; i++) {
    await c.wait(2000)
    const line = await card()
    console.log(`[${(i + 1) * 2}s]`, line)
    if (/可安装|已下载 100|失败|中断/.test(line)) break
  }
} else {
  console.log(await card())
}

c.close()
