// Mechanical extension check for generic modal extraction and CLOSE_DIALOG.
// Jev responses are scripted; this proves the page protocol, not live accuracy.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { launchIsolated } from '../../scripts/jev/task-browser.mjs'
import { runTask } from '../../packages/bridge/dist/agent/loop.mjs'
import { prepareTask } from '../../packages/bridge/dist/agent/task.mjs'

const html = `<!doctype html><title>Cards</title><style>
body{font:16px sans-serif;padding:32px}.feed{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
article{padding:24px;border:1px solid #bbb}dialog{width:600px;min-height:250px}
</style><main><h1>Reading list</h1><div class="feed">
<article><button onclick="openPost(0)">Open item one</button></article>
<article><button onclick="openPost(1)">Open item two</button></article>
<article><button onclick="openPost(2)">Open item three</button></article>
</div></main><dialog aria-modal="true" aria-label="Post"><button onclick="document.querySelector('dialog').close()">Close</button><section id="post"></section></dialog>
<script>
const posts=[['Item one','Video player'],['Item two','A text post about JEV.'],['Item three','Another text post about JEV.']];
function openPost(i){document.querySelector('#post').innerHTML='<h2>'+posts[i][0]+'</h2><span rel="author">Reader '+i+'</span><time datetime="2026-09-24">Sep 24</time><p>'+posts[i][1]+'</p>';document.querySelector('dialog').showModal()}
</script>`
const server = createServer((_, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html) }).listen(0, '127.0.0.1')
await once(server, 'listening')
const origin = `http://127.0.0.1:${server.address().port}`
const browser = await launchIsolated()
const pick = (q, selected) => ({ type: 'choice', choice: selected, probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, k === selected ? 1 : 0])) })
const ask = async ({ state, questions }) => {
  const next = state.elements.find(e => e.name.startsWith('Open item') && !e.visited)
  const answers = {}
  for (const [id, q] of Object.entries(questions)) {
    if (q.type === 'noul') answers[id] = { type: 'noul', noul: state.openedItem.title === 'Item one' ? 0.01 : 0.99 }
    else if (id === 'operation') answers[id] = pick(q, state.openedItem ? 'CLOSE_DIALOG' : next ? 'CLICK' : 'DONE')
    else if (id === 'target_CLICK') answers[id] = pick(q, next?.id ?? Object.keys(q.criteria)[0])
    else answers[id] = pick(q, Object.keys(q.criteria).includes('keep') ? 'keep' : Object.keys(q.criteria).includes('caller') ? 'caller' : Object.keys(q.criteria)[0])
  }
  return { answers, usage: { input_tokens: 0 } }
}
try {
  const task = prepareTask({ goal: 'Collect two text posts about JEV, excluding video', kind: 'collect', collect: { count: 2, item: 'text posts about JEV, excluding video' }, startUrl: origin, allowedOrigins: [origin], llm: 'none' })
  const result = await runTask(task, { call: (name, args) => browser.call(name, args), ask, handoff: async () => { throw Error('No handoff expected') } })
  assert.equal(result.status, 'done', JSON.stringify(result))
  assert.deepEqual(result.items.map(x => x.title), ['Item two', 'Item three'])
  assert.equal(result.skipped, 1)
  assert.ok(result.items.every(x => x.text.includes('text post about JEV.')))
  console.log(JSON.stringify({ event: 'task_collect_mechanical_pass', steps: result.metrics.steps, jevRequests: result.metrics.jevRequests }))
} finally { await browser.close(); server.close() }
