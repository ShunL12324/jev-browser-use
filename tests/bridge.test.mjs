import assert from 'node:assert/strict'
import { test } from 'node:test'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { WebSocket } from 'ws'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createRequire } from 'node:module'
import { Shapes, reshapeParams } from '../packages/bridge/dist/schemas.js'

const { z } = createRequire(new URL('../packages/bridge/package.json', import.meta.url))('zod')

// Reserve an ephemeral test port; never connect to a user's running extension.
async function freePort() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

test('tab switch and close retain the extension operation target', () => {
  for (const action of ['switch', 'close']) {
    const { params, tabId } = reshapeParams('tabs', { action, tabId: 42 })
    assert.equal(tabId, 42)
    assert.deepEqual(params, { action, tabId: 42 })
  }
})

test('typing requires a ref and keeps typed text separate from the target', () => {
  const schema = z.object(Shapes.type)
  assert.equal(schema.safeParse({ text: 'hello' }).success, false)
  const input = schema.parse({ ref: 'f2:e3', text: 'hello', clear: true, tabId: 42 })
  const { params } = reshapeParams('type', input)
  assert.deepEqual(params.target, { ref: 'f2:e3' })
  assert.equal(params.text, 'hello')
  assert.equal(params.clear, true)
})

test('real stdio MCP process relays calls, errors, and heartbeat to a simulated extension', { timeout: 20000 }, async () => {
  const port = await freePort()
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['packages/bridge/dist/index.js'],
    env: { ...process.env, BROWSER_USE_PORT: String(port) },
    stderr: 'pipe'
  })
  const client = new Client({ name: 'replication-smoke', version: '1.0.0' })
  let ws
  try {
    await client.connect(transport)
    const { tools } = await client.listTools()
    assert.equal(tools.length, 20)
    assert.equal(tools.filter(tool => tool.name.startsWith('browser_') && tool.name !== 'browser_task').length, 18)
    assert.ok(tools.some(tool => tool.name === 'browser_task'))
    assert.ok(tools.some(tool => tool.name === 'jev_run'))
    const rejected = await client.callTool({ name: 'jev_run', arguments: { goal: 'No action', startUrl: 'https://example.com/', scenario: 'A', seed: 'test' } })
    assert.equal(JSON.parse(rejected.content[0].text).code, 'EXPERIMENT_ORIGIN')
    ws = new WebSocket(`ws://127.0.0.1:${port}/mcp`)
    await once(ws, 'open')
    ws.send(JSON.stringify({ v: 1, kind: 'hello', id: 'hello', client: 'extension', extensionVersion: 'test' }))
    const pong = once(ws, 'message')
    ws.send(JSON.stringify({ v: 1, kind: 'ping', id: 'ping', ts: 123 }))
    assert.equal(JSON.parse(String((await pong)[0])).echo, 123)

    const commands = []
    ws.on('message', data => {
      const frame = JSON.parse(String(data))
      if (frame.kind !== 'command') return
      commands.push(frame)
      const result = frame.tool === 'click'
        ? { ok: false, code: 'STALE_REF', short_term: true, message: 'element removed' }
        : { ok: true, result: { ok: true, action: frame.params.action, tabId: frame.params.tabId } }
      ws.send(JSON.stringify({ v: 1, kind: 'result', id: frame.id, ...result }))
    })
    for (const action of ['switch', 'close']) {
      const response = await client.callTool({ name: 'browser_tabs', arguments: { action, tabId: 42 } })
      assert.equal(JSON.parse(response.content[0].text).tabId, 42)
      assert.equal(commands.at(-1).params.tabId, 42)
    }
    const failure = await client.callTool({ name: 'browser_click', arguments: { ref: 'e9', tabId: 42 } })
    assert.equal(failure.isError, true)
    assert.equal(JSON.parse(failure.content[0].text).code, 'STALE_REF')
    assert.deepEqual(commands.at(-1).params.target, { ref: 'e9' })
  } finally {
    if (ws && ws.readyState === WebSocket.OPEN) {
      const closed = once(ws, 'close')
      ws.close()
      await closed
    } else ws?.terminate()
    await client.close()
  }
})
