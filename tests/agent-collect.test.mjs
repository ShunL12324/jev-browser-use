import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runTask } from '../packages/bridge/src/agent/loop.mjs'
import { startTask, closeSession } from '../packages/bridge/dist/agent/task.mjs'
import { build } from '../packages/bridge/src/agent/jev.mjs'

const origin = 'http://127.0.0.1:17441'
const choice = (q, id) => ({ type: 'choice', choice: id, probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, k === id ? 1 : 0])) })
const button = (ref, name, item) => ({ ref, role: 'button', name, item, tag: 'button', inputType: null, value: null, checked: null, selected: null, expanded: null, hasPopup: null, disabled: false, readonly: false, modalBlocked: false, dialog: null, context: [], href: null, editable: false, password: false, submit: false, formMethod: 'get', payment: false, inView: true, guard: 'g' })
const cards = [button('e1', 'Open item one', 'Item one'), button('e2', 'Open item two', 'Item two'), button('e3', 'Open duplicate', 'Duplicate card'), button('e4', 'Open item three', 'Item three')]
const details = [
  { kind: 'dialog', title: 'Item one', author: 'Ada', date: '2026-09-24', url: origin + '/one', text: 'Item one\nVideo player' },
  { kind: 'dialog', title: 'Item two', author: 'Ben', date: '2026-09-24', url: origin + '/two', text: 'Item two\nA text post about the topic.' },
  { kind: 'dialog', title: 'Item two', author: 'Ben', date: '2026-09-24', url: origin + '/two', text: 'Item two\nA text post about the topic.' },
  { kind: 'dialog', title: 'Item three', author: 'Cal', date: '2026-09-24', url: origin + '/three', text: 'Item three\nAnother text post about the topic.' }
]
const task = { goal: 'Collect two text posts about the topic', kind: 'collect', collect: { count: 2, item: 'text posts about the topic, not video' }, startUrl: origin + '/', allowedOrigins: [origin], inputs: {}, irreversible: 'none', llm: 'none', budgets: { maxSteps: 20, maxJevRequests: 20, timeoutMs: 10000 } }

test('collect skips unfit and duplicate detail, quotes two DOM items, closes modal and excludes visited cards', async () => {
  let open = -1, clicks = [], closes = 0
  const call = async (name, args) => {
    if (name === 'tabs') return { tabId: 7 }
    if (name === 'navigate') return {}
    if (args.action === 'agent_observe') return { agentProtocol: 3, documentId: 'd1', url: origin + '/', title: 'Feed', text: open < 0 ? 'Three cards' : details[open].text,
      detail: open < 0 ? null : details[open], scroll: { y: 0, height: 800, viewport: 800 }, marker: `m${open}`,
      elements: open < 0 ? structuredClone(cards) : [button('e9', 'Close', '')], omitted: 0 }
    if (args.action === 'agent_settle') return { navigating: false }
    if (args.op === 'click') { open = Number(args.ref.slice(1)) - 1; clicks.push(args.ref) }
    if (args.op === 'close_dialog') { open = -1; closes++ }
    return { execution: 'returned' }
  }
  const seen = []
  const ask = async payload => {
    seen.push(payload.state)
    const answers = {}
    for (const [id, q] of Object.entries(payload.questions)) {
      if (q.type === 'noul') answers[id] = { type: 'noul', noul: open === 0 ? 0.05 : 0.99 }
      else if (id === 'operation') answers[id] = choice(q, open >= 0 ? 'CLOSE_DIALOG' : 'CLICK')
      else if (id === 'target_CLICK') answers[id] = choice(q, Object.keys(q.criteria)[0])
      else answers[id] = choice(q, Object.keys(q.criteria)[0])
    }
    return { answers, usage: { input_tokens: 5 } }
  }
  const result = await runTask(task, { call, ask, handoff: async () => ({}) })
  assert.equal(result.status, 'done')
  assert.deepEqual(clicks, ['e1', 'e2', 'e3', 'e4'])
  assert.equal(closes, 3)
  assert.equal(result.skipped, 1)
  assert.deepEqual(result.items.map(i => i.title), ['Item two', 'Item three'])
  assert.equal(result.items[0].text, details[1].text)
  assert.match(result.items[0].evidenceIds[0], /^ev_[a-f0-9]{16}$/)
  assert.ok(seen.some(s => s.collection?.visited === 1 && s.elements.some(e => e.visited)))
})

test('independent card fitness heads open the first fit link despite a split target Choice', async () => {
  const links = ['Video hill repeats', 'Trail etiquette notes', 'Night running notes'].map((name, i) => ({ ...button(`e${i + 1}`, name, null), role: 'link', tag: 'a', href: origin + `/explore/${i + 1}` }))
  const record = { items: [], skipped: 0, visited: new Set(), processedDetails: new Set() }
  const page = { agentProtocol: 3, documentId: 'd1', url: origin + '/', title: 'Feed', text: 'Results', detail: null, scroll: { y: 0, height: 800, viewport: 800 }, marker: 'list', elements: links, omitted: 0 }
  const prepared = build(structuredClone(page), { ...task, collect: { count: 1, item: 'text posts about the topic, not video' } }, [], [], record)
  assert.equal(prepared.cards.length, 3)
  assert.deepEqual(prepared.cards.map(c => c.question), ['card_fit_1', 'card_fit_2', 'card_fit_3'])
  let open = -1, clicked = []
  const result = await runTask({ ...task, collect: { count: 1, item: 'text posts about the topic, not video' } }, {
    call: async (name, args) => {
      if (name === 'tabs') return { tabId: 3 }
      if (name === 'navigate') return {}
      if (args.action === 'agent_observe') return open < 0 ? structuredClone(page) : { ...page, url: origin + '/explore/2', detail: { kind: 'dialog', title: 'Trail etiquette notes', author: 'Ada', date: '2026-09-24', url: origin + '/explore/2', text: 'Trail etiquette notes\nA full text post about the topic.' }, marker: 'detail', elements: [button('e9', 'Close', '')] }
      if (args.action === 'agent_settle') return { navigating: false }
      if (args.op === 'click') { clicked.push(args.ref); open = Number(args.ref.slice(1)) - 1 }
      return { execution: 'returned' }
    },
    ask: async payload => ({ answers: Object.fromEntries(Object.entries(payload.questions).map(([id, q]) => {
      if (q.type === 'noul') return [id, { type: 'noul', noul: id === 'card_fit_1' ? 0.05 : id.startsWith('card_fit_') ? 0.34 : 0.95 }]
      if (id === 'operation') return [id, choice(q, 'CLICK')]
      if (id === 'target_CLICK' && open < 0) return [id, { type: 'choice', choice: 'e2', probabilities: { e1: 0.33, e2: 0.34, e3: 0.33 } }]
      return [id, choice(q, Object.keys(q.criteria)[0])]
    })), usage: { input_tokens: 1 } }),
    handoff: async () => ({})
  })
  assert.equal(result.status, 'done')
  assert.deepEqual(clicked, ['e2'])
  assert.equal(result.items.length, 1)
  assert.equal(result.skipped, 1)
})

test('a second start resumes the same session tab and exposes prior actions to Jev', async () => {
  const root = mkdtempSync(join(tmpdir(), 'jev-task-session-'))
  let text = 'Initial', navigate = 0, tabs = 0, close = 0, asks = 0, sawHistory = false
  const host = { invoke: async (name, args) => {
    if (name === 'tabs' && args.action === 'new') { tabs++; return { tabId: 9 } }
    if (name === 'tabs' && args.action === 'close') { close++; return { ok: true } }
    if (name === 'navigate') { navigate++; return {} }
    if (args.action === 'agent_observe') return { agentProtocol: 3, documentId: 'd1', url: origin + '/', title: 'Page', text, detail: null, scroll: { y: 0, height: 800, viewport: 800 }, marker: text,
      elements: [button('e1', 'Reveal', '')], omitted: 0 }
    if (args.action === 'agent_settle') return { navigating: false }
    if (args.op === 'click') text = 'Revealed'
    return { execution: 'returned' }
  } }
  const ask = async payload => {
    asks++
    if (asks === 3) sawHistory = payload.state.recentActions.some(a => a.target === 'Reveal')
    const answers = Object.fromEntries(Object.entries(payload.questions).map(([id, q]) => [id, choice(q, id === 'operation' ? asks === 1 ? 'CLICK' : 'DONE' : Object.keys(q.criteria)[0])]))
    return { answers, usage: { input_tokens: 1 } }
  }
  try {
    const options = { host, ask, ledgerPath: join(root, 'budget.json'), traceDirectory: root, waitMs: 5000 }
    const first = await startTask({ ...task, kind: 'navigate', collect: undefined }, options)
    assert.equal(first.status, 'done')
    const second = await startTask({ goal: 'Check the revealed state', sessionId: first.sessionId, allowedOrigins: [origin] }, options)
    assert.equal(second.status, 'done')
    assert.equal(second.tabId, first.tabId)
    assert.equal(tabs, 1); assert.equal(navigate, 1); assert.ok(sawHistory)
    assert.equal((await closeSession({ sessionId: first.sessionId }, { host })).status, 'closed')
    assert.equal(close, 1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('an idle browser session expires and closes its tab', async () => {
  const root = mkdtempSync(join(tmpdir(), 'jev-task-idle-'))
  let closed = 0
  const host = { invoke: async (name, args) => {
    if (name === 'tabs' && args.action === 'new') return { tabId: 18 }
    if (name === 'tabs' && args.action === 'close') { closed++; return { ok: true } }
    if (args.action === 'agent_observe') return { agentProtocol: 3, documentId: 'd1', url: origin + '/', title: 'Page', text: 'Ready', detail: null,
      scroll: { y: 0, height: 800, viewport: 800 }, marker: 'ready', elements: [], omitted: 0 }
    return { execution: 'returned' }
  } }
  try {
    const options = { host, ask: async p => ({ answers: { operation: choice(p.questions.operation, 'DONE') }, usage: { input_tokens: 1 } }), ledgerPath: join(root, 'budget.json'), traceDirectory: root, waitMs: 5000, sessionIdleMs: 30 }
    const first = await startTask({ ...task, kind: 'navigate', collect: undefined }, options)
    assert.equal(first.status, 'done')
    await new Promise(resolve => setTimeout(resolve, 80))
    assert.equal(closed, 1)
    await assert.rejects(startTask({ goal: 'Resume', sessionId: first.sessionId, allowedOrigins: [origin] }, options), { code: 'NO_SESSION' })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('session secrets remain redacted in later task observations and collected detail', async () => {
  const record = { secrets: ['private-code'] }
  let payload
  const result = await runTask({ ...task, kind: 'navigate', collect: undefined }, {
    record,
    call: async (name, args) => name === 'tabs' ? { tabId: 3 } : args.action === 'agent_observe'
      ? { agentProtocol: 3, documentId: 'd1', url: origin + '/', title: 'Page', text: 'private-code', detail: { title: 'private-code', text: 'private-code', url: origin + '/' },
        scroll: { y: 0, height: 800, viewport: 800 }, marker: 'm', elements: [], omitted: 0 } : {},
    ask: async p => { payload = p; return { answers: { operation: choice(p.questions.operation, 'DONE') }, usage: { input_tokens: 1 } } },
    handoff: async () => ({})
  })
  assert.equal(result.status, 'done')
  assert.ok(!JSON.stringify(payload).includes('private-code'))
})
