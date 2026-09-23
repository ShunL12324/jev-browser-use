import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const freePort = () => new Promise(resolve => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) }) })
const delay = ms => new Promise(r => setTimeout(r, ms))

// Simulated extension: owns a tab table, reconnects when its bridge goes away.
function fakeExtension(port) {
  const state = { tabs: [{ id: 1, url: 'https://user.example/', title: 'User tab' }], next: 100, calls: [], connected: false, stop: false }
  const connect = () => {
    if (state.stop) return
    const ws = new WebSocket(`ws://127.0.0.1:${port}/mcp`)
    ws.on('open', () => { state.connected = true; ws.send(JSON.stringify({ v: 1, kind: 'hello', id: 'h', client: 'extension', extensionVersion: 'test' })) })
    ws.on('message', data => {
      const f = JSON.parse(String(data))
      if (f.kind !== 'command') return
      state.calls.push({ tool: f.tool, tabId: f.tabId, params: f.params })
      let result = { ok: true, tool: f.tool, tabId: f.tabId }
      if (f.tool === 'tabs') {
        const p = f.params
        if (p.action === 'new') { const id = state.next++; state.tabs.push({ id, url: p.url ?? 'about:blank', title: '', dedicated: p.dedicated }); result = { ok: true, action: 'new', tabId: id } }
        if (p.action === 'list') result = { ok: true, action: 'list', tabs: state.tabs.map(t => ({ id: t.id, url: t.url, title: t.title, active: false, ...(t.opener ? { openerTabId: t.opener } : {}) })) }
        if (p.action === 'close') { state.tabs = state.tabs.filter(t => t.id !== p.tabId); result = { ok: true, action: 'close', tabId: p.tabId } }
        if (p.action === 'switch') result = { ok: true, action: 'switch', tabId: p.tabId }
      }
      ws.send(JSON.stringify({ v: 1, kind: 'result', id: f.id, ok: true, result }))
    })
    ws.on('close', () => { state.connected = false; setTimeout(connect, 100) })
    ws.on('error', () => {})
    state.ws = ws
  }
  connect()
  return state
}
async function session(port, runtime) {
  const client = new Client({ name: 'hub-test', version: '1' })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['packages/bridge/dist/index.js'], env: { ...process.env, BROWSER_USE_PORT: String(port), XDG_RUNTIME_DIR: runtime }, stderr: 'ignore' }))
  const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); const data = JSON.parse(r.content[0].text); return r.isError ? { error: data.code } : data }
  return { client, call }
}

test('two MCP sessions share one extension without seeing each other\'s tabs; hub failover keeps ownership', { timeout: 30000 }, async () => {
  const port = await freePort(), runtime = mkdtempSync(join(tmpdir(), 'hub-test-'))
  const ext = fakeExtension(port)
  const a = await session(port, runtime)
  await delay(300)
  const b = await session(port, runtime)
  let c
  try {
    for (let i = 0; i < 50 && !ext.connected; i++) await delay(100)
    const ta = (await a.call('browser_tabs', { action: 'new', url: 'http://127.0.0.1:1/a' })).tabId
    const tb = (await b.call('browser_tabs', { action: 'new', url: 'http://127.0.0.1:1/b' })).tabId
    assert.ok(ta && tb && ta !== tb)
    assert.ok(ext.tabs.find(t => t.id === ta).dedicated && ext.tabs.find(t => t.id === tb).dedicated)
    assert.deepEqual((await a.call('browser_tabs', { action: 'list' })).tabs.map(t => t.id), [ta])
    assert.deepEqual((await b.call('browser_tabs', { action: 'list' })).tabs.map(t => t.id), [tb])
    // Neither the other session's tab nor the user's own tab is reachable.
    assert.equal((await b.call('browser_view', { tabId: ta })).error, 'TAB_NOT_OWNED')
    assert.equal((await a.call('browser_view', { tabId: 1 })).error, 'TAB_NOT_OWNED')
    assert.equal((await b.call('browser_tabs', { action: 'close', tabId: ta })).error, 'TAB_NOT_OWNED')
    // Without a tabId, a call goes to the session's own current tab.
    await b.call('browser_view', {})
    assert.equal(ext.calls.at(-1).tabId, tb)
    // A tab opened from b's tab (target=_blank) is adopted by b only.
    ext.tabs.push({ id: 555, url: 'http://127.0.0.1:1/child', title: 'child', opener: tb })
    assert.deepEqual((await b.call('browser_tabs', { action: 'list' })).tabs.map(t => t.id).sort(), [tb, 555].sort())
    assert.equal((await a.call('browser_view', { tabId: 555 })).error, 'TAB_NOT_OWNED')
    assert.ok(!ext.calls.some(x => x.tool !== 'tabs' && x.tabId === 1), 'user tab never touched')
    // The hub (a) exits; b takes over the port, the extension reconnects,
    // and b keeps its tabs; a new session c joins as a peer.
    await a.client.close()
    for (let i = 0; i < 80; i++) { await delay(100); if (ext.connected) { const r = await b.call('browser_tabs', { action: 'list' }); if (!r.error && r.tabs.length === 2) break } }
    assert.deepEqual((await b.call('browser_tabs', { action: 'list' })).tabs.map(t => t.id).sort(), [tb, 555].sort())
    await b.call('browser_view', { tabId: 555 })
    assert.equal(ext.calls.at(-1).tabId, 555)
    c = await session(port, runtime)
    assert.deepEqual((await c.call('browser_tabs', { action: 'list' })).tabs, [])
    assert.equal((await c.call('browser_view', { tabId: tb })).error, 'TAB_NOT_OWNED')
    assert.equal((await c.call('browser_view', {})).error, 'NO_SESSION_TAB')
  } finally {
    ext.stop = true; ext.ws?.close()
    await Promise.allSettled([a.client.close(), b.client.close(), c?.client.close()])
    rmSync(runtime, { recursive: true, force: true })
  }
})
