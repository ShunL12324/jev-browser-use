import assert from 'node:assert/strict'
import { test } from 'node:test'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { WebSocket } from 'ws'
import { prepare, decide, run, validateTask } from '../scripts/jev/core.mjs'
import { connectBrowser } from '../scripts/jev/mcp.mjs'
import { startWsHost } from '../packages/bridge/dist/ws-host.js'

const task = validateTask({ goal: 'Set display name to River and save.', startUrl: 'http://localhost:17330/', values: { name: 'River' }, expectedText: 'Saved display name: River' })
const elements = () => [{ ref: 'e1', tag: 'input', role: 'textbox', name: 'Display name', value: '' }, { ref: 'e2', tag: 'button', role: 'button', name: 'Save display name' }]
const observation = () => ({ view: { url: task.startUrl, title: 'Settings', content: 'No changes saved.', truncated: false }, snapshot: { url: task.startUrl, interactables: elements() } })
function answer(questions, picks = {}, done = 0.01) {
  return { model: 'fixture', usage: { input_tokens: 100 }, answers: Object.fromEntries(Object.entries(questions).map(([key, q]) => {
    if (q.type === 'noul') return [key, { type: 'noul', noul: key === 'goal_met' ? done : 0.01 }]
    const chosen = picks[key] ?? (Object.hasOwn(q.criteria, 'none') ? 'none' : Object.keys(q.criteria)[0])
    return [key, { type: 'choice', choice: chosen, confidence: 1, probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, k === chosen ? 1 : 0])) }]
  })) }
}

test('one request factors actions, field and value; unused none answers do not prevent typing', () => {
  const { view, snapshot } = observation(), p = prepare(task, view, snapshot)
  assert.equal(Object.keys(p.questions).length, 6)
  const d = decide(task, p, answer(p.questions, { action: 'type', type_target: 'e1', type_value: 'name' }), 42)
  assert.deepEqual(d.args, { tabId: 42, ref: 'e1', text: 'River', clear: true, submit: false })
})

test('reject invented refs, low probability, truncated observations and cross-origin pages', () => {
  const { view, snapshot } = observation(), p = prepare(task, view, snapshot)
  const a = answer(p.questions, { action: 'click', click_target: 'e2' })
  a.answers.click_target.choice = 'e999'
  assert.throws(() => decide(task, p, a, 42), { code: 'BAD_ANSWER' })
  const uncertain = answer(p.questions, { action: 'click', click_target: 'e2' })
  uncertain.answers.click_target.probabilities = { e1: 0.45, e2: 0.5, none: 0.05 }
  assert.throws(() => decide(task, p, uncertain, 42), { code: 'UNCERTAIN' })
  assert.throws(() => prepare(task, { ...view, truncated: true }, snapshot), { code: 'PAGE_TOO_LARGE' })
  assert.throws(() => prepare(task, { ...view, url: 'https://example.org/' }, snapshot), { code: 'ORIGIN_CHANGED' })
  const optimistic = answer(p.questions, { action: 'wait' }, 1)
  assert.notEqual(decide(task, p, optimistic, 42).status, 'done')
  const complete = prepare(task, { ...view, content: task.expectedText }, snapshot)
  assert.deepEqual(decide(task, complete, answer(complete.questions, { action: 'wait' }, 0.5), 42), { status: 'done', evidence: 'expected_text' })
})

async function simulatedCall(name, args) {
  const { view, snapshot } = observation()
  if (name === 'tabs') return { tabId: 42 }
  if (name === 'navigate') return { ok: true }
  if (name === 'view') return view
  if (name === 'snapshot') return snapshot
  if (name === 'inspect') return { values: { disabled: 'false', readonly: null, type: 'text', tag: 'input', href: null, target: null } }
  return { ok: true }
}

test('stale target after model call prevents an action', async () => {
  let snapshots = 0, actions = 0
  const call = async (name, args) => {
    const result = await simulatedCall(name, args)
    if (name === 'snapshot' && ++snapshots > 1) result.interactables = []
    if (name === 'type') actions++
    return result
  }
  await assert.rejects(run(task, { call, ask: async p => answer(p.questions, { action: 'type', type_target: 'e1', type_value: 'name' }) }), { code: 'STALE_TARGET' })
  assert.equal(actions, 0)
})

test('abort and token budget stop before executing a model-selected action', async () => {
  let actions = 0
  const controller = new AbortController()
  const call = async (name, args) => { if (name === 'click') actions++; return simulatedCall(name, args) }
  await assert.rejects(run(task, { call, signal: controller.signal, ask: async p => { controller.abort(); return answer(p.questions, { action: 'click', click_target: 'e2' }) } }), { name: 'AbortError' })
  const result = await run({ ...task, maxInputTokens: 1000 }, { call, ask: async p => ({ ...answer(p.questions, { action: 'click', click_target: 'e2' }), usage: { input_tokens: 1001 } }) })
  assert.equal(result.status, 'token_limit'); assert.equal(actions, 0)
})

test('unchanged repeated actions stop instead of looping indefinitely', async () => {
  let clicks = 0
  const result = await run(task, { call: async (name, args) => { if (name === 'click') clicks++; return simulatedCall(name, args) }, ask: async p => answer(p.questions, { action: 'click', click_target: 'e2' }) })
  assert.equal(result.status, 'stalled'); assert.equal(clicks, 2)
})

async function freePort() {
  const server = createServer().listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = server.address().port; await new Promise(r => server.close(r)); return port
}

test('host shutdown closes an attached extension and releases its port', { timeout: 5000 }, async () => {
  const port = await freePort(), host = await startWsHost({ port })
  const ws = new WebSocket(`ws://127.0.0.1:${port}/mcp`)
  await once(ws, 'open')
  const closed = once(ws, 'close')
  await host.close(); await closed
  const server = createServer().listen(port, '127.0.0.1'); await once(server, 'listening'); await new Promise(r => server.close(r))
})

test('runner crosses actual stdio MCP and WS: observe, type, click, verify done in the fixed tab', { timeout: 15000 }, async () => {
  const port = await freePort(), old = process.env.BROWSER_USE_PORT
  process.env.BROWSER_USE_PORT = String(port)
  let browser, ws, value = '', saved = false, calls = []
  try {
    browser = await connectBrowser()
    ws = new WebSocket(`ws://127.0.0.1:${port}/mcp`); await once(ws, 'open')
    ws.on('message', data => {
      const c = JSON.parse(data.toString()); if (c.kind !== 'command') return
      calls.push(c)
      let result = { ok: true }
      if (c.tool === 'tabs') result.tabId = 42
      else {
        assert.equal(c.tabId, 42)
        if (c.tool === 'view') result = { ...result, url: task.startUrl, title: 'Settings', content: saved ? `Saved display name: ${value}` : 'No changes saved.', truncated: false }
        if (c.tool === 'snapshot') result = { ...result, url: task.startUrl, interactables: elements().map(e => e.ref === 'e1' ? { ...e, value } : e) }
        if (c.tool === 'inspect') result.values = { disabled: 'false', readonly: null, type: 'text', tag: c.params.ref === 'e1' ? 'input' : 'button', href: null, target: null }
        if (c.tool === 'type') { assert.equal(c.params.target.ref, 'e1'); value = c.params.text }
        if (c.tool === 'click') { assert.equal(c.params.target.ref, 'e2'); saved = true }
      }
      ws.send(JSON.stringify({ v: 1, kind: 'result', id: c.id, ok: true, result }))
    })
    const result = await run(task, { call: browser.call, ask: async p => answer(p.questions, value ? { action: 'click', click_target: 'e2' } : { action: 'type', type_target: 'e1', type_value: 'name' }, saved ? 0.99 : 0.01) })
    assert.equal(result.status, 'done'); assert.equal(value, 'River')
    assert.deepEqual(calls.filter(c => ['type', 'click'].includes(c.tool)).map(c => c.tool), ['type', 'click'])
  } finally {
    await browser?.close(); ws?.terminate()
    if (old === undefined) delete process.env.BROWSER_USE_PORT; else process.env.BROWSER_USE_PORT = old
  }
})
