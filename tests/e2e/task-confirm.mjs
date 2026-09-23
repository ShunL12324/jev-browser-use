// Mechanical check through the real extension: a page whose commit is guarded
// by window.confirm() never commits without a confirm handoff, commits once
// after approval, and a late (script-driven) link navigation is awaited.
// Fake Jev; no paid calls.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { launchIsolated } from '../../scripts/jev/task-browser.mjs'
import { runTask } from '../../packages/bridge/dist/agent/loop.mjs'
import { prepareTask } from '../../packages/bridge/dist/agent/task.mjs'

let commits = 0
const server = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/cancel') { commits++; res.writeHead(303, { location: '/done' }); return res.end() }
  res.writeHead(200, { 'content-type': 'text/html' })
  if (req.url === '/done') return res.end('<main><h1>Reservation cancelled</h1></main>')
  if (req.url === '/target') return res.end('<main><h1>Target article</h1></main>')
  res.end(`<main><form method="post" action="/cancel" onsubmit="return confirm('Cancel this reservation?')"><button>Cancel reservation</button></form>
    <a href="/target" onclick="event.preventDefault(); setTimeout(() => location.href = '/target', 400)">Delayed link</a></main>`)
}).listen(0, '127.0.0.1')
await once(server, 'listening')
const origin = `http://127.0.0.1:${server.address().port}`
const browser = await launchIsolated()
const click = name => async ({ state, questions }) => {
  const target = state.elements.find(e => e.name === name)
  const pick = (q, id) => ({ type: 'choice', choice: id, probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, k === id ? 1 : 0])) })
  const op = target && questions.target_CLICK?.criteria[target.id] ? 'CLICK' : 'DONE'
  const answers = { operation: pick(questions.operation, op) }
  for (const [id, q] of Object.entries(questions)) if (id !== 'operation') answers[id] = pick(q, id === 'target_CLICK' && target ? target.id : Object.keys(q.criteria).includes('keep') ? 'keep' : Object.keys(q.criteria).includes('caller') ? 'caller' : Object.keys(q.criteria)[0])
  return { answers, usage: { input_tokens: 0 } }
}
const call = (name, args) => browser.call(name, args)
try {
  const t = extra => prepareTask({ goal: 'g', startUrl: origin + '/', allowedOrigins: [origin], ...extra })
  let kinds = []
  let r = await runTask(t({ irreversible: 'confirm' }), { call, ask: click('Cancel reservation'), handoff: async h => { kinds.push(h.reason); return { approve: false } } })
  assert.equal(r.status, 'blocked'); assert.equal(commits, 0); assert.deepEqual(kinds, ['page_confirm_dialog'])
  r = await runTask(t({ irreversible: 'deny' }), { call, ask: click('Cancel reservation'), handoff: async () => { throw Error('deny mode must not ask') } })
  assert.equal(r.status, 'needs_confirmation'); assert.equal(commits, 0)
  kinds = []
  let asked = 0
  r = await runTask(t({ irreversible: 'confirm' }), { call, ask: async p => (asked++ ? click('none') : click('Cancel reservation'))(p), handoff: async h => { kinds.push(h.reason); return { approve: true } } })
  assert.equal(commits, 1); assert.equal(r.finalUrl, origin + '/done'); assert.deepEqual(kinds, ['page_confirm_dialog'])
  asked = 0
  r = await runTask(t({}), { call, ask: async p => (asked++ ? click('none') : click('Delayed link'))(p), handoff: async () => ({}) })
  assert.equal(r.status, 'done'); assert.equal(r.finalUrl, origin + '/target')
  console.log(JSON.stringify({ event: 'task_confirm_navigation_pass', commits, liveJev: false }))
} finally { await browser.close(); server.close() }
