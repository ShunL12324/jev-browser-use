// Mechanical check through the real extension (fake Jev, no paid calls):
// a target=_blank link opens a tab that the task adopts and follows; the page
// settle state is recorded; a second MCP session joining the same extension
// as a hub peer cannot see or use the first session's tabs.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { launchIsolated } from '../../scripts/jev/task-browser.mjs'
import { runTask } from '../../packages/bridge/dist/agent/loop.mjs'
import { prepareTask } from '../../packages/bridge/dist/agent/task.mjs'

const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' })
  if (req.url === '/help') return res.end('<main><h1>Help centre</h1><p>Activation code: 4411</p></main>')
  res.end('<main><h1>Settings</h1><a href="/help" target="_blank">Help centre</a></main>')
}).listen(0, '127.0.0.1')
await once(server, 'listening')
const origin = `http://127.0.0.1:${server.address().port}`
const browser = await launchIsolated()
let peer
try {
  const pick = (q, id) => ({ type: 'choice', choice: id, probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, k === id ? 1 : 0])) })
  let asks = 0
  const ask = async ({ state, questions }) => {
    asks++
    const link = state.elements.find(e => e.name === 'Help centre')
    const op = asks === 1 && link ? 'CLICK' : 'DONE'
    const answers = { operation: pick(questions.operation, op) }
    for (const [id, q] of Object.entries(questions)) if (id !== 'operation') answers[id] = pick(q, id === 'target_CLICK' && link ? link.id : Object.keys(q.criteria).includes('keep') ? 'keep' : Object.keys(q.criteria).includes('caller') ? 'caller' : Object.keys(q.criteria)[0])
    return { answers, usage: { input_tokens: 0 } }
  }
  const events = []
  const result = await runTask(prepareTask({ goal: 'Open the help centre', startUrl: origin + '/', allowedOrigins: [origin] }), { call: (n, a) => browser.call(n, a), ask, handoff: async () => ({}), emit: e => events.push(e) })
  assert.equal(result.status, 'done'); assert.equal(result.finalUrl, origin + '/help')
  const adopted = events.find(e => e.event === 'tab_adopted')
  assert.ok(adopted && adopted.tabId === result.tabId)
  const env = events.find(e => e.event === 'settle_env')
  assert.ok(env && env.visibility)
  const mine = (await browser.tool('browser_tabs', { action: 'list' })).tabs.map(t => t.id)
  assert.ok(mine.includes(result.tabId) && mine.length === 2)
  // A second session (peer of this hub) sees none of these tabs.
  peer = new Client({ name: 'peer', version: '1' })
  await peer.connect(new StdioClientTransport({ command: process.execPath, args: [join(fileURLToPath(new URL('../../', import.meta.url)), 'packages/bridge/dist/index.js')], env: browser.env, stderr: 'ignore' }))
  const peerCall = async (name, args) => { const r = await peer.callTool({ name, arguments: args }); const d = JSON.parse(r.content[0].text); return r.isError ? { error: d.code } : d }
  assert.deepEqual((await peerCall('browser_tabs', { action: 'list' })).tabs, [])
  assert.equal((await peerCall('browser_view', { tabId: result.tabId })).error, 'TAB_NOT_OWNED')
  const own = (await peerCall('browser_tabs', { action: 'new', url: origin + '/' })).tabId
  assert.ok((await peerCall('browser_view', { tabId: own })).content?.includes('Settings'))
  assert.equal((await browser.tool('browser_view', { tabId: own }).catch(e => ({ error: e.code }))).error, 'TAB_NOT_OWNED')
  console.log(JSON.stringify({ event: 'task_tabs_pass', adoptedTab: adopted.tabId, settleEnv: env, liveJev: false }))
} finally { await peer?.close(); await browser.close(); server.close() }
