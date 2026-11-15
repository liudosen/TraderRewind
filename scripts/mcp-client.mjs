#!/usr/bin/env node
// ============================================================
// TraderRewind — 最小 MCP Streamable HTTP 客户端（开发/巡检用）
//
// 用法：
//   node scripts/mcp-client.mjs --health
//   node scripts/mcp-client.mjs --list
//   node scripts/mcp-client.mjs --call list_sessions
//   node scripts/mcp-client.mjs --call get_trade_context --args '{"sessionId":1,"tradeId":"t_..."}'
//
// 不依赖任何 npm 包：Node 18+ 自带 fetch。
// ============================================================

import fs from 'node:fs'

const args = process.argv.slice(2)
function flag(name, def = undefined) {
  const i = args.indexOf(name)
  if (i < 0) return def
  const next = args[i + 1]
  return next && !next.startsWith('--') ? next : true
}
const url = flag('--url', process.env.TR_MCP_URL || 'http://127.0.0.1:47821/mcp')
const list = flag('--list', false)
const call = flag('--call', null)
const health = flag('--health', false)
const rawArgs = flag('--args', '{}')
const argsFile = flag('--args-file', null)
const out = flag('--out', null)
const quiet = flag('--quiet', false)

async function main() {
  if (health) {
    const res = await fetch(url.replace(/\/mcp\/?$/, '/health'))
    console.log(JSON.stringify(await res.json(), null, 2))
    return
  }

  let sessionId = null
  let protocolVersion = null

  async function post(payload) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
      ...(protocolVersion ? { 'MCP-Protocol-Version': protocolVersion } : {})
    }
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) })
    const sid = res.headers.get('mcp-session-id')
    if (sid) sessionId = sid
    const pv = res.headers.get('mcp-protocol-version')
    if (pv) protocolVersion = pv
    if (res.status === 202) return null
    const text = await res.text()
    if (!text.trim()) return null
    const ct = res.headers.get('content-type') || ''
    if (ct.includes('text/event-stream')) {
      let last = null
      for (const line of text.split(/\r?\n/)) {
        const l = line.trim()
        if (!l.startsWith('data:')) continue
        const data = l.slice(5).trim()
        if (!data || data === '[DONE]') continue
        try { last = JSON.parse(data) } catch { /* ignore */ }
      }
      return last
    }
    return JSON.parse(text)
  }

  const init = await post({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'traderrewind-smoke', version: '1.0.0' }
    }
  })
  if (init?.error) throw new Error(`initialize: ${init.error.message}`)
  if (!quiet) {
    console.error(
      `[mcp] ${init.result.serverInfo.name} ${init.result.serverInfo.version} protocol=${init.result.protocolVersion} session=${sessionId}`
    )
  }
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' })

  let payload
  if (list) {
    const r = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    payload = r?.result?.tools
  } else if (call) {
    let toolArgs = {}
    try {
      const text = argsFile ? fs.readFileSync(argsFile, 'utf8') : rawArgs
      toolArgs = typeof text === 'string' ? JSON.parse(text) : text
    } catch (e) {
      throw new Error(`--args 不是合法 JSON: ${e.message}`)
    }
    const r = await post({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: call, arguments: toolArgs }
    })
    if (r?.error) throw new Error(`${call}: ${r.error.message}`)
    if (r?.result?.isError) {
      const text = r.result.content?.map((c) => c.text).join('\n')
      throw new Error(`${call}: ${text}`)
    }
    payload = r?.result?.structuredContent ?? r?.result
  } else {
    const r = await post({ jsonrpc: '2.0', id: 2, method: 'resources/list' })
    payload = r?.result
  }

  const text = JSON.stringify(payload, null, 2)
  if (out) {
    fs.writeFileSync(out, text)
    console.error(`[mcp] wrote ${out} (${Buffer.byteLength(text)} bytes)`)
  } else {
    console.log(text)
  }
}

main().catch((e) => {
  console.error('[mcp] ERROR:', e.message)
  process.exitCode = 1
})
